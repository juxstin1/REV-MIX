#!/usr/bin/env python3
"""
xy_fx_bridge.py — Turn a Novation Launchpad Pro MK3 into an XY FX pad
for Serato / rekordbox / djay, with a live crosshair drawn on the grid.

WHAT IT DOES
  - Puts the Launchpad in Programmer Mode (full control of pads + LEDs).
  - Reads finger POSITION on the grid  -> X (CC16) and Y (CC17).
      * Tracks EVERY pad under the finger and uses the CENTROID, so a finger
        straddling two pads lands between them -> a drag glides instead of
        snapping pad-to-pad (~15 effective steps/axis on a sweep).
  - Reads finger PRESSURE (aftertouch)  -> Z / FX depth (CC18).
  - Draws a live crosshair under your finger so you SEE the grid like djay.
  - LATCH: the bottom row is a lock bar. Tap it to toggle.
      * UNLOCKED (dim red row): lift finger -> depth glides to 0 (momentary FX).
      * LOCKED   (green row):    lift finger -> X/Y/Z FREEZE where you left them
        (hands-free FX hold). Crosshair stays lit at the frozen spot. Tap the
        bar again to release; depth glides back down.
  - GLIDE: an EMA smoother on the output so pad-to-pad jumps and the release
    tail are continuous, not stepped. Tunable / defeatable (GLIDE = 0.0).
  - Emits CCs on a virtual MIDI port your DJ software maps.

REQUIREMENTS
    pip install mido python-rtmidi

  macOS / Linux: a virtual port named "XY FX Bridge" is created automatically.
  Windows: python-rtmidi can't create virtual ports. Install loopMIDI
    (https://www.tobias-erichsen.de/software/loopmidi.html), add a port named
    exactly "XY FX Bridge", then run this script — it opens that port.

ON THE LAUNCHPAD (one-time)
  Aftertouch on: hold SETUP -> Aftertouch page -> enable (Channel Pressure is
  smoothest for this; Polyphonic also works). Lowest velocity/trigger threshold
  makes drags pick up sooner.

MAP IN YOUR DJ APP
  MIDI-learn, then sweep the grid:
    CC16 -> FX param A (filter / wet)   [X, left -> right]
    CC17 -> FX param B (echo feedback)  [Y, bottom field row -> top]
    CC18 -> FX depth / dry-wet          [pressure]
  These land on a SECOND generic MIDI device — your REV-5 stays untouched.
"""

import sys
import time
import threading
import mido

# ----------------------------- CONFIG -----------------------------
LP_NAME_HINT = "Launchpad Pro MK3"   # substring match on the port name
VIRTUAL_OUT  = "XY FX Bridge"        # the port your DJ app will map
CC_X = 16                            # left -> right
CC_Y = 17                            # field bottom -> top
CC_Z = 18                            # pressure / FX depth
MIDI_CH = 0                          # output channel (0 = MIDI ch 1)

# GLIDE: EMA smoothing on the emitted value. 0.0 = off (instant, snappy).
# Higher = silkier glide but more lag. 0.5 ≈ smooths stepping, ~imperceptible
# lag. 0.85+ = slow, syrupy sweeps (nice on resonant filters). Range 0.0–0.97.
GLIDE = 0.5
GLIDE_HZ = 240                       # smoother tick rate

# Launchpad palette colour indices (0-127). Tweak to taste.
COL_OFF      = 0
COL_FIELD    = 1     # dim background for the XY field
COL_CROSS    = 41    # highlighted row + column
COL_CURSOR   = 5     # the cell at the crosshair centre
COL_LOCKED   = 21    # bottom row when LATCH is on  (green)
COL_UNLOCKED = 7     # bottom row when LATCH is off (dim red)

# Bottom row (row 1) is the latch/lock bar — not part of the XY field.
# The playable field is rows 2..8.
FIELD_ROW_MIN = 2
# ------------------------------------------------------------------

# Programmer-mode toggle SysEx (Novation manufacturer id 00 20 29).
# F0 00 20 29 02 0E 0E <mode> F7  -> mode 1 = Programmer, 0 = Live.
SYSEX_PROGRAMMER_ON  = [0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x01]
SYSEX_PROGRAMMER_OFF = [0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x00]


def find_port(ports, hint):
    for p in ports:
        if hint.lower() in p.lower():
            return p
    return None


def note_to_xy(note):
    """Programmer-mode grid layout: note = row*10 + col, row/col in 1..8."""
    col, row = note % 10, note // 10
    if 1 <= col <= 8 and 1 <= row <= 8:
        return col, row
    return None


def xy_to_note(col, row):
    return row * 10 + col


def scale(v, lo, hi):
    """Map v in [lo,hi] -> 0..127 (v may be a float centroid)."""
    val = int(round((v - lo) / (hi - lo) * 127))
    return max(0, min(127, val))


# -------------------------- LED DRAWING ---------------------------
def light(lp_out, col, row, color):
    lp_out.send(mido.Message('note_on', channel=0,
                             note=xy_to_note(col, row), velocity=color))


def draw_lock_bar(lp_out, latched):
    color = COL_LOCKED if latched else COL_UNLOCKED
    for c in range(1, 9):
        light(lp_out, c, 1, color)


def draw_field(lp_out, latched):
    for r in range(FIELD_ROW_MIN, 9):
        for c in range(1, 9):
            light(lp_out, c, r, COL_FIELD)
    draw_lock_bar(lp_out, latched)


def draw_crosshair(lp_out, col, row, latched):
    for r in range(FIELD_ROW_MIN, 9):
        for c in range(1, 9):
            if c == col and r == row:
                color = COL_CURSOR
            elif c == col or r == row:
                color = COL_CROSS
            else:
                color = COL_FIELD
            light(lp_out, c, r, color)
    draw_lock_bar(lp_out, latched)


def clear(lp_out):
    for r in range(1, 9):
        for c in range(1, 9):
            light(lp_out, c, r, COL_OFF)


# -------------------------- SHARED STATE --------------------------
class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.tx = self.ty = self.tz = 0.0     # targets (set by input thread)
        self.cx = self.cy = self.cz = 0.0     # current emitted (glide thread)
        self.running = True


def glide_loop(vout, st):
    """Background EMA smoother: eases current toward target, emits on change."""
    alpha = 1.0 if GLIDE <= 0 else max(0.001, 1.0 - GLIDE)
    period = 1.0 / GLIDE_HZ
    last = (-1, -1, -1)
    while st.running:
        with st.lock:
            tx, ty, tz = st.tx, st.ty, st.tz
            st.cx += alpha * (tx - st.cx)
            st.cy += alpha * (ty - st.cy)
            st.cz += alpha * (tz - st.cz)
            # snap when within half a CC step to settle cleanly
            if abs(tx - st.cx) < 0.5: st.cx = tx
            if abs(ty - st.cy) < 0.5: st.cy = ty
            if abs(tz - st.cz) < 0.5: st.cz = tz
            cur = (int(round(st.cx)), int(round(st.cy)), int(round(st.cz)))
        if cur != last:
            if cur[0] != last[0]:
                vout.send(mido.Message('control_change', channel=MIDI_CH, control=CC_X, value=cur[0]))
            if cur[1] != last[1]:
                vout.send(mido.Message('control_change', channel=MIDI_CH, control=CC_Y, value=cur[1]))
            if cur[2] != last[2]:
                vout.send(mido.Message('control_change', channel=MIDI_CH, control=CC_Z, value=cur[2]))
            last = cur
        time.sleep(period)


def open_virtual_out():
    try:
        vout = mido.open_output(VIRTUAL_OUT, virtual=True)
        print(f'Created virtual port "{VIRTUAL_OUT}". Map it in your DJ app.')
        return vout
    except (NotImplementedError, OSError):
        existing = find_port(mido.get_output_names(), VIRTUAL_OUT)
        if not existing:
            print(f'Could not create a virtual port, and no "{VIRTUAL_OUT}" port exists.')
            print(f'Windows: install loopMIDI and add a port named "{VIRTUAL_OUT}", then re-run.')
            sys.exit(1)
        print(f'Using existing port "{existing}".')
        return mido.open_output(existing)


def main():
    in_name  = find_port(mido.get_input_names(),  LP_NAME_HINT)
    out_name = find_port(mido.get_output_names(), LP_NAME_HINT)
    if not in_name or not out_name:
        print("Launchpad Pro MK3 not found. Ports seen:")
        print("  IN :", mido.get_input_names())
        print("  OUT:", mido.get_output_names())
        print('Adjust LP_NAME_HINT to match a name above.')
        sys.exit(1)

    lp_in  = mido.open_input(in_name)
    lp_out = mido.open_output(out_name)
    vout   = open_virtual_out()

    lp_out.send(mido.Message('sysex', data=SYSEX_PROGRAMMER_ON))
    time.sleep(0.1)

    st = State()
    glide = threading.Thread(target=glide_loop, args=(vout, st), daemon=True)
    glide.start()

    held = set()        # field pads (col,row) currently under the finger
    latched = False     # lock mode
    frozen = False      # latched + lifted -> values held hands-free

    draw_field(lp_out, latched)
    print("XY FX bridge running. Drag the grid. Bottom row = lock. Ctrl-C to quit.")

    def aim_at(centroid_pads):
        cx = sum(c for c, _ in centroid_pads) / len(centroid_pads)
        cy = sum(r for _, r in centroid_pads) / len(centroid_pads)
        with st.lock:
            st.tx = scale(cx, 1, 8)
            st.ty = scale(cy, FIELD_ROW_MIN, 8)
        draw_crosshair(lp_out, int(round(cx)), int(round(cy)), latched)

    try:
        for msg in lp_in:
            if msg.type == 'note_on' and msg.velocity > 0:
                xy = note_to_xy(msg.note)
                if not xy:
                    continue
                col, row = xy

                if row == 1:                       # bottom row = lock toggle
                    if not held:                   # ignore accidental hits mid-drag
                        latched = not latched
                        if not latched and frozen: # unlocking releases the hold
                            frozen = False
                            with st.lock:
                                st.tz = 0.0        # depth glides down
                            draw_field(lp_out, latched)
                        else:
                            draw_lock_bar(lp_out, latched)
                    continue

                frozen = False                     # touching takes over any freeze
                held.add((col, row))
                aim_at(held)

            elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                xy = note_to_xy(msg.note)
                if not xy or xy[1] == 1:
                    continue
                held.discard(xy)
                if held:
                    aim_at(held)                   # re-aim at remaining pads
                elif latched:
                    frozen = True                  # FREEZE: hold X/Y/Z, keep crosshair lit
                else:
                    with st.lock:
                        st.tz = 0.0                # release: depth glides to 0
                    draw_field(lp_out, latched)

            elif msg.type in ('polytouch', 'aftertouch'):
                if held:                           # pressure only while a finger is down
                    val = float(msg.value)
                    with st.lock:
                        st.tz = val

    except KeyboardInterrupt:
        pass
    finally:
        st.running = False
        time.sleep(0.05)
        clear(lp_out)
        lp_out.send(mido.Message('sysex', data=SYSEX_PROGRAMMER_OFF))
        lp_in.close()
        lp_out.close()
        vout.close()
        print("\nReleased the Launchpad. Bye.")


if __name__ == '__main__':
    main()

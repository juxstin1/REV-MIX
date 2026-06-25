# XY Bridge — host MIDI-learn cheat-sheets

When **BRIDGE** is on in the Launchpad screen (or you run `tools/xy_fx_bridge.py`),
REV·MIX opens a virtual MIDI port and emits the XY pad as three CCs:

| Control | CC | MIDI channel | Range | Suggested FX param |
|---|---|---|---|---|
| **X** (left → right) | **CC 16** | 1 | 0–127 | filter / FX param A (wet) |
| **Y** (field bottom → top) | **CC 17** | 1 | 0–127 | echo feedback / FX param B |
| **Z** (finger pressure) | **CC 18** | 1 | 0–127 | FX depth / dry-wet |

Virtual port name: **`REVMIX XY Bridge`** (macOS/Linux create it automatically; on
Windows make a loopMIDI port with that exact name first — see `xy_fx_bridge.py` header).

These land on a **second, generic MIDI device** so your primary controller (REV-5,
DDJ, etc.) stays untouched. Map them once and the Launchpad grid becomes an XY pad for
any of the apps below.

---

## rekordbox

1. Preferences → **Controller → MIDI** → select **REVMIX XY Bridge**.
2. Turn on **MIDI LEARN**.
3. Click the on-screen **FX1 knob 1** in rekordbox, then sweep the Launchpad grid
   left↔right → it learns **CC 16** (X).
4. Click **FX1 knob 2**, sweep up↔down → **CC 17** (Y).
5. Click the **FX depth / on** control, press into a pad → **CC 18** (Z).
6. Turn MIDI LEARN off.

A starting `.xml` you can import and then refine is in
`tools/host-maps/rekordbox-xy-fx.xml` (verify the FX target names against your rekordbox
version — MIDI maps are version-sensitive).

## Serato DJ

1. **MIDI** (top-right) → click it to enter MIDI assign mode.
2. Click an **FX param knob** (e.g. FX1 Param 1), then sweep the grid X → assigns CC 16.
3. Repeat for Y (CC 17) and the FX **Depth**/wet (CC 18).
4. Exit MIDI mode. Serato saves the map per-device automatically.

## djay Pro

1. Settings → **MIDI** → enable **REVMIX XY Bridge**.
2. **MIDI Learn** → click a mapped FX control → sweep the grid axis.
3. Assign X→CC16, Y→CC17, Z(pressure)→CC18.

> Tip: pick an FX combo where X and Y are musically independent — e.g. **X = filter**,
> **Y = echo/reverb amount**, **Z = wet** — so the pad reads like a Kaoss pad rather
> than two knobs fighting each other.
</content>

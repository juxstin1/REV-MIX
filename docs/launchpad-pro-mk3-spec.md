# Spec — Launchpad Pro MK3 Control Surface + Customization Screen

Status: **v1 built · Phase-1 transport hardware-verified on Windows** (Rust midir backend
+ full editor + XY-on-grid + host bridge) · Branch: `claude/xy-fx-pad-spec-o1vcso`

> **Build note:** implemented per this spec. `src-tauri/launchpad.rs` (midir, commands +
> `lp:input`/`lp:state` events), TS client `audio/launchpad.ts`, mapping model
> `audio/launchpad-map.ts`, XY engine `audio/launchpad-xy.ts` (centroid · per-axis glide ·
> lock/freeze · pressure→Z), dispatch+LED runtime `audio/launchpad-runtime.ts`, and the
> `LaunchpadScreen` editor (virtual device, inspector, MIDI-learn, pages, colour, connect,
> mirror, bridge), persisted to the library JSON. Host cheat-sheets in `tools/host-maps/`.
> TS typechecks + Vite builds clean.
>
> **Bring-up log (2026-06-25, Win11 26200, real Pro MK3):**
> - Fixed a Rust compile error: `HDR` was `[u8; 6]` for a 5-byte header → `[u8; 5]`. The
>   crate now builds clean against the full Tauri + midir stack (MSVC, ~stable-msvc).
> - **Round-trip verified on hardware** via `src-tauri/examples/midi_probe.rs`: Programmer
>   Mode entered, pad 11 lit green (RGB SysEx out), and grid notes / velocity / aftertouch /
>   edge CCs all read back correctly.
> - **Grid addressing confirmed:** `note = row*10 + col` (e.g. pad r3c1 → note 31, r6c8 → 68).
> - **Edge CCs confirmed:** top edge 91–98 (saw 94/95), left edge ×0 (saw 30).
> - **Aftertouch is CHANNEL pressure (`0xD0`), not poly (`0xA0`)** on this unit's default —
>   fine for the single-finger XY-Z axis; the TS runtime must read `kind:"pressure"`.
> - **Programmer port = base `LPProMK3 MIDI`** (Windows also exposes `MIDIIN2/OUT2` = DAW and
>   `MIDIIN3/OUT3` = DIN). `is_lp_port` was tightened to select the base port deterministically.
> - The unit streams **MIDI clock (`0xF8`)** continuously; `parse_midi` now explicitly drops
>   all System Real-Time / Common (`≥0xF0`).
> - **Gotcha:** the MIDI ports go un-enumerable (0 ports in *both* WinMM and WinRT) after a
>   sleep/idle; a **USB replug** restarts the NovationUsbMidi port nodes and they reappear.

Add a **Launchpad Pro [MK3]** integration to REV·MIX: drive the 64 RGB pads + edge
buttons as a hardware control surface, **and** a screen to **customize** what every
pad/button does and how it lights — decks, cues, loops, the performance FX pads, and
the new **XY FX pad** emulated across the grid. On-device, no cloud.

> **Build posture:** this is the full spec to get us "as close to the real deal" as
> research allows before we sit down to build and troubleshoot on the actual unit
> tonight. A handful of exact constants are flagged **⚠VERIFY** — confirm against the
> hardware / the Programmer's Reference PDF (page numbers cited) during bring-up.

---

## 1. Feasibility — the one thing that shapes everything

**Web MIDI (`navigator.requestMIDIAccess`) is NOT available in REV·MIX's webview on
macOS.** Tauri uses **WKWebView** on macOS, and Apple's WebKit has never shipped Web
MIDI (cited fingerprinting concerns). It *is* present in **WebView2 (Windows)**. So we
cannot rely on Web MIDI in the renderer cross-platform.

**Decision: talk to the Launchpad from Rust (Tauri core), not the webview.**
- Use the Rust **`midir`** crate (cross-platform: CoreMIDI / WinMM / ALSA) in
  `src-tauri`, exposed to the React UI through **Tauri commands** (UI→device) and
  **events** (device→UI). This is robust on macOS *and* Windows and keeps the hot LED
  path off the JS main thread.
- Alternative considered: **`tauri-plugin-midi`** (specta-rs) — a Tauri plugin that
  polyfills the Web MIDI API into the webview (TS + Rust, MIT, ~v0.2). Lower-effort if
  we want `navigator.requestMIDIAccess()` to "just work," but it's young (small user
  base) and adds a dependency we don't control. **Recommend the direct `midir`
  backend** for a small, audited surface; keep the plugin as a fallback.

Everything below assumes the `midir`-in-Rust transport.

Sources: [MDN requestMIDIAccess](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess) ·
[Tauri webview versions](https://v2.tauri.app/reference/webview-versions/) ·
[tauri-plugin-midi](https://github.com/specta-rs/tauri-plugin-midi) ·
[midir](https://github.com/Boddlnagg/midir)

---

## 2. The device (research summary)

Novation **Launchpad Pro [MK3]** — 64 velocity- **and** pressure-sensitive (polyphonic
aftertouch) RGB pads in an 8×8 grid, surrounded by edge buttons, with USB-MIDI plus
its own MIDI DIN + CV. It connects over USB and presents **multiple MIDI ports**; the
**non-DAW port** (commonly enumerated as `LPProMK3 MIDI`) is the one used for
Programmer Mode. The DAW port (`LPProMK3 DAW`) is for the Ableton/DAW handshake and we
leave it alone.

### 2.1 Programmer Mode — the contract we use

> *"Programmer Mode is an alternate state used to control the surface externally via
> MIDI. In Programmer Mode, the Launchpad loses access to all other modes; each pad and
> button sends and responds to a specified MIDI message."*

This is the mode we run in. In it, the silkscreen labels are irrelevant — **every
control is addressed by a fixed number** and lit by sending MIDI back. We enter
Programmer Mode on connect and return to Live/Session on disconnect.

**Enter / leave Programmer Mode** — ✅ **hardware-validated** by our `xy_fx_bridge.py`
prototype (`tools/xy_fx_bridge.py`), which drives a real Pro MK3 with exactly these bytes:
```
Enter Programmer:  F0 00 20 29 02 0E 0E 01 F7
Leave (Live):      F0 00 20 29 02 0E 0E 00 F7
```
SysEx header for all Pro MK3 messages: **`F0 00 20 29 02 0E …`** (`00 20 29` = Novation,
`02 0E` = Pro MK3 model id).

### 2.2 Surface addressing — `row*10 + col`

A single unified scheme: **row 1–8 = the grid (bottom→top)**, **col 1–8 = the grid
(left→right)**; **row 0** = bottom edge, **row 9** = top edge; **col 0** = left edge,
**col 9** = right edge.

| Region | Message type | Numbers |
|---|---|---|
| 8×8 grid | **Note On/Off** | **11–88** (bottom-left = 11, top-left = 81, top-right = 88) |
| Top edge (8) | **CC** | **91–98** |
| Bottom edge (8) | **CC** | **1–8** |
| Left edge (8) | **CC** | **10, 20, 30, 40, 50, 60, 70, 80** |
| Right edge (8) | **CC** | **19, 29, 39, 49, 59, 69, 79, 89** |

Confirmed: grid note 11 = lower-left, 81 = upper-left (per the Programmer's Reference
examples **and** the working prototype's `note = row*10 + col`, rows/cols 1–8). Edge
CCs corroborated by the Mixxx LP Pro MK3 mapping
(top row `0x5B–0x62` = 91–98; bottom row `0x01–0x08` = 1–8; side columns at `x0`/`x9`).
⚠VERIFY the exact CCs of named transport buttons (Play/Record/Shift/Capture, etc.)
against the PDF "Programmer Mode Layout" (p.19) at bring-up.

### 2.3 Pads: velocity + polyphonic aftertouch

Pads send **Note On** (velocity 1–127) and **Note Off**; they are **pressure-sensitive
(poly aftertouch)** — useful for the XY pad and FX depth. Aftertouch reporting is
governed by a global device setting (can be Poly AT, converted to Channel AT, or a CC).
We'll request **poly aftertouch** and read key-pressure per pad. ⚠VERIFY the AT mode
default and whether it must be set via SysEx (p.16-ish "Aftertouch").

### 2.4 Lighting — LED SysEx

Two ways to light an LED:

**A. Per-message Note/CC (simple):** send the same Note/CC number back with a velocity =
**colour palette index (0–127)**, on a **channel that selects the lighting mode**:
- Channel 1 → **static**, Channel 2 → **flashing**, Channel 3 → **pulsing**.
- e.g. `9*0h note=0Bh vel=05h` lights pad 11 solid red.

**B. Bulk RGB/colour SysEx (what we'll mostly use):**
```
F0 00 20 29 02 0E 03  <spec> [<spec> …]  F7
```
Each `<spec>` = **`[ type, index, data… ]`**:

| type | meaning | data bytes |
|---|---|---|
| `00` | static, palette colour | 1 byte: palette index 0–127 |
| `01` | flashing | 2 bytes: colour B, colour A |
| `02` | pulsing | 1 byte: palette index |
| `03` | **RGB** | 3 bytes: R, G, B (each **0–127**, 127 = max) |

One message can carry **up to ~106 specs** (whole surface in one shot). Single-pad RGB
shorthand (from the Mixxx script): `F0 00 20 29 02 0E 03 03 <index> <r> <g> <b> F7`.
We render the whole surface by batching `type 03` specs.

Palette: velocity 0–127 → fixed colour palette (see PDF appendix). We'll use **RGB
(type 03)** for deck-accurate colours (REV·MIX uses `#c8ff3d` / `#5dd8ff`) and palette
indices only where convenient. ⚠VERIFY palette table if we expose palette picking.

### 2.5 Faders (optional, later)

The **Fader layout** (id `01h`) gives up to **8 faders**, all one orientation
(H or V), each individually **unipolar or bipolar**, each sending a CC. Setup SysEx
carries up to 8 entries of **`[ type (0 uni / 1 bi), cc, colour ]`** (⚠VERIFY exact
setup header, p.15 "DAW Faders"). Candidate for motorized-feeling EQ/filter/volume
strips later; **out of scope for v1**, noted for the data model.

### 2.6 Other layouts (for "leave programmer" / future)

Layout ids (select via `…02 0E 00 <layout> <page> 00 F7`): Session `00`, Fader `01`,
Chord `02`, Custom `03`, Note/Drum `04`, Scale `05`, Sequencer settings/steps `06–0F`.
We only need: Programmer (toggle, §2.1) for our surface, and selecting **Session `00`**
on exit to hand the device back to normal use.

Sources: [Programmer's Reference Guide (Focusrite PDF)](https://fael-downloads-prod.focusrite.com/customer/prod/s3fs-public/downloads/LPP3_prog_ref_guide_200415.pdf) ·
[Mixxx LP Pro MK3 mapping](https://github.com/mxmilkiib/mixxx-novation-launchpad-pro-mk3-milkii) ·
[Novation LP Pro MK3 interface guide](https://userguides.novationmusic.com/hc/en-gb/articles/25494530115346-Launchpad-Pro-MK3-interface) ·
[Custom Mode Editor guide](https://support.novationmusic.com/hc/en-gb/articles/360009860380-Launchpad-Components-Custom-Mode-Editor-Guide)

---

## 3. Architecture in REV·MIX

```
 Launchpad ⇄ USB-MIDI ⇄  src-tauri (Rust, midir)            React renderer
                          ─────────────────────────         ───────────────────────────
                          launchpad.rs                       audio/launchpad.ts  (client)
                           • open MIDI in/out (port match)    • invoke('lp_*') commands
                           • enter Programmer Mode            • listen('lp_input') events
                           • forward input → emit events      surface/                 (UI)
                           • apply LED frames (debounced)      • LaunchpadScreen.tsx
                          Tauri commands:                      • mapping engine (TS)
                           lp_connect / lp_disconnect          • LED render from app state
                           lp_send (raw)                       • binds actions → engine.*
                           lp_set_leds (batched RGB frame)
                          Tauri events:
                           lp_input { kind, num, val, chan }
                           lp_state { connected, name }
```

### 3.1 Rust side (`src-tauri/src/launchpad.rs`)

- **Port discovery:** enumerate `midir` in/out ports; match the Programmer port by name
  (contains `LPProMK3` and not `DAW`; ⚠VERIFY exact port string on macOS vs Windows).
- **Lifecycle:** on connect → send *Enter Programmer*; on disconnect / app-quit →
  send *Leave (Session)* and clear LEDs. Guard against re-entrancy.
- **Input:** parse Note On/Off (grid + velocity + later poly AT) and CC (edges); emit a
  normalized `lp_input` event `{ kind: "note"|"cc"|"aftertouch", num, val, chan }`.
- **Output:** `lp_set_leds(frame)` takes a list of `{ index, r, g, b }` and emits one
  batched `type 03` SysEx; coalesce calls at ~60 Hz to avoid flooding USB.
- **Safety:** all SysEx built from typed helpers; never send raw user bytes except via a
  dev-only `lp_send`.

### 3.2 TypeScript client (`src/audio/launchpad.ts`)

- Thin wrapper over `invoke`/`listen`; exposes `connect()`, `disconnect()`,
  `onInput(cb)`, `setLeds(frame)`, `setLed(index, color)`.
- Owns the **mapping runtime**: translate an incoming `lp_input` → a bound **action**,
  call the matching `engine.*` / app handler, then recompute affected LEDs.
- Mirrors device state into React (a `useLaunchpad()` hook) so the on-screen editor
  shows live pad presses and the current LED frame.

### 3.3 Optional: external MIDI-bridge mode (Serato / rekordbox / djay)

The same surface can drive **other** DJ software, not just REV·MIX — that's exactly what
`tools/xy_fx_bridge.py` does today: it opens a **virtual MIDI port** ("XY FX Bridge")
and emits `CC16 = X`, `CC17 = Y`, `CC18 = Z (pressure)` for the host app to MIDI-learn,
landing on a *second* generic MIDI device so the user's primary controller (e.g. a
REV-5) stays untouched. We fold this in as a **bridge output mode** on the same mapping:
each binding can target an **internal action** (drives `engine.*`) *or* an **external
CC** (forwarded out a virtual port via the Rust `midir` backend, which can also
*create* virtual ports on macOS/Linux; Windows needs loopMIDI).

This means one editor configures the Launchpad for REV·MIX **and** for Serato/rekordbox/
djay sets. Platform note from the prototype: virtual-port *creation* isn't available on
Windows python-rtmidi (needs loopMIDI) — the Rust `midir` path has the same OS
constraint, so on Windows we document the loopMIDI step or open an existing port.

### 3.4 Where it plugs into existing code

- Actions reuse the **exact functions the UI already calls**: `engine.play/seek/setLoop/
  perf*`, the `FX_PADS` table (`CDJ.tsx`), and the new **`fx-map.ts`** XY effects — so a
  hardware pad and an on-screen control drive one path, same as knobs↔automation today.
- New top-bar view `LAUNCHPAD` (next to `SEQUENCER` / `LIBRARY`) opens the editor.
- Persistence piggybacks on the **library JSON** (`src/library.ts`): a new
  `launchpadMappings` collection, same debounce-save pattern as playlists/sets.

---

## 4. The customization screen (UX)

A dedicated screen, `LaunchpadScreen.tsx`, styled like the rest of the console.

### 4.1 Layout

- **Virtual device** — a faithful 8×8 grid + the four edge button strips, 1:1 with the
  hardware, rendered with the same skeuomorphic treatment. It is both a **monitor**
  (lights mirror what the hardware shows, real presses flash live) and an **editor**
  (click a pad to assign it).
- **Inspector panel** (right) — for the selected pad/button: its address (e.g. `note 11`
  / `cc 91`), the **assigned action**, action-specific options, **LED behaviour**
  (idle colour, active colour, lighting type static/flash/pulse), and a **colour
  picker** (RGB + palette swatches matching deck accents).
- **Toolbar** — device **connect/disconnect** + status LED, current **mapping name**
  (load/save/duplicate/delete), **page/layer** selector, **MIDI Learn** toggle, and
  **"Mirror to hardware"** on/off.
- **Action palette** (left) — searchable list of bindable actions grouped by category
  (Transport, Cue, Loop, FX pad, **XY FX**, Mixer, Deck select, Page, Macro). Drag onto
  a pad, or select-pad-then-click-action.

### 4.2 Interactions

- **Assign:** select pad → pick action (or drag). Multi-select a region to bulk-assign
  (e.g. paint a 4×2 block as the FX pads, or an 8×8 region as the XY surface).
- **MIDI Learn:** arm Learn, press the physical pad to select it, then choose the
  action — no need to hunt the number.
- **Colour:** per-pad idle/active colours; "match deck accent" shortcut; copy/paste
  colour; per-region fill.
- **Pages/Layers:** up to N **pages** (a "page" button on the surface flips the whole
  grid's mapping) so one device hosts Deck-A cues, Deck-B cues, an FX page, and a full
  **XY page** without running out of pads.
- **Test mode:** with hardware connected, presses fire the real audio so you can audit a
  layout live; without hardware, presses are simulated on screen.
- **Reset / presets:** revert a pad, revert page, or load the **default REV·MIX map**
  (§6).

---

## 5. Mapping data model

```ts
// src/audio/launchpad-map.ts
export type LpRegion = "grid" | "top" | "bottom" | "left" | "right";
export type LpColor = { r: number; g: number; b: number }; // 0..127 each (device-native)
export type LpLightType = "static" | "flash" | "pulse";

export type LpActionId =
  // transport / deck
  | "deck.playPause" | "deck.cue" | "deck.sync" | "deck.select"
  // cues / loops (param = index / beats)
  | "cue.trigger" | "cue.set" | "loop.toggle"
  // performance FX (param = FX_PADS key)
  | "fx.pad"
  // XY FX pad emulated on the grid (param = fx id; pads encode x/y by position)
  | "xy.select" | "xy.cell"
  // mixer
  | "mixer.xfadeNudge" | "mixer.filterStep" | "mixer.eqKill"
  // surface
  | "page.select" | "macro" | "none";

export interface LpBinding {
  /** device address */
  region: LpRegion;
  num: number;            // 11..88 grid note, or CC for edges
  action: LpActionId;
  /** action-specific payload: deck "A"/"B", cue index, beats, fx key, xy coords… */
  params?: Record<string, string | number>;
  /** LED look */
  idle?: LpColor;
  active?: LpColor;
  light?: LpLightType;
  /** momentary (hold) vs toggle, for FX-style actions */
  mode?: "momentary" | "toggle";
}

export interface LpPage {
  id: string;
  name: string;
  bindings: LpBinding[];   // sparse — unbound controls fall through to "none"
}

export interface LpMapping {
  id: string;
  name: string;
  deck: "A" | "B" | "active"; // default deck context for deck-relative actions
  pages: LpPage[];
  activePageBinding?: number; // which edge button flips pages
}
```

Stored in the library JSON as `launchpadMappings: LpMapping[]` + a `currentMappingId`.

### 5.1 Action ↔ engine binding (the runtime)

A dispatch table maps `LpActionId` → handler, reusing existing code:

| Action | Calls |
|---|---|
| `deck.playPause` | the App `playPause(deck)` |
| `cue.trigger` / `cue.set` | CDJ hot-cue logic (`engine.seek` / store) |
| `loop.toggle` | `engine.setLoop` / `clearLoop` (param `beats`) |
| `fx.pad` | `FX_PADS[key].engage/release` (momentary via Note On/Off) |
| `xy.select` | set active XY effect (`fx-map.ts` id) |
| `xy.cell` | `FX_BY_ID[fx].engage/apply(deck, x, y, beat)` from the pad's grid position |
| `mixer.filterStep` / `eqKill` | `engine.setFilter` / `engine.setEq` |
| `page.select` | switch `LpPage` |

### 5.2 XY-on-the-grid — mechanics (from the validated prototype)

`tools/xy_fx_bridge.py` already proves the feel on real hardware; we port its logic into
the TS runtime (driving `fx-map.ts` directly instead of emitting external CCs). The
pieces that make it feel like djay's pad rather than a stepped 8×8:

- **Centroid straddle (sub-pad resolution).** Track **every** grid pad currently under
  the finger (a `Set` of `(col,row)`), and aim at their **centroid**, not the last pad.
  A finger bridging two pads lands *between* them → a sweep yields ~15 effective
  steps/axis instead of 8. `x = mean(col)→0..1`, `y = mean(row over the field rows)→0..1`.
- **EMA glide smoother (continuous, not stepped).** A background ticker (~240 Hz) eases
  the *emitted* value toward the target: `cur += (1−GLIDE)·(target−cur)`, with a
  **snap-when-within-half-a-step** rule so it settles dead-on instead of crawling
  forever. `GLIDE` 0.0 = instant/snappy (original feel), 0.5 = smooths stepping with
  imperceptible lag, 0.85 = syrupy filter sweeps. Verified: glide 0.85 settles in
  ~146 ms; glide 0 is instant. In REV·MIX this thread is a `requestAnimationFrame` /
  worker loop calling `FX_BY_ID[fx].apply(deck, x, y, beat)`.
- **Lock bar + freeze (hands-free hold).** The **bottom row is a latch bar** (tap to
  toggle; green = locked, dim-red = unlocked). It's also a guard: bottom-row hits are
  **ignored while a field drag is in progress**, so you can't toggle by accident.
  - *Unlocked:* lift → depth (Z) glides to 0 — momentary FX (the HOLD feel).
  - *Locked:* lift → **freeze** X/Y/Z exactly where you left them, crosshair stays lit
    at that spot; walk away and grab the other deck with the FX still running. Tap the
    bar again → release (depth glides down, field redraws). Touching the field again
    takes over any freeze.
- **Pressure → Z / FX depth.** Poly (or channel) aftertouch drives a **third axis** (Z,
  e.g. dry/wet or FX depth), **only while a finger is down**; when frozen the held Z
  stays put. Maps cleanly onto an extra `apply()` param or a per-FX depth knob.
- **Live crosshair on the grid.** Redraw the highlighted row+column (`COL_CROSS`) and the
  centre cell (`COL_CURSOR`) under the finger each move; the rest of the field sits at
  `COL_FIELD` dim. This mirrors the on-screen `XYPad` puck so the hardware *looks* like
  djay. (Palette indices are best-guess in the prototype — `COL_*` constants — and are
  on the ⚠VERIFY list.)

**Field is rows 2–8 by default** (row 1 = lock bar) → 7 Y-rows; centroid keeps Y
resolution usable. Open option (per the prototype author): keep the **full 8-row field**
and move the lock toggle to a **single corner pad** instead of a full-width bar — a
one-block change. Decide on hardware (§9).

This makes the grid a coarse-but-expressive Kaoss pad that mirrors the on-screen
`XYPad`; the same `fx-map.ts` effects (FILTER/ECHO/REVERB/FLANGER/PHASER/GATER/SLICER/
CRUSH) are selectable from the top edge.

---

## 6. Proposed default REV·MIX mapping (starting point)

A sensible factory layout we can refine on the unit. Deck context shown by edge colour
(A = acid `#c8ff3d`, B = ice `#5dd8ff`).

- **Page 1 — PERFORM (per active deck)**
  - Rows 1–2 (notes 11–28): **8 hot cues** ×… (top row cues, bottom row alt), coloured
    per `CUE_COLORS`.
  - Rows 3–4 (31–48): **auto-loops** ¼ → 32 beats (the `LOOP_SIZES` set).
  - Rows 5–6 (51–68): **performance FX pads** (the 8 `FX_PADS`), momentary, lit while
    held.
  - Rows 7–8 (71–88): reserved / scene macros.
  - Left edge: Deck A play, cue, sync, MT, page-down… Right edge: Deck B equivalents.
  - Top edge: page selectors (PERFORM / XY / MIX). Bottom edge: track-select (queue).
- **Page 2 — XY FX**: full 8×8 = the XY surface; top edge = FX selector
  (FILTER/ECHO/REVERB/FLANGER/PHASER/GATER/SLICER/CRUSH); left/right = A/B target +
  HOLD/LATCH.
- **Page 3 — MIX**: filter steps, EQ kills, crossfader nudge, master.

(All editable — this is just the seed map shipped with the app.)

---

## 7. LED feedback rules

- **Idle:** each bound control shows its `idle` colour dim; unbound = off.
- **Active state mirrors app state**, not just key-down: playing deck pulses its play
  button; an engaged loop pulses its size pad; a held FX pad is bright; the XY page
  lights the column/row crosshair of the current point; armed automix breathes.
- **Render path:** app state → compute desired LED frame (array of `{index,color}`) →
  diff vs last frame → send only changed specs as one batched `type 03` SysEx, ≤60 Hz.
- **Connect:** flash a brief REV·MIX identity animation, then paint the active page.
- **Disconnect / quit:** clear LEDs, return to Session layout.

---

## 8. Implementation phases

0. **Prototype check (already done):** `tools/xy_fx_bridge.py` runs the XY-on-grid feel
   on the real unit (programmer toggle, centroid, glide, lock/freeze, pressure). Use it
   as the reference for the TS port and to sanity-check ⚠VERIFY constants on hardware.
1. **Transport bring-up (Rust):** `midir` port discovery, enter Programmer Mode, log
   input, light a test pad. Prove round-trip on the real unit. *(This is the riskiest
   bit — do it first, on hardware. The prototype already confirms the bytes work.)*
2. **TS client + hook:** commands/events, `useLaunchpad()`, on-screen virtual device
   that mirrors presses and a manual LED test.
3. **Mapping model + runtime:** data types, dispatch table wired to `engine.*` /
   `FX_PADS` / `fx-map.ts`; default map (§6) hardcoded.
4. **Editor UI:** assign/learn/colour/pages, persistence to library JSON.
5. **LED feedback engine:** state→frame diffing, per-page paint, animations.
6. **Polish:** poly-aftertouch → FX depth, XY-on-grid, faders layout (optional),
   multi-unit / hot-plug handling.

Phases 1–3 give a usable, mappable controller; 4–5 deliver the customization screen;
6 is finesse.

---

## 9. Open questions & ⚠VERIFY-on-hardware list

**Decisions for you:**
1. **Transport:** direct `midir` Rust backend (recommended) vs `tauri-plugin-midi`?
2. **Scope of v1 customization:** full editor (pages, learn, colour) now, or ship the
   default map first and add the editor next?
3. **Aftertouch:** use poly-AT for FX depth, or ignore pressure in v1?
4. **Faders layout:** want the DAW-fader mode for EQ/volume strips, or grid-only?
5. **Lock control:** full-width bottom-row lock bar (7-row field) vs single corner-pad
   toggle (full 8-row field)? (Prototype default = bar.)
6. **External bridge:** also emit CC16/17/18 to a virtual port for Serato/rekordbox/djay
   (§3.3), or REV·MIX-internal only for now?

**"Next slice" options carried over from the prototype (pick any when we build):**
- **Per-axis glide** — snappy X for filter, syrupy Y for echo (independent `GLIDE` per
  axis) instead of one global smoother.
- **Split bottom row** — lock toggle + a couple of cue/FX-on triggers instead of a
  full-width bar.
- **Host cheat-sheets** — a rekordbox `.xml` / djay MIDI-learn map so X/Y/Z land on the
  expressive FX combo immediately (for the external-bridge mode).
- **Per-axis colour** for the crosshair to distinguish X vs Y sweeps.

**⚠VERIFY against the unit / PDF during bring-up:**
- Exact Programmer enter/leave bytes (§2.1) — PDF p.7.
- Exact CCs of named edge/transport buttons (§2.2) — PDF p.19 layout diagram.
- macOS vs Windows **port name** strings for the Programmer port (§3.1).
- Poly-aftertouch default + any SysEx needed to enable it (§2.3).
- Colour **palette table** indices if we expose palette picking (§2.4).
- Fader setup SysEx header (§2.5) — PDF p.15.
- Per-pad LED **refresh ceiling** before USB saturation (tune the ≤60 Hz coalescing).

---

## 10. Sources

- [Launchpad Pro [MK3] Programmer's Reference Guide — Focusrite PDF](https://fael-downloads-prod.focusrite.com/customer/prod/s3fs-public/downloads/LPP3_prog_ref_guide_200415.pdf) (primary)
- [Novation — Launchpad Pro MK3 interface guide](https://userguides.novationmusic.com/hc/en-gb/articles/25494530115346-Launchpad-Pro-MK3-interface)
- [Novation — Launchpad Components / Custom Mode Editor](https://support.novationmusic.com/hc/en-gb/articles/360009860380-Launchpad-Components-Custom-Mode-Editor-Guide)
- [Mixxx controller script — LP Pro MK3 (mxmilkiib)](https://github.com/mxmilkiib/mixxx-novation-launchpad-pro-mk3-milkii) (RGB SysEx + CC maps)
- [DrivenByMoss documentation — Novation Launchpad](https://github.com/git-moss/DrivenByMoss-Documentation/blob/master/Novation/Novation-Launchpad.md)
- [MDN — requestMIDIAccess](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess) · [Tauri webview versions](https://v2.tauri.app/reference/webview-versions/) · [tauri-plugin-midi](https://github.com/specta-rs/tauri-plugin-midi) · [midir](https://github.com/Boddlnagg/midir)
- `tools/xy_fx_bridge.py` — our **hardware-validated** Python prototype (mido + rtmidi):
  programmer toggle, centroid straddle, EMA glide, lock/freeze, pressure→Z. Reference
  implementation for the XY-on-grid runtime (§5.2) and the external-bridge mode (§3.3).
</content>

# Spec — Square XY FX Pad (Kaoss-style)

Status: **v1 built** (phases 1–3 below; A/B target, 9 effects) · Branch: `claude/xy-fx-pad-spec-o1vcso`

> **Build note:** `XYPad.tsx` + `audio/fx-map.ts` + engine XY DSP are implemented and
> wired into the mixer centre column. Shipped effects: FILTER, ECHO, REVERB, FLANGER,
> PHASER, GATER, SLICER, ROLL, BITCRUSH. Deferred to a later pass: MASTER target,
> VIBRATO, PING-PONG, REVERSER, true bitcrush sample-rate reduction (worklet),
> live-X roll-length change. See §8.

A square, touch-driven **XY FX pad** in the REV·MIX console. One finger (or pointer)
drives **two effect parameters at once** — X and Y — over a live crosshair, with an
**FX selector** underneath to choose which effect the pad is currently performing.
Modeled on the Korg Kaoss Pad and the X/Y pads in WeDJ / VirtualDJ / dj.app: the
default crosshair maps **power (wet/intensity) on X and the filter on Y**, and every
effect dj.app ships (filter, echo, reverb, flanger, phaser, gater, slicer, roll,
bitcrush, reverser, ping-pong, vibrato …) is selectable from the strip below.

---

## 1. Research — what we're matching

| Source | XY pad behaviour | Notes |
|---|---|---|
| **Korg Kaoss Pad** (the original) | Touch position → two params; lift = effect off or held depending on hold mode | Bottom-left origin; X = horizontal param, Y = vertical param |
| **WeDJ for iPad** (Pioneer) | "Use the X/Y pad to blend 2 effects by tracing your finger on the x and y axes" | FX assigned per axis; Pad FX + Combo FX |
| **VirtualDJ** | "XY Pad Effect view to adjust 2 parameters at the same time" | Any 2-knob effect can be driven from one pad |
| **dj.app / YouDJ** | XY pad to "try out effects while playing"; effect set incl. filter, echo, reverb, flanger, phaser, gater, slicer, roll, bitcrush, reverser, ping-pong, vibrato | Pad picks one effect; X/Y are that effect's two macro params |

**Takeaway for REV·MIX:** one square pad, a **per-effect X/Y mapping table**, a
**hold vs. latch** behaviour, and an **FX selector** row. The pad targets a deck
(A / B) or the master bus. This reuses the existing performance-FX engine and adds a
small number of new DSP blocks.

Sources:
- [WeDJ for iPad — Pioneer DJ](https://www.pioneerdj.com/en/product/software-interfaces/wedj-for-ipad/)
- [VirtualDJ — XY Pad Effect view](https://virtualdj.com/manuals/virtualdj/appendix/nativeeffects.html)
- [YOUDJ — effect set](https://you.dj/upgrade)
- [DJ effects reference — DJ Knowledge Base](https://pestrela.github.io/dj_kb/effects/)

---

## 2. Where it lives in the existing app

REV·MIX already has a complete per-deck channel strip and a performance-FX layer
(`src/audio/engine.ts`): sweep `filter`, synced `delay`/`delayFb`/`delayWet`,
convolution `reverb`, `trem` gain stage, `chorusDelay`/`chorusWet`, plus LFO
infrastructure (`startLfo`/`stopLfo`) and a beat-repeat scheduler (`perfStutter`).
The CDJ pads (`src/components/CDJ.tsx`) already prove the **hold/lock momentary**
interaction model we want to reuse.

The XY pad is a **new third bank alongside the existing FX work**, but rendered as
its own panel rather than crammed into the 8-pad grid, because it needs continuous
2-D area, not discrete buttons.

**Placement:** a new `XYPad` panel. Two reasonable homes — pick one in review:

- **A. Mixer center column** (`Mixer.tsx`, under the MASTER knob) — always visible,
  reads as part of the console. Tight on vertical space.
- **B. Dedicated FX panel** below the decks / as a toggled stage view next to
  `SEQUENCER` — more room, less always-on. *(Recommended: A, with a compact pad.)*

**Target selection:** the pad acts on one destination at a time — `A`, `B`, or
`MASTER` — chosen by a small segmented control on the panel. Default = the current
`activeDeck` from `App.tsx`. Per-deck FX reuse the existing channel-strip nodes;
`MASTER` requires a master-bus FX chain (see §5.4).

---

## 3. Interaction design

### 3.1 The pad

- A **square** surface (1:1), min ~180 px, scaling to available space. Bottom-left
  is the origin **(x=0, y=0)**; top-right is **(1, 1)** — matches Kaoss/WeDJ.
- **Crosshair picker:** full-width horizontal + full-height vertical guide lines
  intersecting at the live point, plus a glowing puck at `(x, y)`. Deck-accent color
  (`#c8ff3d` for A, `#5dd8ff` for B, neutral white for MASTER).
- **Readouts:** the two live param values rendered as small `mono` labels on the X
  and Y edges (e.g. `LP 480 Hz` / `WET 72%`), so the performer sees the mapping.
- **Grid + axis legends:** faint grid; the selected effect's axis names printed along
  the bottom (X) and left (Y), e.g. `X: POWER` · `Y: FILTER`.

### 3.2 Pointer behaviour

- **Pointer down inside the pad → engage** the effect and set X/Y to the touch point.
- **Drag → continuously update** both params (throttled to rAF / pointer events).
- **Pointer up:**
  - **HOLD mode (default):** effect disengages (wet → 0 with a short release), puck
    snaps back to a rest indicator. Momentary, like a real Kaoss pad.
  - **LATCH mode:** effect stays engaged at the last X/Y; puck stays lit. Press again
    (or hit `KILL`) to release.
- **Hold/latch toggle** mirrors the existing `HOLD` / `LOCK` control and styling in
  `CDJ.tsx` (`fxMode`), for muscle-memory consistency.
- Uses `setPointerCapture` + window `pointermove`/`pointerup` exactly like `Knob.tsx`
  and the jog wheel, so drags continue outside the element bounds.

### 3.3 FX selector

- A row/grid of effect buttons **underneath** the pad (the "FX selector"), styled like
  the existing `pad-bank` / `pad-grid` buttons.
- Exactly **one effect active at a time** (radio behaviour). Switching effects while
  the pad is held performs a fast crossfade: ramp the old effect's wet to 0, engage
  the new one at the current X/Y.
- The default selection is **`FILTER/POWER`** — the "power on X, filter on Y" combo
  the brief calls for (see §4, FX #1).

### 3.4 Beat sync

Time-based effects (echo, slicer, roll, gater, ping-pong) sync to the deck's grid via
the existing `track.analysis.beatInterval` (`beat` in `CDJ.tsx`). When the pad targets
MASTER, use the `activeDeck`'s beat. Tempo-synced params (delay time, slice length,
gate rate) snap X or Y to musical divisions (1/16, 1/8, 1/4, 1/2, 1 bar) rather than a
continuous sweep — quantized fields are noted per-effect in §4.

### 3.5 Keyboard / accessibility

- Pad is focusable; arrow keys nudge X/Y by 1/32, `Space`/`Enter` engages-at-center,
  `Esc` releases. ARIA: `role="application"`, `aria-label` describing the active FX
  and current X/Y values. Not a primary path, but no dead-ends for non-pointer users.

---

## 4. Effect catalog & X/Y mappings

Each effect defines **what X and Y do**. "Reuses" = already in `engine.ts`; **NEW** =
DSP to add (§5.5). `idle` = the (x,y) corner that is sonically neutral, so HOLD-release
and "rest" read correctly.

| # | FX (selector label) | X axis | Y axis | Engine | Sync |
|---|---|---|---|---|---|
| 1 | **FILTER / POWER** *(default)* | Wet/intensity 0→100% | Filter: LP↔HP sweep (center = bypass) | Reuses `setFilter`, dry/wet | — |
| 2 | **ECHO** | Feedback 0→0.75 | Delay time: 1/16→1 beat (quantized) | Reuses `prepareDelay`,`rampDelayWet` | ✓ |
| 3 | **REVERB** | Wet 0→100% | Size/character: bright→dark IR + pre-delay | Reuses `setReverbCharacter`,`rampReverbWet` | — |
| 4 | **FLANGER** | Wet/depth | LFO rate 0.05→6 Hz | **NEW** (mod delay + feedback) | optional |
| 5 | **PHASER** | Wet/depth | LFO rate / sweep center | **NEW** (allpass chain + LFO) | optional |
| 6 | **GATER** | Wet/depth | Gate rate: 1/4→1/32 (quantized) | Reuses `trem` w/ square LFO | ✓ |
| 7 | **SLICER** | Slice length: 1/8→1 beat (quantized) | Gate depth / duty | **NEW-ish** (beat-synced gate; reuses gate engine) | ✓ |
| 8 | **ROLL** (beat-repeat) | Roll length: 1/16→1/2 beat (quantized) | Wet/feedback | Reuses `perfStutter` (slip roll) | ✓ |
| 9 | **BITCRUSH** | Bit depth 16→2 bits | Sample-rate reduction / downsample | **NEW** (WaveShaper + S&H worklet) | — |
| 10 | **VIBRATO** | Depth (pitch mod) | LFO rate 1→9 Hz | **NEW** (mod delay, no feedback) | optional |
| 11 | **PING-PONG** | Feedback | Time: 1/8→1/2 beat (quantized), stereo bounce | **NEW** (stereo cross-fed delay) | ✓ |
| 12 | **REVERSER** | Wet | Grain/segment length (quantized) | **NEW** (reverse-buffer tap) | ✓ |
| 13 | **NOISE/RISER** *(optional)* | Level | Sweep filter on noise bed | **NEW** (optional, build-up FX) | — |

Notes:
- **#1 is the brief's "power on X, filter on Y."** Idle corner = bottom-left
  (`x=0` → fully dry, `y=0.5` band → filter bypass). Y below center sweeps lowpass
  (reuses the `<0.5` branch of `setFilter`), above center sweeps highpass.
- **Quantized axes** snap to musical divisions, with the chosen division shown in the
  edge readout (e.g. `1/8`). Snapping is done in the component before calling the
  engine, using `beatInterval`.
- The set above is a **superset of dj.app's** list; ship #1–#8 first (covers the brief:
  fx + filter + slicer + the staples), then #9–#13.

---

## 5. Audio engine design

### 5.1 Principle (unchanged)

Keep the engine's existing contract: **the UI drives `AudioParam`s; manual and
automix share one signal path.** The XY pad is just another caller of `engine` methods,
plus a thin set of new methods for the new effects.

### 5.2 Per-deck vs. master routing

- **Per-deck (A/B):** reuse the channel-strip nodes already wired in `makeDeck`
  (`filter`, `delay*`, `reverb*`, `trem`, `chorus*`). New per-deck effects (flanger,
  phaser, bitcrush, …) get new nodes inserted into the strip, **post-fader on the send
  bus** (tapping `analyser` like delay/reverb already do) so tails ring through cuts.
- **Master:** add a master FX chain between `master` and `masterAnalyser` (or as a
  parallel send off `master`). Mirrors the per-deck blocks but on the summed signal.

### 5.3 New continuous-control API surface

The pad needs **continuous setters** (the existing perf methods are mostly
boolean engage/release). Proposed additions to `MixerEngine`, all taking normalized
`0..1` and ramping via `setTargetAtTime` like the current setters:

```ts
// generic XY entry points — route by selected effect + target
type FxTarget = DeckId | "MASTER";
engine.xyEngage(target: FxTarget, fx: FxId): void;     // start effect (wet ramps in)
engine.xySet(target: FxTarget, x: number, y: number): void;  // continuous, 0..1
engine.xyRelease(target: FxTarget, fx: FxId): void;    // wet ramps out / latch off

// new per-effect DSP (called by the router; signatures illustrative)
engine.setFlanger(target, depth: number, rateHz: number): void;
engine.setPhaser(target, depth: number, rateHz: number): void;
engine.setGater(target, depth: number, rateHz: number): void;   // square-LFO trem
engine.setSlicer(target, sliceSec: number, duty: number, on: boolean): void;
engine.setBitcrush(target, bits: number, downsample: number): void;
engine.setVibrato(target, depth: number, rateHz: number): void;
engine.setPingPong(target, timeSec: number, feedback: number, on: boolean): void;
engine.setReverser(target, segSec: number, wet: number, on: boolean): void;
```

`xySet` maps `(x,y)` to the active effect's two params per §4 (the mapping table lives
in the component or a shared `fx-map.ts`; the engine just exposes the primitives).

### 5.4 Master FX chain

```
master → [masterFilter] → [masterFlanger/phaser/bitcrush sends] → masterAnalyser → destination
```

Build lazily (only when MASTER is first targeted) to avoid adding nodes for users who
never touch master FX. Reuse `impulseResponse` for a master reverb send if reverb is
allowed on master.

### 5.5 New DSP blocks (how to build each)

- **Flanger / Vibrato:** `DelayNode` (~1–10 ms) modulated by an `OscillatorNode`→`Gain`
  (reuse `startLfo`). Flanger adds a feedback `Gain`; vibrato has none and is 100% wet.
- **Phaser:** 4–6 cascaded `BiquadFilterNode type="allpass"`, their `frequency`
  modulated by one shared LFO; mix dry+wet, optional feedback.
- **Gater:** the existing `trem` gain stage driven by a **square** LFO (build a
  square via a `PeriodicWave`, or a fast-ramp scheduler) at the gate rate.
- **Slicer:** beat-synced gate — schedule `trem.gain` (or a dedicated gain) to
  open/close on the grid using `setValueAtTime` envelopes; conceptually a quantized
  gater. Can share the gater node.
- **Roll:** reuse `perfStutter` (already a slip beat-repeat); expose continuous
  `sliceSec` and a wet mix so the pad's X sets roll length.
- **Bitcrush:** bit-depth via a `WaveShaperNode` with a quantizing curve; sample-rate
  reduction via a tiny sample-and-hold `AudioWorkletProcessor` (new worklet file, or
  fold into an existing one). This is the one genuinely new worklet.
- **Ping-pong:** two `DelayNode`s cross-fed L→R/R→L with a shared feedback `Gain`,
  panned hard via `StereoPannerNode`.
- **Reverser:** maintain a short ring buffer (worklet) and play segments backwards on
  the grid; lowest priority, can ship last.

### 5.6 Reset / safety

Extend `resetStrip` (and add a `resetMasterFx`) to neutralize every new node, so the
automix `resetStrip` after a transition also clears any latched XY FX. New-track load
in `CDJ.tsx` already drops latched FX; the XY panel must subscribe to the same signal.

---

## 6. Component API

New `src/components/XYPad.tsx`:

```ts
interface XYPadProps {
  /** which deck/master the pad currently drives */
  target: "A" | "B" | "MASTER";
  onTargetChange: (t: "A" | "B" | "MASTER") => void;
  /** beat interval (s) of the relevant deck, for quantized FX */
  beat: number;
  /** accent color for the crosshair (deck color / neutral) */
  accent: string;
}
```

Internal state: `fx: FxId`, `mode: "HOLD" | "LATCH"`, `point: {x,y} | null`,
`engaged: boolean`. Effect metadata (label, axis names, mapping fn, idle corner,
quantize flags) in a shared `src/audio/fx-map.ts`:

```ts
interface FxDef {
  id: FxId;
  label: string;
  xLabel: string; yLabel: string;
  /** map normalized pad coords to engine params + readout strings */
  apply: (engine: MixerEngine, target: FxTarget, x: number, y: number, beat: number)
    => { xReadout: string; yReadout: string };
  engage: (engine: MixerEngine, target: FxTarget) => void;
  release: (engine: MixerEngine, target: FxTarget) => void;
}
```

This keeps `XYPad.tsx` dumb (geometry + pointer + rendering) and puts the
audio knowledge in one table, parallel to `FX_PADS` in `CDJ.tsx`.

`App.tsx` owns `target` (defaulting to `activeDeck`) and passes `beat` from
`tracks[deckForTarget]?.analysis?.beatInterval ?? 60/128`, mirroring `CDJ.tsx`.

---

## 7. Visual / CSS

- New `.xy-pad` block in `App.css` consistent with the skeuomorphic console: inset
  brushed panel, faint grid (`repeating-linear-gradient`), glowing crosshair lines and
  puck using the deck-accent CSS var (`--knob-accent` pattern already in use).
- FX selector reuses `.pad-bank` / `.pad-grid` styling; active effect lit like the
  current `.on` state. HOLD/LATCH reuses the `.pad-bank.mini` toggle styling.
- Edge readouts in the existing `mono` face.

---

## 8. Implementation plan

1. **Scaffold UI (no audio):** `XYPad.tsx` + CSS, crosshair + pointer tracking +
   readouts, FX selector with FILTER/POWER only, HOLD/LATCH, target selector.
   Wire `point` → console.log. *(De-risks the interaction first.)*
2. **`fx-map.ts` + engine XY entry points** (`xyEngage/xySet/xyRelease`) wired to the
   **existing** effects: FILTER/POWER, ECHO, REVERB, GATER, ROLL. Ships a usable pad
   with zero new DSP.
3. **New DSP — phase 1:** SLICER (quantized gate), FLANGER, PHASER. Covers the brief's
   "fx, slicer, and all the fx dj.app supports" core.
4. **New DSP — phase 2:** BITCRUSH (new worklet), VIBRATO, PING-PONG.
5. **Master FX chain** + REVERSER + optional NOISE/RISER.
6. **Integration polish:** automix `resetStrip` clears latched XY FX; new-track load
   drops it; accessibility pass; record XY-FX use into the set log (optional).

Phases 1–2 already satisfy the brief; 3–6 complete the dj.app parity.

---

## 9. Open questions (for review)

1. **Placement** — mixer center column (always-on, compact) vs. dedicated/toggled FX
   panel (roomier)? *(Recommend: mixer center.)*
2. **Target default** — follow `activeDeck`, or a sticky manual A/B/MASTER selector?
3. **Multiple effects at once?** dj.app/Kaoss = one at a time. Recommend single-effect
   to start; the engine can already stack, so multi-FX is a later option.
4. **Master FX scope** — allow all effects on master, or a safe subset (filter, echo,
   reverb, bitcrush) to avoid surprises on the summed bus?
5. **Set recording** — should XY-FX performance be logged like transitions are?
6. **MIDI / hardware** — out of scope now, but the `xySet` API is MIDI-mappable later.
</content>
</invoke>

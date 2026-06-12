/**
 * MIDI control map. Each `MidiAction` is a thing the controller can drive on the
 * console; `apply` translates a decoded value into an engine/UI call via the
 * `MidiTargets` callbacks supplied by App.
 *
 * Continuous controls receive a normalised 0..1 value (`norm`) that is already
 * 14-bit-aware (see useMidi decoding), so the pitch slider resolves finely.
 * Jog actions receive a signed relative delta. Buttons fire once per press;
 * `hold` actions (FX pads) fire on both press and release.
 *
 * Note/CC numbers are NOT hardcoded — the user binds them by moving the control
 * (MIDI learn). Pad/loop/bank actions route into the existing CDJ deck controls.
 */

import { DeckId } from "../audio/engine";
import { PadBank } from "./deckControls";

/** Callbacks into the live console. Wired up in App.tsx. */
export interface MidiTargets {
  playPause(deck: DeckId): void;
  cue(deck: DeckId): void;
  setVolume(deck: DeckId, v: number): void; // 0..1 channel fader
  setTrim(deck: DeckId, v: number): void; // 0..1
  setEq(deck: DeckId, band: "low" | "mid" | "high", v: number): void; // 0..1
  setFilter(deck: DeckId, v: number): void; // 0..1, 0.5 = bypass
  setRate(deck: DeckId, rate: number): void; // playback rate factor
  setCrossfader(v: number): void; // 0..1
  nudge(deck: DeckId, dir: number): void; // jog: signed magnitude
  loadDeck(deck: DeckId): void;
  mixNow(): void;
  toggleAutomix(): void;
  // deck performance — routed to the CDJ component for that deck
  setBank(deck: DeckId, bank: PadBank): void; // CUE / LOOP / FX tab
  padInBank(deck: DeckId, bank: PadBank, index: number, pressed: boolean): void;
  autoLoop(deck: DeckId): void;
  loopHalve(deck: DeckId): void;
  loopDouble(deck: DeckId): void;
  sync(deck: DeckId): void;
}

/** the three pad banks, with the action-id slug + group used in the panel */
export const PAD_BANKS: { bank: PadBank; slug: string; label: string; kind: MidiKind }[] = [
  { bank: "CUE", slug: "cue", label: "HOT CUE", kind: "button" },
  { bank: "LOOP", slug: "loop", label: "LOOP", kind: "button" },
  { bank: "FX", slug: "fx", label: "FX", kind: "hold" },
];

/** the 8 pad action ids for a deck+bank, in pad order (used by row-learn) */
export const padIds = (deck: DeckId, slug: string): string[] =>
  Array.from({ length: 8 }, (_, i) => `pad.${slug}.${i + 1}.${deck}`);

/** How a control's value is interpreted. Drives the learn hint shown in the UI. */
export type MidiKind = "button" | "hold" | "abs" | "center" | "tempo" | "jog";

export interface MidiAction {
  id: string;
  label: string;
  group: string;
  kind: MidiKind;
  /**
   * `v` is: 0..1 norm for abs/center/tempo, a signed delta for jog, else a
   * press indicator. `pressed` is the button/pad edge (true=down, false=up).
   */
  apply: (t: MidiTargets, v: number, pressed: boolean) => void;
}

/** ±8% tempo range from a normalised 0..1 fader, centred (0.5) at unity. */
export const rateFromNorm = (n: number): number => 1 + (n - 0.5) * 0.16;

/** Relative 7-bit jog value → signed ticks (forward +, reverse −). */
export const jogDelta = (v: number): number => (v < 64 ? v : v - 128);

const deckActions = (d: DeckId): MidiAction[] => [
  { id: `play.${d}`, label: `Play / Pause ${d}`, group: "Transport", kind: "button", apply: (t) => t.playPause(d) },
  { id: `cue.${d}`, label: `Cue ${d} (to start)`, group: "Transport", kind: "button", apply: (t) => t.cue(d) },
  { id: `sync.${d}`, label: `Sync ${d}`, group: "Transport", kind: "button", apply: (t) => t.sync(d) },
  { id: `load.${d}`, label: `Load deck ${d}`, group: "Transport", kind: "button", apply: (t) => t.loadDeck(d) },
  { id: `jog.${d}`, label: `Jog wheel ${d} (nudge)`, group: "Transport", kind: "jog", apply: (t, v) => t.nudge(d, v) },
  { id: `vol.${d}`, label: `Channel fader ${d}`, group: "Mixer", kind: "abs", apply: (t, v) => t.setVolume(d, v) },
  { id: `trim.${d}`, label: `Trim / gain ${d}`, group: "Mixer", kind: "abs", apply: (t, v) => t.setTrim(d, v) },
  { id: `tempo.${d}`, label: `Pitch / tempo slider ${d}`, group: "Mixer", kind: "tempo", apply: (t, v) => t.setRate(d, rateFromNorm(v)) },
  { id: `eq.hi.${d}`, label: `EQ HI ${d}`, group: "EQ", kind: "center", apply: (t, v) => t.setEq(d, "high", v) },
  { id: `eq.mid.${d}`, label: `EQ MID ${d}`, group: "EQ", kind: "center", apply: (t, v) => t.setEq(d, "mid", v) },
  { id: `eq.low.${d}`, label: `EQ LOW ${d}`, group: "EQ", kind: "center", apply: (t, v) => t.setEq(d, "low", v) },
  { id: `filter.${d}`, label: `Filter / Color ${d}`, group: "EQ", kind: "center", apply: (t, v) => t.setFilter(d, v) },
  { id: `loop.auto.${d}`, label: `Auto loop ${d} (4 beat)`, group: "Loop", kind: "button", apply: (t) => t.autoLoop(d) },
  { id: `loop.half.${d}`, label: `Loop ½ ${d}`, group: "Loop", kind: "button", apply: (t) => t.loopHalve(d) },
  { id: `loop.double.${d}`, label: `Loop 2× ${d}`, group: "Loop", kind: "button", apply: (t) => t.loopDouble(d) },
  { id: `bank.cue.${d}`, label: `Pad bank → HOT CUE ${d}`, group: "Pad bank", kind: "button", apply: (t) => t.setBank(d, "CUE") },
  { id: `bank.loop.${d}`, label: `Pad bank → LOOP ${d}`, group: "Pad bank", kind: "button", apply: (t) => t.setBank(d, "LOOP") },
  { id: `bank.fx.${d}`, label: `Pad bank → FX ${d}`, group: "Pad bank", kind: "button", apply: (t) => t.setBank(d, "FX") },
  // one set of 8 pads per bank — the REV-5 sends distinct notes per mode
  ...PAD_BANKS.flatMap(({ bank, slug, label, kind }) =>
    Array.from({ length: 8 }, (_, i): MidiAction => ({
      id: `pad.${slug}.${i + 1}.${d}`,
      label: `${label} pad ${i + 1} ${d}`,
      group: "Pads",
      kind,
      apply: (t, _v, pressed) => t.padInBank(d, bank, i, pressed),
    }))
  ),
];

export const ACTIONS: MidiAction[] = [
  ...deckActions("A"),
  ...deckActions("B"),
  { id: "xfade", label: "Crossfader", group: "Mixer", kind: "abs", apply: (t, v) => t.setCrossfader(v) },
  { id: "mixnow", label: "MIX NOW", group: "Automix", kind: "button", apply: (t) => t.mixNow() },
  { id: "automix", label: "Toggle AUTOMIX", group: "Automix", kind: "button", apply: (t) => t.toggleAutomix() },
];

export const ACTION_BY_ID: Record<string, MidiAction> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a])
);

/** Generic-list groups for the panel. Pad-bank switches and performance pads
 *  are rendered in their own dedicated blocks (see MidiPanel), so they're not
 *  listed here. */
export const GROUPS = ["Loop", "Transport", "Mixer", "EQ", "Automix"] as const;

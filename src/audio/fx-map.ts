/**
 * XY-pad effect table. Each effect maps the pad's normalized (x, y) — origin
 * bottom-left — onto two engine parameters, and supplies engage/release for
 * the momentary (HOLD) / latched (LATCH) lifecycle. The component stays dumb
 * geometry; all the audio knowledge lives here, parallel to FX_PADS in CDJ.tsx.
 */
import { engine, DeckId, FxId } from "./engine";

export interface FxDef {
  id: FxId;
  label: string;
  xLabel: string;
  yLabel: string;
  /** rest position of the puck when the pad is idle */
  idle: { x: number; y: number };
  engage: (id: DeckId, x: number, y: number, beat: number) => void;
  /** continuous update; returns the two edge readouts */
  apply: (id: DeckId, x: number, y: number, beat: number) => { x: string; y: string };
  release: (id: DeckId, beat: number) => void;
}

/* ── helpers ─────────────────────────────────────────────── */

const pct = (v: number) => `${Math.round(v * 100)}%`;

const divLabel = (d: number) => (d >= 1 ? `${d}` : `1/${Math.round(1 / d)}`);

/** pick a value from an ordered list by a 0..1 position */
function pick<T>(v: number, arr: T[]): T {
  return arr[Math.max(0, Math.min(arr.length - 1, Math.floor(v * arr.length)))];
}

// musical divisions in beats, ordered so a higher axis value = the later entry
const TIME_UP = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]; // short → long
const RATE_UP = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16]; // slow → fast (higher = faster)
const SLICE = [1 / 2, 1 / 4, 1 / 8, 1 / 16]; // long → short
const ROLL = [1 / 4, 1 / 8, 1 / 16, 1 / 32]; // long → short

function filterReadout(y: number): string {
  if (Math.abs(y - 0.5) < 0.04) return "OPEN";
  return y < 0.5 ? "LP" : "HP";
}

/* ── effects ─────────────────────────────────────────────── */

export const FX_DEFS: FxDef[] = [
  {
    id: "filter",
    label: "FILTER",
    xLabel: "RESO",
    yLabel: "FILTER",
    idle: { x: 0, y: 0.5 },
    engage: () => {},
    apply: (id, x, y) => {
      engine.setFilterXY(id, y, x);
      return { x: pct(x), y: filterReadout(y) };
    },
    release: (id) => engine.clearFilterXY(id),
  },
  {
    id: "echo",
    label: "ECHO",
    xLabel: "FEEDBK",
    yLabel: "TIME",
    idle: { x: 0, y: 0.3 },
    engage: (id) => engine.rampDelayWet(id, 0.5, 0.05),
    apply: (id, x, y, beat) => {
      const div = pick(y, TIME_UP);
      engine.prepareDelay(id, div * beat, x * 0.75);
      return { x: pct(x), y: divLabel(div) };
    },
    release: (id) => engine.rampDelayWet(id, 0, 1.2),
  },
  {
    id: "reverb",
    label: "REVERB",
    xLabel: "WET",
    yLabel: "TONE",
    idle: { x: 0, y: 0 },
    engage: (id) => engine.setReverbCharacter(id, "bright"),
    apply: (id, x, y) => {
      engine.setReverbCharacter(id, y < 0.5 ? "bright" : "dark");
      engine.rampReverbWet(id, x * 0.7, 0.06);
      return { x: pct(x), y: y < 0.5 ? "BRIGHT" : "DARK" };
    },
    release: (id) => engine.rampReverbWet(id, 0, 1.2),
  },
  {
    id: "flanger",
    label: "FLANGER",
    xLabel: "DEPTH",
    yLabel: "RATE",
    idle: { x: 0, y: 0.3 },
    engage: (id) => engine.flangerEngage(id, true),
    apply: (id, x, y) => {
      const rate = 0.05 + y * 6;
      engine.setFlanger(id, x, rate);
      return { x: pct(x), y: `${rate.toFixed(1)}Hz` };
    },
    release: (id) => engine.flangerEngage(id, false),
  },
  {
    id: "phaser",
    label: "PHASER",
    xLabel: "DEPTH",
    yLabel: "RATE",
    idle: { x: 0, y: 0.3 },
    engage: (id) => engine.phaserEngage(id, true),
    apply: (id, x, y) => {
      const rate = 0.05 + y * 5;
      engine.setPhaser(id, x, rate);
      return { x: pct(x), y: `${rate.toFixed(1)}Hz` };
    },
    release: (id) => engine.phaserEngage(id, false),
  },
  {
    id: "gater",
    label: "GATER",
    xLabel: "DEPTH",
    yLabel: "RATE",
    idle: { x: 0, y: 0.5 },
    engage: () => {},
    apply: (id, x, y, beat) => {
      const div = pick(y, RATE_UP);
      engine.setGate(id, div * beat, 0.5, x * 0.95);
      return { x: pct(x), y: divLabel(div) };
    },
    release: (id) => engine.clearGate(id),
  },
  {
    id: "slicer",
    label: "SLICER",
    xLabel: "SLICE",
    yLabel: "DEPTH",
    idle: { x: 0.5, y: 0.6 },
    engage: () => {},
    apply: (id, x, y, beat) => {
      const div = pick(x, SLICE);
      engine.setGate(id, div * beat, 0.5, 0.6 + y * 0.4);
      return { x: divLabel(div), y: pct(y) };
    },
    release: (id) => engine.clearGate(id),
  },
  {
    id: "roll",
    label: "ROLL",
    xLabel: "LENGTH",
    yLabel: "—",
    idle: { x: 0.5, y: 0.5 },
    // beat-repeat slice is fixed at press time (slip roll)
    engage: (id, x, _y, beat) => engine.perfStutter(id, pick(x, ROLL) * beat, true),
    apply: (_id, x) => ({ x: divLabel(pick(x, ROLL)), y: "" }),
    release: (id) => engine.perfStutter(id, 0, false),
  },
  {
    id: "bitcrush",
    label: "CRUSH",
    xLabel: "BITS",
    yLabel: "WET",
    idle: { x: 0, y: 0 },
    engage: (id) => engine.bitcrushEngage(id, true),
    apply: (id, x, y) => {
      const bits = Math.round(16 - x * 14); // 16 → 2 bits
      engine.setBitcrush(id, bits, y);
      return { x: `${bits}b`, y: pct(y) };
    },
    release: (id) => engine.bitcrushEngage(id, false),
  },
];

export const FX_BY_ID: Record<FxId, FxDef> = Object.fromEntries(
  FX_DEFS.map((f) => [f.id, f])
) as Record<FxId, FxDef>;

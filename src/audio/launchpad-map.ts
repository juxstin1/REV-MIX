/**
 * Launchpad mapping model: the data types for a customizable layout, the
 * catalog of bindable actions (for the editor palette + inspector), surface
 * address helpers, and the default REV·MIX map. The runtime that executes a
 * binding lives in launchpad-runtime.ts.
 */
import { DeckId } from "./engine";
import { FX_DEFS } from "./fx-map";
import { hexTo7 } from "./launchpad";

export type LpRegion = "grid" | "top" | "bottom" | "left" | "right";
export type LpLightType = "static" | "flash" | "pulse";
export interface LpColor {
  r: number;
  g: number;
  b: number;
} // 0..127 device-native

export type LpActionId =
  | "none"
  | "deck.playPause"
  | "deck.cueJump"
  | "deck.sync"
  | "deck.select"
  | "cue.trigger"
  | "loop.toggle"
  | "fx.pad"
  | "xy.cell"
  | "xy.select"
  | "xy.target"
  | "xy.mode"
  | "mixer.filterStep"
  | "mixer.eqKill"
  | "mixer.xfade"
  | "page.select";

export interface LpBinding {
  region: LpRegion;
  num: number; // grid note 11..88 or edge CC
  action: LpActionId;
  params?: Record<string, string | number>;
  idle?: LpColor;
  active?: LpColor;
  light?: LpLightType;
  mode?: "momentary" | "toggle";
}

export interface LpPage {
  id: string;
  name: string;
  bindings: LpBinding[]; // sparse; unbound controls = off
}

export interface LpMapping {
  id: string;
  name: string;
  /** deck for deck-relative actions when a binding doesn't pin one */
  deck: DeckId | "active";
  pages: LpPage[];
}

/* ── palette ─────────────────────────────────────────────────── */

export const COL = {
  off: { r: 0, g: 0, b: 0 } as LpColor,
  dim: { r: 8, g: 8, b: 8 } as LpColor,
  acid: hexTo7("#c8ff3d"),
  ice: hexTo7("#5dd8ff"),
  pink: hexTo7("#ff5ec8"),
  amber: hexTo7("#ffc83d"),
  violet: hexTo7("#9d7bff"),
  mint: hexTo7("#5dffb0"),
  red: hexTo7("#ff5e5e"),
  white: hexTo7("#e8f0da"),
};

export const deckColor = (d: DeckId): LpColor => (d === "A" ? COL.acid : COL.ice);

/* ── surface addressing (row*10 + col) ──────────────────────── */

export const gridNotes: number[] = (() => {
  const out: number[] = [];
  for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) out.push(r * 10 + c);
  return out;
})();
export const topCCs = [91, 92, 93, 94, 95, 96, 97, 98];
export const bottomCCs = [1, 2, 3, 4, 5, 6, 7, 8];
export const leftCCs = [80, 70, 60, 50, 40, 30, 20, 10]; // top→bottom
export const rightCCs = [89, 79, 69, 59, 49, 39, 29, 19]; // top→bottom

/** note 11..88 → {col,row} 1..8, or null */
export function noteToXY(note: number): { col: number; row: number } | null {
  const col = note % 10;
  const row = Math.floor(note / 10);
  return col >= 1 && col <= 8 && row >= 1 && row <= 8 ? { col, row } : null;
}
export const xyToNote = (col: number, row: number) => row * 10 + col;

export function regionOf(num: number): LpRegion {
  if (noteToXY(num)) return "grid";
  if (topCCs.includes(num)) return "top";
  if (bottomCCs.includes(num)) return "bottom";
  if (leftCCs.includes(num)) return "left";
  return "right";
}

/* ── action catalog (for the editor palette + inspector) ───────── */

export interface LpParamSpec {
  key: string;
  label: string;
  kind: "deck" | "cueIndex" | "beats" | "fxKey" | "fxId" | "page" | "number" | "text";
  options?: { label: string; value: string | number }[];
  default?: string | number;
}
export interface LpActionDef {
  id: LpActionId;
  label: string;
  category: "Transport" | "Cue" | "Loop" | "FX" | "XY" | "Mixer" | "Surface";
  params?: LpParamSpec[];
  momentary?: boolean; // FX-style hold
}

const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const fxPadKeys = ["twist", "brake", "echo2", "echo4", "verb", "unison", "trem", "tiptip"];

export const ACTION_CATALOG: LpActionDef[] = [
  { id: "none", label: "— none —", category: "Surface" },
  {
    id: "deck.playPause",
    label: "Play / Pause",
    category: "Transport",
    params: [{ key: "deck", label: "Deck", kind: "deck", default: "active" }],
  },
  {
    id: "deck.sync",
    label: "Sync",
    category: "Transport",
    params: [{ key: "deck", label: "Deck", kind: "deck", default: "active" }],
  },
  {
    id: "deck.select",
    label: "Select Deck",
    category: "Transport",
    params: [{ key: "deck", label: "Deck", kind: "deck", default: "A" }],
  },
  {
    id: "cue.trigger",
    label: "Hot Cue",
    category: "Cue",
    params: [
      { key: "deck", label: "Deck", kind: "deck", default: "active" },
      { key: "index", label: "Cue #", kind: "cueIndex", default: 0 },
    ],
  },
  {
    id: "loop.toggle",
    label: "Auto-Loop",
    category: "Loop",
    params: [
      { key: "deck", label: "Deck", kind: "deck", default: "active" },
      {
        key: "beats",
        label: "Beats",
        kind: "beats",
        default: 4,
        options: LOOP_BEATS.map((b) => ({ label: String(b), value: b })),
      },
    ],
  },
  {
    id: "fx.pad",
    label: "Performance FX",
    category: "FX",
    momentary: true,
    params: [
      { key: "deck", label: "Deck", kind: "deck", default: "active" },
      {
        key: "key",
        label: "FX",
        kind: "fxKey",
        default: "echo2",
        options: fxPadKeys.map((k) => ({ label: k, value: k })),
      },
    ],
  },
  { id: "xy.cell", label: "XY field cell", category: "XY", momentary: true },
  {
    id: "xy.select",
    label: "XY effect select",
    category: "XY",
    params: [
      {
        key: "fx",
        label: "Effect",
        kind: "fxId",
        default: "filter",
        options: FX_DEFS.map((f) => ({ label: f.label, value: f.id })),
      },
    ],
  },
  {
    id: "xy.target",
    label: "XY deck target",
    category: "XY",
    params: [{ key: "deck", label: "Deck", kind: "deck", default: "A" }],
  },
  {
    id: "xy.mode",
    label: "XY lock toggle",
    category: "XY",
  },
  {
    id: "mixer.filterStep",
    label: "Filter step",
    category: "Mixer",
    params: [
      { key: "deck", label: "Deck", kind: "deck", default: "active" },
      { key: "value", label: "0..1", kind: "number", default: 0.5 },
    ],
  },
  {
    id: "mixer.eqKill",
    label: "EQ kill (hold)",
    category: "Mixer",
    momentary: true,
    params: [
      { key: "deck", label: "Deck", kind: "deck", default: "active" },
      {
        key: "band",
        label: "Band",
        kind: "text",
        default: "low",
        options: [
          { label: "low", value: "low" },
          { label: "mid", value: "mid" },
          { label: "high", value: "high" },
        ],
      },
    ],
  },
  {
    id: "page.select",
    label: "Select Page",
    category: "Surface",
    params: [{ key: "page", label: "Page #", kind: "page", default: 0 }],
  },
];

export const ACTION_BY_ID: Record<LpActionId, LpActionDef> = Object.fromEntries(
  ACTION_CATALOG.map((a) => [a.id, a])
) as Record<LpActionId, LpActionDef>;

/* ── default REV·MIX map ─────────────────────────────────────── */

const CUE_COLORS = [COL.acid, COL.ice, COL.pink, COL.amber, COL.violet, COL.mint, COL.white, COL.red];

function performPage(): LpPage {
  const b: LpBinding[] = [];
  // rows 8 & 7 (notes 81..88, 71..78): 8 + 8 hot cues for the active deck
  [8, 7].forEach((row, ri) =>
    bottomRange(row).forEach((note, ci) => {
      const idx = ri * 8 + ci;
      b.push({
        region: "grid",
        num: note,
        action: "cue.trigger",
        params: { deck: "active", index: idx },
        idle: dimOf(CUE_COLORS[ci]),
        active: CUE_COLORS[ci],
      });
    })
  );
  // rows 6 & 5 (61..68, 51..58): auto-loops ¼..32
  [6, 5].forEach((row, ri) =>
    bottomRange(row).forEach((note, ci) => {
      const beats = LOOP_BEATS[ri * 8 + ci] ?? 4;
      b.push({
        region: "grid",
        num: note,
        action: "loop.toggle",
        params: { deck: "active", beats },
        idle: dimOf(COL.mint),
        active: COL.mint,
        mode: "toggle",
      });
    })
  );
  // rows 4 & 3 (41..48): performance FX pads (8) on row 4; row 3 spare
  bottomRange(4).forEach((note, ci) => {
    const key = fxPadKeys[ci];
    b.push({
      region: "grid",
      num: note,
      action: "fx.pad",
      params: { deck: "active", key },
      idle: dimOf(COL.violet),
      active: COL.violet,
      mode: "momentary",
    });
  });
  // top edge: page selectors
  b.push({ region: "top", num: 91, action: "page.select", params: { page: 0 }, idle: dimOf(COL.white), active: COL.white });
  b.push({ region: "top", num: 92, action: "page.select", params: { page: 1 }, idle: dimOf(COL.amber), active: COL.amber });
  b.push({ region: "top", num: 93, action: "page.select", params: { page: 2 }, idle: dimOf(COL.ice), active: COL.ice });
  // left edge: deck A transport; right edge: deck B transport
  b.push({ region: "left", num: 80, action: "deck.playPause", params: { deck: "A" }, idle: dimOf(COL.acid), active: COL.acid });
  b.push({ region: "left", num: 70, action: "deck.sync", params: { deck: "A" }, idle: dimOf(COL.acid), active: COL.acid });
  b.push({ region: "left", num: 60, action: "deck.select", params: { deck: "A" }, idle: dimOf(COL.acid), active: COL.acid });
  b.push({ region: "right", num: 89, action: "deck.playPause", params: { deck: "B" }, idle: dimOf(COL.ice), active: COL.ice });
  b.push({ region: "right", num: 79, action: "deck.sync", params: { deck: "B" }, idle: dimOf(COL.ice), active: COL.ice });
  b.push({ region: "right", num: 69, action: "deck.select", params: { deck: "B" }, idle: dimOf(COL.ice), active: COL.ice });
  return { id: "perform", name: "PERFORM", bindings: b };
}

function xyPage(): LpPage {
  const b: LpBinding[] = [];
  // bottom row (row 1 = notes 11..18) is the lock bar
  bottomRange(1).forEach((note) =>
    b.push({ region: "grid", num: note, action: "xy.mode", idle: dimOf(COL.red), active: COL.mint })
  );
  // field rows 2..8 = XY cells
  for (let row = 2; row <= 8; row++)
    bottomRange(row).forEach((note) =>
      b.push({ region: "grid", num: note, action: "xy.cell", idle: COL.dim, active: COL.acid, mode: "momentary" })
    );
  // top edge: effect selector (first 8 of FX_DEFS)
  FX_DEFS.slice(0, 8).forEach((f, i) =>
    b.push({ region: "top", num: topCCs[i], action: "xy.select", params: { fx: f.id }, idle: dimOf(COL.white), active: COL.acid })
  );
  // left = target deck A, right = target deck B
  b.push({ region: "left", num: 80, action: "xy.target", params: { deck: "A" }, idle: dimOf(COL.acid), active: COL.acid });
  b.push({ region: "right", num: 89, action: "xy.target", params: { deck: "B" }, idle: dimOf(COL.ice), active: COL.ice });
  // page selectors on top-right corner
  b.push({ region: "top", num: 98, action: "page.select", params: { page: 0 }, idle: dimOf(COL.white), active: COL.white });
  return { id: "xy", name: "XY FX", bindings: b };
}

function mixPage(): LpPage {
  const b: LpBinding[] = [];
  // rows 8..5 left half deck A filter steps; right half deck B
  for (let row = 5; row <= 8; row++) {
    bottomRange(row).forEach((note, ci) => {
      const deck: DeckId = ci < 4 ? "A" : "B";
      const value = (ci % 4) / 3; // 0,0.33,0.66,1 → LP..HP-ish
      b.push({
        region: "grid",
        num: note,
        action: "mixer.filterStep",
        params: { deck, value: 0.5 - 0.5 * value },
        idle: dimOf(deckColor(deck)),
        active: deckColor(deck),
      });
    });
  }
  // rows 4..3: EQ kills (low/mid/high) per deck
  const bands = ["low", "mid", "high"];
  [4, 3].forEach((row) =>
    bottomRange(row).forEach((note, ci) => {
      const deck: DeckId = ci < 4 ? "A" : "B";
      const band = bands[ci % 3];
      b.push({
        region: "grid",
        num: note,
        action: "mixer.eqKill",
        params: { deck, band },
        idle: dimOf(COL.amber),
        active: COL.red,
        mode: "momentary",
      });
    })
  );
  b.push({ region: "top", num: 91, action: "page.select", params: { page: 0 }, idle: dimOf(COL.white), active: COL.white });
  return { id: "mix", name: "MIX", bindings: b };
}

/** notes for a given grid row (1..8), left→right */
function bottomRange(row: number): number[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((c) => row * 10 + c);
}

/** a dimmed version of a colour for the idle LED state */
export function dimOf(c: LpColor): LpColor {
  return { r: Math.round(c.r * 0.18), g: Math.round(c.g * 0.18), b: Math.round(c.b * 0.18) };
}

export function defaultMapping(): LpMapping {
  return {
    id: "default",
    name: "REV·MIX Default",
    deck: "active",
    pages: [performPage(), xyPage(), mixPage()],
  };
}

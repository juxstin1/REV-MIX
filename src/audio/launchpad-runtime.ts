/**
 * Launchpad runtime: turns hardware input into REV·MIX actions and computes the
 * LED frame from live app state. Reuses the same engine/fx-map paths the UI uses,
 * so a hardware pad and an on-screen control drive one signal path.
 */
import { engine, DeckId, FxId } from "./engine";
import { FX_BY_ID } from "./fx-map";
import { LpInputEvent, LedSpec, launchpad } from "./launchpad";
import { XYEngine, XYConfig } from "./launchpad-xy";
import {
  LpMapping,
  LpBinding,
  LpColor,
  COL,
  noteToXY,
  xyToNote,
} from "./launchpad-map";

const FX_PAD_KEYS = ["twist", "brake", "echo2", "echo4", "verb", "unison", "trem", "tiptip"] as const;
type FxPadKey = (typeof FX_PAD_KEYS)[number];

// the engage/release pairs from CDJ's FX_PADS, expressed against the engine
const FX_PAD_FN: Record<FxPadKey, { on: (id: DeckId, beat: number) => void; off: (id: DeckId, beat: number) => void }> = {
  twist: { on: (id) => engine.perfTwister(id, true), off: (id) => engine.perfTwister(id, false) },
  brake: { on: (id) => engine.perfBrake(id, true), off: (id) => engine.perfBrake(id, false) },
  echo2: { on: (id, b) => engine.perfEcho(id, b, 0.5, true), off: (id, b) => engine.perfEcho(id, b, 0.5, false) },
  echo4: { on: (id, b) => engine.perfEcho(id, b, 0.25, true), off: (id, b) => engine.perfEcho(id, b, 0.25, false) },
  verb: { on: (id) => engine.perfReverb(id, true), off: (id) => engine.perfReverb(id, false) },
  unison: { on: (id) => engine.perfUnison(id, true), off: (id) => engine.perfUnison(id, false) },
  trem: { on: (id, b) => engine.perfTremolo(id, 2 / b, true), off: (id, b) => engine.perfTremolo(id, 2 / b, false) },
  tiptip: { on: (id, b) => engine.perfStutter(id, b / 4, true), off: (id) => engine.perfStutter(id, 0, false) },
};

export interface LpHost {
  getActiveDeck(): DeckId;
  setActiveDeck(d: DeckId): void;
  beatFor(d: DeckId): number;
  playPause(d: DeckId): void;
  sync?(d: DeckId): void;
}

const OFF: LpColor = COL.off;

export class LaunchpadRuntime {
  mapping: LpMapping;
  page = 0;
  bridgeEnabled = false;
  private host: LpHost;

  // per-deck performance state owned by the surface
  private cues: Record<DeckId, (number | null)[]> = { A: Array(16).fill(null), B: Array(16).fill(null) };
  private loops: Record<DeckId, number | null> = { A: null, B: null };
  private heldFx = new Set<string>(); // `${deck}:${key}`

  // XY
  xy: XYEngine;
  xyFx: FxId = "filter";
  xyDeck: DeckId = "A";
  private xyLast = { x: 0, y: 0.5 };
  private xyCross: { col: number; row: number } | null = null;

  constructor(mapping: LpMapping, host: LpHost, xyCfg?: Partial<XYConfig>) {
    this.mapping = mapping;
    this.host = host;
    this.xy = new XYEngine(
      {
        onEngage: () => FX_BY_ID[this.xyFx].engage(this.xyDeck, this.xyLast.x, this.xyLast.y, this.beat(this.xyDeck)),
        onChange: (x, y) => {
          this.xyLast = { x, y };
          FX_BY_ID[this.xyFx].apply(this.xyDeck, x, y, this.beat(this.xyDeck));
        },
        onRelease: () => FX_BY_ID[this.xyFx].release(this.xyDeck, this.beat(this.xyDeck)),
        onBridge: (x7, y7, z7) => {
          if (!this.bridgeEnabled) return;
          launchpad.bridgeCc(16, x7);
          launchpad.bridgeCc(17, y7);
          launchpad.bridgeCc(18, z7);
        },
        onCrosshair: (cell) => (this.xyCross = cell),
      },
      xyCfg
    );
  }

  private beat(d: DeckId) {
    return this.host.beatFor(d);
  }

  setMapping(m: LpMapping) {
    this.mapping = m;
    this.page = Math.min(this.page, m.pages.length - 1);
  }
  setPage(i: number) {
    if (i === this.page) return;
    this.xy.reset();
    this.page = Math.max(0, Math.min(this.mapping.pages.length - 1, i));
  }

  private currentBindings(): LpBinding[] {
    return this.mapping.pages[this.page]?.bindings ?? [];
  }
  private bindingFor(num: number): LpBinding | undefined {
    return this.currentBindings().find((b) => b.num === num);
  }

  private resolveDeck(p?: Record<string, string | number>): DeckId {
    const d = p?.deck;
    if (d === "A" || d === "B") return d;
    return this.host.getActiveDeck();
  }

  /* ── input dispatch ──────────────────────────────────────── */

  handleInput(e: LpInputEvent) {
    // aftertouch drives the XY Z axis regardless of binding
    if (e.kind === "aftertouch" || e.kind === "pressure") {
      this.xy.pressure(e.val);
      return;
    }
    const down = e.kind === "note_on" || (e.kind === "cc" && e.val > 0);
    const up = e.kind === "note_off" || (e.kind === "cc" && e.val === 0);
    const b = this.bindingFor(e.num);
    if (!b) return;

    switch (b.action) {
      case "deck.playPause":
        if (down) this.host.playPause(this.resolveDeck(b.params));
        break;
      case "deck.sync":
        if (down) this.host.sync?.(this.resolveDeck(b.params));
        break;
      case "deck.select":
        if (down) this.host.setActiveDeck(this.resolveDeck(b.params));
        break;
      case "cue.trigger":
        if (down) this.cueTrigger(this.resolveDeck(b.params), Number(b.params?.index ?? 0));
        break;
      case "loop.toggle":
        if (down) this.loopToggle(this.resolveDeck(b.params), Number(b.params?.beats ?? 4));
        break;
      case "fx.pad":
        this.fxPad(this.resolveDeck(b.params), String(b.params?.key ?? "echo2") as FxPadKey, down, up);
        break;
      case "xy.cell":
        if (down) this.xy.press(e.num);
        else if (up) this.xy.release(e.num);
        break;
      case "xy.select":
        if (down) this.xySelect(String(b.params?.fx ?? "filter") as FxId);
        break;
      case "xy.target":
        if (down) this.xyTarget(this.resolveDeck(b.params));
        break;
      case "xy.mode":
        if (down) this.xy.toggleLock();
        break;
      case "mixer.filterStep":
        if (down) engine.setFilter(this.resolveDeck(b.params), Number(b.params?.value ?? 0.5));
        break;
      case "mixer.eqKill":
        this.eqKill(this.resolveDeck(b.params), String(b.params?.band ?? "low") as "low" | "mid" | "high", down, up);
        break;
      case "page.select":
        if (down) this.setPage(Number(b.params?.page ?? 0));
        break;
    }
  }

  private cueTrigger(deck: DeckId, idx: number) {
    const store = this.cues[deck];
    if (store[idx] == null) {
      store[idx] = engine.position(deck);
    } else {
      if (this.loops[deck] != null) {
        engine.clearLoop(deck);
        this.loops[deck] = null;
      }
      engine.seek(deck, store[idx]!);
      if (!engine.decks[deck].playing) this.host.playPause(deck);
    }
  }

  private loopToggle(deck: DeckId, beats: number) {
    if (this.loops[deck] === beats) {
      engine.clearLoop(deck);
      this.loops[deck] = null;
      return;
    }
    engine.setLoop(deck, engine.position(deck), beats * this.beat(deck));
    this.loops[deck] = beats;
  }

  private fxPad(deck: DeckId, key: FxPadKey, down: boolean, up: boolean) {
    const fn = FX_PAD_FN[key];
    const k = `${deck}:${key}`;
    if (down && !this.heldFx.has(k)) {
      fn.on(deck, this.beat(deck));
      this.heldFx.add(k);
    } else if (up && this.heldFx.has(k)) {
      fn.off(deck, this.beat(deck));
      this.heldFx.delete(k);
    }
  }

  private eqKill(deck: DeckId, band: "low" | "mid" | "high", down: boolean, up: boolean) {
    const k = `${deck}:eq${band}`;
    if (down && !this.heldFx.has(k)) {
      engine.setEq(deck, band, 0);
      this.heldFx.add(k);
    } else if (up && this.heldFx.has(k)) {
      engine.setEq(deck, band, 0.5);
      this.heldFx.delete(k);
    }
  }

  private xySelect(fx: FxId) {
    if (fx === this.xyFx) return;
    if (this.xy.isEngaged) FX_BY_ID[this.xyFx].release(this.xyDeck, this.beat(this.xyDeck));
    this.xyFx = fx;
    if (this.xy.isEngaged) {
      FX_BY_ID[fx].engage(this.xyDeck, this.xyLast.x, this.xyLast.y, this.beat(this.xyDeck));
      FX_BY_ID[fx].apply(this.xyDeck, this.xyLast.x, this.xyLast.y, this.beat(this.xyDeck));
    }
  }

  private xyTarget(deck: DeckId) {
    if (deck === this.xyDeck) return;
    if (this.xy.isEngaged) FX_BY_ID[this.xyFx].release(this.xyDeck, this.beat(this.xyDeck));
    this.xyDeck = deck;
    if (this.xy.isEngaged) FX_BY_ID[this.xyFx].engage(deck, this.xyLast.x, this.xyLast.y, this.beat(deck));
  }

  /* ── LED frame ───────────────────────────────────────────── */

  /** full frame for the current page; unbound controls render off */
  renderFrame(): LedSpec[] {
    const frame: LedSpec[] = [];
    const seen = new Set<number>();
    for (const b of this.currentBindings()) {
      seen.add(b.num);
      frame.push({ index: b.num, ...this.colorFor(b) });
    }
    // clear any addressable control not bound on this page
    for (const n of ALL_INDICES) if (!seen.has(n)) frame.push({ index: n, r: 0, g: 0, b: 0 });
    return frame;
  }

  private colorFor(b: LpBinding): LpColor {
    const on = b.active ?? COL.white;
    const idle = b.idle ?? OFF;
    switch (b.action) {
      case "deck.playPause":
        return engine.decks[this.resolveDeck(b.params)].playing ? on : idle;
      case "loop.toggle":
        return this.loops[this.resolveDeck(b.params)] === Number(b.params?.beats) ? on : idle;
      case "fx.pad":
        return this.heldFx.has(`${this.resolveDeck(b.params)}:${b.params?.key}`) ? on : idle;
      case "mixer.eqKill":
        return this.heldFx.has(`${this.resolveDeck(b.params)}:eq${b.params?.band}`) ? on : idle;
      case "xy.select":
        return this.xyFx === b.params?.fx ? on : idle;
      case "xy.target":
        return this.xyDeck === this.resolveDeck(b.params) ? on : idle;
      case "xy.mode":
        return this.xy.latched ? COL.mint : idle; // green locked / dim-red unlocked
      case "page.select":
        return this.page === Number(b.params?.page) ? on : idle;
      case "xy.cell": {
        const xy = noteToXY(b.num);
        if (!this.xyCross || !xy) return idle;
        if (xy.col === this.xyCross.col && xy.row === this.xyCross.row) return COL.amber; // cursor
        if (xy.col === this.xyCross.col || xy.row === this.xyCross.row) return on; // crosshair
        return idle;
      }
      default:
        return idle;
    }
  }

  /** drop everything (page change / disconnect): release latched FX too */
  panic() {
    this.xy.reset();
    for (const k of this.heldFx) {
      const [deck, key] = k.split(":");
      if (key.startsWith("eq")) engine.setEq(deck as DeckId, key.slice(2) as "low" | "mid" | "high", 0.5);
      else FX_PAD_FN[key as FxPadKey]?.off(deck as DeckId, this.beat(deck as DeckId));
    }
    this.heldFx.clear();
  }
}

/** every addressable control index for clear-all frames */
const ALL_INDICES: number[] = (() => {
  const out: number[] = [];
  for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) out.push(xyToNote(c, r));
  out.push(91, 92, 93, 94, 95, 96, 97, 98, 1, 2, 3, 4, 5, 6, 7, 8);
  for (let r = 1; r <= 8; r++) out.push(r * 10, r * 10 + 9);
  return out;
})();

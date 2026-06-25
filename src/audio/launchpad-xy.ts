/**
 * XY-on-the-grid engine — ports tools/xy_fx_bridge.py into the app.
 *
 *  - Tracks every grid pad under the finger and aims at the CENTROID, so a
 *    finger straddling pads lands between them (sub-pad resolution).
 *  - Per-axis EMA glide on a rAF loop: snappy X (filter), syrupier Y (echo),
 *    with a snap-when-close rule so values settle dead-on, not crawling.
 *  - Lock/freeze: unlocked lift releases; locked lift freezes X/Y/Z hands-free.
 *  - Pressure (aftertouch) → Z, only while a finger is down.
 *
 * It is UI-agnostic: callbacks wire it to fx-map (internal) and/or the external
 * MIDI bridge. The runtime owns one instance.
 */
import { noteToXY } from "./launchpad-map";

export interface XYConfig {
  glideX: number; // 0..0.97 (0 = instant/snappy)
  glideY: number;
  glideZ: number;
  fieldRowMin: number; // 1 = full field (corner-pad lock), 2 = bottom-row lock bar
}

export interface XYCallbacks {
  onEngage: () => void;
  onChange: (x: number, y: number, z: number) => void;
  onRelease: () => void;
  /** fired on every settled change for the external DJ-app bridge (0..127) */
  onBridge?: (x7: number, y7: number, z7: number) => void;
  /** crosshair moved — repaint LEDs ({col,row} 1..8, or null when cleared) */
  onCrosshair: (cell: { col: number; row: number } | null) => void;
}

export class XYEngine {
  cfg: XYConfig = { glideX: 0.3, glideY: 0.6, glideZ: 0.4, fieldRowMin: 2 };
  private cb: XYCallbacks;

  private held = new Set<number>(); // grid notes under the finger
  latched = false;
  frozen = false;
  private engaged = false;

  private tx = 0;
  private ty = 0;
  private tz = 0; // targets
  private cx = 0;
  private cy = 0;
  private cz = 0; // current (glided)
  private raf = 0;
  private last7 = [-1, -1, -1];

  constructor(cb: XYCallbacks, cfg?: Partial<XYConfig>) {
    this.cb = cb;
    if (cfg) this.cfg = { ...this.cfg, ...cfg };
  }

  setConfig(cfg: Partial<XYConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  /** is a note part of the playable field (above the lock bar)? */
  private inField(note: number): boolean {
    const xy = noteToXY(note);
    return !!xy && xy.row >= this.cfg.fieldRowMin;
  }

  press(note: number) {
    if (!this.inField(note)) return;
    this.frozen = false;
    if (!this.engaged) {
      this.engaged = true;
      this.cb.onEngage();
    }
    this.held.add(note);
    this.aim();
    this.ensureLoop();
  }

  release(note: number) {
    if (!this.held.delete(note)) return;
    if (this.held.size > 0) {
      this.aim();
      return;
    }
    if (this.latched) {
      this.frozen = true; // freeze X/Y/Z, keep crosshair lit
    } else {
      this.engaged = false;
      this.tz = 0;
      this.cb.onRelease();
      this.cb.onCrosshair(null);
    }
  }

  /** poly/channel pressure → Z, only while a finger is down */
  pressure(val: number) {
    if (this.held.size > 0) this.tz = Math.max(0, Math.min(1, val / 127));
  }

  /** lock bar / corner pad toggled. Guarded against mid-drag accidents. */
  toggleLock(): "locked" | "unlocked" | "released" {
    if (this.held.size > 0) return this.latched ? "locked" : "unlocked"; // ignore mid-drag
    if (this.latched && this.frozen) {
      // unlocking a frozen hold releases it
      this.latched = false;
      this.frozen = false;
      this.engaged = false;
      this.tz = 0;
      this.cb.onRelease();
      this.cb.onCrosshair(null);
      return "released";
    }
    this.latched = !this.latched;
    return this.latched ? "locked" : "unlocked";
  }

  /** centroid of held pads → targets + crosshair */
  private aim() {
    let sc = 0;
    let sr = 0;
    for (const n of this.held) {
      const xy = noteToXY(n)!;
      sc += xy.col;
      sr += xy.row;
    }
    const col = sc / this.held.size;
    const row = sr / this.held.size;
    const rmin = this.cfg.fieldRowMin;
    this.tx = (col - 1) / 7;
    this.ty = (row - rmin) / (8 - rmin);
    this.cb.onCrosshair({ col: Math.round(col), row: Math.round(row) });
  }

  private ensureLoop() {
    if (this.raf || typeof requestAnimationFrame === "undefined") {
      if (typeof requestAnimationFrame === "undefined") this.tick(); // test/no-raf
      return;
    }
    const step = () => {
      const settled = this.tick();
      if (settled && !this.engaged) {
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** one glide step; returns true when fully settled */
  private tick(): boolean {
    const ax = this.cfg.glideX <= 0 ? 1 : 1 - this.cfg.glideX;
    const ay = this.cfg.glideY <= 0 ? 1 : 1 - this.cfg.glideY;
    const az = this.cfg.glideZ <= 0 ? 1 : 1 - this.cfg.glideZ;
    this.cx += ax * (this.tx - this.cx);
    this.cy += ay * (this.ty - this.cy);
    this.cz += az * (this.tz - this.cz);
    const snap = 0.5 / 127;
    if (Math.abs(this.tx - this.cx) < snap) this.cx = this.tx;
    if (Math.abs(this.ty - this.cy) < snap) this.cy = this.ty;
    if (Math.abs(this.tz - this.cz) < snap) this.cz = this.tz;

    this.cb.onChange(this.cx, this.cy, this.cz);
    const x7 = Math.round(this.cx * 127);
    const y7 = Math.round(this.cy * 127);
    const z7 = Math.round(this.cz * 127);
    if (this.cb.onBridge && (x7 !== this.last7[0] || y7 !== this.last7[1] || z7 !== this.last7[2])) {
      this.cb.onBridge(x7, y7, z7);
      this.last7 = [x7, y7, z7];
    }
    return this.cx === this.tx && this.cy === this.ty && this.cz === this.tz;
  }

  /** stop everything (page switch / disconnect) */
  reset() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.held.clear();
    if (this.engaged) this.cb.onRelease();
    this.engaged = false;
    this.frozen = false;
    this.cb.onCrosshair(null);
  }

  get isEngaged() {
    return this.engaged;
  }
}

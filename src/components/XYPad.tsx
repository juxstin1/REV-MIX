import { useCallback, useEffect, useRef, useState } from "react";
import { DeckId, FxId } from "../audio/engine";
import { FX_DEFS, FX_BY_ID } from "../audio/fx-map";

interface XYPadProps {
  /** which deck the pad defaults to (follows the active deck) */
  defaultTarget: DeckId;
  /** beat interval (s) per deck, for tempo-synced effects */
  beats: Record<DeckId, number>;
}

const ACCENT: Record<DeckId, string> = { A: "#c8ff3d", B: "#5dd8ff" };

/**
 * Kaoss-style XY FX pad. Finger position drives two effect parameters at
 * once (X / Y) over a live crosshair; the FX selector underneath picks which
 * effect performs. HOLD = momentary (release on lift), LATCH = stays on.
 */
export function XYPad({ defaultTarget, beats }: XYPadProps) {
  const [fx, setFx] = useState<FxId>("filter");
  const [mode, setMode] = useState<"HOLD" | "LATCH">("HOLD");
  const [target, setTarget] = useState<DeckId>(defaultTarget);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [readout, setReadout] = useState<{ x: string; y: string }>({ x: "", y: "" });

  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // live snapshot for the window pointer handlers
  const live = useRef({ fx, mode, target, engaged });
  live.current = { fx, mode, target, engaged };

  const def = FX_BY_ID[fx];
  const accent = ACCENT[target];

  const coords = (e: PointerEvent | React.PointerEvent) => {
    const r = surfaceRef.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); // origin bottom-left
    return { x, y };
  };

  const engageAt = useCallback(
    (x: number, y: number) => {
      const d = FX_BY_ID[live.current.fx];
      const tg = live.current.target;
      const b = beats[tg];
      d.engage(tg, x, y, b);
      setReadout(d.apply(tg, x, y, b));
      setPoint({ x, y });
      setEngaged(true);
    },
    [beats]
  );

  const updateAt = useCallback(
    (x: number, y: number) => {
      const d = FX_BY_ID[live.current.fx];
      const tg = live.current.target;
      setReadout(d.apply(tg, x, y, beats[tg]));
      setPoint({ x, y });
    },
    [beats]
  );

  const release = useCallback(() => {
    const d = FX_BY_ID[live.current.fx];
    const tg = live.current.target;
    d.release(tg, beats[tg]);
    setEngaged(false);
    setPoint(null);
  }, [beats]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    const { x, y } = coords(e);
    if (live.current.engaged) updateAt(x, y);
    else engageAt(x, y);
  };

  // window-level drag so the move continues outside the surface bounds
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const { x, y } = coords(e);
      updateAt(x, y);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (live.current.mode === "HOLD" && live.current.engaged) release();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [updateAt, release]);

  // release whatever is engaged on unmount
  useEffect(() => () => release(), [release]);

  /** swap effect (or target) without leaving the old one stuck on */
  const switchTo = (next: { fx?: FxId; target?: DeckId }) => {
    const curFx = live.current.fx;
    const curTg = live.current.target;
    if (live.current.engaged) FX_BY_ID[curFx].release(curTg, beats[curTg]);
    const nextFx = next.fx ?? curFx;
    const nextTg = next.target ?? curTg;
    if (live.current.engaged && point) {
      const d = FX_BY_ID[nextFx];
      d.engage(nextTg, point.x, point.y, beats[nextTg]);
      setReadout(d.apply(nextTg, point.x, point.y, beats[nextTg]));
    }
    if (next.fx) setFx(next.fx);
    if (next.target) setTarget(next.target);
  };

  const toHold = () => {
    if (mode === "HOLD") return;
    if (engaged) release();
    setMode("HOLD");
  };

  const puck = point ?? def.idle;

  return (
    <div className="xy-pad" style={{ "--xy-accent": accent } as React.CSSProperties}>
      <div className="xy-head">
        <span className="xy-title mono">XY FX</span>
        <div className="xy-target">
          {(["A", "B"] as DeckId[]).map((t) => (
            <button
              key={t}
              className={`xy-tbtn mono${target === t ? " on" : ""}`}
              style={{ "--xy-accent": ACCENT[t] } as React.CSSProperties}
              onClick={() => switchTo({ target: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="xy-stage">
        <span className="xy-axis-y mono">{def.yLabel}</span>
        <div
          ref={surfaceRef}
          className={`xy-surface${engaged ? " live" : ""}`}
          onPointerDown={onPointerDown}
          role="application"
          aria-label={`XY FX ${def.label}, X ${def.xLabel} ${readout.x}, Y ${def.yLabel} ${readout.y}`}
        >
          <div className="xy-grid" />
          <div className="xy-cross-h" style={{ bottom: `${puck.y * 100}%` }} />
          <div className="xy-cross-v" style={{ left: `${puck.x * 100}%` }} />
          <div
            className={`xy-puck${engaged ? " on" : ""}`}
            style={{ left: `${puck.x * 100}%`, bottom: `${puck.y * 100}%` }}
          />
          {engaged && (
            <>
              <span className="xy-read xy-read-x mono">{readout.x}</span>
              {readout.y && <span className="xy-read xy-read-y mono">{readout.y}</span>}
            </>
          )}
        </div>
        <span className="xy-axis-x mono">{def.xLabel}</span>
      </div>

      <div className="xy-modes">
        <button className={`xy-mode mono${mode === "HOLD" ? " on" : ""}`} onClick={toHold}>
          HOLD
        </button>
        <button className={`xy-mode mono${mode === "LATCH" ? " on" : ""}`} onClick={() => setMode("LATCH")}>
          LATCH
        </button>
        {mode === "LATCH" && engaged && (
          <button className="xy-mode mono xy-kill" onClick={release}>
            KILL
          </button>
        )}
      </div>

      <div className="xy-fx-grid">
        {FX_DEFS.map((d) => (
          <button
            key={d.id}
            className={`xy-fx-btn mono${fx === d.id ? " on" : ""}`}
            onClick={() => switchTo({ fx: d.id })}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

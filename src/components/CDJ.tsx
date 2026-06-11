import { useCallback, useEffect, useRef, useState } from "react";
import { engine, DeckId } from "../audio/engine";
import { LoadedTrack } from "../types";

interface CDJProps {
  id: DeckId;
  track: LoadedTrack | null;
  /** what's on the other deck — used by SYNC */
  otherTrack: LoadedTrack | null;
  playing: boolean;
  getPosition: () => number;
}

type PadBank = "CUE" | "LOOP" | "FX";

const LOOP_SIZES = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

function loopLabel(beats: number): string {
  if (beats === 0.25) return "¼";
  if (beats === 0.5) return "½";
  return String(beats);
}

interface FxPad {
  key: string;
  label: string;
  engage: (id: DeckId, beat: number) => void;
  release: (id: DeckId, beat: number) => void;
}

const FX_PADS: FxPad[] = [
  {
    key: "twist",
    label: "TWIST",
    engage: (id) => engine.perfTwister(id, true),
    release: (id) => engine.perfTwister(id, false),
  },
  {
    key: "brake",
    label: "V.BRAKE",
    engage: (id) => engine.perfBrake(id, true),
    release: (id) => engine.perfBrake(id, false),
  },
  {
    key: "echo2",
    label: "ECHO ½",
    engage: (id, beat) => engine.perfEcho(id, beat, 0.5, true),
    release: (id, beat) => engine.perfEcho(id, beat, 0.5, false),
  },
  {
    key: "echo4",
    label: "ECHO ¼",
    engage: (id, beat) => engine.perfEcho(id, beat, 0.25, true),
    release: (id, beat) => engine.perfEcho(id, beat, 0.25, false),
  },
  {
    key: "verb",
    label: "REVERB",
    engage: (id) => engine.perfReverb(id, true),
    release: (id) => engine.perfReverb(id, false),
  },
  {
    key: "unison",
    label: "UNISON",
    engage: (id) => engine.perfUnison(id, true),
    release: (id) => engine.perfUnison(id, false),
  },
  {
    key: "trem",
    label: "TREM+",
    // eighth-note chop at the track's tempo
    engage: (id, beat) => engine.perfTremolo(id, 2 / beat, true),
    release: (id, beat) => engine.perfTremolo(id, 2 / beat, false),
  },
  {
    key: "tiptip",
    label: "TIPTIP",
    // 1/4-beat roll with declick envelopes — rhythmic, not abrasive
    engage: (id, beat) => engine.perfStutter(id, beat / 4, true),
    release: (id, beat) => engine.perfStutter(id, beat / 4, false),
  },
];

const CUE_COLORS = ["#c8ff3d", "#5dd8ff", "#ff5ec8", "#ffc83d", "#9d7bff", "#5dffb0", "#ff8c5e", "#e8f0da"];

/** Spinning platter + 3 banks of 8 performance pads, per deck. */
export function CDJ({ id, track, otherTrack, playing, getPosition }: CDJProps) {
  const beat = track?.analysis?.beatInterval ?? 60 / 128;
  const [bank, setBank] = useState<PadBank>("CUE");
  const [heldFx, setHeldFx] = useState<Set<string>>(new Set());
  const [fxMode, setFxMode] = useState<"HOLD" | "LOCK">("HOLD");
  const [cues, setCues] = useState<(number | null)[]>(Array(8).fill(null));
  const [loop, setLoop] = useState<{ beats: number; start: number } | null>(null);
  const [mt, setMt] = useState(true);
  const [quantize, setQuantize] = useState(true);
  const [synced, setSynced] = useState(false);
  const bendBase = useRef(1);

  const otherId: DeckId = id === "A" ? "B" : "A";

  /** snap a position to the nearest beat when quantize is on */
  const snapBeat = useCallback(
    (pos: number): number => {
      const a = track?.analysis;
      if (!quantize || !a) return pos;
      const rel = Math.round((pos - a.firstDownbeat) / a.beatInterval);
      return Math.max(0, a.firstDownbeat + rel * a.beatInterval);
    },
    [track?.analysis, quantize]
  );

  // hot cues + loop + sync state are per-track
  useEffect(() => {
    setCues(Array(8).fill(null));
    setLoop(null); // engine.load() already cleared the audio-side loop
    setSynced(false);
  }, [track?.path]);

  /* ── jog wheel ──────────────────────────────────────────── */
  const platterRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ lastAngle: number; wasPlaying: boolean } | null>(null);
  const SECONDS_PER_REV = 1.8; // 33⅓ rpm feel

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = platterRef.current;
      if (el && !drag.current) {
        const angle = (getPosition() / SECONDS_PER_REV) * 360;
        el.style.transform = `rotate(${angle % 360}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getPosition]);

  const angleAt = (e: PointerEvent | React.PointerEvent): number => {
    const el = platterRef.current!;
    const r = el.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  const onJogDown = useCallback(
    (e: React.PointerEvent) => {
      if (!track) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const wasPlaying = engine.decks[id].playing;
      if (wasPlaying) engine.pause(id);
      drag.current = { lastAngle: angleAt(e), wasPlaying };
    },
    [id, track]
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const el = platterRef.current;
      if (!d || !el) return;
      const a = angleAt(e);
      let delta = a - d.lastAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      d.lastAngle = a;
      const newPos = engine.position(id) + (delta / 360) * SECONDS_PER_REV;
      engine.seek(id, newPos);
      el.style.transform = `rotate(${(newPos / SECONDS_PER_REV) * 360}deg)`;
    };
    const up = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      if (d.wasPlaying) engine.play(id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [id]);

  /* ── pads ───────────────────────────────────────────────── */

  const fxRelease = (pad: FxPad) => {
    if (!heldFx.has(pad.key)) return;
    pad.release(id, beat);
    setHeldFx((s) => {
      const n = new Set(s);
      n.delete(pad.key);
      return n;
    });
  };

  const fxDown = (pad: FxPad) => {
    if (!track) return;
    if (fxMode === "LOCK" && heldFx.has(pad.key)) {
      fxRelease(pad); // locked pad pressed again = unlatch
      return;
    }
    pad.engage(id, beat);
    setHeldFx((s) => new Set(s).add(pad.key));
  };

  /** pointer leaving/lifting only releases in HOLD mode */
  const fxUp = (pad: FxPad) => {
    if (fxMode === "HOLD") fxRelease(pad);
  };

  const releaseAllFx = () => {
    heldFx.forEach((key) => {
      const pad = FX_PADS.find((p) => p.key === key);
      pad?.release(id, beat);
    });
    setHeldFx(new Set());
  };

  // a new track on the deck drops any latched FX
  useEffect(() => {
    if (heldFx.size > 0) releaseAllFx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.path]);

  const cuePress = (i: number) => {
    if (!track) return;
    if (cues[i] === null) {
      const pos = snapBeat(getPosition());
      setCues((c) => c.map((v, j) => (j === i ? pos : v)));
    } else {
      // a cue jump always releases the loop
      if (loop) {
        engine.clearLoop(id);
        setLoop(null);
      }
      engine.seek(id, snapBeat(cues[i]!));
      if (!engine.decks[id].playing) engine.play(id);
    }
  };

  const cueClear = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    setCues((c) => c.map((v, j) => (j === i ? null : v)));
  };

  /** auto-loop: snap start to the beat grid; same size again = release;
   *  different size while looping = resize from the same start (half/double) */
  const loopPress = (beats: number) => {
    if (!track) return;
    if (loop?.beats === beats) {
      engine.clearLoop(id);
      setLoop(null);
      return;
    }
    let start: number;
    if (loop) {
      start = loop.start; // resize in place
    } else {
      const pos = getPosition();
      start = pos;
      const a = track.analysis;
      if (a && beats >= 1 && quantize) {
        start = a.firstDownbeat + Math.floor((pos - a.firstDownbeat) / a.beatInterval) * a.beatInterval;
        if (start > pos) start -= a.beatInterval;
        if (start < 0) start = 0;
      }
    }
    engine.setLoop(id, start, beats * beat);
    setLoop({ beats, start });
  };

  /* ── sync / pitch bend / keylock ────────────────────────── */

  const syncNow = () => {
    const a = track?.analysis;
    const b = otherTrack?.analysis;
    if (!a || !b) return;
    const otherDeck = engine.decks[otherId];
    let target = (b.bpm * otherDeck.rate) / a.bpm;
    if (target > 1.5) target /= 2;
    if (target < 0.66) target *= 2;
    engine.setRate(id, target);
    // phase-pull: bend tempo briefly to land on the other deck's beat grid
    if (engine.decks[id].playing && otherDeck.playing) {
      const fA = ((((getPosition() - a.firstDownbeat) / a.beatInterval) % 1) + 1) % 1;
      const fB = ((((engine.position(otherId) - b.firstDownbeat) / b.beatInterval) % 1) + 1) % 1;
      let err = fB - fA;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      engine.nudgePhase(id, err * a.beatInterval, 1.5);
    }
    setSynced(true);
  };

  const bend = (dir: 1 | -1, on: boolean) => {
    if (!track) return;
    if (on) {
      bendBase.current = engine.decks[id].rate;
      engine.setRate(id, bendBase.current * (dir === 1 ? 1.045 : 1 / 1.045));
    } else {
      engine.setRate(id, bendBase.current);
    }
  };

  return (
    <div className={`cdj cdj-${id.toLowerCase()}`}>
      <div className="jog-block">
        <div className="jog-ring">
          <div className="jog-platter" ref={platterRef} onPointerDown={onJogDown}>
            <i className="jog-marker" />
            <div className="jog-center mono">
              <span className={`jog-state${playing || loop ? " on" : ""}`}>
                {loop ? `LOOP ${loopLabel(loop.beats)}` : playing ? "PLAY" : "STOP"}
              </span>
              <span className="jog-bpm">{track?.analysis ? `${track.analysis.bpm.toFixed(1)}` : "--.-"}</span>
            </div>
          </div>
        </div>
        <div className="jog-controls">
          <button
            className="bend-btn mono"
            onPointerDown={() => bend(-1, true)}
            onPointerUp={() => bend(-1, false)}
            onPointerLeave={() => bend(-1, false)}
            disabled={!track}
            title="pitch bend −"
          >
            −
          </button>
          <button
            className={`sync-btn mono${synced ? " on" : ""}`}
            onClick={syncNow}
            disabled={!track?.analysis || !otherTrack?.analysis}
          >
            SYNC
          </button>
          <button
            className="bend-btn mono"
            onPointerDown={() => bend(1, true)}
            onPointerUp={() => bend(1, false)}
            onPointerLeave={() => bend(1, false)}
            disabled={!track}
            title="pitch bend +"
          >
            +
          </button>
        </div>
      </div>

      <div className="pad-block">
        <div className="pad-banks">
          <button className={`pad-bank${bank === "CUE" ? " on" : ""}`} onClick={() => setBank("CUE")}>
            HOT CUE
          </button>
          <button
            className={`pad-bank${bank === "LOOP" ? " on" : ""}${loop ? " lit" : ""}`}
            onClick={() => setBank("LOOP")}
          >
            LOOP
          </button>
          <button className={`pad-bank${bank === "FX" ? " on" : ""}`} onClick={() => setBank("FX")}>
            FX
          </button>
          <span className="bank-spacer" />
          <button
            className={`pad-bank mini${quantize ? " on" : ""}`}
            onClick={() => setQuantize((q) => !q)}
            title="quantize cues + loops to the beat grid"
          >
            Q
          </button>
          <button
            className={`pad-bank mini${mt ? " on" : ""}`}
            onClick={() => {
              setMt((m) => {
                engine.setMasterTempo(id, !m);
                return !m;
              });
            }}
            title="master tempo (keylock)"
          >
            MT
          </button>
        </div>

        {bank === "LOOP" ? (
          <div className="pad-grid">
            {LOOP_SIZES.map((b) => (
              <button
                key={b}
                className={`pad loop-pad${loop?.beats === b ? " on" : ""}`}
                onClick={() => loopPress(b)}
                disabled={!track}
              >
                <span>{loopLabel(b)}</span>
                <em className="mono">{b < 1 ? "BEAT" : b === 1 ? "BEAT" : "BEATS"}</em>
              </button>
            ))}
          </div>
        ) : bank === "CUE" ? (
          <div className="pad-grid">
            {cues.map((c, i) => (
              <button
                key={i}
                className={`pad cue-pad${c !== null ? " set" : ""}`}
                style={c !== null ? ({ "--pad-color": CUE_COLORS[i] } as React.CSSProperties) : undefined}
                onClick={() => cuePress(i)}
                onContextMenu={(e) => cueClear(i, e)}
                disabled={!track}
              >
                <span>{i + 1}</span>
                {c !== null && <em className="mono">{fmtCue(c)}</em>}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="fx-mode">
              <button
                className={`pad-bank mini${fxMode === "HOLD" ? " on" : ""}`}
                onClick={() => {
                  if (fxMode !== "HOLD") {
                    releaseAllFx();
                    setFxMode("HOLD");
                  }
                }}
              >
                HOLD
              </button>
              <button
                className={`pad-bank mini${fxMode === "LOCK" ? " on" : ""}`}
                onClick={() => setFxMode("LOCK")}
              >
                LOCK
              </button>
              {fxMode === "LOCK" && heldFx.size > 0 && (
                <button className="pad-bank mini fx-killall" onClick={releaseAllFx}>
                  KILL ALL
                </button>
              )}
            </div>
            <div className="pad-grid">
              {FX_PADS.map((p) => (
                <button
                  key={p.key}
                  className={`pad fx-pad${heldFx.has(p.key) ? " held" : ""}`}
                  onPointerDown={() => fxDown(p)}
                  onPointerUp={() => fxUp(p)}
                  onPointerLeave={() => fxUp(p)}
                  disabled={!track}
                >
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function fmtCue(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

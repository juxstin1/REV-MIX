import { useEffect, useState } from "react";
import { LoadedTrack } from "../types";
import { TransitionHud as HudState } from "../audio/automix";
import { Waveform } from "./Waveform";
import { TransitionHud } from "./TransitionHud";
import { CDJ } from "./CDJ";

interface DeckProps {
  id: "A" | "B";
  track: LoadedTrack | null;
  otherTrack: LoadedTrack | null;
  playing: boolean;
  active: boolean;
  getPosition: () => number;
  onPlayPause: () => void;
  onSeek: (t: number) => void;
  onLoad: () => void;
  markers?: { t: number; label: string }[];
  /** live auto-mix HUD (shown when this deck is part of the transition) */
  hud?: HudState | null;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function Deck({ id, track, otherTrack, playing, active, getPosition, onPlayPause, onSeek, onLoad, markers, hud }: DeckProps) {
  const a = track?.analysis ?? null;
  const deckHud = hud && (hud.fromDeck === id || hud.toDeck === id) ? hud : null;
  return (
    <section className={`deck deck-${id.toLowerCase()}${active ? " active" : ""}`}>
      <header className="deck-head">
        <span className="deck-id">{id}</span>
        <div className="deck-title">
          {track ? (
            <>
              <strong>{track.name}</strong>
              <span className="deck-badges mono">
                {a ? (
                  <>
                    <em>{a.bpm.toFixed(1)} BPM</em>
                    <em>
                      {a.key} · {a.camelot}
                    </em>
                  </>
                ) : (
                  <em className="analysing">ANALYSING…</em>
                )}
                {track.voxStatus === "done" && <em className="vox-done">VOX</em>}
                {track.voxStatus === "pending" && <em className="analysing vox-wait">VOX…</em>}
              </span>
            </>
          ) : (
            <strong className="empty">NO TRACK</strong>
          )}
        </div>
        <button className="deck-load" onClick={onLoad}>
          LOAD
        </button>
      </header>

      <Waveform
        buffer={track?.buffer ?? null}
        analysis={a}
        getPosition={getPosition}
        onSeek={onSeek}
        color={id === "A" ? "#c8ff3d" : "#5dd8ff"}
        markers={markers}
      />

      {deckHud && <TransitionHud hud={deckHud} role={deckHud.toDeck === id ? "IN" : "OUT"} />}

      <footer className="deck-foot">
        <button className={`deck-play${playing ? " playing" : ""}`} onClick={onPlayPause} disabled={!track}>
          {playing ? "❚❚" : "▶"}
        </button>
        <DeckClock getPosition={getPosition} duration={track?.buffer.duration ?? 0} />
      </footer>

      <CDJ id={id} track={track} otherTrack={otherTrack} playing={playing} getPosition={getPosition} />
    </section>
  );
}

function getPositionSafe(get: () => number) {
  try {
    return get();
  } catch {
    return 0;
  }
}

/** re-render the time readout ~5×/s without re-rendering the deck */
function DeckClock({ getPosition, duration }: { getPosition: () => number; duration: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 200);
    return () => clearInterval(t);
  }, []);
  const pos = getPositionSafe(getPosition);
  return (
    <>
      <span className="deck-time mono">
        {fmtTime(pos)}
        <i> / {fmtTime(duration)}</i>
      </span>
      <span className="deck-remain mono">-{fmtTime(Math.max(0, duration - pos))}</span>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../audio/engine";
import { DRUM_VOICES, DrumVoice, playVoice } from "../audio/drums";
import { SeqPattern } from "../library";

const STEPS = 16;
const ROWS = DRUM_VOICES.length;

interface SequencerProps {
  /** active deck BPM for SYNC */
  deckBpm: number | null;
  patterns: SeqPattern[];
  onSavePattern: (name: string, bpm: number, steps: number[][]) => void;
  onDeletePattern: (id: string) => void;
}

const emptyGrid = (): number[][] => Array.from({ length: ROWS }, () => Array(STEPS).fill(0));

/** 16-step loop sequencer with synthesized drum voices. */
export function Sequencer({ deckBpm, patterns, onSavePattern, onDeletePattern }: SequencerProps) {
  const [grid, setGrid] = useState<number[][]>(emptyGrid);
  const [bpm, setBpm] = useState(128);
  const [playing, setPlaying] = useState(false);
  const [uiStep, setUiStep] = useState(-1);
  const [name, setName] = useState("");

  const gridRef = useRef(grid);
  gridRef.current = grid;
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;

  /* lookahead scheduler on the audio clock */
  useEffect(() => {
    if (!playing) {
      setUiStep(-1);
      return;
    }
    void engine.resume();
    const ctx = engine.ctx;
    let step = 0;
    let nextT = ctx.currentTime + 0.06;
    const timer = window.setInterval(() => {
      while (nextT < ctx.currentTime + 0.13) {
        const g = gridRef.current;
        for (let r = 0; r < ROWS; r++) {
          if (g[r][step]) playVoice(ctx, engine.master, DRUM_VOICES[r] as DrumVoice, nextT);
        }
        const stepDur = 60 / bpmRef.current / 4;
        const thisStep = step;
        const delay = Math.max(0, (nextT - ctx.currentTime) * 1000);
        window.setTimeout(() => setUiStep(thisStep), delay);
        step = (step + 1) % STEPS;
        nextT += stepDur;
      }
    }, 25);
    return () => window.clearInterval(timer);
  }, [playing]);

  const toggle = useCallback((r: number, s: number) => {
    setGrid((g) => g.map((row, ri) => (ri === r ? row.map((v, si) => (si === s ? (v ? 0 : 1) : v)) : row)));
  }, []);

  const loadPattern = (p: SeqPattern) => {
    setGrid(p.steps.map((row) => [...row]));
    setBpm(p.bpm);
    setName(p.name);
  };

  return (
    <div className="seq">
      <header className="seq-bar">
        <button className={`seq-play${playing ? " on" : ""}`} onClick={() => setPlaying((p) => !p)}>
          {playing ? "■ STOP" : "▶ PLAY"}
        </button>
        <label className="seq-bpm mono">
          BPM
          <input
            type="number"
            min={60}
            max={200}
            value={bpm}
            onChange={(e) => setBpm(Math.max(60, Math.min(200, Number(e.target.value) || 128)))}
          />
        </label>
        <button
          className="seq-sync mono"
          disabled={!deckBpm}
          onClick={() => deckBpm && setBpm(Math.round(deckBpm * 10) / 10)}
        >
          SYNC DECK {deckBpm ? `(${deckBpm.toFixed(1)})` : ""}
        </button>
        <button className="seq-clear mono" onClick={() => setGrid(emptyGrid())}>
          CLEAR
        </button>
        <div className="seq-save">
          <input
            className="mono"
            placeholder="PATTERN NAME…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="mono"
            disabled={!name.trim()}
            onClick={() => onSavePattern(name.trim(), bpm, gridRef.current.map((r) => [...r]))}
          >
            SAVE
          </button>
        </div>
      </header>

      <div className="seq-grid">
        {DRUM_VOICES.map((voice, r) => (
          <div className="seq-row" key={voice}>
            <button
              className="seq-rowlabel mono"
              onClick={() => playVoice(engine.ctx, engine.master, voice, engine.ctx.currentTime + 0.02)}
              title="preview"
            >
              {voice}
            </button>
            {grid[r].map((on, s) => (
              <button
                key={s}
                className={[
                  "seq-cell",
                  on ? "on" : "",
                  s % 4 === 0 ? "beat" : "",
                  s === uiStep ? "now" : "",
                ].join(" ")}
                onPointerDown={() => toggle(r, s)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="seq-patterns">
        <h3>SAVED LOOPS</h3>
        {patterns.length === 0 && <p className="lib-empty mono">NO LOOPS YET — DRAW ONE AND SAVE IT</p>}
        {patterns.map((p) => (
          <div className="lib-row" key={p.id}>
            <span className="lib-row-name">
              {p.name} <em className="mono">{p.bpm} BPM</em>
            </span>
            <button onClick={() => loadPattern(p)}>LOAD</button>
            <button className="lib-x" onClick={() => onDeletePattern(p.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

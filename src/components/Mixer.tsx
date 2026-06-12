import { useCallback, useMemo, useState } from "react";
import { engine, DeckId } from "../audio/engine";
import { StripState } from "../types";
import { Knob } from "./Knob";
import { Fader } from "./Fader";
import { Crossfader } from "./Crossfader";
import { VUMeter } from "./VUMeter";

interface MixerProps {
  xfade: number;
  onXfade: (v: number) => void;
  strips: Record<DeckId, StripState>;
  onStripChange: (id: DeckId, k: keyof StripState, v: number) => void;
}

/**
 * The console — a two-channel club mixer rendered as 3D hardware:
 * brushed faceplate in perspective, rotary pots, LED meters,
 * line faders and a crossfader. Pot/fader state is owned by App so the
 * MIDI controller and these on-screen controls stay in lock-step.
 */
export function Mixer({ xfade, onXfade, strips, onStripChange: update }: MixerProps) {
  const [master, setMaster] = useState(0.75);

  const meterBufs = useMemo(
    () => ({
      A: new Float32Array(engine.decks.A.strip.analyser.fftSize),
      B: new Float32Array(engine.decks.B.strip.analyser.fftSize),
      M: new Float32Array(engine.masterAnalyser.fftSize),
    }),
    []
  );
  const levelA = useCallback(() => engine.level(engine.decks.A.strip.analyser, meterBufs.A), [meterBufs]);
  const levelB = useCallback(() => engine.level(engine.decks.B.strip.analyser, meterBufs.B), [meterBufs]);
  const levelM = useCallback(() => engine.level(engine.masterAnalyser, meterBufs.M), [meterBufs]);

  return (
    <div className="mixer-tilt">
      <div className="mixer">
        <div className="mixer-screws">
          <i /> <i /> <i /> <i />
        </div>
        <div className="mixer-brand mono">REV·MX2</div>

        <div className="mixer-channels">
          <ChannelStrip id="A" strip={strips.A} onChange={update} getLevel={levelA} />

          <div className="mixer-center">
            <div className="center-meter">
              <span className="strip-tag mono">MST</span>
              <VUMeter getLevel={levelM} />
            </div>
            <Knob label="MASTER" value={master} onChange={(v) => (setMaster(v), engine.setMaster(v))} size={48} />
          </div>

          <ChannelStrip id="B" strip={strips.B} onChange={update} getLevel={levelB} />
        </div>

        <Crossfader value={xfade} onChange={onXfade} />
      </div>
    </div>
  );
}

function ChannelStrip({
  id,
  strip,
  onChange,
  getLevel,
}: {
  id: DeckId;
  strip: StripState;
  onChange: (id: DeckId, k: keyof StripState, v: number) => void;
  getLevel: () => number;
}) {
  const accent = id === "A" ? "#c8ff3d" : "#5dd8ff";
  return (
    <div className="strip" style={{ "--knob-accent": accent } as React.CSSProperties}>
      <span className="strip-tag mono" style={{ color: accent }}>
        CH {id}
      </span>
      <Knob label="TRIM" value={strip.trim} onChange={(v) => onChange(id, "trim", v)} centerDetent size={42} />
      <div className="strip-eq">
        <Knob label="HI" value={strip.high} onChange={(v) => onChange(id, "high", v)} centerDetent size={42} labelTop />
        <Knob label="MID" value={strip.mid} onChange={(v) => onChange(id, "mid", v)} centerDetent size={42} labelTop />
        <Knob label="LOW" value={strip.low} onChange={(v) => onChange(id, "low", v)} centerDetent size={42} labelTop />
      </div>
      <Knob label="FILTER" value={strip.filter} onChange={(v) => onChange(id, "filter", v)} centerDetent size={50} />
      <div className="strip-bottom">
        <VUMeter getLevel={getLevel} />
        <Fader value={strip.fader} onChange={(v) => onChange(id, "fader", v)} />
      </div>
    </div>
  );
}

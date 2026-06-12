import { useEffect, useState } from "react";
import { engine } from "../audio/engine";
import { TransitionHud as HudState, TransitionPhase } from "../audio/automix";

/** what the countdown targets in each phase */
function target(hud: HudState): { label: string; at: number } | null {
  switch (hud.phase) {
    case "ARMING":
      return { label: "MIX IN", at: hud.mixInAt };
    case "BLENDING":
      return { label: "BASS SWAP", at: hud.bassSwapAt ?? hud.mixOutAt };
    case "BASS_SWAP":
      return { label: "MIX OUT", at: hud.mixOutAt };
    case "ECHO_OUT":
      return { label: "OUT", at: hud.mixOutAt };
    case "COMPLETE":
      return null;
  }
}

const PHASE_LABEL: Record<TransitionPhase, string> = {
  ARMING: "ARMING",
  BLENDING: "BLENDING",
  BASS_SWAP: "BASS SWAP",
  ECHO_OUT: "ECHO OUT",
  COMPLETE: "COMPLETE",
};

function clock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

interface Props {
  hud: HudState;
  /** this deck's role in the transition */
  role: "IN" | "OUT";
}

/** Compact "Auto DJ" readout on a CDJ screen. Renders engine state only — the
 *  sole local computation is the clock countdown to the next phase target. */
export function TransitionHud({ hud, role }: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);

  const tgt = target(hud);
  const remaining = tgt ? tgt.at - engine.ctx.currentTime : 0;
  const clash = hud.vocalsKnown && hud.vocalClash > 0.25;

  return (
    <div className={`hud hud-${hud.phase.toLowerCase()}${hud.active ? " active" : ""}`}>
      <div className="hud-top">
        <span className="hud-brand mono">AUTO DJ</span>
        <span className={`hud-role mono role-${role.toLowerCase()}`}>
          {role === "IN" ? "▲ IN" : "▼ OUT"}
        </span>
      </div>

      <div className="hud-style">
        <span className="mono">{hud.style.replace("_", " ")}</span>
        <span className="hud-conf mono">{pct(hud.confidence)}%</span>
      </div>

      <div className="hud-scores mono">
        <span>BPM <em>{pct(hud.bpmScore)}</em></span>
        <span>KEY <em>{pct(hud.keyScore)}</em></span>
        <span>ENR <em>{pct(hud.energyScore)}</em></span>
      </div>

      <div className="hud-row mono">
        <span className={`hud-vox${clash ? " clash" : ""}`}>
          {!hud.vocalsKnown ? "VOCALS …" : clash ? `VOCALS CLASH ${pct(hud.vocalClash)}%` : "VOCALS CLEAR"}
        </span>
      </div>

      <div className="hud-foot mono">
        <span className="hud-phase">{PHASE_LABEL[hud.phase]}</span>
        {tgt && (
          <span className="hud-count">
            {tgt.label} <em>{clock(remaining)}</em>
          </span>
        )}
      </div>
    </div>
  );
}

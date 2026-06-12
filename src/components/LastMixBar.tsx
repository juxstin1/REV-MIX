import { useState } from "react";
import { TransitionTelemetry, RiskCode, RISK_LABEL } from "../audio/automix";

export type LastMix = TransitionTelemetry & { fromName: string; toName: string };

/** the labels the user can tag a bad mix with */
export const REVIEW_REASONS = [
  "ROBOTIC VOCAL",
  "BAD PHRASE",
  "VOCAL CLASH",
  "TOO MUCH PITCH",
  "BASS CLASH",
  "BAD FX",
  "TOO LONG",
] as const;

/** seed the reason picker from the system's auto-risk flags */
const RISK_TO_REASON: Record<RiskCode, string[]> = {
  LOW_CONFIDENCE: [],
  VOCAL_CLASH: ["VOCAL CLASH"],
  HIGH_PITCH: ["TOO MUCH PITCH"],
  LONG_BLEND_PITCH: ["TOO MUCH PITCH", "TOO LONG"],
};

interface Props {
  mix: LastMix;
  risk: RiskCode[];
  onRate: (verdict: "good" | "review", reasons: string[]) => void;
  onReplay: () => void;
  replayDisabled: boolean;
}

export function LastMixBar({ mix, risk, onRate, onReplay, replayDisabled }: Props) {
  const [reviewing, setReviewing] = useState(false);
  const [reasons, setReasons] = useState<Set<string>>(new Set());
  const [rated, setRated] = useState<"good" | "review" | null>(null);

  const risky = risk.length > 0;

  const startReview = () => {
    const seed = new Set<string>();
    for (const r of risk) RISK_TO_REASON[r].forEach((x) => seed.add(x));
    setReasons(seed);
    setReviewing(true);
  };
  const toggle = (r: string) =>
    setReasons((s) => {
      const n = new Set(s);
      n.has(r) ? n.delete(r) : n.add(r);
      return n;
    });

  return (
    <div className={`lastmix mono${risky ? " risky" : ""}${rated ? " rated" : ""}`}>
      <div className="lastmix-line">
        <span className="lastmix-tag">{risky ? "⚑ REVIEW?" : "LAST MIX"}</span>
        <span className="lastmix-style">{mix.style.replace("_", " ")}</span>
        <span className="lastmix-conf">{(mix.confidence * 100) | 0}%</span>
        <span>
          {mix.outBpm.toFixed(0)}→{mix.inBpm.toFixed(0)} BPM ({mix.pitchShiftPct >= 0 ? "+" : ""}
          {mix.pitchShiftPct.toFixed(1)}%)
        </span>
        <span>
          swap {mix.bassSwapSec.toFixed(1)}s · out {mix.mixOutSec.toFixed(1)}s
        </span>
        {risk.map((r) => (
          <span className="lastmix-risk" key={r}>
            {RISK_LABEL[r]}
          </span>
        ))}

        <div className="lastmix-actions">
          {rated ? (
            <span className="lastmix-saved">✓ {rated === "good" ? "GOOD" : "REVIEW"}</span>
          ) : (
            <>
              <button
                className="lastmix-btn good"
                title="this was fire — keep doing that"
                onClick={() => {
                  onRate("good", []);
                  setRated("good");
                }}
              >
                👍
              </button>
              <button className="lastmix-btn bad" title="flag for review" onClick={startReview}>
                👎
              </button>
            </>
          )}
          {/* always available: re-arm the SAME style on the current decks */}
          <button
            className="lastmix-btn replay"
            onClick={onReplay}
            disabled={replayDisabled}
            title={
              replayDisabled
                ? "REPLAY needs both decks loaded + the active deck playing"
                : `re-run a ${mix.style.replace("_", " ")} transition on the current decks`
            }
          >
            ↻ DO IT AGAIN
          </button>
        </div>
      </div>

      {reviewing && !rated && (
        <div className="lastmix-review">
          <span className="lastmix-review-q">WHAT WENT WRONG?</span>
          {REVIEW_REASONS.map((r) => (
            <button
              key={r}
              className={`reason-chip${reasons.has(r) ? " on" : ""}`}
              onClick={() => toggle(r)}
            >
              {r}
            </button>
          ))}
          <button
            className="lastmix-btn bad"
            onClick={() => {
              onRate("review", [...reasons]);
              setRated("review");
            }}
          >
            SAVE REVIEW
          </button>
        </div>
      )}
    </div>
  );
}

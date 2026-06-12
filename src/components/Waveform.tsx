import { useEffect, useMemo, useRef } from "react";
import { TrackAnalysis, SectionLabel } from "../audio/analysis";

const SECTION_FILL: Record<SectionLabel, string> = {
  INTRO: "rgba(125,138,106,0.30)",
  BUILD: "rgba(255,200,61,0.38)",
  DROP: "rgba(200,255,61,0.40)",
  BREAKDOWN: "rgba(93,216,255,0.34)",
  GROOVE: "rgba(200,255,61,0.16)",
  OUTRO: "rgba(125,138,106,0.30)",
};

const SECTION_TEXT: Record<SectionLabel, string> = {
  INTRO: "rgba(200,212,176,0.95)",
  BUILD: "rgba(255,214,120,1)",
  DROP: "rgba(220,255,130,1)",
  BREAKDOWN: "rgba(150,228,255,1)",
  GROOVE: "rgba(190,205,165,0.85)",
  OUTRO: "rgba(200,212,176,0.95)",
};

/** colour a transition marker by what it is */
function markerColor(label: string): string {
  const l = label.toUpperCase();
  if (l.includes("OUT")) return "#ff8c5e";
  if (l.includes("DROP")) return "#5dd8ff";
  return "#c8ff3d";
}

interface WaveformProps {
  buffer: AudioBuffer | null;
  analysis: TrackAnalysis | null;
  /** current position in seconds (drives the playhead) */
  getPosition: () => number;
  onSeek: (t: number) => void;
  color: string;
  /** track-time markers (s) to highlight, e.g. planned transition start */
  markers?: { t: number; label: string }[];
}

// screen layout — discrete lanes so nothing overlaps, like a real CDJ display
const H = 108;
const SEC_LANE = 14; // top ribbon: track structure (sections)
const MARK_LANE = 20; // bottom band: transition flags
const BODY_TOP = SEC_LANE;
const BODY_BOT = H - MARK_LANE;
const BODY_H = BODY_BOT - BODY_TOP;
const BODY_MID = BODY_TOP + BODY_H / 2;

/** CDJ-style track display: structure ribbon, beat-grid waveform, transition
 *  flags — each in its own lane, with a playhead overlay. */
export function Waveform({ buffer, analysis, getPosition, onSeek, color, markers = [] }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // peaks computed once per buffer
  const peaks = useMemo(() => {
    if (!buffer) return null;
    const data = buffer.getChannelData(0);
    const n = 800;
    const block = Math.floor(data.length / n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let max = 0;
      const start = i * block;
      for (let j = 0; j < block; j += 8) {
        const v = Math.abs(data[start + j]);
        if (v > max) max = v;
      }
      out[i] = max;
    }
    return out;
  }, [buffer]);

  // static layer: structure ribbon + waveform + beat grid + transition flags
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const w = wrap.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, H);

    // lane dividers (subtle screen guides)
    ctx.fillStyle = "rgba(232,240,218,0.10)";
    ctx.fillRect(0, SEC_LANE, w, 1);
    ctx.fillRect(0, BODY_BOT, w, 1);

    if (!peaks || !buffer) {
      ctx.fillStyle = "rgba(125,138,106,0.25)";
      ctx.fillRect(0, BODY_MID - 0.5, w, 1);
      return;
    }

    const pxPerSec = w / buffer.duration;

    // mix-in / mix-out regions (body only)
    if (analysis) {
      ctx.fillStyle = "rgba(120,130,100,0.14)";
      ctx.fillRect(0, BODY_TOP, analysis.mixInPoint * pxPerSec, BODY_H);
      ctx.fillRect(analysis.mixOutPoint * pxPerSec, BODY_TOP, w - analysis.mixOutPoint * pxPerSec, BODY_H);
    }

    // waveform, energy-shaded, centred in the body lane
    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const t = (i / peaks.length) * buffer.duration;
      let alpha = 0.85;
      if (analysis) {
        const e = analysis.energy[Math.min(analysis.energy.length - 1, Math.floor(t))] ?? 0.5;
        alpha = 0.32 + e * 0.68;
      }
      const h = Math.max(1, peaks[i] * (BODY_H - 8));
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fillRect(i * barW, BODY_MID - h / 2, Math.max(1, barW - 0.6), h);
    }
    ctx.globalAlpha = 1;

    // beat grid (body only): downbeats brighter, phrases full-height
    if (analysis) {
      for (let b = 0; ; b++) {
        const t = analysis.firstDownbeat + b * analysis.beatInterval;
        if (t > buffer.duration) break;
        const x = t * pxPerSec;
        const isDownbeat = b % 4 === 0;
        const isPhrase = b % 32 === 0;
        if (!isDownbeat && pxPerSec < 3) continue;
        ctx.fillStyle = isPhrase
          ? "rgba(232,240,218,0.45)"
          : isDownbeat
            ? "rgba(232,240,218,0.18)"
            : "rgba(232,240,218,0.07)";
        const gh = isPhrase ? BODY_H : isDownbeat ? BODY_H * 0.5 : BODY_H * 0.25;
        ctx.fillRect(x, BODY_MID - gh / 2, 1, gh);
      }

      // structure ribbon along the top lane
      ctx.textBaseline = "middle";
      for (const s of analysis.sections) {
        const x0 = s.start * pxPerSec;
        const x1 = Math.min(w, s.end * pxPerSec);
        ctx.fillStyle = SECTION_FILL[s.label];
        ctx.fillRect(x0, 0, x1 - x0, SEC_LANE - 1);
        if (x1 - x0 > 30) {
          ctx.fillStyle = SECTION_TEXT[s.label];
          ctx.font = "700 8px 'IBM Plex Mono', monospace";
          ctx.fillText(s.label, x0 + 4, SEC_LANE / 2);
        }
      }

      // vocal activity strip, just inside the body bottom
      if (analysis.vocals) {
        ctx.fillStyle = "rgba(255,94,200,0.75)";
        for (let s = 0; s < analysis.vocals.length; s++) {
          if (analysis.vocals[s] > 0.3) ctx.fillRect(s * pxPerSec, BODY_BOT - 3, pxPerSec + 0.5, 2);
        }
      }
    }

    // transition flags in the bottom band — two rows so close flags don't collide
    ctx.textBaseline = "middle";
    ctx.font = "700 8px 'IBM Plex Mono', monospace";
    const lastRight = [-999, -999];
    for (const m of markers) {
      const x = (m.t / buffer.duration) * w;
      const col = markerColor(m.label);
      // full-height tick through the body
      ctx.fillStyle = col;
      ctx.fillRect(x - 1, BODY_TOP, 2, BODY_H);
      // flag: pick the row that's free at this x
      const label = m.label.toUpperCase();
      const tw = ctx.measureText(label).width;
      const row = x < lastRight[0] + 6 ? 1 : 0;
      lastRight[row] = x + tw + 8;
      const fy = BODY_BOT + 2 + row * 9;
      const fx = Math.min(x + 3, w - tw - 8);
      ctx.fillStyle = "rgba(8,10,6,0.9)";
      ctx.fillRect(fx, fy, tw + 6, 8);
      ctx.fillStyle = col;
      ctx.fillRect(fx, fy, 2, 8);
      ctx.fillText(label, fx + 5, fy + 4.5);
    }
  }, [peaks, buffer, analysis, color, markers]);

  // dynamic layer: playhead
  useEffect(() => {
    const overlay = overlayRef.current;
    const wrap = wrapRef.current;
    if (!overlay || !wrap) return;
    const w = wrap.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = w * dpr;
    overlay.height = H * dpr;
    const ctx = overlay.getContext("2d")!;
    ctx.scale(dpr, dpr);

    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, w, H);
      if (buffer) {
        const pos = getPosition();
        const x = (pos / buffer.duration) * w;
        ctx.fillStyle = "rgba(200,255,61,0.14)";
        ctx.fillRect(0, BODY_TOP, x, BODY_H);
        ctx.fillStyle = "rgba(232,240,218,0.95)";
        ctx.fillRect(x - 0.5, 0, 1.5, H);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [buffer, getPosition]);

  return (
    <div
      className="waveform"
      ref={wrapRef}
      style={{ height: H }}
      onPointerDown={(e) => {
        if (!buffer) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * buffer.duration);
      }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: H, position: "absolute", inset: 0 }} />
      <canvas ref={overlayRef} style={{ width: "100%", height: H, position: "absolute", inset: 0 }} />
    </div>
  );
}

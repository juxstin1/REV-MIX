import { useEffect, useMemo, useRef } from "react";
import { TrackAnalysis, SectionLabel } from "../audio/analysis";

const SECTION_FILL: Record<SectionLabel, string> = {
  INTRO: "rgba(125,138,106,0.22)",
  BUILD: "rgba(255,200,61,0.30)",
  DROP: "rgba(200,255,61,0.32)",
  BREAKDOWN: "rgba(93,216,255,0.26)",
  GROOVE: "rgba(200,255,61,0.10)",
  OUTRO: "rgba(125,138,106,0.22)",
};

const SECTION_TEXT: Record<SectionLabel, string> = {
  INTRO: "rgba(180,195,155,0.8)",
  BUILD: "rgba(255,210,110,0.95)",
  DROP: "rgba(216,255,110,0.95)",
  BREAKDOWN: "rgba(140,225,255,0.95)",
  GROOVE: "rgba(180,195,155,0.7)",
  OUTRO: "rgba(180,195,155,0.8)",
};

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

const H = 84;

/** Canvas waveform with beat grid, energy shading, playhead and markers. */
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

  // static layer: waveform + beat grid + markers
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

    if (!peaks || !buffer) {
      ctx.fillStyle = "rgba(125,138,106,0.25)";
      ctx.fillRect(0, H / 2 - 0.5, w, 1);
      return;
    }

    const mid = H / 2;
    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const t = (i / peaks.length) * buffer.duration;
      let alpha = 0.85;
      if (analysis) {
        const e = analysis.energy[Math.min(analysis.energy.length - 1, Math.floor(t))] ?? 0.5;
        alpha = 0.3 + e * 0.7;
      }
      const h = Math.max(1, peaks[i] * (H - 10));
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW - 0.6), h);
    }
    ctx.globalAlpha = 1;

    // beat grid: downbeats brighter
    if (analysis) {
      const pxPerSec = w / buffer.duration;
      for (let b = 0; ; b++) {
        const t = analysis.firstDownbeat + b * analysis.beatInterval;
        if (t > buffer.duration) break;
        const x = t * pxPerSec;
        const isDownbeat = b % 4 === 0;
        const isPhrase = b % 32 === 0;
        if (!isDownbeat && pxPerSec < 3) continue;
        ctx.fillStyle = isPhrase
          ? "rgba(232,240,218,0.55)"
          : isDownbeat
            ? "rgba(232,240,218,0.22)"
            : "rgba(232,240,218,0.08)";
        ctx.fillRect(x, 0, 1, isPhrase ? H : isDownbeat ? H * 0.5 : H * 0.25);
      }

      // mix-in / mix-out regions
      ctx.fillStyle = "rgba(200,255,61,0.07)";
      ctx.fillRect(0, 0, analysis.mixInPoint * pxPerSec, H);
      ctx.fillRect(analysis.mixOutPoint * pxPerSec, 0, w - analysis.mixOutPoint * pxPerSec, H);

      // section bands along the top — the track's structure, visible
      for (const s of analysis.sections) {
        const x0 = s.start * pxPerSec;
        const x1 = Math.min(w, s.end * pxPerSec);
        ctx.fillStyle = SECTION_FILL[s.label];
        ctx.fillRect(x0, 0, x1 - x0, 9);
        if (x1 - x0 > 38) {
          ctx.fillStyle = SECTION_TEXT[s.label];
          ctx.font = "7px 'IBM Plex Mono', monospace";
          ctx.fillText(s.label, x0 + 3, 7);
        }
      }

      // vocal activity strip (from stem separation)
      if (analysis.vocals) {
        ctx.fillStyle = "rgba(255,94,200,0.7)";
        for (let s = 0; s < analysis.vocals.length; s++) {
          if (analysis.vocals[s] > 0.3) {
            ctx.fillRect(s * pxPerSec, H - 4, pxPerSec + 0.5, 3);
          }
        }
      }
    }

    // markers
    for (const m of markers) {
      const x = (m.t / buffer.duration) * w;
      ctx.fillStyle = "#c8ff3d";
      ctx.fillRect(x - 1, 0, 2, H);
      ctx.font = "8px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#c8ff3d";
      ctx.fillText(m.label, Math.min(x + 4, w - 40), 10);
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
        ctx.fillStyle = "rgba(232,240,218,0.9)";
        ctx.fillRect(x - 0.5, 0, 1.5, H);
        ctx.fillStyle = "rgba(200,255,61,0.18)";
        ctx.fillRect(0, 0, x, H);
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

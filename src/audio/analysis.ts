/**
 * On-device track analysis: BPM, beat grid, musical key (Camelot),
 * energy contour and mix-in/mix-out regions.
 *
 * Pipeline: decode → mono 22050 Hz → STFT (1024/512) → spectral-flux onset
 * envelope → autocorrelation tempo → beat phase fit → chromagram →
 * Krumhansl–Schmuckler key match.
 */

export interface TrackAnalysis {
  bpm: number;
  /** seconds of the first downbeat */
  firstDownbeat: number;
  /** seconds between beats (60 / bpm) */
  beatInterval: number;
  /** musical key, e.g. "Am" */
  key: string;
  /** Camelot wheel code, e.g. "8A" */
  camelot: string;
  mode: "major" | "minor";
  /** normalised 0..1 energy per second of audio */
  energy: Float32Array;
  /** per-second band energy (low <250 Hz, mid 250–3500, high >3500) */
  bands: { low: Float32Array; mid: Float32Array; high: Float32Array };
  /** per-second onset flux, normalised to the track mean */
  fluxPerSec: Float32Array;
  /** seconds where the intro settles into full energy (good mix-in point) */
  mixInPoint: number;
  /** seconds where the outro starts losing energy (good mix-out region) */
  mixOutPoint: number;
  duration: number;
  /** per-second vocal activity 0..1 from stem separation (arrives async) */
  vocals?: Float32Array;
  /** musical structure, phrase-aligned */
  sections: Section[];
}

export type SectionLabel = "INTRO" | "BUILD" | "DROP" | "BREAKDOWN" | "GROOVE" | "OUTRO";

export interface Section {
  /** seconds */
  start: number;
  end: number;
  label: SectionLabel;
}

const SR = 22050;
const FRAME = 1024;
const HOP = 512;

/* ── FFT (radix-2, in-place) ──────────────────────────────── */

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hann = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

/* ── resample to mono 22050 ───────────────────────────────── */

async function toMono(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.ceil(buffer.duration * SR);
  const off = new OfflineAudioContext(1, length, SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

/* ── onset envelope via spectral flux ─────────────────────── */

interface Frames {
  flux: Float32Array; // onset strength per frame
  bassFlux: Float32Array; // low-band onset strength (kick emphasis)
  chroma: Float32Array; // 12 bins, summed over whole track
  rmsPerSec: Float32Array;
  bandLow: Float32Array; // per-second band energy sums
  bandMid: Float32Array;
  bandHigh: Float32Array;
  fluxPerSec: Float32Array;
}

function analyseFrames(mono: Float32Array): Frames {
  const nFrames = Math.max(1, Math.floor((mono.length - FRAME) / HOP));
  const flux = new Float32Array(nFrames);
  const bassFlux = new Float32Array(nFrames);
  const chroma = new Float32Array(12);
  const prevMag = new Float32Array(FRAME / 2);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  const secs = Math.ceil(mono.length / SR);
  const rmsPerSec = new Float32Array(secs);
  const rmsCount = new Float32Array(secs);
  const bandLow = new Float32Array(secs);
  const bandMid = new Float32Array(secs);
  const bandHigh = new Float32Array(secs);
  const fluxPerSec = new Float32Array(secs);
  const midMaxBin = Math.round((3500 * FRAME) / SR);

  // precompute bin → pitch-class map (ignore <60 Hz and >5 kHz)
  const pitchClass = new Int8Array(FRAME / 2).fill(-1);
  for (let b = 1; b < FRAME / 2; b++) {
    const freq = (b * SR) / FRAME;
    if (freq < 60 || freq > 5000) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    pitchClass[b] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const bassMaxBin = Math.round((150 * FRAME) / SR); // <150 Hz

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = mono[start + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);

    const sec = Math.min(secs - 1, Math.floor(start / SR));
    const lowMaxBin = Math.round((250 * FRAME) / SR);
    let fl = 0;
    let bfl = 0;
    for (let b = 1; b < FRAME / 2; b++) {
      const mag = Math.hypot(re[b], im[b]);
      const d = mag - prevMag[b];
      if (d > 0) {
        fl += d;
        if (b <= bassMaxBin) bfl += d;
      }
      if (b <= lowMaxBin) bandLow[sec] += mag;
      else if (b <= midMaxBin) bandMid[sec] += mag;
      else bandHigh[sec] += mag;
      const pc = pitchClass[b];
      if (pc >= 0) chroma[pc] += mag;
      prevMag[b] = mag;
    }
    flux[f] = fl;
    bassFlux[f] = bfl;
    fluxPerSec[sec] += fl;
    let sum = 0;
    for (let i = 0; i < FRAME; i += 4) sum += mono[start + i] * mono[start + i];
    rmsPerSec[sec] += Math.sqrt(sum / (FRAME / 4));
    rmsCount[sec]++;
  }

  for (let s = 0; s < secs; s++) {
    if (rmsCount[s] > 0) {
      rmsPerSec[s] /= rmsCount[s];
      bandLow[s] /= rmsCount[s];
      bandMid[s] /= rmsCount[s];
      bandHigh[s] /= rmsCount[s];
      fluxPerSec[s] /= rmsCount[s];
    }
  }
  // normalise flux to the track mean so regions compare as "vs typical"
  let fluxMean = 0;
  for (let s = 0; s < secs; s++) fluxMean += fluxPerSec[s];
  fluxMean = fluxMean / secs || 1;
  for (let s = 0; s < secs; s++) fluxPerSec[s] /= fluxMean;

  return { flux, bassFlux, chroma, rmsPerSec, bandLow, bandMid, bandHigh, fluxPerSec };
}

/* ── tempo via autocorrelation of onset envelope ──────────── */

function detectTempo(flux: Float32Array): number {
  // normalise + de-mean
  const n = flux.length;
  const env = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= n;
  for (let i = 0; i < n; i++) env[i] = flux[i] - mean;

  const frameRate = SR / HOP; // ≈ 43 fps
  const minLag = Math.floor((60 / 200) * frameRate); // 200 BPM
  const maxLag = Math.ceil((60 / 60) * frameRate); // 60 BPM

  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += env[i] * env[i + lag];
    // gentle prior toward club tempos (~125 BPM)
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.pow((bpm - 125) / 45, 2));
    const score = acc * (0.7 + 0.3 * prior);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // parabolic refinement around bestLag
  const acAt = (lag: number) => {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += env[i] * env[i + lag];
    return acc;
  };
  const y0 = acAt(bestLag - 1);
  const y1 = acAt(bestLag);
  const y2 = acAt(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const lag = bestLag + Math.max(-0.5, Math.min(0.5, shift));

  let bpm = (60 * frameRate) / lag;
  // fold into 70–180
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/* ── beat phase + downbeat ────────────────────────────────── */

function fitBeatPhase(flux: Float32Array, bassFlux: Float32Array, bpm: number): number {
  const frameRate = SR / HOP;
  const period = (60 / bpm) * frameRate; // frames per beat
  const steps = 64;

  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    for (let t = phase; t < flux.length; t += period) {
      score += flux[Math.round(t)] ?? 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  // downbeat: among the 4 candidate beats, pick the one whose bass flux is
  // strongest when sampled every 4 beats
  let bestDb = 0;
  let bestDbScore = -Infinity;
  for (let d = 0; d < 4; d++) {
    let score = 0;
    for (let t = bestPhase + d * period; t < bassFlux.length; t += 4 * period) {
      score += bassFlux[Math.round(t)] ?? 0;
    }
    if (score > bestDbScore) {
      bestDbScore = score;
      bestDb = d;
    }
  }

  const firstDownbeatFrame = bestPhase + bestDb * period;
  return firstDownbeatFrame / frameRate; // seconds
}

/* ── key via Krumhansl–Schmuckler profiles ────────────────── */

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Camelot wheel: index = pitch class of tonic
const CAMELOT_MAJOR: Record<string, string> = {
  B: "1B", "F#": "2B", "C#": "3B", "G#": "4B", "D#": "5B", "A#": "6B",
  F: "7B", C: "8B", G: "9B", D: "10B", A: "11B", E: "12B",
};
const CAMELOT_MINOR: Record<string, string> = {
  "G#": "1A", "D#": "2A", "A#": "3A", F: "4A", C: "5A", G: "6A",
  D: "7A", A: "8A", E: "9A", B: "10A", "F#": "11A", "C#": "12A",
};

function correlate(chroma: Float32Array, profile: number[], rot: number): number {
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) {
    const x = chroma[(i + rot) % 12];
    const y = profile[i];
    sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
  }
  const cov = sxy - (sx * sy) / 12;
  const den = Math.sqrt((sxx - (sx * sx) / 12) * (syy - (sy * sy) / 12));
  return den > 0 ? cov / den : 0;
}

function detectKey(chroma: Float32Array): { key: string; camelot: string; mode: "major" | "minor" } {
  let best = { score: -Infinity, tonic: 0, minor: false };
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = correlate(chroma, MAJOR_PROFILE, tonic);
    const min = correlate(chroma, MINOR_PROFILE, tonic);
    if (maj > best.score) best = { score: maj, tonic, minor: false };
    if (min > best.score) best = { score: min, tonic, minor: true };
  }
  const name = NOTE_NAMES[best.tonic];
  const key = best.minor ? `${name}m` : name;
  const camelot = best.minor ? CAMELOT_MINOR[name] : CAMELOT_MAJOR[name];
  return { key, camelot: camelot ?? "?", mode: best.minor ? "minor" : "major" };
}

/** Harmonic compatibility 0..1 from Camelot codes (1 = same/adjacent). */
export function camelotCompatibility(a: string, b: string): number {
  const pa = /^(\d+)([AB])$/.exec(a);
  const pb = /^(\d+)([AB])$/.exec(b);
  if (!pa || !pb) return 0.5;
  const na = parseInt(pa[1], 10);
  const nb = parseInt(pb[1], 10);
  const ringDist = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  const sameLetter = pa[2] === pb[2];
  if (ringDist === 0) return sameLetter ? 1 : 0.9;
  if (ringDist === 1 && sameLetter) return 0.85;
  if (ringDist === 2 && sameLetter) return 0.5;
  return Math.max(0, 0.4 - ringDist * 0.05);
}

/* ── energy contour + mix regions ─────────────────────────── */

function mixRegions(rms: Float32Array): { mixIn: number; mixOut: number; energy: Float32Array } {
  const n = rms.length;
  const energy = new Float32Array(n);
  // smooth with ±4 s window
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) {
      sum += rms[j];
      c++;
    }
    energy[i] = sum / c;
  }
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, energy[i]);
  if (max > 0) for (let i = 0; i < n; i++) energy[i] /= max;

  const thresh = 0.5;
  let mixIn = 0;
  for (let i = 0; i < n; i++) {
    if (energy[i] >= thresh) {
      mixIn = i;
      break;
    }
  }
  let mixOut = n - 1;
  for (let i = n - 1; i >= 0; i--) {
    if (energy[i] >= thresh) {
      mixOut = i;
      break;
    }
  }
  return { mixIn, mixOut, energy };
}

/* ── entry point ──────────────────────────────────────────── */

export async function analyseTrack(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const mono = await toMono(buffer);
  const frames = analyseFrames(mono);
  const bpm = detectTempo(frames.flux);
  const firstDownbeat = fitBeatPhase(frames.flux, frames.bassFlux, bpm);
  const { key, camelot, mode } = detectKey(frames.chroma);
  const { mixIn, mixOut, energy } = mixRegions(frames.rmsPerSec);

  const base = {
    bpm,
    firstDownbeat,
    beatInterval: 60 / bpm,
    key,
    camelot,
    mode,
    energy,
    bands: { low: frames.bandLow, mid: frames.bandMid, high: frames.bandHigh },
    fluxPerSec: frames.fluxPerSec,
    mixInPoint: mixIn,
    mixOutPoint: mixOut,
    duration: buffer.duration,
  };
  return { ...base, sections: analyzeStructure(base) };
}

export interface RegionProfile {
  /** band shares, sum to 1 */
  low: number;
  mid: number;
  high: number;
  /** onset flux vs the track's average (1 = typical, >1.3 = percussive) */
  percussive: number;
}

/** Spectral character of a region — used to pick the entry element and FX. */
export function regionProfile(a: TrackAnalysis, t0: number, t1: number): RegionProfile {
  const s0 = Math.max(0, Math.floor(t0));
  const s1 = Math.min(a.bands.low.length - 1, Math.ceil(t1));
  let low = 0;
  let mid = 0;
  let high = 0;
  let flux = 0;
  let n = 0;
  for (let s = s0; s <= s1; s++) {
    low += a.bands.low[s];
    mid += a.bands.mid[s];
    high += a.bands.high[s];
    flux += a.fluxPerSec[s];
    n++;
  }
  const total = low + mid + high || 1;
  return { low: low / total, mid: mid / total, high: high / total, percussive: n ? flux / n : 1 };
}

/* ── musical structure ────────────────────────────────────── */

interface PhraseStats {
  start: number;
  end: number;
  energy: number;
  bassShare: number;
  flux: number;
  /** energy slope inside the phrase (last half − first half) */
  rise: number;
}

/**
 * Section classifier: chop the track into 32-beat phrases, place section
 * boundaries where the feature profile (energy / bass share / onset
 * density) jumps, then label each section with DJ vocabulary —
 * INTRO · BUILD · DROP · BREAKDOWN · GROOVE · OUTRO.
 */
export function analyzeStructure(a: Omit<TrackAnalysis, "sections">): Section[] {
  const phraseLen = 32 * a.beatInterval;
  if (!isFinite(phraseLen) || phraseLen <= 0 || a.duration < phraseLen) {
    return [{ start: 0, end: a.duration, label: "GROOVE" }];
  }

  const statsOf = (t0: number, t1: number): PhraseStats => {
    const s0 = Math.max(0, Math.floor(t0));
    const s1 = Math.max(s0 + 1, Math.min(a.energy.length, Math.ceil(t1)));
    let e = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    let fl = 0;
    let n = 0;
    let eFirst = 0;
    let eLast = 0;
    let nHalf = 0;
    const half = (s0 + s1) / 2;
    for (let s = s0; s < s1; s++) {
      e += a.energy[s];
      low += a.bands.low[s];
      mid += a.bands.mid[s];
      high += a.bands.high[s];
      fl += a.fluxPerSec[s];
      n++;
      if (s < half) {
        eFirst += a.energy[s];
        nHalf++;
      } else {
        eLast += a.energy[s];
      }
    }
    const total = low + mid + high || 1;
    return {
      start: t0,
      end: t1,
      energy: n ? e / n : 0,
      bassShare: low / total,
      flux: n ? fl / n : 0,
      rise: nHalf && n - nHalf ? eLast / (n - nHalf) - eFirst / nHalf : 0,
    };
  };

  // per-phrase stats on the downbeat-aligned phrase grid
  const phrases: PhraseStats[] = [];
  let t = a.firstDownbeat > phraseLen / 2 ? a.firstDownbeat - phraseLen : a.firstDownbeat;
  t = Math.max(0, t);
  if (t > 1) phrases.push(statsOf(0, t)); // pickup before the first phrase
  for (; t < a.duration - 1; t += phraseLen) {
    phrases.push(statsOf(t, Math.min(a.duration, t + phraseLen)));
  }
  if (phrases.length === 0) return [{ start: 0, end: a.duration, label: "GROOVE" }];

  // boundaries where the profile jumps between consecutive phrases
  const groups: PhraseStats[][] = [[phrases[0]]];
  for (let i = 1; i < phrases.length; i++) {
    const p = phrases[i - 1];
    const q = phrases[i];
    const jump =
      Math.abs(q.energy - p.energy) * 1.6 +
      Math.abs(q.bassShare - p.bassShare) * 2.2 +
      Math.abs(q.flux - p.flux) * 0.5;
    if (jump > 0.38) groups.push([q]);
    else groups[groups.length - 1].push(q);
  }

  // collapse groups to section stats
  const merged = groups.map((g) => {
    const s = statsOf(g[0].start, g[g.length - 1].end);
    return s;
  });

  // track-level reference levels
  const bassVals = merged.map((m) => m.bassShare).sort((x, y) => x - y);
  const medianBass = bassVals[Math.floor(bassVals.length / 2)] || 0.33;

  const labels: SectionLabel[] = merged.map((m, i) => {
    const isFirst = i === 0;
    const isLast = i === merged.length - 1;
    const next = merged[i + 1];
    const prev = merged[i - 1];

    if (isLast && (m.energy < 0.55 || m.rise < -0.12)) return "OUTRO";
    if (isFirst && m.energy < 0.55) return "INTRO";
    // sparse low end + quieter → breakdown, unless it's climbing into a peak
    if (m.bassShare < medianBass * 0.65 && m.energy < 0.7 && !isFirst && !isLast) {
      if (next && next.energy > m.energy + 0.15) return "BUILD";
      return "BREAKDOWN";
    }
    if (m.rise > 0.14 && next && next.energy > m.energy + 0.08) return "BUILD";
    if (m.energy >= 0.72 && m.bassShare >= medianBass * 0.85) {
      return "DROP";
    }
    // high energy right after a build/breakdown still counts as the drop
    if (m.energy >= 0.65 && prev && (prev.bassShare < medianBass * 0.65 || prev.rise > 0.14)) {
      return "DROP";
    }
    return "GROOVE";
  });

  // merge consecutive same-label sections
  const sections: Section[] = [];
  for (let i = 0; i < merged.length; i++) {
    const last = sections[sections.length - 1];
    if (last && last.label === labels[i]) last.end = merged[i].end;
    else sections.push({ start: merged[i].start, end: merged[i].end, label: labels[i] });
  }
  return sections;
}

/** Snap a time (s) to the nearest phrase boundary (32 beats) at or after `t`. */
export function nextPhraseBoundary(a: TrackAnalysis, t: number, phraseBeats = 32): number {
  const rel = (t - a.firstDownbeat) / a.beatInterval;
  const phrase = Math.ceil(rel / phraseBeats);
  return a.firstDownbeat + phrase * phraseBeats * a.beatInterval;
}

/** Snap to nearest downbeat at or after `t`. */
export function nextDownbeat(a: TrackAnalysis, t: number): number {
  const rel = (t - a.firstDownbeat) / (a.beatInterval * 4);
  return a.firstDownbeat + Math.ceil(rel) * a.beatInterval * 4;
}

/**
 * The track's "lift" — where the waveform first reaches SUSTAINED high
 * energy (the drop / first chorus). Found by scanning the smoothed energy
 * contour for a strong onset that holds for at least 8 seconds, then
 * snapping to the downbeat grid.
 */
export function findLiftPoint(a: TrackAnalysis): number {
  const e = a.energy;
  const end = e.length - 8; // full track — the biggest moment can be late
  for (let t = Math.max(0, Math.floor(a.mixInPoint)); t < end; t++) {
    if (e[t] >= 0.78) {
      let sum = 0;
      for (let j = t; j < t + 8; j++) sum += e[j];
      if (sum / 8 >= 0.72) return nextDownbeat(a, Math.max(a.firstDownbeat, t - 0.5));
    }
  }
  // no clear drop — assume the music settles 32 beats after the intro
  return nextDownbeat(a, a.mixInPoint + 32 * a.beatInterval);
}

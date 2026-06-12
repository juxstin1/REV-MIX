/**
 * AutoMix — plans and executes intentional, phrase-aligned transitions.
 *
 * The model first scores the pair (tempo, harmony, energy, placement),
 * then chooses a transition STYLE to fit the material:
 *
 *  ELEMENT_BLEND — long 64-beat blend. The incoming track enters as a
 *    single element (filtered highs or mids only), unfolds in phases
 *    (mids open → bass swap → outgo highs ease), and the outgoing track
 *    leaves through a tempo-synced echo tail.
 *  REVERB_WASH — for energy drops / ambient incomings: the outgoing track
 *    dissolves into reverb (dark IR for minor keys, bright for major)
 *    under a lowpass sweep while the new track rises.
 *  ECHO_OUT — only when tempos are irreconcilable (>9% stretch): cut on
 *    the phrase with a beat-synced delay tail, incoming starts clean at
 *    native tempo.
 *
 * Beat-lock: the incoming deck holds its matched rate for the WHOLE
 * overlap (zero drift), then glides to native tempo after the old track
 * is gone.
 */

import {
  TrackAnalysis,
  camelotCompatibility,
  nextPhraseBoundary,
  nextDownbeat,
  regionProfile,
  findLiftPoint,
} from "./analysis";

/* ── structural anchors ───────────────────────────────────── */

/** Where the incoming track should peak: its first DROP, else first
 *  GROOVE, else the raw energy lift (fallback for unlabelled material). */
function incomingAnchor(to: TrackAnalysis): { t: number; label: string } {
  const drop = to.sections.find((s) => s.label === "DROP");
  if (drop) return { t: nextDownbeat(to, Math.max(to.firstDownbeat, drop.start - 0.5)), label: "DROP" };
  const groove = to.sections.find((s) => s.label === "GROOVE");
  if (groove)
    return { t: nextDownbeat(to, Math.max(to.firstDownbeat, groove.start - 0.5)), label: "GROOVE" };
  return { t: findLiftPoint(to), label: "LIFT" };
}

/** Where the outgoing track wants to leave: its OUTRO start, else the
 *  energy-derived mix-out point. */
function exitAnchor(from: TrackAnalysis): number {
  const outro = from.sections.find((s) => s.label === "OUTRO");
  return outro ? outro.start : from.mixOutPoint;
}
import { MixerEngine, DeckId } from "./engine";

export type TransitionStyle = "ELEMENT_BLEND" | "REVERB_WASH" | "ECHO_OUT";
export type EntryElement = "HIGHS" | "MIDS";

export interface TransitionPlan {
  fromDeck: DeckId;
  toDeck: DeckId;
  style: TransitionStyle;
  /** which element of the incoming track leads (ELEMENT_BLEND only) */
  entry: EntryElement;
  /** position (s, track time) on outgoing track where the blend starts */
  startAtFrom: number;
  /** position (s, track time) on incoming track where it enters */
  startAtTo: number;
  /** blend length in beats of the outgoing track */
  beats: number;
  /** blend length in seconds (outgoing tempo) */
  seconds: number;
  /** blend beat where the bass hands over — aligned to the incoming lift */
  swapBeat: number;
  /** position (s, incoming track time) of the incoming track's lift/drop */
  liftAtTo: number;
  /** playbackRate for the incoming deck during the overlap */
  matchRate: number;
  /** 0..1 — the model's confidence in this transition */
  score: number;
  /** the feature breakdown behind the score (tempo/harmony/energy/placement) */
  features: MixFeatures;
  /** 0..1 — predicted vocal overlap during the blend */
  vocalClash: number;
  /** whether both tracks had vocal analysis available when planned */
  vocalsKnown: boolean;
  /** human-readable reasoning, shown in the UI */
  notes: string[];
}

/** Lifecycle of a firing transition, emitted by the scheduler (never inferred
 *  by the UI). */
export type TransitionPhase = "ARMING" | "BLENDING" | "BASS_SWAP" | "ECHO_OUT" | "COMPLETE";

/**
 * Read-only snapshot the CDJ HUD renders. It carries the engine's own scores
 * and the scheduled AudioContext times — the UI computes nothing here except
 * a clock countdown. Build it from a plan with {@link hudFromPlan}.
 */
export interface TransitionHud {
  active: boolean;
  fromDeck: DeckId;
  toDeck: DeckId;
  style: TransitionStyle;
  confidence: number; // 0..1
  bpmScore: number; // 0..1 tempo affinity
  keyScore: number; // 0..1 harmonic affinity
  energyScore: number; // 0..1 energy continuity
  vocalClash: number; // 0..1
  vocalsKnown: boolean;
  phase: TransitionPhase;
  mixInAt: number; // ctx time the blend starts
  bassSwapAt?: number; // ctx time the bass hands over
  dropAt?: number; // ctx time the incoming track hits its drop
  mixOutAt: number; // ctx time the outgoing track is gone
}

/** Map a plan + scheduled times into a HUD snapshot. Centralised here so the
 *  UI never re-derives transition decisions. */
export function hudFromPlan(
  plan: TransitionPlan,
  t: {
    active: boolean;
    phase: TransitionPhase;
    mixInAt: number;
    bassSwapAt?: number;
    dropAt?: number;
    mixOutAt: number;
  }
): TransitionHud {
  return {
    active: t.active,
    fromDeck: plan.fromDeck,
    toDeck: plan.toDeck,
    style: plan.style,
    confidence: plan.score,
    bpmScore: plan.features.tempoAffinity,
    keyScore: plan.features.harmonicAffinity,
    energyScore: plan.features.energyContinuity,
    vocalClash: plan.vocalClash,
    vocalsKnown: plan.vocalsKnown,
    phase: t.phase,
    mixInAt: t.mixInAt,
    bassSwapAt: t.bassSwapAt,
    dropAt: t.dropAt,
    mixOutAt: t.mixOutAt,
  };
}

export interface MixFeatures {
  tempoAffinity: number;
  harmonicAffinity: number;
  energyContinuity: number;
  placement: number;
}

/**
 * The "golden" transition profile — every tunable dial behind the automix,
 * frozen in one place. THIS IS THE LOCKED DEFAULT. Do not tweak these numbers
 * in place: if you want to experiment, copy this to a new named profile and
 * switch to it, so the golden behaviour is always recoverable.
 */
export interface TransitionProfile {
  name: string;
  /** scoring weights — must sum to ~1 */
  weights: { tempo: number; harmonic: number; energy: number; placement: number };
  /** how hard a vocal clash dents the score (1 = a full duet halves it twice) */
  vocalPenalty: number;
  /** max tempo stretch before we refuse to beatmatch (1.12 = ±12%) */
  maxStretchPct: number;
  /** tempo-affinity falloff: 0 score at this folded log2 ratio */
  tempoTolerance: number;
  /** energy-continuity sensitivity */
  energyFactor: number;
  /** placement window = max(min, duration*frac) seconds around the exit */
  placementWindowFrac: number;
  placementWindowMin: number;
  /** blend length in beats, per style */
  blendBeats: { ELEMENT_BLEND: number; REVERB_WASH: number; ECHO_OUT: number };
  /** where in the blend the bass hands over, as a fraction of its length */
  entrySwapFrac: { ELEMENT_BLEND: number; REVERB_WASH: number };
  /** reverb-wash triggers: incoming this much lower, or both ends below floor */
  washEnergyDrop: number;
  washLowEnergy: number;
  /** highs-first entry when the intro is this bright or this percussive */
  entryHighThresh: number;
  entryPercThresh: number;
}

export const GOLDEN_PROFILE: Readonly<TransitionProfile> = Object.freeze({
  name: "golden-v1",
  weights: { tempo: 0.34, harmonic: 0.27, energy: 0.21, placement: 0.18 },
  vocalPenalty: 0.5,
  maxStretchPct: 1.12,
  tempoTolerance: 0.23,
  energyFactor: 1.6,
  placementWindowFrac: 0.18,
  placementWindowMin: 20,
  blendBeats: { ELEMENT_BLEND: 64, REVERB_WASH: 32, ECHO_OUT: 8 },
  entrySwapFrac: { ELEMENT_BLEND: 0.625, REVERB_WASH: 0.5 },
  washEnergyDrop: 0.22,
  washLowEnergy: 0.45,
  entryHighThresh: 0.3,
  entryPercThresh: 1.25,
});

/** the live profile (currently always the golden default) */
const P = GOLDEN_PROFILE;

const W = P.weights;
const W_VOX = P.vocalPenalty;
// keylock playback preserves pitch, so a wider stretch stays musical
const MAX_STRETCH = Math.log2(P.maxStretchPct); // before we refuse to beatmatch

export function scorePair(
  from: TrackAnalysis,
  to: TrackAnalysis,
  startAtFrom: number,
  blendSeconds: number
): { score: number; features: MixFeatures } {
  // tempo: 1 at equal BPM, 0 at ~16% apart (allow half/double time)
  const ratio = Math.abs(Math.log2(to.bpm / from.bpm));
  const foldedRatio = Math.min(ratio, Math.abs(ratio - 1));
  const tempoAffinity = Math.max(0, 1 - foldedRatio / P.tempoTolerance);

  const harmonicAffinity = camelotCompatibility(from.camelot, to.camelot);

  // energy continuity at the seam
  const eFrom = energyAt(from, startAtFrom);
  const eTo = energyAt(to, to.mixInPoint + 16 * to.beatInterval);
  const energyContinuity = 1 - Math.min(1, Math.abs(eFrom - eTo) * P.energyFactor);

  // placement: the blend's MIDPOINT should sit near the structural exit
  const mid = startAtFrom + blendSeconds / 2;
  const distToOutro = Math.abs(mid - exitAnchor(from));
  const placement = Math.max(
    0,
    1 - distToOutro / Math.max(P.placementWindowMin, from.duration * P.placementWindowFrac)
  );

  const features = { tempoAffinity, harmonicAffinity, energyContinuity, placement };
  const score =
    W.tempo * tempoAffinity +
    W.harmonic * harmonicAffinity +
    W.energy * energyContinuity +
    W.placement * placement;
  return { score, features };
}

function energyAt(a: TrackAnalysis, t: number): number {
  const i = Math.max(0, Math.min(a.energy.length - 1, Math.round(t)));
  return a.energy[i] ?? 0;
}

function vocalsAt(a: TrackAnalysis, t: number): number {
  if (!a.vocals || a.vocals.length === 0) return 0;
  const i = Math.max(0, Math.min(a.vocals.length - 1, Math.round(t)));
  return a.vocals[i] ?? 0;
}

/**
 * How much the two vocals would sing over each other during the blend:
 * mean of vocalA(t) × vocalB(t') across the overlap (0 = clean, 1 = full
 * duet). Incoming track time advances at matchRate per wall second.
 */
function vocalClash(
  from: TrackAnalysis,
  to: TrackAnalysis,
  startAtFrom: number,
  seconds: number,
  startAtTo: number,
  matchRate: number
): number {
  if (!from.vocals || !to.vocals) return 0;
  let acc = 0;
  let n = 0;
  for (let dt = 0; dt < seconds; dt += 1) {
    acc += vocalsAt(from, startAtFrom + dt) * vocalsAt(to, startAtTo + dt * matchRate);
    n++;
  }
  return n ? acc / n : 0;
}

function tempoMatchRate(from: TrackAnalysis, to: TrackAnalysis): number {
  let r = from.bpm / to.bpm;
  if (r > 1.5) r /= 2;
  if (r < 0.66) r *= 2;
  return r;
}

interface StyleChoice {
  style: TransitionStyle;
  entry: EntryElement;
  beats: number;
  fxNote: string;
}

/** which element leads, from what the incoming intro actually contains */
function introEntry(to: TrackAnalysis): EntryElement {
  const intro = regionProfile(to, to.mixInPoint, to.mixInPoint + 32 * to.beatInterval);
  return intro.high > P.entryHighThresh || intro.percussive > P.entryPercThresh ? "HIGHS" : "MIDS";
}

function chooseStyle(from: TrackAnalysis, to: TrackAnalysis): StyleChoice {
  const rate = tempoMatchRate(from, to);
  const stretch = Math.abs(Math.log2(rate));

  if (stretch > MAX_STRETCH) {
    return {
      style: "ECHO_OUT",
      entry: "HIGHS",
      beats: P.blendBeats.ECHO_OUT,
      fxNote: `tempos too far (${from.bpm.toFixed(0)}→${to.bpm.toFixed(0)}) — clean echo cut`,
    };
  }

  const eFrom = energyAt(from, from.mixOutPoint);
  const eTo = energyAt(to, to.mixInPoint + 16 * to.beatInterval);
  if (eTo < eFrom - P.washEnergyDrop || (eFrom < P.washLowEnergy && eTo < P.washLowEnergy)) {
    const colour = to.mode === "minor" ? "dark" : "bright";
    return {
      style: "REVERB_WASH",
      entry: "MIDS",
      beats: P.blendBeats.REVERB_WASH,
      fxNote: `energy drop — ${colour} reverb wash (${to.key})`,
    };
  }

  // element blend: lead with the element the incoming intro actually has
  const entry = introEntry(to);
  return {
    style: "ELEMENT_BLEND",
    entry,
    beats: P.blendBeats.ELEMENT_BLEND,
    fxNote: `${entry === "HIGHS" ? "percussion-first" : "melody-first"} entry, echo tail out`,
  };
}

/** Build the choice for an explicitly requested style (REPLAY — "do that kind
 *  of thing again"). Leaves the default decision path untouched. */
function forcedChoice(to: TrackAnalysis, style: TransitionStyle): StyleChoice {
  if (style === "ECHO_OUT") return { style, entry: "HIGHS", beats: P.blendBeats.ECHO_OUT, fxNote: "replay · echo cut" };
  if (style === "REVERB_WASH") return { style, entry: "MIDS", beats: P.blendBeats.REVERB_WASH, fxNote: "replay · reverb wash" };
  const entry = introEntry(to);
  return { style: "ELEMENT_BLEND", entry, beats: P.blendBeats.ELEMENT_BLEND, fxNote: "replay · element blend" };
}

/**
 * Plan the best transition from the playing deck to the loaded deck.
 * Style and length are chosen from the material; the start point is the
 * phrase boundary whose blend window scores highest.
 */
export function planTransition(
  fromDeck: DeckId,
  from: TrackAnalysis,
  to: TrackAnalysis,
  currentPos: number,
  forceNow = false,
  forceStyle?: TransitionStyle
): TransitionPlan {
  const toDeck: DeckId = fromDeck === "A" ? "B" : "A";
  const choice = forceStyle ? forcedChoice(to, forceStyle) : chooseStyle(from, to);

  // fit the blend inside the remaining runway
  const fitBeats = (start: number): number => {
    const room = Math.floor((from.duration - 2 - start) / from.beatInterval);
    let b = Math.min(choice.beats, Math.max(8, Math.floor(room / 8) * 8));
    if (choice.style === "ELEMENT_BLEND" && b < 16) b = Math.min(16, room);
    return Math.max(4, b);
  };

  const matchRate = choice.style === "ECHO_OUT" ? 1 : tempoMatchRate(from, to);

  // ── structure-aware entry: target the incoming track's first DROP
  // section (or GROOVE / raw lift as fallbacks) and time the blend so it
  // lands exactly on the bass handover beat. While rates are matched,
  // N incoming beats = N outgoing beats in real time — exact alignment.
  const anchor = incomingAnchor(to);
  const lift = anchor.t;
  const entryFor = (b: number): { swapBeat: number; startAtTo: number } => {
    if (choice.style === "ECHO_OUT") {
      // cut straight into the meat of the new track
      return { swapBeat: 0, startAtTo: lift };
    }
    const frac =
      choice.style === "ELEMENT_BLEND" ? P.entrySwapFrac.ELEMENT_BLEND : P.entrySwapFrac.REVERB_WASH;
    const ideal = Math.round((b * frac) / 8) * 8;
    const liftBeats = Math.floor((lift - to.firstDownbeat) / to.beatInterval / 8) * 8;
    const swapBeat = Math.max(8, Math.min(ideal, b - 8, Math.max(8, liftBeats)));
    return { swapBeat, startAtTo: Math.max(to.firstDownbeat, lift - swapBeat * to.beatInterval) };
  };

  // candidate starts: phrase boundaries such that the blend midpoint
  // brackets the structural exit — each scored with the vocal-clash
  // penalty so the blend shifts to where the two vocals don't fight
  const idealStart = exitAnchor(from) - (choice.beats * from.beatInterval) / 2;
  const earliest = forceNow
    ? nextPhraseBoundary(from, currentPos + 1.5)
    : Math.max(currentPos + 1.5, idealStart - 32 * from.beatInterval);

  let bestStart = nextPhraseBoundary(from, earliest);
  let bestScore = -1;
  let bestFeatures: MixFeatures | null = null;
  let bestClash = 0;
  for (let i = 0; i < 4; i++) {
    const t = nextPhraseBoundary(from, earliest) + i * 32 * from.beatInterval;
    const b = fitBeats(t);
    if (b < 4 || t + b * from.beatInterval > from.duration - 1) break;
    const e = entryFor(b);
    const { score, features } = scorePair(from, to, t, b * from.beatInterval);
    const clash = vocalClash(from, to, t, b * from.beatInterval, e.startAtTo, matchRate);
    const penalised = score - W_VOX * clash;
    if (penalised > bestScore) {
      bestScore = penalised;
      bestStart = t;
      bestFeatures = features;
      bestClash = clash;
    }
    if (forceNow) break;
  }

  const beats = fitBeats(bestStart);
  const f = bestFeatures ?? scorePair(from, to, bestStart, beats * from.beatInterval).features;
  const { swapBeat, startAtTo } = entryFor(beats);

  const voxKnown = !!from.vocals && !!to.vocals;
  const notes = [
    choice.style.replace("_", " "),
    `${beats} beats`,
    `tempo ${from.bpm.toFixed(1)}→${to.bpm.toFixed(1)} (${((matchRate - 1) * 100).toFixed(1)}% stretch)`,
    `keys ${from.camelot}→${to.camelot} (${(f.harmonicAffinity * 100) | 0}%)`,
    choice.style === "ECHO_OUT"
      ? `entering at the ${anchor.label}`
      : `${anchor.label} lands on bass @ beat ${swapBeat}`,
    voxKnown ? `vocal clash ${(bestClash * 100) | 0}%` : "vocals: analysing…",
    choice.fxNote,
  ];

  return {
    fromDeck,
    toDeck,
    style: choice.style,
    entry: choice.entry,
    startAtFrom: bestStart,
    startAtTo,
    beats,
    seconds: beats * from.beatInterval,
    swapBeat,
    liftAtTo: lift,
    matchRate,
    score: Math.max(0, bestScore),
    features: f,
    vocalClash: bestClash,
    vocalsKnown: voxKnown,
    notes,
  };
}

export interface ScheduledTransition extends TransitionPlan {
  ctxStart: number; // blend start (MIX IN)
  ctxSwap: number; // bass handover
  ctxDrop: number; // incoming track's drop
  ctxEcho: number; // exit phase (echo / wash)
  ctxEnd: number; // outgoing gone (MIX OUT)
  cancel: () => void;
}

/** A flight-recorder snapshot of one fired transition — what actually happened,
 *  so a great mix can be recognised and repeated. Times are seconds relative to
 *  MIX IN. */
export interface TransitionTelemetry {
  style: TransitionStyle;
  profile: string;
  outBpm: number;
  inBpm: number;
  pitchShiftPct: number;
  confidence: number;
  beats: number;
  vocalClash: number;
  bassSwapSec: number;
  mixOutSec: number;
}

/**
 * Thresholds for auto-flagging a transition as risky. These tune which mixes
 * land in the REVIEW pile — they are diagnostics, NOT audio DSP. Feedback
 * collected here is meant to refine transition CHOICE later (style/timing/
 * tolerances), never to mutate the stretcher or FX.
 */
export const REVIEW_THRESHOLDS = Object.freeze({
  minConfidence: 0.55,
  maxVocalClash: 0.4,
  maxPitchShift: 5.0,
  /** a long ELEMENT_BLEND is the worst place for a big stretch (most exposure) */
  blendPitchShift: 4.5,
});

export type RiskCode = "LOW_CONFIDENCE" | "VOCAL_CLASH" | "HIGH_PITCH" | "LONG_BLEND_PITCH";

export const RISK_LABEL: Record<RiskCode, string> = {
  LOW_CONFIDENCE: "LOW CONFIDENCE",
  VOCAL_CLASH: "VOCAL CLASH",
  HIGH_PITCH: "HIGH PITCH",
  LONG_BLEND_PITCH: "LONG BLEND + PITCH",
};

/** Pure: which auto-risk flags apply to a fired transition's telemetry. */
export function transitionRisk(t: TransitionTelemetry): RiskCode[] {
  const r: RiskCode[] = [];
  const pitch = Math.abs(t.pitchShiftPct);
  if (t.confidence < REVIEW_THRESHOLDS.minConfidence) r.push("LOW_CONFIDENCE");
  if (t.vocalClash > REVIEW_THRESHOLDS.maxVocalClash) r.push("VOCAL_CLASH");
  if (pitch > REVIEW_THRESHOLDS.maxPitchShift) r.push("HIGH_PITCH");
  if (t.style === "ELEMENT_BLEND" && pitch > REVIEW_THRESHOLDS.blendPitchShift) r.push("LONG_BLEND_PITCH");
  return r;
}

export function telemetryFromSched(s: ScheduledTransition, outBpm: number, inBpm: number): TransitionTelemetry {
  return {
    style: s.style,
    profile: P.name,
    outBpm,
    inBpm,
    pitchShiftPct: (s.matchRate - 1) * 100,
    confidence: s.score,
    beats: s.beats,
    vocalClash: s.vocalClash,
    bassSwapSec: s.ctxSwap - s.ctxStart,
    mixOutSec: s.ctxEnd - s.ctxStart,
  };
}

/** dotted-eighth for bright/major material, quarter for moody/minor */
function delayTimeFor(a: TrackAnalysis): { time: number; feedback: number; label: string } {
  const beat = a.beatInterval;
  return a.mode === "major"
    ? { time: beat * 0.75, feedback: 0.42, label: "dotted-8th echo" }
    : { time: beat, feedback: 0.55, label: "1/4-note echo" };
}

export function scheduleTransition(
  engine: MixerEngine,
  plan: TransitionPlan,
  fromAnalysis: TrackAnalysis,
  toAnalysis: TrackAnalysis,
  onDone: () => void,
  onPhase: (phase: TransitionPhase) => void = () => {}
): ScheduledTransition {
  const ctx = engine.ctx;
  const fromDeck = engine.decks[plan.fromDeck];
  const pos = engine.position(plan.fromDeck);

  const lead = (plan.startAtFrom - pos) / fromDeck.rate;
  const t0 = ctx.currentTime + Math.max(0.05, lead);
  const dur = plan.seconds;
  const t1 = t0 + dur;
  const bi = plan.seconds / plan.beats; // one outgoing beat, in seconds
  const target = plan.toDeck === "B" ? 1 : 0;
  const origin = engine.crossfader;

  const timers: number[] = [];
  const after = (when: number, fn: () => void) =>
    timers.push(window.setTimeout(fn, Math.max(0, (when - ctx.currentTime) * 1000)));

  if (plan.style === "ELEMENT_BLEND") {
    // ── entry: one element only, faded in from silence ──
    engine.rampEqDb(plan.toDeck, "low", -26, 0.01);
    if (plan.entry === "HIGHS") {
      // percussion-first: 12-beat fade under a 24-beat highpass sweep
      engine.scheduleFaderFadeIn(plan.toDeck, t0, 12 * bi);
      timers.push(...engine.scheduleFilterSweep(plan.toDeck, "highpass", 1300, 25, t0, 24 * bi, true));
    } else {
      // melody-first: mids fade in over 12 beats, highs open at beat 16
      engine.scheduleFaderFadeIn(plan.toDeck, t0, 12 * bi);
      engine.rampEqDb(plan.toDeck, "high", -14, 0.01);
      engine.rampEqDb(plan.toDeck, "high", 0, 8 * bi, t0 + 16 * bi);
    }
    engine.play(plan.toDeck, plan.startAtTo, t0, plan.matchRate);

    // ── crossfader: slow S-curve across the full blend ──
    engine.scheduleXfadeCurve([
      { t: t0, v: origin },
      { t: t0 + 16 * bi, v: origin + (target - origin) * 0.3 },
      { t: t0 + 32 * bi, v: origin + (target - origin) * 0.55 },
      { t: t0 + 48 * bi, v: origin + (target - origin) * 0.8 },
      { t: t1, v: target },
    ]);

    // ── bass handover, aligned to the incoming track's lift ──
    // outgoing low eases out over 4 beats; incoming low FADES in over 8,
    // starting 2 beats later — gradual, no slam, no mud
    const swapAt = t0 + plan.swapBeat * bi;
    engine.rampEqDb(plan.fromDeck, "low", -26, 4 * bi, swapAt);
    engine.rampEqDb(plan.toDeck, "low", 0, 8 * bi, swapAt + 2 * bi);

    // ── outgoing exit: highs ease, LP sweep, echo tail ──
    engine.rampEqDb(plan.fromDeck, "high", -10, 8 * bi, t0 + dur * 0.75);
    timers.push(
      ...engine.scheduleFilterSweep(plan.fromDeck, "lowpass", 18000, 320, t1 - 12 * bi, 12 * bi)
    );
    const echo = delayTimeFor(fromAnalysis);
    after(t1 - 8 * bi, () => {
      engine.prepareDelay(plan.fromDeck, echo.time / fromDeck.rate, echo.feedback);
      engine.rampDelayWet(plan.fromDeck, 0.4, 4 * bi);
    });
  } else if (plan.style === "REVERB_WASH") {
    engine.rampEqDb(plan.toDeck, "low", -26, 0.01);
    engine.scheduleFaderFadeIn(plan.toDeck, t0, 8 * bi);
    engine.play(plan.toDeck, plan.startAtTo, t0, plan.matchRate);

    engine.scheduleXfadeCurve([
      { t: t0, v: origin },
      { t: t0 + 8 * bi, v: origin + (target - origin) * 0.3 },
      { t: t0 + 24 * bi, v: origin + (target - origin) * 0.7 },
      { t: t1, v: target },
    ]);

    // outgoing dissolves: reverb up, lowpass down
    engine.setReverbCharacter(plan.fromDeck, toAnalysis.mode === "minor" ? "dark" : "bright");
    engine.rampReverbWet(plan.fromDeck, 0.5, 8 * bi, t0);
    timers.push(
      ...engine.scheduleFilterSweep(plan.fromDeck, "lowpass", 18000, 240, t0 + 8 * bi, 16 * bi)
    );

    const swapAt = t0 + plan.swapBeat * bi;
    engine.rampEqDb(plan.fromDeck, "low", -26, 4 * bi, swapAt);
    engine.rampEqDb(plan.toDeck, "low", 0, 6 * bi, swapAt + 2 * bi);
    engine.rampEqDb(plan.fromDeck, "high", -8, 8 * bi, t1 - 8 * bi);
  } else {
    // ECHO_OUT: cut on the phrase, tail rings, incoming starts clean & full
    engine.setFader(plan.toDeck, 1);
    const echo = delayTimeFor(fromAnalysis);
    engine.prepareDelay(plan.fromDeck, echo.time / fromDeck.rate, Math.max(0.55, echo.feedback));
    engine.rampDelayWet(plan.fromDeck, 0.6, 0.08, t0 - 0.1);
    engine.rampFaderGain(plan.fromDeck, 0, 1 * bi, t0 + 0.02);

    engine.play(plan.toDeck, plan.startAtTo, t0, 1);
    engine.scheduleXfadeCurve([
      { t: t0, v: origin },
      { t: t0 + 2 * bi, v: target },
    ]);
  }

  // ── phase emission for the HUD (authoritative — UI never infers this) ──
  const ctxSwap = t0 + plan.swapBeat * bi;
  const ctxDrop = t0 + (plan.liftAtTo - plan.startAtTo) / (plan.matchRate || 1);
  const ctxEcho = plan.style === "ECHO_OUT" ? t0 + bi : t1 - 8 * bi;
  after(t0, () => onPhase("BLENDING"));
  if (plan.style === "ECHO_OUT") {
    after(ctxEcho, () => onPhase("ECHO_OUT"));
  } else {
    after(ctxSwap, () => onPhase("BASS_SWAP"));
    after(ctxEcho, () => onPhase("ECHO_OUT"));
  }

  /* ── completion ─────────────────────────────────────────── */
  const endAt = plan.style === "ECHO_OUT" ? t0 + 10 * bi : t1;
  after(endAt + 0.08, () => {
    engine.stop(plan.fromDeck);
    engine.resetStrip(plan.fromDeck);
    // glide incoming to native tempo now that the old track is gone
    if (plan.matchRate !== 1) {
      engine.rampRate(plan.toDeck, 1, 16 * toAnalysis.beatInterval);
    }
    onPhase("COMPLETE");
    onDone();
  });

  const cancel = () => timers.forEach((t) => window.clearTimeout(t));
  return { ...plan, ctxStart: t0, ctxSwap, ctxDrop, ctxEcho, ctxEnd: endAt, cancel };
}


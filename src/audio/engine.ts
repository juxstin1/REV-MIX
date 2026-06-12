/**
 * Web Audio mixer engine — two decks, each with a full channel strip
 * (trim → 3-band EQ → sweep filter → channel fader), summed through an
 * equal-power crossfader into the master bus.
 *
 * Every knob/fader on screen drives an AudioParam here; the automix
 * scheduler automates the same params, so manual and auto control share
 * one signal path exactly like real hardware.
 */

export type DeckId = "A" | "B";

export interface ChannelStrip {
  trim: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  filter: BiquadFilterNode;
  fader: GainNode;
  xfade: GainNode;
  analyser: AnalyserNode;
  /** tempo-synced feedback delay, post-fader so tails ring after a cut */
  delay: DelayNode;
  delayFb: GainNode;
  delayWet: GainNode;
  /** convolution reverb, post-fader */
  reverb: ConvolverNode;
  reverbWet: GainNode;
  /** performance FX: tremolo gain stage + chorus (unison) parallel path */
  trem: GainNode;
  chorusDelay: DelayNode;
  chorusWet: GainNode;
  /** CRUSH waveshaper, in series (transparent when curve = null) */
  crush: WaveShaperNode;
  /** FLANGER feedback tap around the chorus delay (0 = off) */
  flangerFb: GainNode;
}

/** running performance-FX handles (LFOs, brake state, stutter timers) */
type Lfo = { osc: OscillatorNode; depth: GainNode };

interface PerfState {
  twister?: Lfo;
  trem?: Lfo;
  chorus?: Lfo;
  wub?: Lfo;
  gate?: Lfo;
  flanger?: Lfo;
  riser?: { noise: AudioBufferSourceNode; gain: GainNode };
  brakePrevRate?: number;
  brakeRestoreTimer?: number;
  stutter?: { timer: number; pos: number; startedAt: number; slice: number };
}

export interface Deck {
  id: DeckId;
  buffer: AudioBuffer | null;
  /** granular worklet player (created once the worklet module loads) */
  player: AudioWorkletNode | null;
  strip: ChannelStrip;
  playing: boolean;
  /** track position (s) when playback started/seeked */
  startOffset: number;
  /** ctx.currentTime when playback started */
  startCtxTime: number;
  /** current playback rate (tempo factor) */
  rate: number;
  /** master tempo (keylock): tempo changes don't change pitch */
  mt: boolean;
  /** active loop region (s, track time) */
  loop?: { start: number; end: number };
}

const EQ_MIN_DB = -26; // full kill
const EQ_MAX_DB = 6;

export class MixerEngine {
  readonly ctx: AudioContext;
  readonly decks: Record<DeckId, Deck>;
  readonly master: GainNode;
  readonly masterAnalyser: AnalyserNode;
  private xfadePos = 0.5;
  private workletReady: Promise<void>;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    this.decks = {
      A: this.makeDeck("A"),
      B: this.makeDeck("B"),
    };
    this.setCrossfader(0.5);

    // granular master-tempo players (one per deck, persistent)
    this.workletReady = this.ctx.audioWorklet
      .addModule("/stretch-processor.js")
      .then(() => {
        for (const id of ["A", "B"] as DeckId[]) {
          const d = this.decks[id];
          const node = new AudioWorkletNode(this.ctx, "stretch-player", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          node.connect(d.strip.trim);
          node.port.onmessage = (e) => {
            if (e.data?.type === "ended") {
              d.playing = false;
              d.startOffset = d.buffer?.duration ?? 0;
            }
          };
          d.player = node;
        }
      })
      .catch((e) => {
        console.error("stretch worklet failed to load", e);
      });
  }

  private makeDeck(id: DeckId): Deck {
    const c = this.ctx;
    const trim = c.createGain();
    trim.gain.value = 1;

    const low = c.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 250;

    const mid = c.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1200;
    mid.Q.value = 0.9;

    const high = c.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 3500;

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 22050; // bypass position
    filter.Q.value = 1.1;

    const fader = c.createGain();
    fader.gain.value = 1;

    const xfade = c.createGain();
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;

    // FX: synced feedback delay with damped loop
    const delay = c.createDelay(3);
    delay.delayTime.value = 0.4;
    const delayFb = c.createGain();
    delayFb.gain.value = 0;
    const delayDamp = c.createBiquadFilter();
    delayDamp.type = "lowpass";
    delayDamp.frequency.value = 3800;
    const delayWet = c.createGain();
    delayWet.gain.value = 0;

    // FX: convolution reverb (IR assigned when a wash is scheduled)
    const reverb = c.createConvolver();
    const reverbWet = c.createGain();
    reverbWet.gain.value = 0;

    // performance FX: tremolo gain stage + chorus parallel tap
    const trem = c.createGain();
    trem.gain.value = 1;
    const chorusDelay = c.createDelay(0.1);
    chorusDelay.delayTime.value = 0.018;
    const chorusWet = c.createGain();
    chorusWet.gain.value = 0;
    const flangerFb = c.createGain();
    flangerFb.gain.value = 0;

    // CRUSH sits in series; curve = null is a clean passthrough
    const crush = c.createWaveShaper();
    crush.oversample = "2x";

    trim.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(filter);
    filter.connect(crush);
    crush.connect(trem);
    trem.connect(fader);
    trem.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusWet.connect(fader);
    // flanger feedback loop around the chorus delay (silent until engaged)
    chorusDelay.connect(flangerFb);
    flangerFb.connect(chorusDelay);
    fader.connect(analyser);
    analyser.connect(xfade);
    // sends tap the post-fader signal: cutting the fader leaves tails ringing
    analyser.connect(delay);
    delay.connect(delayDamp);
    delayDamp.connect(delayFb);
    delayFb.connect(delay);
    delay.connect(delayWet);
    delayWet.connect(xfade);
    analyser.connect(reverb);
    reverb.connect(reverbWet);
    reverbWet.connect(xfade);
    xfade.connect(this.master);

    return {
      id,
      buffer: null,
      player: null,
      strip: {
        trim, low, mid, high, filter, fader, xfade, analyser,
        delay, delayFb, delayWet, reverb, reverbWet,
        trem, chorusDelay, chorusWet, crush, flangerFb,
      },
      playing: false,
      startOffset: 0,
      startCtxTime: 0,
      rate: 1,
      mt: true,
    };
  }

  private perf: Record<DeckId, PerfState> = { A: {}, B: {} };

  async resume() {
    if (this.ctx.state !== "running") await this.ctx.resume();
    await this.workletReady;
  }

  private post(id: DeckId, msg: Record<string, unknown>, transfer?: Transferable[]) {
    const p = this.decks[id].player;
    if (p) p.port.postMessage(msg, transfer ?? []);
  }

  load(id: DeckId, buffer: AudioBuffer) {
    const d = this.decks[id];
    this.stop(id);
    d.buffer = buffer;
    d.startOffset = 0;
    d.rate = 1;
    d.loop = undefined;
    // ship channel data to the worklet (copies, transferred)
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      channels.push(buffer.getChannelData(c).slice());
    }
    this.post(id, { type: "load", channels }, channels.map((c) => c.buffer));
    this.post(id, { type: "mode", preserve: d.mt });
  }

  /** current track position in seconds (loop-aware) */
  position(id: DeckId): number {
    const d = this.decks[id];
    let pos = d.playing
      ? // NOTE: approximation during rate ramps; the rAF UI loop tolerates it
        d.startOffset + (this.ctx.currentTime - d.startCtxTime) * d.rate
      : d.startOffset;
    if (d.loop && pos > d.loop.end) {
      const len = d.loop.end - d.loop.start;
      pos = d.loop.start + ((pos - d.loop.start) % len);
    }
    return pos;
  }

  /** engage a loop region; the player wraps sample-accurately */
  setLoop(id: DeckId, start: number, length: number) {
    const d = this.decks[id];
    // rebase bookkeeping so the wrap math starts clean
    d.startOffset = this.position(id);
    d.startCtxTime = this.ctx.currentTime;
    d.loop = { start, end: start + length };
    this.post(id, { type: "loop", start, end: start + length });
  }

  /** drop the loop — playback continues from the current (wrapped) spot */
  clearLoop(id: DeckId) {
    const d = this.decks[id];
    d.startOffset = this.position(id);
    d.startCtxTime = this.ctx.currentTime;
    d.loop = undefined;
    this.post(id, { type: "loop", start: -1, end: -1 });
  }

  play(id: DeckId, offset?: number, when?: number, rate?: number) {
    const d = this.decks[id];
    if (!d.buffer || !d.player) return;
    const r = rate ?? d.rate;
    const startAt = when ?? this.ctx.currentTime;
    const off = Math.max(0, offset ?? d.startOffset);
    this.post(id, { type: "play", offset: off, when: startAt, rate: r });
    d.playing = true;
    d.rate = r;
    d.startOffset = off;
    d.startCtxTime = startAt;
  }

  pause(id: DeckId) {
    const d = this.decks[id];
    if (!d.playing) return;
    d.startOffset = this.position(id);
    this.post(id, { type: "stop" });
    d.playing = false;
  }

  stop(id: DeckId) {
    const d = this.decks[id];
    this.post(id, { type: "stop" });
    d.playing = false;
    d.startOffset = 0;
  }

  seek(id: DeckId, t: number) {
    const d = this.decks[id];
    if (!d.buffer) return;
    const clamped = Math.max(0, Math.min(d.buffer.duration, t));
    d.startOffset = clamped;
    d.startCtxTime = this.ctx.currentTime;
    if (d.playing) this.post(id, { type: "seek", offset: clamped });
  }

  /** master tempo (keylock) on/off — pitch-preserving tempo changes */
  setMasterTempo(id: DeckId, on: boolean) {
    const d = this.decks[id];
    d.mt = on;
    this.post(id, { type: "mode", preserve: on });
  }

  /** Ramp a deck's playback rate (tempo match) over `dur` seconds. */
  rampRate(id: DeckId, target: number, dur: number, when?: number) {
    const d = this.decks[id];
    if (!d.playing) {
      d.rate = target;
      return;
    }
    const t0 = when ?? this.ctx.currentTime;
    // resync the position tracker to "now" so the linear approximation stays close
    d.startOffset = this.position(id);
    d.startCtxTime = this.ctx.currentTime;
    this.post(id, { type: "rate", value: target, ramp: dur, at: t0 });
    // track average rate during the ramp for position estimates
    d.rate = (d.rate + target) / 2;
    const token = (this.rampTokens[id] = (this.rampTokens[id] ?? 0) + 1);
    setTimeout(() => {
      // a newer ramp superseded this one — don't clobber its rate
      if (this.rampTokens[id] !== token) return;
      d.rate = target;
      d.startOffset = this.position(id);
      d.startCtxTime = this.ctx.currentTime;
    }, (t0 - this.ctx.currentTime + dur) * 1000);
  }

  private rampTokens: Partial<Record<DeckId, number>> = {};

  setRate(id: DeckId, rate: number) {
    const d = this.decks[id];
    // invalidate any in-flight rampRate completion so it can't clobber this
    this.rampTokens[id] = (this.rampTokens[id] ?? 0) + 1;
    if (d.playing) {
      d.startOffset = this.position(id);
      d.startCtxTime = this.ctx.currentTime;
    }
    d.rate = rate;
    this.post(id, { type: "rate", value: rate, ramp: 0.06 });
  }

  /** one-shot phase nudge: bend tempo briefly to slide `deltaSec` of track
   *  time, then return — beat alignment without an audible jump */
  nudgePhase(id: DeckId, deltaSec: number, dur = 1.5) {
    const d = this.decks[id];
    if (!d.playing) return;
    const base = d.rate;
    this.setRate(id, base + deltaSec / dur);
    window.setTimeout(() => this.setRate(id, base), dur * 1000);
  }

  /* ── channel strip controls (0..1 knob values) ──────────── */

  setTrim(id: DeckId, v: number) {
    // 0..1 → -inf..+6 dB, centre = 0 dB
    this.decks[id].strip.trim.gain.setTargetAtTime(knobToGain(v), this.ctx.currentTime, 0.01);
  }

  setEq(id: DeckId, band: "low" | "mid" | "high", v: number) {
    // centre of knob = 0 dB; left half sweeps to kill, right half to +6
    const gain = v <= 0.5 ? EQ_MIN_DB * (1 - v * 2) : (v - 0.5) * 2 * EQ_MAX_DB;
    this.decks[id].strip[band].gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  /** automix helper: set EQ band in dB directly with a ramp */
  rampEqDb(id: DeckId, band: "low" | "mid" | "high", db: number, dur: number, when?: number) {
    const p = this.decks[id].strip[band].gain;
    const t0 = when ?? this.ctx.currentTime;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(p.value, t0);
    p.linearRampToValueAtTime(db, t0 + dur);
  }

  /** Sweep filter: v=0.5 bypass, <0.5 lowpass sweep, >0.5 highpass sweep. */
  setFilter(id: DeckId, v: number) {
    const f = this.decks[id].strip.filter;
    const t = this.ctx.currentTime;
    if (Math.abs(v - 0.5) < 0.02) {
      f.type = "lowpass";
      f.frequency.setTargetAtTime(22050, t, 0.01);
      return;
    }
    if (v < 0.5) {
      f.type = "lowpass";
      // 0 → 80 Hz, 0.5 → 22 kHz (log sweep)
      const norm = v / 0.5;
      f.frequency.setTargetAtTime(80 * Math.pow(22050 / 80, norm), t, 0.01);
    } else {
      f.type = "highpass";
      // 0.5 → 20 Hz, 1 → 8 kHz
      const norm = (v - 0.5) / 0.5;
      f.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, norm), t, 0.01);
    }
  }

  setFader(id: DeckId, v: number) {
    this.decks[id].strip.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01);
  }

  /** 0 = full A, 1 = full B, equal-power */
  setCrossfader(v: number) {
    this.xfadePos = v;
    const t = this.ctx.currentTime;
    this.decks.A.strip.xfade.gain.setTargetAtTime(Math.cos((v * Math.PI) / 2), t, 0.01);
    this.decks.B.strip.xfade.gain.setTargetAtTime(Math.sin((v * Math.PI) / 2), t, 0.01);
  }

  get crossfader() {
    return this.xfadePos;
  }

  /** automix helper: glide the crossfader over `dur` seconds */
  rampCrossfader(to: number, dur: number, when?: number) {
    const t0 = when ?? this.ctx.currentTime;
    const a = this.decks.A.strip.xfade.gain;
    const b = this.decks.B.strip.xfade.gain;
    a.cancelScheduledValues(t0);
    b.cancelScheduledValues(t0);
    a.setValueAtTime(a.value, t0);
    b.setValueAtTime(b.value, t0);
    // approximate equal-power with a few segments
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const frac = i / steps;
      const v = this.xfadePos + (to - this.xfadePos) * frac;
      a.linearRampToValueAtTime(Math.cos((v * Math.PI) / 2), t0 + dur * frac);
      b.linearRampToValueAtTime(Math.sin((v * Math.PI) / 2), t0 + dur * frac);
    }
    this.xfadePos = to;
  }

  setMaster(v: number) {
    this.master.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.01);
  }

  /* ── FX (used by the automix scheduler) ─────────────────── */

  /** configure the synced delay: time in seconds, feedback 0..1 */
  prepareDelay(id: DeckId, time: number, feedback: number) {
    const s = this.decks[id].strip;
    s.delay.delayTime.setTargetAtTime(Math.min(2.8, time), this.ctx.currentTime, 0.01);
    s.delayFb.gain.setTargetAtTime(Math.min(0.75, feedback), this.ctx.currentTime, 0.01);
  }

  rampDelayWet(id: DeckId, to: number, dur: number, when?: number) {
    this.rampParam(this.decks[id].strip.delayWet.gain, to, dur, when);
  }

  /** pick a reverb colour: bright (short, airy) or dark (long, washed) */
  setReverbCharacter(id: DeckId, character: "bright" | "dark") {
    this.decks[id].strip.reverb.buffer = this.impulseResponse(character);
  }

  rampReverbWet(id: DeckId, to: number, dur: number, when?: number) {
    this.rampParam(this.decks[id].strip.reverbWet.gain, to, dur, when);
  }

  /** kill or restore the channel fader on a schedule (echo-out cut) */
  rampFaderGain(id: DeckId, to: number, dur: number, when?: number) {
    this.rampParam(this.decks[id].strip.fader.gain, to, dur, when);
  }

  /** hold the fader at zero until t0, then fade the channel in over dur */
  scheduleFaderFadeIn(id: DeckId, t0: number, dur: number) {
    const p = this.decks[id].strip.fader.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(0, now);
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(1, t0 + dur);
  }

  /** clear FX + strip automation back to neutral (after a transition) */
  resetStrip(id: DeckId) {
    const s = this.decks[id].strip;
    const t = this.ctx.currentTime;
    for (const p of [s.low.gain, s.mid.gain, s.high.gain]) {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(0, t, 0.03);
    }
    s.fader.gain.cancelScheduledValues(t);
    s.fader.gain.setTargetAtTime(1, t, 0.03);
    s.delayWet.gain.cancelScheduledValues(t);
    s.delayWet.gain.setTargetAtTime(0, t, 0.2);
    s.delayFb.gain.setTargetAtTime(0, t, 0.2);
    s.reverbWet.gain.cancelScheduledValues(t);
    s.reverbWet.gain.setTargetAtTime(0, t, 0.3);
    s.filter.frequency.cancelScheduledValues(t);
    s.filter.type = "lowpass";
    s.filter.frequency.setTargetAtTime(22050, t, 0.03);
    s.trem.gain.setTargetAtTime(1, t, 0.05);
    s.chorusWet.gain.setTargetAtTime(0, t, 0.05);
  }

  /* ── performance FX (CDJ pads) — all momentary hold/release ─ */

  private startLfo(
    target: AudioParam,
    freqHz: number,
    depth: number,
    type: OscillatorType = "sine"
  ): Lfo {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freqHz;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(target);
    osc.start();
    return { osc, depth: g };
  }

  private stopLfo(h?: { osc: OscillatorNode; depth: GainNode }) {
    if (!h) return;
    try {
      h.osc.stop();
    } catch { /* already stopped */ }
    h.osc.disconnect();
    h.depth.disconnect();
  }

  /** TWISTER — slow squelchy filter LFO */
  perfTwister(id: DeckId, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.twister) {
      s.filter.type = "lowpass";
      s.filter.frequency.cancelScheduledValues(t);
      s.filter.frequency.setTargetAtTime(950, t, 0.03);
      p.twister = this.startLfo(s.filter.frequency, 0.8, 780);
    } else if (!on && p.twister) {
      this.stopLfo(p.twister);
      p.twister = undefined;
      s.filter.frequency.setTargetAtTime(22050, t, 0.06);
    }
  }

  /** WUB — dubstep wobble: resonant lowpass with a beat-synced LFO sweeping
   *  the cutoff. `rateHz` is one full wobble per call (¼-note, ⅛-note, …). */
  perfWub(id: DeckId, rateHz: number, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.wub) {
      s.filter.type = "lowpass";
      s.filter.Q.cancelScheduledValues(t);
      s.filter.Q.setTargetAtTime(12, t, 0.02);
      s.filter.frequency.cancelScheduledValues(t);
      s.filter.frequency.setTargetAtTime(560, t, 0.02);
      // triangle = smooth "waoo-waoo"; depth rides the cutoff 100..1000-ish
      p.wub = this.startLfo(s.filter.frequency, rateHz, 460, "triangle");
    } else if (!on && p.wub) {
      this.stopLfo(p.wub);
      p.wub = undefined;
      s.filter.Q.setTargetAtTime(1.1, t, 0.05);
      s.filter.frequency.setTargetAtTime(22050, t, 0.06);
    }
  }

  /** GATE — hard trance gate: square-wave amplitude chop, full depth. */
  perfGate(id: DeckId, rateHz: number, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.gate) {
      s.trem.gain.setTargetAtTime(0.5, t, 0.004);
      p.gate = this.startLfo(s.trem.gain, rateHz, 0.5, "square");
    } else if (!on && p.gate) {
      this.stopLfo(p.gate);
      p.gate = undefined;
      s.trem.gain.setTargetAtTime(1, t, 0.02);
    }
  }

  /** FLANGER — swept short delay with feedback (jet whoosh). */
  perfFlanger(id: DeckId, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.flanger) {
      s.chorusDelay.delayTime.setTargetAtTime(0.005, t, 0.02);
      s.flangerFb.gain.setTargetAtTime(0.72, t, 0.02);
      s.chorusWet.gain.setTargetAtTime(0.6, t, 0.02);
      p.flanger = this.startLfo(s.chorusDelay.delayTime, 0.22, 0.0042);
    } else if (!on && p.flanger) {
      this.stopLfo(p.flanger);
      p.flanger = undefined;
      s.flangerFb.gain.setTargetAtTime(0, t, 0.06);
      s.chorusWet.gain.setTargetAtTime(0, t, 0.12);
      s.chorusDelay.delayTime.setTargetAtTime(0.018, t, 0.06);
    }
  }

  /** CRUSH — overdrive/grit via a tanh-ish waveshaper, in series. */
  perfCrush(id: DeckId, on: boolean) {
    const s = this.decks[id].strip;
    s.crush.curve = on ? this.crushCurve() : null;
  }

  /** RISER — one-press uplifter: a band of noise sweeps up and swells over the
   *  next few beats, then drops out. Self-contained; great for builds. */
  perfRiser(id: DeckId, beatSec: number, on: boolean) {
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.riser) {
      const dur = beatSec * 8; // 8-beat build
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer();
      noise.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.3;
      bp.frequency.setValueAtTime(280, t);
      bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0008, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + dur);
      noise.connect(bp);
      bp.connect(gain);
      gain.connect(this.decks[id].strip.xfade);
      noise.start();
      p.riser = { noise, gain };
    } else if (!on && p.riser) {
      const { noise, gain } = p.riser;
      p.riser = undefined;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(0, t, 0.07);
      window.setTimeout(() => {
        try {
          noise.stop();
        } catch {
          /* already stopped */
        }
        noise.disconnect();
        gain.disconnect();
      }, 320);
    }
  }

  /** V.BRAKE — vinyl stop while held, spin back up on release.
   *  Temporarily drops keylock so the pitch bend IS the brake sound.
   *  Rapid re-presses keep the ORIGINAL rate and cancel any pending
   *  keylock restore, so brake-mashing can't corrupt the deck state. */
  perfBrake(id: DeckId, on: boolean) {
    const d = this.decks[id];
    const p = this.perf[id];
    if (on) {
      if (p.brakeRestoreTimer) {
        window.clearTimeout(p.brakeRestoreTimer);
        p.brakeRestoreTimer = undefined;
      }
      // capture the pre-brake rate exactly once; a mid-ramp re-press must
      // not overwrite it with a half-braked value
      if (p.brakePrevRate === undefined) {
        const r = d.rate;
        p.brakePrevRate = r > 0.5 && r < 2 ? r : 1;
      }
      this.post(id, { type: "mode", preserve: false });
      this.rampRate(id, 0.001, 1.1);
    } else {
      this.rampRate(id, p.brakePrevRate ?? 1, 0.45);
      p.brakeRestoreTimer = window.setTimeout(() => {
        p.brakeRestoreTimer = undefined;
        p.brakePrevRate = undefined;
        this.post(id, { type: "mode", preserve: d.mt });
      }, 500);
    }
  }

  /** ECHO throw — beat-synced delay while held, tail fades on release */
  perfEcho(id: DeckId, beatSec: number, division: number, on: boolean) {
    if (on) {
      this.prepareDelay(id, beatSec * division, 0.62);
      this.rampDelayWet(id, 0.55, 0.05);
    } else {
      this.rampDelayWet(id, 0, 1.8);
    }
  }

  /** REVERB throw */
  perfReverb(id: DeckId, on: boolean) {
    if (on) {
      this.setReverbCharacter(id, "bright");
      this.rampReverbWet(id, 0.45, 0.08);
    } else {
      this.rampReverbWet(id, 0, 1.4);
    }
  }

  /** UNISON — chorus doubler (modulated short delay mixed in) */
  perfUnison(id: DeckId, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    if (on && !p.chorus) {
      p.chorus = this.startLfo(s.chorusDelay.delayTime, 0.55, 0.006);
      s.chorusWet.gain.setTargetAtTime(0.55, this.ctx.currentTime, 0.05);
    } else if (!on && p.chorus) {
      s.chorusWet.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
      const h = p.chorus;
      p.chorus = undefined;
      window.setTimeout(() => this.stopLfo(h), 600);
    }
  }

  /** TREMOLO+ — deep beat-synced amplitude chop */
  perfTremolo(id: DeckId, rateHz: number, on: boolean) {
    const s = this.decks[id].strip;
    const p = this.perf[id];
    const t = this.ctx.currentTime;
    if (on && !p.trem) {
      s.trem.gain.setTargetAtTime(0.55, t, 0.02);
      p.trem = this.startLfo(s.trem.gain, rateHz, 0.45);
    } else if (!on && p.trem) {
      this.stopLfo(p.trem);
      p.trem = undefined;
      s.trem.gain.setTargetAtTime(1, t, 0.04);
    }
  }

  /**
   * TIPTIP — beat-repeat stutter: pauses the deck and retriggers a tiny
   * slice on a lookahead scheduler; release resumes where the track would
   * have been (slip mode).
   */
  perfStutter(id: DeckId, sliceSec: number, on: boolean) {
    const d = this.decks[id];
    const p = this.perf[id];
    if (on && !p.stutter && d.buffer) {
      const pos = this.position(id);
      const startedAt = this.ctx.currentTime;
      this.post(id, { type: "stop" });
      d.playing = false;
      d.startOffset = pos;

      let nextT = this.ctx.currentTime + 0.03;
      const buf = d.buffer;
      const timer = window.setInterval(() => {
        while (nextT < this.ctx.currentTime + 0.12) {
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = d.rate;
          // declick envelope per repeat — soft edges instead of hard cuts
          const dur = sliceSec * 0.97;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0, nextT);
          g.gain.linearRampToValueAtTime(1, nextT + 0.005);
          g.gain.setValueAtTime(1, Math.max(nextT + 0.005, nextT + dur - 0.015));
          g.gain.linearRampToValueAtTime(0, nextT + dur);
          src.connect(g);
          g.connect(d.strip.trim);
          src.start(nextT, pos, dur + 0.01);
          nextT += sliceSec;
        }
      }, 30);
      p.stutter = { timer, pos, startedAt, slice: sliceSec };
    } else if (!on && p.stutter) {
      window.clearInterval(p.stutter.timer);
      // slip: resume where the track would have been without the stutter
      const elapsed = this.ctx.currentTime - p.stutter.startedAt;
      const resumeAt = p.stutter.pos + elapsed * d.rate;
      p.stutter = undefined;
      this.play(id, resumeAt);
    }
  }

  private rampParam(p: AudioParam, to: number, dur: number, when?: number) {
    const t0 = when ?? this.ctx.currentTime;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(p.value, t0);
    p.linearRampToValueAtTime(to, t0 + dur);
  }

  private irCache: Partial<Record<"bright" | "dark", AudioBuffer>> = {};

  private noiseBuf?: AudioBuffer;
  /** cached 2-second white-noise loop for risers */
  private noiseBuffer(): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate * 2, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  private crushCurveCache?: Float32Array;
  /** soft-clip (tanh) drive curve for CRUSH */
  private crushCurve(): Float32Array {
    if (this.crushCurveCache) return this.crushCurveCache;
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 9; // drive
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x);
    }
    this.crushCurveCache = curve;
    return curve;
  }

  private impulseResponse(character: "bright" | "dark"): AudioBuffer {
    const cached = this.irCache[character];
    if (cached) return cached;
    const seconds = character === "bright" ? 1.9 : 3.6;
    const rate = this.ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        let n = (Math.random() * 2 - 1) * Math.pow(1 - i / len, character === "bright" ? 2.0 : 2.6);
        if (character === "dark") {
          lp += 0.09 * (n - lp); // one-pole lowpass → darker tail
          n = lp * 3;
        }
        d[i] = n;
      }
    }
    this.irCache[character] = buf;
    return buf;
  }

  /**
   * Schedule a multi-segment crossfader move (equal-power) — points are
   * (ctxTime, position) pairs; position 0 = A, 1 = B.
   */
  scheduleXfadeCurve(points: { t: number; v: number }[]) {
    if (points.length < 2) return;
    const a = this.decks.A.strip.xfade.gain;
    const b = this.decks.B.strip.xfade.gain;
    const t0 = points[0].t;
    a.cancelScheduledValues(t0);
    b.cancelScheduledValues(t0);
    a.setValueAtTime(Math.cos((points[0].v * Math.PI) / 2), t0);
    b.setValueAtTime(Math.sin((points[0].v * Math.PI) / 2), t0);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const next = points[i];
      const steps = 8;
      for (let s = 1; s <= steps; s++) {
        const frac = s / steps;
        const v = prev.v + (next.v - prev.v) * frac;
        const t = prev.t + (next.t - prev.t) * frac;
        a.linearRampToValueAtTime(Math.cos((v * Math.PI) / 2), t);
        b.linearRampToValueAtTime(Math.sin((v * Math.PI) / 2), t);
      }
    }
    this.xfadePos = points[points.length - 1].v;
  }

  /**
   * Sweep the channel filter between two frequencies. Sets the filter type
   * immediately; restores bypass after the sweep if asked.
   */
  scheduleFilterSweep(
    id: DeckId,
    kind: "lowpass" | "highpass",
    fromHz: number,
    toHz: number,
    t0: number,
    dur: number,
    restoreBypass = false
  ): number[] {
    const f = this.decks[id].strip.filter;
    const timers: number[] = [];
    const startIn = Math.max(0, (t0 - this.ctx.currentTime) * 1000 - 20);
    timers.push(
      window.setTimeout(() => {
        f.type = kind;
      }, startIn)
    );
    f.frequency.cancelScheduledValues(t0);
    f.frequency.setValueAtTime(Math.max(15, fromHz), t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(15, toHz), t0 + dur);
    if (restoreBypass) {
      timers.push(
        window.setTimeout(() => {
          f.type = "lowpass";
          f.frequency.setTargetAtTime(22050, this.ctx.currentTime, 0.05);
        }, (t0 + dur - this.ctx.currentTime) * 1000 + 60)
      );
    }
    return timers;
  }

  /** RMS level 0..1 for VU meters */
  level(analyser: AnalyserNode, buf: Float32Array): number {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
}

function knobToGain(v: number): number {
  if (v <= 0) return 0;
  // centre = unity, max = +6 dB
  const db = v <= 0.5 ? -30 * (1 - v * 2) : (v - 0.5) * 12;
  return Math.pow(10, db / 20);
}

export const engine = new MixerEngine();

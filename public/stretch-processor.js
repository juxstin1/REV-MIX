/**
 * stretch-player — variable-tempo deck playback with optional pitch
 * preservation (master tempo / keylock).
 *
 * Two render paths:
 *  - vinyl mode: plain variable-rate resampling (pitch follows tempo —
 *    used for brakes/spinbacks where the bend IS the effect)
 *  - master-tempo mode: WSOLA — 2048-frame Hann grains at 50% hop spawn
 *    along a read head that advances at `rate`, each grain playing at unity
 *    pitch. Each new grain's start is waveform-aligned (cross-similarity
 *    search) to the previous grain's natural continuation, so overlaps are
 *    phase-coherent instead of comb-filtered — the difference between smooth
 *    keylock and a robotic/metallic vocal.
 *
 * All control is via port messages; offsets/times in seconds.
 */
class StretchPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.length = 0;
    this.pos = 0; // frames, fractional
    this.playing = false;
    this.startAt = -1; // ctx seconds; -1 = immediately
    this.rate = 1;
    this.targetRate = 1;
    this.rateStep = 0;
    this.rateRampLeft = 0;
    this.pendingRamp = null; // {value, rampFrames, at}
    this.preserve = true;
    this.loopStart = -1;
    this.loopEnd = -1;
    this.grains = [];
    this.sinceGrain = 1e9;
    this.GRAIN = 2048;
    this.HOP = 1024;
    this.win = new Float32Array(this.GRAIN);
    for (let i = 0; i < this.GRAIN; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.GRAIN));
    }
    // WSOLA alignment: search the new grain's start near the read head so it
    // best matches the previous grain's continuation (waveform-similarity)
    this.prevGrainStart = 0; // source frame the last grain started at
    this.CORR = 256; // similarity window (frames)
    this.SEEK = 256; // ± search radius (frames)
    this.fade = 128; // declick fade-in progress (128 = no fade pending)
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.type) {
      case "load":
        this.channels = m.channels;
        this.length = m.channels[0].length;
        this.pos = 0;
        this.playing = false;
        this.grains = [];
        this.prevGrainStart = 0;
        this.loopStart = this.loopEnd = -1;
        break;
      case "play":
        this.pos = m.offset * sampleRate;
        this.playing = true;
        this.startAt = m.when !== undefined && m.when > currentTime ? m.when : -1;
        if (m.rate !== undefined) {
          this.rate = this.targetRate = m.rate;
          this.rateRampLeft = 0;
        }
        this.grains = [];
        this.sinceGrain = 1e9;
        this.prevGrainStart = Math.floor(this.pos);
        this.fade = 0;
        break;
      case "stop":
        this.playing = false;
        this.grains = [];
        break;
      case "seek":
        this.pos = m.offset * sampleRate;
        this.grains = [];
        this.sinceGrain = 1e9;
        this.prevGrainStart = Math.floor(this.pos);
        this.fade = 0;
        break;
      case "rate": {
        const apply = () => {
          if (m.ramp && m.ramp > 0) {
            const frames = m.ramp * sampleRate;
            this.targetRate = m.value;
            this.rateStep = (m.value - this.rate) / frames;
            this.rateRampLeft = frames;
          } else {
            this.rate = this.targetRate = m.value;
            this.rateRampLeft = 0;
          }
        };
        if (m.at !== undefined && m.at > currentTime) this.pendingRamp = { msg: m, at: m.at };
        else apply();
        break;
      }
      case "loop":
        this.loopStart = m.start >= 0 ? m.start * sampleRate : -1;
        this.loopEnd = m.end >= 0 ? m.end * sampleRate : -1;
        break;
      case "mode":
        this.preserve = m.preserve;
        this.grains = [];
        this.sinceGrain = 1e9;
        this.prevGrainStart = Math.floor(this.pos);
        this.fade = 0;
        break;
    }
  }

  /**
   * WSOLA: pick the start (near `naturalStart`, the analysis read head) whose
   * leading CORR frames best match the previous grain's continuation, so the
   * two grains overlap-add in phase. Minimises summed squared difference.
   */
  alignedStart(naturalStart) {
    const ch = this.channels[0];
    const tmpl = this.prevGrainStart + this.HOP; // where the last grain is heading
    if (this.grains.length === 0 || tmpl < 0 || tmpl + this.CORR >= this.length) {
      return naturalStart;
    }
    let bestK = 0;
    let bestErr = Infinity;
    for (let k = -this.SEEK; k <= this.SEEK; k++) {
      const s = naturalStart + k;
      if (s < 0 || s + this.CORR >= this.length) continue;
      let err = 0;
      for (let j = 0; j < this.CORR; j += 2) {
        const diff = ch[s + j] - ch[tmpl + j];
        err += diff * diff;
        if (err >= bestErr) break; // early-out once we're worse than the best
      }
      if (err < bestErr) {
        bestErr = err;
        bestK = k;
      }
    }
    return naturalStart + bestK;
  }

  wrap(p) {
    if (this.loopEnd > 0 && p >= this.loopEnd) {
      const len = this.loopEnd - this.loopStart;
      return this.loopStart + ((p - this.loopStart) % len);
    }
    return p;
  }

  readSrc(ch, idx) {
    idx = this.wrap(idx);
    if (idx < 0 || idx >= this.length) return 0;
    return ch[idx | 0];
  }

  readInterp(ch, p) {
    p = this.wrap(p);
    const i = p | 0;
    if (i < 0 || i >= this.length) return 0;
    const f = p - i;
    const a = ch[i];
    const b = i + 1 < this.length ? ch[i + 1] : 0;
    return a + (b - a) * f;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const N = out[0].length;
    for (let c = 0; c < out.length; c++) out[c].fill(0);
    if (!this.channels || !this.playing) return true;

    if (this.pendingRamp && currentTime >= this.pendingRamp.at) {
      const m = this.pendingRamp.msg;
      this.pendingRamp = null;
      this.onMsg({ ...m, at: undefined });
    }

    let startFrame = 0;
    if (this.startAt > 0) {
      const dt = this.startAt - currentTime;
      if (dt > N / sampleRate) return true; // not yet
      startFrame = Math.max(0, Math.floor(dt * sampleRate));
      this.startAt = -1;
    }

    const stereo = this.channels.length > 1 && out.length > 1;
    for (let i = startFrame; i < N; i++) {
      if (this.rateRampLeft > 0) {
        this.rate += this.rateStep;
        if (--this.rateRampLeft === 0) this.rate = this.targetRate;
      }
      let L = 0;
      let R = 0;
      // below 1/4 speed granular OLA would re-read a frozen head as a buzz —
      // always fall back to resampling there (the pitch dive is correct anyway)
      const usePreserve =
        this.preserve && Math.abs(this.rate - 1) > 0.004 && this.rate > 0.25;
      if (usePreserve) {
        if (this.sinceGrain >= this.HOP) {
          const start = this.alignedStart(Math.floor(this.pos));
          this.grains.push({ start, age: 0 });
          this.prevGrainStart = start;
          this.sinceGrain = 0;
        }
        this.sinceGrain++;
        for (let g = this.grains.length - 1; g >= 0; g--) {
          const gr = this.grains[g];
          if (gr.age >= this.GRAIN) {
            this.grains.splice(g, 1);
            continue;
          }
          const w = this.win[gr.age];
          const idx = gr.start + gr.age;
          L += this.readSrc(this.channels[0], idx) * w;
          if (stereo) R += this.readSrc(this.channels[1], idx) * w;
          gr.age++;
        }
        if (!stereo) R = L;
      } else {
        L = this.readInterp(this.channels[0], this.pos);
        R = stereo ? this.readInterp(this.channels[1], this.pos) : L;
      }
      if (this.fade < 128) {
        const f = this.fade / 128;
        L *= f;
        R *= f;
        this.fade++;
      }
      out[0][i] = L;
      if (out.length > 1) out[1][i] = R;

      this.pos += this.rate;
      if (this.loopEnd > 0 && this.pos >= this.loopEnd) {
        this.pos = this.loopStart + (this.pos - this.loopEnd);
      }
      if (this.pos >= this.length) {
        this.playing = false;
        this.port.postMessage({ type: "ended" });
        break;
      }
    }
    return true;
  }
}

registerProcessor("stretch-player", StretchPlayer);

/**
 * Synthesized drum voices for the loop sequencer — no samples, just
 * oscillators and shaped noise, scheduled sample-accurately.
 */

export type DrumVoice = "KICK" | "SNARE" | "CLAP" | "CHAT" | "OHAT" | "PERC";

export const DRUM_VOICES: DrumVoice[] = ["KICK", "SNARE", "CLAP", "CHAT", "OHAT", "PERC"];

let noiseBuf: AudioBuffer | null = null;

function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

function env(ctx: BaseAudioContext, t: number, peak: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  return g;
}

function noiseHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  filterType: BiquadFilterType,
  freq: number,
  peak: number,
  decay: number,
  q = 1
) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(ctx, t, peak, decay);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 0.5, decay + 0.05);
}

export function playVoice(ctx: BaseAudioContext, dest: AudioNode, voice: DrumVoice, t: number) {
  switch (voice) {
    case "KICK": {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
      const g = env(ctx, t, 1.0, 0.26);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.3);
      break;
    }
    case "SNARE": {
      noiseHit(ctx, dest, t, "highpass", 1700, 0.5, 0.16);
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = 190;
      const g = env(ctx, t, 0.4, 0.1);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.12);
      break;
    }
    case "CLAP": {
      // three quick noise bursts
      for (let i = 0; i < 3; i++) {
        noiseHit(ctx, dest, t + i * 0.012, "bandpass", 1150, 0.4, i === 2 ? 0.18 : 0.03, 1.6);
      }
      break;
    }
    case "CHAT":
      noiseHit(ctx, dest, t, "highpass", 7400, 0.32, 0.045);
      break;
    case "OHAT":
      noiseHit(ctx, dest, t, "highpass", 6800, 0.3, 0.32);
      break;
    case "PERC": {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(330, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.07);
      const g = env(ctx, t, 0.45, 0.12);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.15);
      break;
    }
  }
}

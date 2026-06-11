/**
 * Vocal awareness — drives the StemSep sidecar (BS-Roformer vocal split,
 * GPU) through the Rust shell, then reduces the vocals stem to a
 * per-second activity curve the automix planner can reason about.
 */

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface VoxEvent {
  input: string;
  type: string;
  message?: string;
  stems?: { name: string; path: string }[];
  stage?: string;
}

const waiters = new Map<
  string,
  { resolve: (vocalsPath: string) => void; reject: (e: Error) => void; onStage?: (msg: string) => void }
>();
let listenerReady: Promise<void> | null = null;

function ensureListener(): Promise<void> {
  if (!listenerReady) {
    listenerReady = listen<VoxEvent>("vox:event", (e) => {
      const v = e.payload;
      const w = waiters.get(v.input);
      if (!w) return;
      if (v.type === "stage" && v.message) {
        w.onStage?.(v.message);
      } else if (v.type === "done") {
        waiters.delete(v.input);
        const vocals = v.stems?.find((s) => s.name.toLowerCase() === "vocals");
        if (vocals) w.resolve(vocals.path);
        else w.reject(new Error("separation finished but no Vocals stem returned"));
      } else if (v.type === "error") {
        waiters.delete(v.input);
        w.reject(new Error(v.message ?? "separation failed"));
      }
    }).then(() => undefined);
  }
  return listenerReady;
}

/** Separate `path` and resolve with the vocals stem path (cached on disk). */
export async function separateVocals(path: string, onStage?: (msg: string) => void): Promise<string> {
  await ensureListener();
  return new Promise<string>((resolve, reject) => {
    waiters.set(path, { resolve, reject, onStage });
    invoke("separate_vocals", { input: path }).catch((err) => {
      waiters.delete(path);
      reject(new Error(String(err)));
    });
  });
}

/**
 * Decode the vocals stem and reduce it to per-second activity 0..1.
 * Normalised so sustained singing saturates at 1; light smoothing keeps
 * breath gaps from reading as "no vocals".
 */
export async function vocalCurve(
  vocalsPath: string,
  ctx: AudioContext,
  durationSec: number
): Promise<Float32Array> {
  const res = await fetch(convertFileSrc(vocalsPath));
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  const data = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const secs = Math.max(1, Math.ceil(durationSec));
  const rms = new Float32Array(secs);
  for (let s = 0; s < secs; s++) {
    const a = Math.floor(s * sr);
    const b = Math.min(data.length, a + sr);
    if (a >= data.length) break;
    let sum = 0;
    let n = 0;
    for (let i = a; i < b; i += 16) {
      sum += data[i] * data[i];
      n++;
    }
    rms[s] = n ? Math.sqrt(sum / n) : 0;
  }

  let max = 0;
  for (let s = 0; s < secs; s++) max = Math.max(max, rms[s]);
  const out = new Float32Array(secs);
  if (max > 0) {
    // saturate at half the peak so steady verses read as fully "on"
    for (let s = 0; s < secs; s++) out[s] = Math.min(1, rms[s] / (0.5 * max));
    // smooth ±2 s
    const sm = new Float32Array(secs);
    for (let s = 0; s < secs; s++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, s - 2); j <= Math.min(secs - 1, s + 2); j++) {
        sum += out[j];
        n++;
      }
      sm[s] = sum / n;
    }
    return sm;
  }
  return out;
}

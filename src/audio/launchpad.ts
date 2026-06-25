/**
 * Renderer-side client for the Rust Launchpad backend (src-tauri/launchpad.rs).
 * Web MIDI is absent in macOS WKWebView, so the device is driven from Rust and
 * we talk to it over Tauri commands + a `lp:input` event. Everything degrades to
 * a no-op outside Tauri (browser dev), so the editor UI still works for layout.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface LedSpec {
  index: number; // grid 11..88 or edge CC number
  r: number; // 0..127
  g: number;
  b: number;
}

export interface LpInputEvent {
  kind: "note_on" | "note_off" | "cc" | "aftertouch" | "pressure";
  num: number;
  val: number;
  chan: number;
}

export interface LpStateEvent {
  connected: boolean;
  name?: string;
}

/** are we inside the Tauri shell (vs. plain browser dev)? */
export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inTauri) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`launchpad: ${cmd} failed`, e);
    return null;
  }
}

export type LpConnectResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export const launchpad = {
  listPorts: () => call<string[]>("lp_list_ports").then((p) => p ?? []),
  /**
   * Connect + enter Programmer Mode. Returns the error string (not just null) so
   * the UI can tell "no device" apart from "preview mode" — the Pro MK3's ports
   * go un-enumerable after sleep until a USB replug, and the user needs that hint.
   */
  async connect(portHint?: string): Promise<LpConnectResult> {
    if (!inTauri) return { ok: false, error: "preview" };
    try {
      const name = await invoke<string>("lp_connect", { portHint });
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  disconnect: () => call<void>("lp_disconnect"),
  sendLeds: (specs: LedSpec[]) => call<void>("lp_send_leds", { specs }),
  sendRaw: (bytes: number[]) => call<void>("lp_send_raw", { bytes }),
  bridgeStart: () => call<string>("lp_bridge_start"),
  bridgeCc: (cc: number, val: number, channel = 0) =>
    call<void>("lp_bridge_cc", { cc, val, channel }),
  bridgeStop: () => call<void>("lp_bridge_stop"),

  async onInput(cb: (e: LpInputEvent) => void): Promise<UnlistenFn> {
    if (!inTauri) return () => {};
    return listen<LpInputEvent>("lp:input", (e) => cb(e.payload));
  },
  async onState(cb: (e: LpStateEvent) => void): Promise<UnlistenFn> {
    if (!inTauri) return () => {};
    return listen<LpStateEvent>("lp:state", (e) => cb(e.payload));
  },
};

/* ── colour helpers (device LEDs are 7-bit per channel) ─────────── */

/** 8-bit 0..255 → device 0..127 */
export const to7 = (v: number) => Math.max(0, Math.min(127, Math.round(v / 2)));

/** "#rrggbb" → device LedSpec channels (without index) */
export function hexTo7(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return { r: to7((n >> 16) & 255), g: to7((n >> 8) & 255), b: to7(n & 255) };
}

/**
 * Bridges native MIDI (Rust `midi:message` events) to the console. Holds the
 * binding table (message → action), supports MIDI-learn, and keeps a live
 * monitor of incoming messages so the user can see exactly what the REV-5 sends.
 *
 * Bindings persist to localStorage so a mapped controller survives restarts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ACTION_BY_ID, MidiTargets, jogDelta } from "./actions";

export interface MidiEvent {
  key: string; // stable binding key (channel-scoped, value-independent)
  value: number; // meaningful value: 14-bit for pitch-bend, else 0..127
  port: string;
  t: number; // performance.now() timestamp
}

/** map message-key → action id */
export type Bindings = Record<string, string>;

// v2: key scheme changed to be channel-scoped + 14-bit aware
const STORE_KEY = "revmix.midi.bindings.v2";

const loadBindings = (): Bindings => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
};

interface Decoded {
  key: string;
  value: number; // 0..127, or 0..16383 for pitch-bend
  norm: number; // 0..1
  isNote: boolean;
}

/**
 * Decode a raw MIDI message into a stable, value-independent binding key plus a
 * normalised value. Crucially, a Pitch-Bend message (status 0xE0, what Pioneer
 * pitch sliders typically send) is keyed by channel only and read as 14-bit —
 * its low byte changes on every micro-move, so keying on it would lose fine
 * adjustments entirely.
 */
function decode(status: number, d1: number, d2: number): Decoded {
  const type = status & 0xf0;
  const ch = status & 0x0f;
  if (type === 0xe0) {
    const v14 = d1 | (d2 << 7); // LSB, MSB
    return { key: `E:${ch}`, value: v14, norm: v14 / 16383, isNote: false };
  }
  if (type === 0xb0) {
    return { key: `B:${ch}:${d1}`, value: d2, norm: d2 / 127, isNote: false };
  }
  // 0x90 note-on / 0x80 note-off
  return { key: `N:${ch}:${d1}`, value: d2, norm: d2 / 127, isNote: true };
}

/** Human-readable label for a binding key, e.g. "CH1 PITCH" / "CH2 CC11". */
export function formatKey(key: string): string {
  const [t, a, b] = key.split(":");
  const ch = `CH${Number(a) + 1}`;
  if (t === "E") return `${ch} PITCH`;
  if (t === "B") return `${ch} CC${b}`;
  return `${ch} NOTE${b}`;
}

/** offset a note/CC key by k (same channel) — used to map a consecutive row of
 *  pads from a single captured message. Pitch-bend keys can't be offset. */
function offsetKey(key: string, k: number): string | null {
  const [t, ch, num] = key.split(":");
  if (t === "E" || num === undefined) return null;
  const n = Number(num) + k;
  if (n < 0 || n > 127) return null;
  return `${t}:${ch}:${n}`;
}

export function useMidi(targets: MidiTargets, recordMonitor = true) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [port, setPort] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<MidiEvent | null>(null);
  const [log, setLog] = useState<MidiEvent[]>([]);
  const [bindings, setBindings] = useState<Bindings>(loadBindings);
  const [learnId, setLearnId] = useState<string | null>(null);
  // when row-learning a whole pad bank: the ordered action ids to fill from one
  // captured message. `learnRowTag` drives the UI highlight.
  const [learnRowTag, setLearnRowTag] = useState<string | null>(null);

  // refs so the long-lived event listener always sees current values
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const learnRef = useRef<string | null>(null);
  learnRef.current = learnId;
  const learnRowRef = useRef<string[] | null>(null);
  // last value seen per message key — lets button actions fire on a rising
  // edge only, so a knob/fader sweep (dozens of CC ticks) can't machine-gun a
  // button (e.g. spawn a stack of file-open dialogs).
  const lastValRef = useRef<Record<string, number>>({});
  const recordRef = useRef(recordMonitor);
  recordRef.current = recordMonitor;
  const portRef = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(bindings));
  }, [bindings]);

  // single subscription to native MIDI for the app's lifetime
  useEffect(() => {
    const un = listen<{ bytes: number[]; port: string }>("midi:message", (e) => {
      const [status, d1 = 0, d2 = 0] = e.payload.bytes;
      const { key, value, norm, isNote } = decode(status, d1, d2);

      // learn the live port name once (Rust may have auto-connected) without
      // calling setState on every incoming message
      if (e.payload.port && portRef.current !== e.payload.port) {
        portRef.current = e.payload.port;
        setPort(e.payload.port);
      }

      // only feed the monitor UI when it's visible — otherwise a streaming
      // controller would re-render the whole app hundreds of times a second.
      if (recordRef.current || learnRef.current || learnRowRef.current) {
        const ev: MidiEvent = { key, value, port: e.payload.port, t: performance.now() };
        setLast(ev);
        setLog((l) => [ev, ...l].slice(0, 50));
      }

      // row-learn: one press maps a whole pad bank to consecutive notes.
      if (learnRowRef.current) {
        if (isNote && value === 0) return; // wait for a press
        const ids = learnRowRef.current;
        setBindings((b) => {
          const idSet = new Set(ids);
          const newKeys = new Set(ids.map((_, k) => offsetKey(key, k)).filter(Boolean) as string[]);
          const next: Bindings = {};
          for (const [k, v] of Object.entries(b)) {
            if (idSet.has(v)) continue; // drop old bindings for these pads
            if (newKeys.has(k)) continue; // free up the target notes
            next[k] = v;
          }
          ids.forEach((id, k) => {
            const nk = offsetKey(key, k);
            if (nk) next[nk] = id;
          });
          return next;
        });
        learnRowRef.current = null;
        setLearnRowTag(null);
        return;
      }

      // learn mode: bind this message to the armed action.
      // ignore a note release (note-on vel 0) so we capture the press.
      if (learnRef.current) {
        if (isNote && value === 0) return;
        const id = learnRef.current;
        setBindings((b) => {
          // drop any other action currently on this key, then assign
          const next: Bindings = {};
          for (const [k, v] of Object.entries(b)) if (v !== id && k !== key) next[k] = v;
          next[key] = id;
          return next;
        });
        setLearnId(null);
        learnRef.current = null;
        return;
      }

      const prev = lastValRef.current[key] ?? 0;
      lastValRef.current[key] = value;

      const id = bindingsRef.current[key];
      if (!id) return;
      const def = ACTION_BY_ID[id];
      if (!def) return;

      if (def.kind === "button") {
        // rising edge through the midpoint = one press. Works for note
        // on/off (0/127) and CC-button (0/127) alike, and ignores a
        // continuous control that merely sweeps past.
        if (!(value >= 64 && prev < 64)) return;
        def.apply(targetsRef.current, 1, true);
        return;
      }

      if (def.kind === "hold") {
        // FX pads: fire on press AND release so HOLD-mode effects latch
        // only while the pad is down.
        const down = value >= 64;
        const wasDown = prev >= 64;
        if (down && !wasDown) def.apply(targetsRef.current, 1, true);
        else if (!down && wasDown) def.apply(targetsRef.current, 0, false);
        return;
      }

      if (def.kind === "jog") {
        def.apply(targetsRef.current, jogDelta(value), false);
        return;
      }

      // abs / center / tempo — 14-bit-aware normalised value
      def.apply(targetsRef.current, norm, false);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setInputs(await invoke<string[]>("midi_inputs"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const connect = useCallback(async (name?: string) => {
    try {
      const p = await invoke<string>("midi_connect", { name: name ?? null });
      portRef.current = p;
      setPort(p);
      setError(null);
    } catch (e) {
      setError(String(e));
      portRef.current = null;
      setPort(null);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await invoke("midi_disconnect");
    portRef.current = null;
    setPort(null);
  }, []);

  // populate the device list once on mount (auto-connect happens in Rust)
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const learn = useCallback((id: string) => {
    learnRowRef.current = null;
    setLearnRowTag(null);
    setLearnId((cur) => (cur === id ? null : id));
  }, []);

  /** arm a row-learn: capture one pad press and fill `ids` with consecutive
   *  notes. `tag` is an opaque key the UI uses to highlight the active row. */
  const learnRow = useCallback((tag: string, ids: string[]) => {
    setLearnId(null);
    learnRef.current = null;
    setLearnRowTag((cur) => {
      if (cur === tag) {
        learnRowRef.current = null;
        return null;
      }
      learnRowRef.current = ids;
      return tag;
    });
  }, []);

  const clearBinding = useCallback((id: string) => {
    setBindings((b) => {
      const next: Bindings = {};
      for (const [k, v] of Object.entries(b)) if (v !== id) next[k] = v;
      return next;
    });
  }, []);
  /** clear every binding whose action id is in `ids` (a whole pad row) */
  const clearBindings = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setBindings((b) => {
      const next: Bindings = {};
      for (const [k, v] of Object.entries(b)) if (!idSet.has(v)) next[k] = v;
      return next;
    });
  }, []);
  const clearAll = useCallback(() => setBindings({}), []);

  /** reverse lookup: action id → its bound message key (for display) */
  const keyForAction = useCallback(
    (id: string): string | null => {
      const hit = Object.entries(bindings).find(([, v]) => v === id);
      return hit ? hit[0] : null;
    },
    [bindings]
  );

  return {
    inputs,
    port,
    error,
    last,
    log,
    bindings,
    learnId,
    learnRowTag,
    refresh,
    connect,
    disconnect,
    learn,
    learnRow,
    clearBinding,
    clearBindings,
    clearAll,
    keyForAction,
  };
}

export type MidiController = ReturnType<typeof useMidi>;

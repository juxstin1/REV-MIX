/**
 * Library — tracks, tags, playlists and saved sets, persisted as one
 * JSON file in app-local-data via the Rust shell. Less is more: no DB,
 * no sync, just a file.
 */

import { invoke } from "@tauri-apps/api/core";

export interface LibTrack {
  path: string;
  name: string;
  bpm?: number;
  key?: string;
  camelot?: string;
  duration?: number;
  tags: string[];
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  paths: string[];
}

export interface SetEntry {
  path: string;
  name: string;
  /** how this track was mixed in (absent for the set opener) */
  transition?: { style: string; beats: number; score: number };
}

export interface SavedSet {
  id: string;
  name: string;
  savedAt: number;
  entries: SetEntry[];
}

export interface SeqPattern {
  id: string;
  name: string;
  bpm: number;
  /** rows of 16 steps, 0/1, indexed by DRUM_VOICES order */
  steps: number[][];
}

/** A labelled transition — telemetry plus the user's verdict. "good" mixes are
 *  what works; "review" mixes carry reason chips explaining what went wrong, so
 *  the automix scorer can learn the decision rules later. */
export interface TransitionMoment {
  id: string;
  savedAt: number;
  verdict: "good" | "review";
  /** user-picked reasons (review only) */
  reasons: string[];
  /** system auto-risk flags at fire time */
  risk: string[];
  fromName: string;
  toName: string;
  style: string;
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

export interface LibraryData {
  tracks: LibTrack[];
  playlists: Playlist[];
  sets: SavedSet[];
  patterns: SeqPattern[];
  moments: TransitionMoment[];
}

export const emptyLibrary = (): LibraryData => ({
  tracks: [],
  playlists: [],
  sets: [],
  patterns: [],
  moments: [],
});

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function loadLibrary(): Promise<LibraryData> {
  try {
    const raw = await invoke<string>("load_library");
    if (!raw) return emptyLibrary();
    const d = JSON.parse(raw);
    return {
      tracks: Array.isArray(d.tracks) ? d.tracks : [],
      playlists: Array.isArray(d.playlists) ? d.playlists : [],
      sets: Array.isArray(d.sets) ? d.sets : [],
      patterns: Array.isArray(d.patterns) ? d.patterns : [],
      moments: Array.isArray(d.moments) ? d.moments : [],
    };
  } catch {
    return emptyLibrary();
  }
}

export async function saveLibrary(data: LibraryData): Promise<void> {
  try {
    await invoke("save_library", { data: JSON.stringify(data) });
  } catch {
    /* persistence is best-effort; the session still works */
  }
}

/** Insert or update a track's metadata. Returns the same object if nothing changed. */
export function upsertTrack(
  lib: LibraryData,
  t: { path: string; name: string; bpm?: number; key?: string; camelot?: string; duration?: number }
): LibraryData {
  const existing = lib.tracks.find((x) => x.path === t.path);
  if (!existing) {
    return {
      ...lib,
      tracks: [...lib.tracks, { ...t, tags: [], addedAt: Date.now() }],
    };
  }
  if (
    existing.bpm === t.bpm &&
    existing.key === t.key &&
    existing.camelot === t.camelot &&
    existing.duration === t.duration
  ) {
    return lib;
  }
  return {
    ...lib,
    tracks: lib.tracks.map((x) => (x.path === t.path ? { ...x, ...t } : x)),
  };
}

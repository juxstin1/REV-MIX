import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { engine, DeckId } from "./audio/engine";
import { analyseTrack, TrackAnalysis } from "./audio/analysis";
import { separateVocals, vocalCurve } from "./audio/vocals";
import { planTransition, scheduleTransition, ScheduledTransition, TransitionPlan } from "./audio/automix";
import { LoadedTrack } from "./types";
import { Deck } from "./components/Deck";
import { Mixer } from "./components/Mixer";
import { Library } from "./components/Library";
import { Sequencer } from "./components/Sequencer";
import { LaunchpadScreen } from "./components/LaunchpadScreen";
import { LpMapping } from "./audio/launchpad-map";
import {
  LibraryData,
  SetEntry,
  emptyLibrary,
  loadLibrary,
  saveLibrary,
  upsertTrack,
  newId,
} from "./library";
import "./App.css";

const AUDIO_FILTERS = [{ name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "aiff"] }];

export default function App() {
  const [tracks, setTracks] = useState<Record<DeckId, LoadedTrack | null>>({ A: null, B: null });
  const [queue, setQueue] = useState<LoadedTrack[]>([]);
  const [playing, setPlaying] = useState<Record<DeckId, boolean>>({ A: false, B: false });
  const [activeDeck, setActiveDeck] = useState<DeckId>("A");
  const [automix, setAutomix] = useState(false);
  const [xfade, setXfadeState] = useState(0.5);
  const [plan, setPlan] = useState<TransitionPlan | null>(null);
  const [status, setStatus] = useState("LOAD A TRACK TO BEGIN");
  const scheduled = useRef<ScheduledTransition | null>(null);
  const xfadeAnim = useRef(0);

  /* ── library, tags, playlists, sets ─────────────────────── */
  const [lib, setLib] = useState<LibraryData>(emptyLibrary);
  const [libOpen, setLibOpen] = useState(false);
  const [setLog, setSetLog] = useState<SetEntry[]>([]);
  const [view, setView] = useState<"decks" | "seq" | "lp">("decks");
  const libLoaded = useRef(false);
  // gates the always-mounted Launchpad surface so it boots with persisted maps
  const [libReady, setLibReady] = useState(false);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    loadLibrary().then((d) => {
      setLib(d);
      libLoaded.current = true;
      setLibReady(true);
    });
  }, []);

  // debounce-persist library changes
  useEffect(() => {
    if (!libLoaded.current) return;
    const t = setTimeout(() => saveLibrary(lib), 600);
    return () => clearTimeout(t);
  }, [lib]);

  // keep library metadata in sync with analysed tracks
  useEffect(() => {
    const all = [tracks.A, tracks.B, ...queue].filter(Boolean) as LoadedTrack[];
    if (all.length === 0) return;
    setLib((prev) => {
      let next = prev;
      for (const t of all) {
        next = upsertTrack(next, {
          path: t.path,
          name: t.name,
          bpm: t.analysis?.bpm,
          key: t.analysis?.key,
          camelot: t.analysis?.camelot,
          duration: t.buffer.duration,
        });
      }
      return next;
    });
  }, [tracks, queue]);

  /* ── loading & decoding ─────────────────────────────────── */

  const decodeFile = useCallback(async (path: string): Promise<LoadedTrack> => {
    const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? path;
    const res = await fetch(convertFileSrc(path));
    const arr = await res.arrayBuffer();
    const buffer = await engine.ctx.decodeAudioData(arr);
    return { path, name, buffer, analysis: null, voxStatus: "pending" };
  }, []);

  /* ── vocal awareness: stem-separate in the background, serialized ── */
  const voxCurves = useRef(new Map<string, Float32Array>());
  const voxChain = useRef<Promise<void>>(Promise.resolve());

  /** apply an updater to a track wherever it currently lives (deck/queue) */
  const updateTrack = useCallback((path: string, fn: (t: LoadedTrack) => LoadedTrack) => {
    setTracks((ts) => {
      let changed = false;
      const next = { ...ts };
      for (const d of ["A", "B"] as DeckId[]) {
        if (next[d]?.path === path) {
          next[d] = fn(next[d]!);
          changed = true;
        }
      }
      return changed ? next : ts;
    });
    setQueue((q) => q.map((x) => (x.path === path ? fn(x) : x)));
  }, []);

  const withVocals = useCallback((t: LoadedTrack): LoadedTrack => {
    const curve = voxCurves.current.get(t.path);
    if (!curve || !t.analysis) return t;
    return { ...t, voxStatus: "done", analysis: { ...t.analysis, vocals: curve } };
  }, []);

  const queueVox = useCallback(
    (track: LoadedTrack) => {
      voxChain.current = voxChain.current.then(async () => {
        try {
          const vocalsPath = await separateVocals(track.path, (msg) =>
            setStatus(`VOX · ${track.name} · ${msg}`)
          );
          const curve = await vocalCurve(vocalsPath, engine.ctx, track.buffer.duration);
          voxCurves.current.set(track.path, curve);
          updateTrack(track.path, withVocals);
          setStatus(`VOX READY · ${track.name}`);
        } catch (e) {
          updateTrack(track.path, (t) => ({ ...t, voxStatus: "failed" }));
          setStatus(`VOX FAILED · ${track.name} · ${e instanceof Error ? e.message : e}`);
        }
      });
    },
    [updateTrack, withVocals]
  );

  const analyse = useCallback(
    (track: LoadedTrack, place: (t: LoadedTrack) => void) => {
      analyseTrack(track.buffer)
        .then((analysis) => place(withVocals({ ...track, analysis })))
        .catch(() => place(track));
    },
    [withVocals]
  );

  const loadIntoDeck = useCallback(
    (deck: DeckId, track: LoadedTrack) => {
      engine.load(deck, track.buffer);
      setPlaying((p) => ({ ...p, [deck]: false }));
      setTracks((t) => ({ ...t, [deck]: track }));
      if (!track.analysis) {
        analyse(track, (done) =>
          setTracks((t) => (t[deck]?.path === done.path ? { ...t, [deck]: done } : t))
        );
      }
    },
    [analyse]
  );

  const pickFiles = useCallback(async (): Promise<string[]> => {
    const sel = await open({ multiple: true, filters: AUDIO_FILTERS });
    if (!sel) return [];
    return Array.isArray(sel) ? sel : [sel];
  }, []);

  const loadDeckManual = useCallback(
    async (deck: DeckId) => {
      await engine.resume();
      const files = await pickFiles();
      if (!files.length) return;
      try {
        setStatus(`DECODING ${files[0].split(/[\\/]/).pop()}…`);
        const track = await decodeFile(files[0]);
        loadIntoDeck(deck, track);
        queueVox(track);
        setStatus("READY");
        // extra files go to the queue
        for (const f of files.slice(1)) {
          const t = await decodeFile(f);
          analyse(t, (done) =>
            setQueue((q) => q.map((x) => (x.path === done.path ? done : x)))
          );
          setQueue((q) => [...q, t]);
          queueVox(t);
        }
      } catch (e) {
        setStatus(`DECODE FAILED: ${e}`);
      }
    },
    [decodeFile, loadIntoDeck, pickFiles, analyse, queueVox]
  );

  /** decode a path and append it to the queue (used by picker + library) */
  const enqueuePath = useCallback(
    async (path: string) => {
      try {
        setStatus(`DECODING ${path.split(/[\\/]/).pop()}…`);
        const t = await decodeFile(path);
        setQueue((q) => [...q, t]);
        analyse(t, (done) => setQueue((q) => q.map((x) => (x.path === done.path ? done : x))));
        queueVox(t);
        setStatus("READY");
      } catch (e) {
        setStatus(`DECODE FAILED: ${e}`);
      }
    },
    [decodeFile, analyse, queueVox]
  );

  const addToQueue = useCallback(async () => {
    await engine.resume();
    const files = await pickFiles();
    for (const f of files) await enqueuePath(f);
  }, [pickFiles, enqueuePath]);

  /* ── feed decks from the queue ──────────────────────────── */

  useEffect(() => {
    // if a deck is empty and the queue has tracks, auto-load the next one
    const free: DeckId | null = !tracks.A ? "A" : !tracks.B ? "B" : null;
    if (free && queue.length > 0 && !scheduled.current) {
      const [next, ...rest] = queue;
      setQueue(rest);
      loadIntoDeck(free, next);
    }
  }, [tracks, queue, loadIntoDeck]);

  /* ── transport ──────────────────────────────────────────── */

  const playPause = useCallback(
    async (deck: DeckId) => {
      await engine.resume();
      if (engine.decks[deck].playing) {
        engine.pause(deck);
        setPlaying((p) => ({ ...p, [deck]: false }));
      } else {
        engine.play(deck);
        setPlaying((p) => ({ ...p, [deck]: true }));
        setActiveDeck(deck);
        // set recording: a manual play opens (or continues) the set
        const t = tracksRef.current[deck];
        if (t) {
          setSetLog((log) =>
            log.length && log[log.length - 1].path === t.path
              ? log
              : [...log, { path: t.path, name: t.name }]
          );
        }
      }
    },
    []
  );

  /* ── automix engine ─────────────────────────────────────── */

  const animateXfade = useCallback((to: number, durMs: number) => {
    cancelAnimationFrame(xfadeAnim.current);
    const start = performance.now();
    let from = 0;
    setXfadeState((v) => ((from = v), v));
    const tick = (now: number) => {
      const f = Math.min(1, (now - start) / durMs);
      setXfadeState(from + (to - from) * f);
      if (f < 1) xfadeAnim.current = requestAnimationFrame(tick);
    };
    xfadeAnim.current = requestAnimationFrame(tick);
  }, []);

  const fireTransition = useCallback(
    (p: TransitionPlan, fromAnalysis: TrackAnalysis, toAnalysis: TrackAnalysis) => {
      const sched = scheduleTransition(engine, p, fromAnalysis, toAnalysis, () => {
        scheduled.current = null;
        setPlan(null);
        setPlaying((pl) => ({ ...pl, [p.fromDeck]: false, [p.toDeck]: true }));
        setActiveDeck(p.toDeck);
        // set recording: log the incoming track with how it was mixed in
        const incoming = tracksRef.current[p.toDeck];
        if (incoming) {
          setSetLog((log) => [
            ...log,
            {
              path: incoming.path,
              name: incoming.name,
              transition: { style: p.style, beats: p.beats, score: p.score },
            },
          ]);
        }
        // outgoing deck is now free — clear it so the queue effect refills it
        setTracks((t) => ({ ...t, [p.fromDeck]: null }));
        setStatus(`NOW ON DECK ${p.toDeck}`);
      });
      scheduled.current = sched;
      setPlaying((pl) => ({ ...pl, [p.toDeck]: true }));
      const leadMs = Math.max(0, (sched.ctxStart - engine.ctx.currentTime) * 1000);
      const uiDurMs = (sched.ctxEnd - sched.ctxStart) * 1000;
      window.setTimeout(() => {
        animateXfade(p.toDeck === "B" ? 1 : 0, uiDurMs);
        setStatus(`${p.style.replace("_", " ")} · ${p.fromDeck}→${p.toDeck} · ${p.beats} BEATS`);
      }, leadMs);
      setStatus(`TRANSITION ARMED · ${p.style.replace("_", " ")} · ${p.fromDeck}→${p.toDeck}`);
    },
    [animateXfade]
  );

  // watcher: when automix is on, plan and arm transitions automatically
  useEffect(() => {
    if (!automix) return;
    const iv = setInterval(() => {
      if (scheduled.current) return;
      const from = tracks[activeDeck];
      const toDeck: DeckId = activeDeck === "A" ? "B" : "A";
      const to = tracks[toDeck];
      if (!from?.analysis || !to?.analysis || !engine.decks[activeDeck].playing) return;

      const pos = engine.position(activeDeck);
      const p = planTransition(activeDeck, from.analysis, to.analysis, pos);
      setPlan(p);

      // arm the schedule once we're within 10 s of the blend start
      if (p.startAtFrom - pos < 10 && p.startAtFrom > pos) {
        fireTransition(p, from.analysis, to.analysis);
      }
      // failsafe: if we somehow passed the planned point, mix immediately
      if (p.startAtFrom <= pos && from.analysis.duration - pos < 30) {
        fireTransition(
          planTransition(activeDeck, from.analysis, to.analysis, pos, true),
          from.analysis,
          to.analysis
        );
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [automix, tracks, activeDeck, fireTransition]);

  const mixNow = useCallback(() => {
    if (scheduled.current) return;
    const from = tracks[activeDeck];
    const toDeck: DeckId = activeDeck === "A" ? "B" : "A";
    const to = tracks[toDeck];
    if (!from?.analysis || !to?.analysis) {
      setStatus("BOTH DECKS NEED ANALYSED TRACKS");
      return;
    }
    if (!engine.decks[activeDeck].playing) {
      setStatus("PLAY THE ACTIVE DECK FIRST");
      return;
    }
    const p = planTransition(activeDeck, from.analysis, to.analysis, engine.position(activeDeck), true);
    setPlan(p);
    fireTransition(p, from.analysis, to.analysis);
  }, [tracks, activeDeck, fireTransition]);

  const setXfade = useCallback((v: number) => {
    cancelAnimationFrame(xfadeAnim.current);
    setXfadeState(v);
    engine.setCrossfader(v);
  }, []);

  /* ── library handlers ───────────────────────────────────── */

  const libAddTag = useCallback((path: string, tag: string) => {
    setLib((l) => ({
      ...l,
      tracks: l.tracks.map((t) =>
        t.path === path && !t.tags.includes(tag) ? { ...t, tags: [...t.tags, tag] } : t
      ),
    }));
  }, []);

  const libRemoveTag = useCallback((path: string, tag: string) => {
    setLib((l) => ({
      ...l,
      tracks: l.tracks.map((t) =>
        t.path === path ? { ...t, tags: t.tags.filter((x) => x !== tag) } : t
      ),
    }));
  }, []);

  const libSavePlaylist = useCallback(
    (name: string) => {
      const paths = [tracks.A, tracks.B, ...queue]
        .filter(Boolean)
        .map((t) => (t as LoadedTrack).path);
      if (paths.length === 0) return;
      setLib((l) => ({ ...l, playlists: [...l.playlists, { id: newId(), name, paths }] }));
      setStatus(`PLAYLIST SAVED · ${name} · ${paths.length} TRACKS`);
    },
    [tracks, queue]
  );

  const libLoadPaths = useCallback(
    async (paths: string[]) => {
      setLibOpen(false);
      await engine.resume();
      for (const p of paths) await enqueuePath(p);
    },
    [enqueuePath]
  );

  const libLoadPlaylist = useCallback(
    (id: string) => {
      const pl = lib.playlists.find((p) => p.id === id);
      if (pl) void libLoadPaths(pl.paths);
    },
    [lib.playlists, libLoadPaths]
  );

  const libDeletePlaylist = useCallback((id: string) => {
    setLib((l) => ({ ...l, playlists: l.playlists.filter((p) => p.id !== id) }));
  }, []);

  const libSaveSet = useCallback(
    (name: string) => {
      if (setLog.length === 0) return;
      setLib((l) => ({
        ...l,
        sets: [...l.sets, { id: newId(), name, savedAt: Date.now(), entries: setLog }],
      }));
      setStatus(`SET SAVED · ${name} · ${setLog.length} TRACKS`);
    },
    [setLog]
  );

  const libLoadSet = useCallback(
    (id: string) => {
      const s = lib.sets.find((x) => x.id === id);
      if (s) void libLoadPaths(s.entries.map((e) => e.path));
    },
    [lib.sets, libLoadPaths]
  );

  const libDeleteSet = useCallback((id: string) => {
    setLib((l) => ({ ...l, sets: l.sets.filter((s) => s.id !== id) }));
  }, []);

  const libSavePattern = useCallback((name: string, bpm: number, steps: number[][]) => {
    setLib((l) => ({ ...l, patterns: [...l.patterns, { id: newId(), name, bpm, steps }] }));
    setStatus(`LOOP SAVED · ${name}`);
  }, []);

  const libDeletePattern = useCallback((id: string) => {
    setLib((l) => ({ ...l, patterns: l.patterns.filter((p) => p.id !== id) }));
  }, []);

  const persistLaunchpad = useCallback((mappings: LpMapping[], currentId: string) => {
    setLib((l) => ({ ...l, launchpad: { mappings, currentId } }));
  }, []);

  /* ── render ─────────────────────────────────────────────── */

  const markersFor = (deck: DeckId): { t: number; label: string }[] => {
    if (!plan) return [];
    if (plan.fromDeck === deck) return [{ t: plan.startAtFrom, label: "MIX OUT" }];
    if (plan.toDeck === deck)
      return [
        { t: plan.startAtTo, label: "MIX IN" },
        { t: plan.liftAtTo, label: "DROP" },
      ];
    return [];
  };

  return (
    <div className="shell">
      <header className="topbar">
        <h1>
          REV<span>MIX</span>
        </h1>
        <div className="topbar-status mono">{status}</div>
        <div className="topbar-controls">
          <button
            className={`lib-toggle${view === "seq" ? " active" : ""}`}
            onClick={() => setView((v) => (v === "seq" ? "decks" : "seq"))}
          >
            {view === "seq" ? "DECKS" : "SEQUENCER"}
          </button>
          <button
            className={`lib-toggle${view === "lp" ? " active" : ""}`}
            onClick={() => setView((v) => (v === "lp" ? "decks" : "lp"))}
          >
            {view === "lp" ? "DECKS" : "LAUNCHPAD"}
          </button>
          <button className="lib-toggle" onClick={() => setLibOpen((o) => !o)}>
            LIBRARY
          </button>
          <button className={`automix-toggle${automix ? " on" : ""}`} onClick={() => setAutomix((a) => !a)}>
            <i className="led" />
            AUTOMIX
          </button>
          <button className="mixnow-btn" onClick={mixNow} disabled={!!scheduled.current}>
            MIX NOW ⟶
          </button>
        </div>
      </header>

      {view === "seq" && (
        <main className="stage stage-seq">
          <Sequencer
            deckBpm={tracks[activeDeck]?.analysis?.bpm ?? null}
            patterns={lib.patterns}
            onSavePattern={libSavePattern}
            onDeletePattern={libDeletePattern}
          />
        </main>
      )}

      {/* The Launchpad surface stays MOUNTED across views (hidden, like the decks)
          so the hardware keeps driving fx-map / cues / the bridge while you're on
          the decks — it's a control surface, not just an editor screen. */}
      {libReady && (
        <main className="stage stage-lp" style={view !== "lp" ? { display: "none" } : undefined}>
          <LaunchpadScreen
            getActiveDeck={() => activeDeck}
            setActiveDeck={setActiveDeck}
            playPause={(d) => void playPause(d)}
            beats={{
              A: tracks.A?.analysis?.beatInterval ?? 60 / 128,
              B: tracks.B?.analysis?.beatInterval ?? 60 / 128,
            }}
            initialMappings={lib.launchpad?.mappings}
            initialCurrentId={lib.launchpad?.currentId}
            onPersist={persistLaunchpad}
          />
        </main>
      )}

      <main className="stage" style={view !== "decks" ? { display: "none" } : undefined}>
        <Deck
          id="A"
          track={tracks.A}
          otherTrack={tracks.B}
          playing={playing.A}
          active={activeDeck === "A"}
          getPosition={() => engine.position("A")}
          onPlayPause={() => playPause("A")}
          onSeek={(t) => engine.seek("A", t)}
          onLoad={() => loadDeckManual("A")}
          markers={markersFor("A")}
        />

        <Mixer
          xfade={xfade}
          onXfade={setXfade}
          activeDeck={activeDeck}
          fxBeats={{
            A: tracks.A?.analysis?.beatInterval ?? 60 / 128,
            B: tracks.B?.analysis?.beatInterval ?? 60 / 128,
          }}
        />

        <Deck
          id="B"
          track={tracks.B}
          otherTrack={tracks.A}
          playing={playing.B}
          active={activeDeck === "B"}
          getPosition={() => engine.position("B")}
          onPlayPause={() => playPause("B")}
          onSeek={(t) => engine.seek("B", t)}
          onLoad={() => loadDeckManual("B")}
          markers={markersFor("B")}
        />
      </main>

      <footer className="bottombar">
        <div className="queue">
          <button className="queue-add" onClick={addToQueue}>
            + ADD TRACKS
          </button>
          <div className="queue-list">
            {queue.length === 0 ? (
              <span className="queue-empty mono">QUEUE EMPTY — ADD TRACKS AND TOGGLE AUTOMIX</span>
            ) : (
              queue.map((t, i) => (
                <span className="queue-item mono" key={t.path + i}>
                  <em>{i + 1}</em> {t.name}
                  {t.analysis ? ` · ${t.analysis.bpm.toFixed(0)} · ${t.analysis.camelot}` : " · …"}
                </span>
              ))
            )}
          </div>
        </div>
        {plan && (
          <div className="plan mono">
            <span className="plan-score">
              MODEL {(plan.score * 100).toFixed(0)}%
            </span>
            {plan.notes.join(" · ")}
          </div>
        )}
      </footer>

      <Library
        open={libOpen}
        lib={lib}
        setLog={setLog}
        onClose={() => setLibOpen(false)}
        onQueueTrack={(p) => void libLoadPaths([p])}
        onAddTag={libAddTag}
        onRemoveTag={libRemoveTag}
        onSavePlaylist={libSavePlaylist}
        onLoadPlaylist={libLoadPlaylist}
        onDeletePlaylist={libDeletePlaylist}
        onSaveSet={libSaveSet}
        onClearSet={() => setSetLog([])}
        onLoadSet={libLoadSet}
        onDeleteSet={libDeleteSet}
      />
    </div>
  );
}

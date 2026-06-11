import { useState } from "react";
import { LibraryData, LibTrack, SetEntry } from "../library";

interface LibraryProps {
  open: boolean;
  lib: LibraryData;
  setLog: SetEntry[];
  onClose: () => void;
  onQueueTrack: (path: string) => void;
  onAddTag: (path: string, tag: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
  onSavePlaylist: (name: string) => void;
  onLoadPlaylist: (id: string) => void;
  onDeletePlaylist: (id: string) => void;
  onSaveSet: (name: string) => void;
  onClearSet: () => void;
  onLoadSet: (id: string) => void;
  onDeleteSet: (id: string) => void;
}

export function Library(props: LibraryProps) {
  const { open, lib, setLog } = props;
  const [filter, setFilter] = useState("");
  const [plName, setPlName] = useState("");
  const [setName, setSetName] = useState("");

  if (!open) return null;

  const q = filter.trim().toLowerCase();
  const tracks = q
    ? lib.tracks.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          (t.camelot ?? "").toLowerCase() === q
      )
    : lib.tracks;

  return (
    <>
      <div className="lib-backdrop" onClick={props.onClose} />
      <aside className="lib-drawer">
        <header className="lib-head">
          <h2>
            LIBRARY <span className="mono">{lib.tracks.length}</span>
          </h2>
          <button className="lib-close" onClick={props.onClose}>
            ✕
          </button>
        </header>

        <input
          className="lib-filter mono"
          placeholder="FILTER BY NAME / TAG / KEY…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="lib-scroll">
          {/* ── tracks ── */}
          <section className="lib-section">
            <h3>TRACKS</h3>
            {tracks.length === 0 && <p className="lib-empty mono">NOTHING HERE YET — LOAD SOME MUSIC</p>}
            {tracks.map((t) => (
              <TrackRow
                key={t.path}
                track={t}
                onQueue={() => props.onQueueTrack(t.path)}
                onAddTag={(tag) => props.onAddTag(t.path, tag)}
                onRemoveTag={(tag) => props.onRemoveTag(t.path, tag)}
              />
            ))}
          </section>

          {/* ── playlists ── */}
          <section className="lib-section">
            <h3>PLAYLISTS</h3>
            <div className="lib-newrow">
              <input
                className="mono"
                placeholder="NAME…"
                value={plName}
                onChange={(e) => setPlName(e.target.value)}
              />
              <button
                disabled={!plName.trim()}
                onClick={() => {
                  props.onSavePlaylist(plName.trim());
                  setPlName("");
                }}
              >
                SAVE DECKS+QUEUE
              </button>
            </div>
            {lib.playlists.map((p) => (
              <div className="lib-row" key={p.id}>
                <span className="lib-row-name">
                  {p.name} <em className="mono">{p.paths.length} TRACKS</em>
                </span>
                <button onClick={() => props.onLoadPlaylist(p.id)}>LOAD</button>
                <button className="lib-x" onClick={() => props.onDeletePlaylist(p.id)}>
                  ✕
                </button>
              </div>
            ))}
          </section>

          {/* ── current set ── */}
          <section className="lib-section">
            <h3>
              CURRENT SET <span className="mono">{setLog.length}</span>
            </h3>
            {setLog.map((e, i) => (
              <div className="lib-setentry mono" key={i}>
                <em>{i + 1}</em> {e.name}
                {e.transition && (
                  <span className="lib-trans">
                    {" "}
                    ⟵ {e.transition.style.replace("_", " ")} · {e.transition.beats}b ·{" "}
                    {(e.transition.score * 100) | 0}%
                  </span>
                )}
              </div>
            ))}
            <div className="lib-newrow">
              <input
                className="mono"
                placeholder="SET NAME…"
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
              />
              <button
                disabled={!setName.trim() || setLog.length === 0}
                onClick={() => {
                  props.onSaveSet(setName.trim());
                  setSetName("");
                }}
              >
                SAVE SET
              </button>
              <button disabled={setLog.length === 0} onClick={props.onClearSet}>
                CLEAR
              </button>
            </div>
          </section>

          {/* ── saved sets ── */}
          <section className="lib-section">
            <h3>SAVED SETS</h3>
            {lib.sets.map((s) => (
              <div className="lib-row" key={s.id}>
                <span className="lib-row-name">
                  {s.name}{" "}
                  <em className="mono">
                    {s.entries.length} TRACKS · {new Date(s.savedAt).toLocaleDateString()}
                  </em>
                </span>
                <button onClick={() => props.onLoadSet(s.id)}>REQUEUE</button>
                <button className="lib-x" onClick={() => props.onDeleteSet(s.id)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
        </div>
      </aside>
    </>
  );
}

function TrackRow({
  track,
  onQueue,
  onAddTag,
  onRemoveTag,
}: {
  track: LibTrack;
  onQueue: () => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const [tag, setTag] = useState("");
  return (
    <div className="lib-track">
      <div className="lib-track-main">
        <span className="lib-track-name">{track.name}</span>
        <span className="lib-track-meta mono">
          {track.bpm ? `${track.bpm.toFixed(0)} BPM` : "—"} · {track.camelot ?? "—"}
        </span>
      </div>
      <div className="lib-track-tags">
        {track.tags.map((t) => (
          <button className="lib-tag mono" key={t} title="remove" onClick={() => onRemoveTag(t)}>
            {t}
          </button>
        ))}
        <input
          className="lib-tag-input mono"
          placeholder="+TAG"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tag.trim()) {
              onAddTag(tag.trim().toLowerCase());
              setTag("");
            }
          }}
        />
      </div>
      <button className="lib-queue-btn mono" onClick={onQueue}>
        →Q
      </button>
    </div>
  );
}

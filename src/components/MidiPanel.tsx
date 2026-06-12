import { ACTIONS, GROUPS, PAD_BANKS, padIds } from "../midi/actions";
import { DeckId } from "../audio/engine";
import { MidiController, MidiEvent, formatKey } from "../midi/useMidi";

function describeEvent(ev: MidiEvent): string {
  return `${formatKey(ev.key)} = ${ev.value}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  midi: MidiController;
}

export function MidiPanel({ open, onClose, midi }: Props) {
  if (!open) return null;
  const {
    port, inputs, error, last, log, learnId, learnRowTag,
    refresh, connect, disconnect, learn, learnRow, clearBinding, clearBindings, clearAll, keyForAction,
  } = midi;

  return (
    <>
      <div className="lib-backdrop" onClick={onClose} />
      <aside className="midi-drawer">
        <header className="lib-head">
          <h2>
            MIDI <span className="mono">{port ? "● LINKED" : "○ NO DEVICE"}</span>
          </h2>
          <button className="lib-close" onClick={onClose}>
            ✕
          </button>
        </header>

        {/* connection */}
        <div className="midi-conn">
          <div className="midi-conn-row">
            <select
              className="mono midi-select"
              value={port ?? ""}
              onChange={(e) => connect(e.target.value || undefined)}
            >
              <option value="">{inputs.length ? "— select input —" : "no inputs detected"}</option>
              {inputs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button className="midi-btn" onClick={() => refresh()}>
              ⟳
            </button>
            {port ? (
              <button className="midi-btn" onClick={() => disconnect()}>
                UNLINK
              </button>
            ) : (
              <button className="midi-btn hot" onClick={() => connect()}>
                AUTO
              </button>
            )}
          </div>
          {error && <p className="midi-err mono">{error}</p>}
          {!inputs.length && !error && (
            <p className="midi-hint mono">
              No MIDI inputs. On Windows the DDJ-REV5 needs Pioneer's driver installed — then hit ⟳.
            </p>
          )}
        </div>

        {/* live monitor */}
        <div className="midi-monitor">
          <div className="midi-monitor-last mono">{last ? describeEvent(last) : "— move a control —"}</div>
          <div className="midi-monitor-log">
            {log.map((ev, i) => (
              <span className="mono" key={ev.t + ":" + i}>
                {describeEvent(ev)}
              </span>
            ))}
          </div>
        </div>

        {/* dedicated pad-bank switch mapping — mirrors the deck tabs */}
        <div className="midi-banks">
          <h3 className="mono">PAD BANK SWITCH — bind a REV-5 button to each tab</h3>
          {(["A", "B"] as const).map((d) => (
            <div className="midi-bankrow" key={d}>
              <span className={`midi-bankrow-tag mono deck-${d.toLowerCase()}`}>DECK {d}</span>
              <div className="midi-banktabs">
                {([["cue", "HOT CUE"], ["loop", "LOOP"], ["fx", "FX"]] as const).map(([b, label]) => {
                  const id = `bank.${b}.${d}`;
                  const key = keyForAction(id);
                  const learning = learnId === id;
                  return (
                    <button
                      key={b}
                      className={`midi-banktab${learning ? " learning" : ""}${key ? " bound" : ""}`}
                      onClick={() => learn(id)}
                    >
                      <span>{label}</span>
                      <em className="mono">{learning ? "PRESS BTN…" : key ? formatKey(key) : "unmapped"}</em>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* mappings */}
        <div className="midi-scroll">
          <p className="midi-hint mono midi-howto">
            PADS: the REV-5 sends different notes per mode, so each bank has its
            own 8 pads. Switch the controller to a mode, hit “LEARN 8” and press
            PAD 1 — the whole row maps to consecutive notes. Tap a chip to fix one.
          </p>

          {/* performance pads — one row of 8 per bank, with row-learn */}
          {(["A", "B"] as DeckId[]).map((d) => (
            <section className="midi-section" key={`pads-${d}`}>
              <h3 className={`mono deck-${d.toLowerCase()}`}>DECK {d} · PERFORMANCE PADS</h3>
              {PAD_BANKS.map(({ slug, label }) => {
                const ids = padIds(d, slug);
                const tag = `${d}.${slug}`;
                const rowLearning = learnRowTag === tag;
                const mappedCount = ids.filter((id) => keyForAction(id)).length;
                return (
                  <div className="midi-padrow" key={slug}>
                    <div className="midi-padrow-head">
                      <span className="midi-padrow-label">{label}</span>
                      <span className="midi-padrow-count mono">{mappedCount}/8</span>
                      <button
                        className={`midi-btn sm${rowLearning ? " hot" : ""}`}
                        onClick={() => learnRow(tag, ids)}
                      >
                        {rowLearning ? "PRESS PAD 1…" : "LEARN 8"}
                      </button>
                      <button className="midi-btn sm ghost" disabled={!mappedCount} onClick={() => clearBindings(ids)}>
                        ✕
                      </button>
                    </div>
                    <div className="midi-padchips">
                      {ids.map((id, i) => {
                        const key = keyForAction(id);
                        const chipLearning = learnId === id;
                        return (
                          <button
                            key={id}
                            className={`midi-padchip${key ? " set" : ""}${chipLearning ? " learning" : ""}`}
                            onClick={() => learn(id)}
                            title={key ? formatKey(key) : "unmapped — tap then press the pad"}
                          >
                            {chipLearning ? "•" : i + 1}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}

          {GROUPS.map((group) => (
            <section className="midi-section" key={group}>
              <h3 className="mono">{group}</h3>
              {ACTIONS.filter((a) => a.group === group).map((a) => {
                const key = keyForAction(a.id);
                const learning = learnId === a.id;
                return (
                  <div className={`midi-row${learning ? " learning" : ""}`} key={a.id}>
                    <span className="midi-row-label">{a.label}</span>
                    <span className="midi-row-bind mono">
                      {learning ? "MOVE IT…" : key ? formatKey(key) : "—"}
                    </span>
                    <button className="midi-btn sm" onClick={() => learn(a.id)}>
                      {learning ? "CANCEL" : "LEARN"}
                    </button>
                    <button className="midi-btn sm ghost" disabled={!key} onClick={() => clearBinding(a.id)}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="midi-foot">
          <button className="midi-btn ghost" onClick={() => clearAll()}>
            CLEAR ALL BINDINGS
          </button>
        </footer>
      </aside>
    </>
  );
}

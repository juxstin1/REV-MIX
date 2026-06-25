import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeckId } from "../audio/engine";
import { launchpad, LpInputEvent, hexTo7, inTauri } from "../audio/launchpad";
import { LaunchpadRuntime, LpHost } from "../audio/launchpad-runtime";
import {
  LpMapping,
  LpBinding,
  LpColor,
  LpActionId,
  ACTION_CATALOG,
  ACTION_BY_ID,
  defaultMapping,
  regionOf,
  topCCs,
  bottomCCs,
  leftCCs,
  rightCCs,
  xyToNote,
  COL,
} from "../audio/launchpad-map";

interface LaunchpadScreenProps {
  getActiveDeck: () => DeckId;
  setActiveDeck: (d: DeckId) => void;
  playPause: (d: DeckId) => void;
  beats: Record<DeckId, number>;
  initialMappings?: LpMapping[];
  initialCurrentId?: string;
  onPersist: (mappings: LpMapping[], currentId: string) => void;
}

const colorCss = (c?: LpColor) => (c ? `rgb(${c.r * 2}, ${c.g * 2}, ${c.b * 2})` : "#0a0c07");
const to2 = (v: number) => Math.min(255, v * 2).toString(16).padStart(2, "0");
const colorHex = (c?: LpColor) => (c ? `#${to2(c.r)}${to2(c.g)}${to2(c.b)}` : "#000000");

/** XY glide presets (per-axis) the user can pick */
const GLIDE_PRESETS = [
  { label: "SNAP", x: 0, y: 0, z: 0 },
  { label: "BALANCED", x: 0.3, y: 0.6, z: 0.4 },
  { label: "SYRUP", x: 0.6, y: 0.85, z: 0.6 },
];

export function LaunchpadScreen({
  getActiveDeck,
  setActiveDeck,
  playPause,
  beats,
  initialMappings,
  initialCurrentId,
  onPersist,
}: LaunchpadScreenProps) {
  const [mappings, setMappings] = useState<LpMapping[]>(
    initialMappings && initialMappings.length ? initialMappings : [defaultMapping()]
  );
  const [currentId, setCurrentId] = useState<string>(initialCurrentId ?? mappings[0].id);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [learn, setLearn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [portName, setPortName] = useState<string>("");
  const [mirror, setMirror] = useState(true);
  const [bridge, setBridge] = useState(false);
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const [ledSig, setLedSig] = useState(0); // bump to repaint virtual LEDs

  const current = mappings.find((m) => m.id === currentId) ?? mappings[0];

  // live host wrapper (stable identity, reads latest props via ref)
  const live = useRef({ getActiveDeck, setActiveDeck, playPause, beats });
  live.current = { getActiveDeck, setActiveDeck, playPause, beats };
  const host = useMemo<LpHost>(
    () => ({
      getActiveDeck: () => live.current.getActiveDeck(),
      setActiveDeck: (d) => live.current.setActiveDeck(d),
      playPause: (d) => live.current.playPause(d),
      beatFor: (d) => live.current.beats[d] ?? 60 / 128,
    }),
    []
  );

  const runtime = useRef<LaunchpadRuntime | null>(null);
  if (!runtime.current) runtime.current = new LaunchpadRuntime(current, host);

  // keep runtime mapping/page/bridge in sync with UI
  useEffect(() => {
    runtime.current!.setMapping(current);
  }, [current]);
  useEffect(() => {
    runtime.current!.setPage(page);
  }, [page]);
  useEffect(() => {
    runtime.current!.bridgeEnabled = bridge;
  }, [bridge]);

  const learnRef = useRef(learn);
  learnRef.current = learn;

  // device input
  useEffect(() => {
    let un = () => {};
    launchpad.onInput((e: LpInputEvent) => onDeviceInput(e)).then((u) => (un = u));
    const unState = launchpad.onState((s) => {
      setConnected(s.connected);
      setPortName(s.name ?? "");
    });
    return () => {
      un();
      unState.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = useCallback((num: number, on: boolean) => {
    setPressed((p) => {
      const n = new Set(p);
      if (on) n.add(num);
      else n.delete(num);
      return n;
    });
  }, []);

  const onDeviceInput = useCallback(
    (e: LpInputEvent) => {
      const down = e.kind === "note_on" || (e.kind === "cc" && e.val > 0);
      const up = e.kind === "note_off" || (e.kind === "cc" && e.val === 0);
      if (down) flash(e.num, true);
      if (up) flash(e.num, false);
      // MIDI learn: grab the pressed control instead of firing it
      if (learnRef.current && down && (e.kind === "note_on" || e.kind === "cc")) {
        setSelected(e.num);
        setLearn(false);
        return;
      }
      runtime.current!.handleInput(e);
    },
    [flash]
  );

  // LED refresh loop → mirror to hardware + repaint virtual device
  const lastFrame = useRef<string>("");
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const frame = runtime.current!.renderFrame();
      const sig = frame.map((f) => `${f.index}:${f.r},${f.g},${f.b}`).join("|");
      if (sig !== lastFrame.current) {
        lastFrame.current = sig;
        setLedSig((s) => (s + 1) & 0xffff);
        if (mirror && connected) launchpad.sendLeds(frame);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mirror, connected]);

  // persist on change (debounced by React batching; App debounces to disk)
  useEffect(() => {
    onPersist(mappings, currentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappings, currentId]);

  /* ── editing ─────────────────────────────────────────────── */

  // one frame per repaint (keyed on ledSig), shared across all 96 cells
  const frameMap = useMemo(() => {
    void ledSig;
    const m = new Map<number, LpColor>();
    for (const f of runtime.current!.renderFrame()) m.set(f.index, { r: f.r, g: f.g, b: f.b });
    return m;
  }, [ledSig]);
  const ledColor = useCallback((num: number): LpColor => frameMap.get(num) ?? COL.off, [frameMap]);

  const bindingOf = (num: number): LpBinding | undefined =>
    current.pages[page]?.bindings.find((b) => b.num === num);

  const mutateBinding = (num: number, patch: Partial<LpBinding>) => {
    setMappings((ms) =>
      ms.map((m) => {
        if (m.id !== currentId) return m;
        const pages = m.pages.map((pg, i) => {
          if (i !== page) return pg;
          const exists = pg.bindings.find((b) => b.num === num);
          let bindings: LpBinding[];
          if (exists) {
            bindings = pg.bindings.map((b) => (b.num === num ? { ...b, ...patch } : b));
          } else {
            bindings = [...pg.bindings, { region: regionOf(num), num, action: "none", ...patch }];
          }
          return { ...pg, bindings };
        });
        return { ...m, pages };
      })
    );
  };

  const removeBinding = (num: number) => {
    setMappings((ms) =>
      ms.map((m) =>
        m.id !== currentId
          ? m
          : { ...m, pages: m.pages.map((pg, i) => (i === page ? { ...pg, bindings: pg.bindings.filter((b) => b.num !== num) } : pg)) }
      )
    );
  };

  /* ── mapping management ──────────────────────────────────── */

  const renameMapping = (name: string) =>
    setMappings((ms) => ms.map((m) => (m.id === currentId ? { ...m, name } : m)));
  const newMapping = () => {
    const m = defaultMapping();
    m.id = `map-${Date.now().toString(36)}`;
    m.name = "New Map";
    setMappings((ms) => [...ms, m]);
    setCurrentId(m.id);
  };
  const duplicateMapping = () => {
    const m: LpMapping = JSON.parse(JSON.stringify(current));
    m.id = `map-${Date.now().toString(36)}`;
    m.name = `${current.name} copy`;
    setMappings((ms) => [...ms, m]);
    setCurrentId(m.id);
  };
  const deleteMapping = () => {
    if (mappings.length <= 1) return;
    setMappings((ms) => ms.filter((m) => m.id !== currentId));
    setCurrentId(mappings.find((m) => m.id !== currentId)!.id);
  };
  const resetMapping = () => {
    const d = defaultMapping();
    d.id = currentId;
    d.name = current.name;
    setMappings((ms) => ms.map((m) => (m.id === currentId ? d : m)));
  };

  /* ── connection ──────────────────────────────────────────── */

  const connect = async () => {
    if (connected) {
      await launchpad.disconnect();
      setConnected(false);
      return;
    }
    const name = await launchpad.connect();
    if (name) {
      setConnected(true);
      setPortName(name);
    }
  };
  const toggleBridge = async () => {
    if (!bridge) {
      const n = await launchpad.bridgeStart();
      setBridge(!!n || !inTauri);
    } else {
      await launchpad.bridgeStop();
      setBridge(false);
    }
  };

  const applyGlide = (p: (typeof GLIDE_PRESETS)[number]) =>
    runtime.current!.xy.setConfig({ glideX: p.x, glideY: p.y, glideZ: p.z });

  const sel = selected != null ? bindingOf(selected) : undefined;
  const selAction = sel?.action ?? "none";

  return (
    <div className="lp-screen">
      <div className="lp-toolbar">
        <div className="lp-tool-group">
          <button className={`lp-btn${connected ? " on" : ""}`} onClick={connect}>
            <i className="led" /> {connected ? "CONNECTED" : "CONNECT"}
          </button>
          <span className="lp-port mono">{connected ? portName : inTauri ? "no device" : "browser preview"}</span>
        </div>
        <div className="lp-tool-group">
          <button className={`lp-btn mini${mirror ? " on" : ""}`} onClick={() => setMirror((m) => !m)} title="send LEDs to hardware">
            MIRROR
          </button>
          <button className={`lp-btn mini${learn ? " on" : ""}`} onClick={() => setLearn((l) => !l)} title="press a pad to select it">
            LEARN
          </button>
          <button className={`lp-btn mini${bridge ? " on" : ""}`} onClick={toggleBridge} title="emit CC16/17/18 to Serato/rekordbox/djay">
            BRIDGE
          </button>
        </div>
        <div className="lp-tool-group">
          <select className="lp-select mono" value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input className="lp-name mono" value={current.name} onChange={(e) => renameMapping(e.target.value)} />
          <button className="lp-btn mini" onClick={newMapping}>NEW</button>
          <button className="lp-btn mini" onClick={duplicateMapping}>DUP</button>
          <button className="lp-btn mini" onClick={resetMapping}>RESET</button>
          <button className="lp-btn mini danger" onClick={deleteMapping} disabled={mappings.length <= 1}>DEL</button>
        </div>
      </div>

      <div className="lp-pages">
        {current.pages.map((pg, i) => (
          <button key={pg.id} className={`lp-page${page === i ? " on" : ""}`} onClick={() => setPage(i)}>
            {pg.name}
          </button>
        ))}
      </div>

      <div className="lp-body">
        <VirtualDevice
          ledColor={ledColor}
          bindingOf={bindingOf}
          selected={selected}
          pressed={pressed}
          onSelect={setSelected}
          onLocalPress={(num, down) => {
            // clicking the on-screen pad fires the mapping too (preview without hardware)
            flash(num, down);
            const region = regionOf(num);
            const kind = region === "grid" ? (down ? "note_on" : "note_off") : "cc";
            runtime.current!.handleInput({ kind: kind as LpInputEvent["kind"], num, val: down ? 127 : 0, chan: 0 });
          }}
        />

        <Inspector
          selected={selected}
          binding={sel}
          action={selAction}
          beats={beats}
          onAction={(a) => selected != null && mutateBinding(selected, { action: a, params: defaultParams(a) })}
          onParam={(k, v) => selected != null && mutateBinding(selected, { params: { ...(sel?.params ?? {}), [k]: v } })}
          onColor={(which, hex) => selected != null && mutateBinding(selected, { [which]: hexTo7(hex) })}
          onMode={(m) => selected != null && mutateBinding(selected, { mode: m })}
          onClear={() => selected != null && removeBinding(selected)}
          onGlide={applyGlide}
        />
      </div>
    </div>
  );
}

/* ── default params for a freshly assigned action ───────────── */
function defaultParams(a: LpActionId): Record<string, string | number> | undefined {
  const def = ACTION_BY_ID[a];
  if (!def.params) return undefined;
  const p: Record<string, string | number> = {};
  for (const s of def.params) if (s.default != null) p[s.key] = s.default;
  return p;
}

/* ── virtual device ──────────────────────────────────────────── */

function VirtualDevice({
  ledColor,
  bindingOf,
  selected,
  pressed,
  onSelect,
  onLocalPress,
}: {
  ledColor: (num: number) => LpColor;
  bindingOf: (num: number) => LpBinding | undefined;
  selected: number | null;
  pressed: Set<number>;
  onSelect: (n: number) => void;
  onLocalPress: (num: number, down: boolean) => void;
}) {
  const Cell = ({ num, round }: { num: number; round?: boolean }) => {
    const bound = !!bindingOf(num);
    return (
      <button
        className={`lp-cell${round ? " round" : ""}${selected === num ? " sel" : ""}${bound ? " bound" : ""}${
          pressed.has(num) ? " press" : ""
        }`}
        style={{ background: colorCss(ledColor(num)) }}
        onPointerDown={() => {
          onSelect(num);
          onLocalPress(num, true);
        }}
        onPointerUp={() => onLocalPress(num, false)}
        onPointerLeave={() => pressed.has(num) && onLocalPress(num, false)}
        title={`${bindingOf(num)?.action ?? "unbound"} · ${num}`}
      />
    );
  };

  return (
    <div className="lp-device">
      <div className="lp-row lp-top">
        <i className="lp-corner" />
        {topCCs.map((n) => (
          <Cell key={n} num={n} round />
        ))}
        <i className="lp-corner" />
      </div>
      {Array.from({ length: 8 }, (_, ri) => {
        const row = 8 - ri; // top row first
        return (
          <div className="lp-row" key={row}>
            <Cell num={leftCCs[ri]} round />
            {Array.from({ length: 8 }, (_, ci) => (
              <Cell key={ci} num={xyToNote(ci + 1, row)} />
            ))}
            <Cell num={rightCCs[ri]} round />
          </div>
        );
      })}
      <div className="lp-row lp-bottom">
        <i className="lp-corner" />
        {bottomCCs.map((n) => (
          <Cell key={n} num={n} round />
        ))}
        <i className="lp-corner" />
      </div>
    </div>
  );
}

/* ── inspector ───────────────────────────────────────────────── */

function Inspector({
  selected,
  binding,
  action,
  onAction,
  onParam,
  onColor,
  onMode,
  onClear,
  onGlide,
}: {
  selected: number | null;
  binding: LpBinding | undefined;
  action: LpActionId;
  beats: Record<DeckId, number>;
  onAction: (a: LpActionId) => void;
  onParam: (k: string, v: string | number) => void;
  onColor: (which: "idle" | "active", hex: string) => void;
  onMode: (m: "momentary" | "toggle") => void;
  onClear: () => void;
  onGlide: (p: (typeof GLIDE_PRESETS)[number]) => void;
}) {
  if (selected == null)
    return (
      <div className="lp-inspector">
        <p className="lp-hint mono">Select a pad or button to map it. Toggle LEARN, then press the hardware control to grab it.</p>
      </div>
    );

  const def = ACTION_BY_ID[action];
  const region = regionOf(selected);
  return (
    <div className="lp-inspector">
      <div className="lp-insp-head">
        <span className="mono">
          {region.toUpperCase()} · {region === "grid" ? "note" : "cc"} {selected}
        </span>
        <button className="lp-btn mini danger" onClick={onClear}>UNBIND</button>
      </div>

      <label className="lp-field">
        <span>Action</span>
        <select className="lp-select mono" value={action} onChange={(e) => onAction(e.target.value as LpActionId)}>
          {ACTION_CATALOG.map((a) => (
            <option key={a.id} value={a.id}>
              {a.category} · {a.label}
            </option>
          ))}
        </select>
      </label>

      {def.params?.map((p) => (
        <label className="lp-field" key={p.key}>
          <span>{p.label}</span>
          {p.options ? (
            <select className="lp-select mono" value={String(binding?.params?.[p.key] ?? p.default ?? "")} onChange={(e) => onParam(p.key, coerce(e.target.value))}>
              {p.options.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : p.kind === "deck" ? (
            <select className="lp-select mono" value={String(binding?.params?.[p.key] ?? "active")} onChange={(e) => onParam(p.key, e.target.value)}>
              <option value="active">active</option>
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          ) : p.kind === "cueIndex" ? (
            <input className="lp-num mono" type="number" min={0} max={15} value={Number(binding?.params?.[p.key] ?? 0)} onChange={(e) => onParam(p.key, Number(e.target.value))} />
          ) : p.kind === "page" ? (
            <input className="lp-num mono" type="number" min={0} value={Number(binding?.params?.[p.key] ?? 0)} onChange={(e) => onParam(p.key, Number(e.target.value))} />
          ) : (
            <input className="lp-num mono" type="number" step="0.01" value={Number(binding?.params?.[p.key] ?? 0)} onChange={(e) => onParam(p.key, Number(e.target.value))} />
          )}
        </label>
      ))}

      <div className="lp-field">
        <span>Colours</span>
        <div className="lp-colors">
          <label>
            idle
            <input type="color" value={colorHex(binding?.idle)} onChange={(e) => onColor("idle", e.target.value)} />
          </label>
          <label>
            active
            <input type="color" value={colorHex(binding?.active)} onChange={(e) => onColor("active", e.target.value)} />
          </label>
        </div>
      </div>

      {def.momentary !== undefined && (
        <div className="lp-field">
          <span>Trigger</span>
          <div className="lp-seg">
            <button className={`lp-btn mini${binding?.mode !== "toggle" ? " on" : ""}`} onClick={() => onMode("momentary")}>HOLD</button>
            <button className={`lp-btn mini${binding?.mode === "toggle" ? " on" : ""}`} onClick={() => onMode("toggle")}>TOGGLE</button>
          </div>
        </div>
      )}

      {(action === "xy.cell" || action === "xy.mode" || action === "xy.select") && (
        <div className="lp-field">
          <span>XY glide</span>
          <div className="lp-seg">
            {GLIDE_PRESETS.map((g) => (
              <button key={g.label} className="lp-btn mini" onClick={() => onGlide(g)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function coerce(v: string): string | number {
  const n = Number(v);
  return v !== "" && !Number.isNaN(n) ? n : v;
}

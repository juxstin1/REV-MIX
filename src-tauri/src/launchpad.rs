//! Launchpad Pro [MK3] control-surface backend.
//!
//! Web MIDI is unavailable in WKWebView (macOS), so all MIDI I/O lives here in
//! Rust (`midir`, cross-platform) and is exposed to the renderer through Tauri
//! commands (UI→device) and a `lp:input` event (device→UI).
//!
//! Protocol (validated against the unit via tools/xy_fx_bridge.py):
//!   - Header                F0 00 20 29 02 0E …
//!   - Programmer on/off     F0 00 20 29 02 0E 0E <01|00> F7
//!   - Bulk RGB LEDs         F0 00 20 29 02 0E 03 [03 idx r g b]… F7   (r,g,b 0..127)
//!   - Grid notes 11..88 (row*10+col), edges as CC.

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Novation manufacturer + Pro MK3 model header (no F0).
/// `00 20 29` = Novation, `02 0E` = Pro MK3 model id — 5 bytes.
const HDR: [u8; 5] = [0x00, 0x20, 0x29, 0x02, 0x0E];
const PROGRAMMER_ON: [u8; 8] = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x01];
const PROGRAMMER_OFF: [u8; 8] = [0xF0, 0x00, 0x20, 0x29, 0x02, 0x0E, 0x0E, 0x00];

#[derive(Default)]
pub struct LpState {
    out: Mutex<Option<MidiOutputConnection>>,
    input: Mutex<Option<MidiInputConnection<()>>>,
    /// optional virtual port for the external DJ-app bridge (Serato/rekordbox/djay)
    bridge: Mutex<Option<MidiOutputConnection>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LedSpec {
    pub index: u8,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Serialize, Clone)]
struct LpInput {
    /// "note_on" | "note_off" | "cc" | "aftertouch" | "pressure"
    kind: &'static str,
    num: u8,
    val: u8,
    chan: u8,
}

fn clamp7(v: u8) -> u8 {
    v.min(127)
}

/// Does this port name look like the Pro MK3's **Programmer/standalone** port?
///
/// The unit exposes three USB-MIDI port pairs. We want the base surface port and
/// must reject the others:
///   - macOS: a separate `… DAW` port for the Live handshake.
///   - Windows: WinMM names them `LPProMK3 MIDI` (base — what we want),
///     `MIDIIN2/MIDIOUT2 (LPProMK3 MIDI)` (DAW), and `MIDIIN3/MIDIOUT3 (…)` (DIN).
/// Verified on real hardware (build 26200, NovationUsbMidi driver): the base
/// `LPProMK3 MIDI` port is the one that enters Programmer Mode and carries the grid.
fn is_lp_port(name: &str) -> bool {
    let n = name.to_lowercase();
    let is_lp =
        n.contains("launchpad pro") || n.contains("lppromk3") || n.contains("lppro mk3");
    if !is_lp {
        return false;
    }
    // macOS DAW port:
    if n.contains("daw") {
        return false;
    }
    // Windows secondary interfaces (DAW = 2, DIN = 3):
    if n.contains("midiin2") || n.contains("midiin3") || n.contains("midiout2") || n.contains("midiout3")
    {
        return false;
    }
    true
}

#[tauri::command]
pub fn lp_list_ports() -> Result<Vec<String>, String> {
    let mo = MidiOutput::new("REVMIX-scan").map_err(|e| e.to_string())?;
    Ok(mo
        .ports()
        .iter()
        .filter_map(|p| mo.port_name(p).ok())
        .collect())
}

#[tauri::command]
pub fn lp_connect(
    app: AppHandle,
    state: State<'_, LpState>,
    port_hint: Option<String>,
) -> Result<String, String> {
    // Make reconnect safe: release any existing connection first. WinMM input
    // ports are exclusive, so a stale handle would block re-opening the port.
    *state.input.lock().unwrap() = None;
    *state.out.lock().unwrap() = None;

    // ----- output -----
    let mo = MidiOutput::new("REVMIX-out").map_err(|e| e.to_string())?;
    let out_ports = mo.ports();
    let pick = |name_ok: &dyn Fn(&str) -> bool| {
        out_ports.iter().find(|p| {
            mo.port_name(p)
                .map(|n| name_ok(&n))
                .unwrap_or(false)
        })
    };
    let out_port = match &port_hint {
        Some(h) => pick(&|n: &str| n.to_lowercase().contains(&h.to_lowercase())),
        None => pick(&is_lp_port),
    }
    .ok_or_else(|| "Launchpad Pro MK3 output port not found".to_string())?;
    let out_name = mo.port_name(out_port).unwrap_or_default();
    let mut out_conn = mo
        .connect(out_port, "revmix-lp-out")
        .map_err(|e| e.to_string())?;

    // enter Programmer mode
    out_conn
        .send(&PROGRAMMER_ON)
        .map_err(|e| e.to_string())?;

    // ----- input -----
    let mut mi = MidiInput::new("REVMIX-in").map_err(|e| e.to_string())?;
    mi.ignore(Ignore::None); // we want SysEx + aftertouch
    let in_ports = mi.ports();
    let in_port = match &port_hint {
        Some(h) => in_ports.iter().find(|p| {
            mi.port_name(p)
                .map(|n| n.to_lowercase().contains(&h.to_lowercase()))
                .unwrap_or(false)
        }),
        None => in_ports.iter().find(|p| {
            mi.port_name(p).map(|n| is_lp_port(&n)).unwrap_or(false)
        }),
    }
    .ok_or_else(|| "Launchpad Pro MK3 input port not found".to_string())?;

    let app_in = app.clone();
    let in_conn = mi
        .connect(
            in_port,
            "revmix-lp-in",
            move |_ts, msg, _| {
                if let Some(ev) = parse_midi(msg) {
                    let _ = app_in.emit("lp:input", ev);
                }
            },
            (),
        )
        .map_err(|e| e.to_string())?;

    *state.out.lock().unwrap() = Some(out_conn);
    *state.input.lock().unwrap() = Some(in_conn);
    let _ = app.emit("lp:state", serde_json::json!({ "connected": true, "name": out_name }));
    Ok(out_name)
}

fn parse_midi(msg: &[u8]) -> Option<LpInput> {
    if msg.is_empty() {
        return None;
    }
    // Ignore System Real-Time (0xF8 clock, 0xFA/FB/FC transport, 0xFE active
    // sensing) and System Common / SysEx (0xF0..0xF7). The Pro MK3 streams
    // MIDI clock (0xF8) continuously; these are not surface events.
    if msg[0] >= 0xF0 {
        return None;
    }
    let status = msg[0] & 0xF0;
    let chan = msg[0] & 0x0F;
    match status {
        0x90 => {
            let num = *msg.get(1)?;
            let val = *msg.get(2)?;
            Some(LpInput {
                kind: if val > 0 { "note_on" } else { "note_off" },
                num,
                val,
                chan,
            })
        }
        0x80 => Some(LpInput {
            kind: "note_off",
            num: *msg.get(1)?,
            val: 0,
            chan,
        }),
        0xB0 => Some(LpInput {
            kind: "cc",
            num: *msg.get(1)?,
            val: *msg.get(2)?,
            chan,
        }),
        0xA0 => Some(LpInput {
            kind: "aftertouch", // polyphonic key pressure: num = pad
            num: *msg.get(1)?,
            val: *msg.get(2)?,
            chan,
        }),
        0xD0 => Some(LpInput {
            kind: "pressure", // channel pressure: val = amount
            num: 0,
            val: *msg.get(1)?,
            chan,
        }),
        _ => None,
    }
}

#[tauri::command]
pub fn lp_send_leds(state: State<'_, LpState>, specs: Vec<LedSpec>) -> Result<(), String> {
    if specs.is_empty() {
        return Ok(());
    }
    let mut buf: Vec<u8> = Vec::with_capacity(8 + specs.len() * 5);
    buf.push(0xF0);
    buf.extend_from_slice(&HDR);
    buf.push(0x03); // "RGB/colour spec" command
    for s in &specs {
        // type 03 = RGB; index, then r,g,b (0..127)
        buf.extend_from_slice(&[0x03, s.index, clamp7(s.r), clamp7(s.g), clamp7(s.b)]);
    }
    buf.push(0xF7);
    let mut guard = state.out.lock().unwrap();
    let conn = guard.as_mut().ok_or("Launchpad not connected")?;
    conn.send(&buf).map_err(|e| e.to_string())
}

/// Raw passthrough — dev/debug only (e.g. custom layout/fader SysEx).
#[tauri::command]
pub fn lp_send_raw(state: State<'_, LpState>, bytes: Vec<u8>) -> Result<(), String> {
    let mut guard = state.out.lock().unwrap();
    let conn = guard.as_mut().ok_or("Launchpad not connected")?;
    conn.send(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lp_disconnect(app: AppHandle, state: State<'_, LpState>) -> Result<(), String> {
    if let Some(mut conn) = state.out.lock().unwrap().take() {
        // clear all LEDs (whole grid + edges) then hand the device back
        let mut clear: Vec<u8> = vec![0xF0];
        clear.extend_from_slice(&HDR);
        clear.push(0x03);
        for &idx in ALL_LEDS.iter() {
            clear.extend_from_slice(&[0x03, idx, 0, 0, 0]);
        }
        clear.push(0xF7);
        let _ = conn.send(&clear);
        let _ = conn.send(&PROGRAMMER_OFF);
    }
    *state.input.lock().unwrap() = None;
    let _ = app.emit("lp:state", serde_json::json!({ "connected": false }));
    Ok(())
}

/* ── external MIDI bridge (Serato / rekordbox / djay) ───────────── */

#[tauri::command]
pub fn lp_bridge_start(state: State<'_, LpState>) -> Result<String, String> {
    let name = "REVMIX XY Bridge";
    let mo = MidiOutput::new("REVMIX-bridge").map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use midir::os::unix::VirtualOutput;
        let conn = mo.create_virtual(name).map_err(|e| e.to_string())?;
        *state.bridge.lock().unwrap() = Some(conn);
        return Ok(name.to_string());
    }
    #[cfg(not(unix))]
    {
        // Windows can't create virtual ports — open a pre-existing loopMIDI port.
        let ports = mo.ports();
        let port = ports
            .iter()
            .find(|p| {
                mo.port_name(p)
                    .map(|n| n.contains(name))
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                format!("No \"{name}\" port. On Windows, create one in loopMIDI first.")
            })?;
        let conn = mo.connect(port, "revmix-bridge").map_err(|e| e.to_string())?;
        *state.bridge.lock().unwrap() = Some(conn);
        Ok(name.to_string())
    }
}

#[tauri::command]
pub fn lp_bridge_cc(
    state: State<'_, LpState>,
    cc: u8,
    val: u8,
    channel: u8,
) -> Result<(), String> {
    let mut guard = state.bridge.lock().unwrap();
    let conn = guard.as_mut().ok_or("Bridge not started")?;
    conn.send(&[0xB0 | (channel & 0x0F), clamp7(cc), clamp7(val)])
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lp_bridge_stop(state: State<'_, LpState>) -> Result<(), String> {
    *state.bridge.lock().unwrap() = None;
    Ok(())
}

/// Every addressable LED index (grid 11..88 + the four CC edges) for clear-all.
const ALL_LEDS: [u8; 96] = {
    let mut a = [0u8; 96];
    let mut i = 0;
    // grid 11..88
    let mut r = 1;
    while r <= 8 {
        let mut c = 1;
        while c <= 8 {
            a[i] = r * 10 + c;
            i += 1;
            c += 1;
        }
        r += 1;
    }
    // top 91..98, bottom 1..8
    let mut c = 1;
    while c <= 8 {
        a[i] = 90 + c;
        i += 1;
        a[i] = c;
        i += 1;
        c += 1;
    }
    // left x0 (10..80), right x9 (19..89)
    let mut rr = 1;
    while rr <= 8 {
        a[i] = rr * 10;
        i += 1;
        a[i] = rr * 10 + 9;
        i += 1;
        rr += 1;
    }
    a
};

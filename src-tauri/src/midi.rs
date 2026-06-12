//! Native MIDI input via `midir` (WinMM on Windows). We read raw MIDI from a
//! hardware controller — e.g. the Pioneer DDJ-REV5 — and forward every Note/CC
//! message to the webview as a `midi:message` event. The frontend owns the
//! actual control mapping (see `src/midi/`), so this layer stays dumb: open a
//! port, stream bytes, done.
//!
//! Web MIDI was the obvious alternative but its permission story inside WebView2
//! is unreliable; a native port is deterministic and also opens the door to LED
//! feedback later.

use midir::{Ignore, MidiInput, MidiInputConnection};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Holds the live input connection so it isn't dropped (which would close the
/// port). One connection at a time — opening a new port replaces the old.
#[derive(Default)]
pub struct MidiHub {
    conn: Mutex<Option<MidiInputConnection<()>>>,
}

#[derive(Clone, serde::Serialize)]
struct MidiMessage {
    /// raw status + data bytes (2–3 for the messages we care about)
    bytes: Vec<u8>,
    port: String,
}

/// Substrings we treat as "this is the DJ controller" for auto-connect.
const PREFERRED: &[&str] = &["rev", "ddj", "pioneer", "alphatheta"];

fn name_matches(name: &str, needle: &str) -> bool {
    name.to_lowercase().contains(&needle.to_lowercase())
}

/// List the names of all MIDI input ports currently visible to the OS.
#[tauri::command]
pub fn midi_inputs() -> Result<Vec<String>, String> {
    let midi_in = MidiInput::new("revmix-scan").map_err(|e| e.to_string())?;
    let names = midi_in
        .ports()
        .iter()
        .filter_map(|p| midi_in.port_name(p).ok())
        .collect();
    Ok(names)
}

/// Open a MIDI input port and start streaming messages to the webview.
///
/// `name` is matched as a case-insensitive substring. When omitted we pick the
/// first port that looks like a Pioneer/REV controller, else the first port.
/// Returns the name of the port actually opened.
#[tauri::command]
pub fn midi_connect(
    app: AppHandle,
    hub: State<'_, MidiHub>,
    name: Option<String>,
) -> Result<String, String> {
    let mut midi_in = MidiInput::new("revmix-in").map_err(|e| e.to_string())?;
    // Drop the noise we never map: clock, active-sensing, sysex. Notes/CC stay.
    midi_in.ignore(Ignore::All);

    let ports = midi_in.ports();
    if ports.is_empty() {
        return Err("no MIDI input ports found".into());
    }

    // Resolve which port to open.
    let chosen = match &name {
        Some(n) => ports
            .iter()
            .find(|p| midi_in.port_name(p).map(|pn| name_matches(&pn, n)).unwrap_or(false)),
        None => ports
            .iter()
            .find(|p| {
                midi_in
                    .port_name(p)
                    .map(|pn| PREFERRED.iter().any(|k| name_matches(&pn, k)))
                    .unwrap_or(false)
            })
            .or_else(|| ports.first()),
    }
    .ok_or_else(|| match &name {
        Some(n) => format!("no MIDI input matching \"{n}\""),
        None => "no MIDI input ports found".to_string(),
    })?
    .clone();

    let port_name = midi_in.port_name(&chosen).map_err(|e| e.to_string())?;

    // Close any existing connection before opening the new one.
    {
        let mut guard = hub.conn.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    let emit_name = port_name.clone();
    let conn = midi_in
        .connect(
            &chosen,
            "revmix-in",
            move |_ts, bytes, _| {
                let _ = app.emit(
                    "midi:message",
                    MidiMessage {
                        bytes: bytes.to_vec(),
                        port: emit_name.clone(),
                    },
                );
            },
            (),
        )
        .map_err(|e| format!("failed to open MIDI port \"{port_name}\": {e}"))?;

    *hub.conn.lock().map_err(|e| e.to_string())? = Some(conn);
    Ok(port_name)
}

/// Close the active MIDI input port, if any.
#[tauri::command]
pub fn midi_disconnect(hub: State<'_, MidiHub>) -> Result<(), String> {
    *hub.conn.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// Best-effort auto-connect at startup: grab the REV5/DDJ if it's already on.
/// Silent on failure — the user can connect from the MIDI panel.
pub fn try_autoconnect(app: &AppHandle) {
    let hub = app.state::<MidiHub>();
    let _ = midi_connect(app.clone(), hub, None);
}

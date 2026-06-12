mod midi;

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

/// Locate the StemSep python sidecar. In dev we reuse the sibling `dj`
/// project's venv (audio-separator + ROCm torch) instead of duplicating it;
/// a packaged build would ship its own `python` resource dir.
fn python_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dj")
        .join("python");
    if dev.exists() {
        return Ok(dev);
    }
    app.path()
        .resource_dir()
        .map(|r| r.join("python"))
        .map_err(|e| e.to_string())
        .and_then(|p| {
            if p.exists() {
                Ok(p)
            } else {
                Err("StemSep python sidecar not found (expected ..\\dj\\python)".into())
            }
        })
}

/// Run vocal/instrumental separation for `input` in the background.
/// Progress streams as `vox:event` events (JSON, tagged with the input path);
/// results are cached under app-local-data/stems so each track runs once.
#[tauri::command]
fn separate_vocals(app: AppHandle, input: String) -> Result<(), String> {
    let py_dir = python_dir(&app)?;
    let script = py_dir.join("separate.py");
    let stems_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("stems");

    let track_name = std::path::Path::new(&input)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let expected = stems_dir
        .join(&track_name)
        .join("vocals")
        .join(format!("{track_name} - Vocals.wav"));
    if expected.exists() {
        let _ = app.emit(
            "vox:event",
            serde_json::json!({
                "input": input,
                "type": "done",
                "stems": [{"name": "Vocals", "path": expected.to_string_lossy()}]
            }),
        );
        return Ok(());
    }

    let mut cmd = Command::new("uv");
    cmd.arg("run")
        .arg("--project")
        .arg(&py_dir)
        .arg("python")
        .arg(&script)
        .arg("--input")
        .arg(&input)
        .arg("--preset")
        .arg("vocals")
        .arg("--output")
        .arg(&stems_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start separator (is uv installed?): {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // stderr → log events
    let app_err = app.clone();
    let input_err = input.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit(
                "vox:log",
                serde_json::json!({"input": input_err, "line": line}),
            );
        }
    });

    // stdout → JSON-lines protocol, tagged with the input path
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut saw_terminal = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(mut v) = serde_json::from_str::<Value>(&line) {
                if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                    if t == "done" || t == "error" {
                        saw_terminal = true;
                    }
                }
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("input".into(), Value::String(input.clone()));
                }
                let _ = app_out.emit("vox:event", v);
            }
        }
        let status = child.wait().ok();
        if !saw_terminal {
            let code = status.and_then(|s| s.code());
            let _ = app_out.emit(
                "vox:event",
                serde_json::json!({
                    "input": input,
                    "type": "error",
                    "message": format!("separator exited unexpectedly (code {:?})", code)
                }),
            );
        }
    });

    Ok(())
}

fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("library.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_library(app: AppHandle) -> Result<String, String> {
    let p = library_path(&app)?;
    if p.exists() {
        std::fs::read_to_string(p).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
fn save_library(app: AppHandle, data: String) -> Result<(), String> {
    let p = library_path(&app)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(midi::MidiHub::default())
        .setup(|app| {
            midi::try_autoconnect(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            separate_vocals,
            load_library,
            save_library,
            midi::midi_inputs,
            midi::midi_connect,
            midi::midi_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Grove desktop shell (M5): a thin native window over the daemon-served web app.
// Responsibilities: adopt a running daemon or spawn one, wait for health, then
// navigate the window to the daemon URL. Token injection works exactly as in a
// browser because the page itself is served by the daemon. No Tauri IPC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

const PORT: u16 = 4870;

struct Daemon(Mutex<Option<Child>>);

fn healthy() -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(800))
        .build();
    agent
        .get(&format!("http://127.0.0.1:{PORT}/api/health"))
        .call()
        .is_ok()
}

/// Dev-mode resolution: the daemon script lives two packages over. Packaged
/// builds (deferred) will ship a bundled runtime and override via env.
fn daemon_script() -> PathBuf {
    if let Ok(p) = std::env::var("GROVE_DAEMON_SCRIPT") {
        return PathBuf::from(p);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest.join("../../core/dist/index.js");
    script.canonicalize().unwrap_or(script)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = if healthy() {
                None // adopt the daemon the user already runs
            } else {
                Some(
                    Command::new("node")
                        .arg(daemon_script())
                        .env("GROVE_PARENT_PID", std::process::id().to_string())
                        .spawn()
                        .expect("failed to start the grove daemon — is node on PATH and `pnpm build` run?"),
                )
            };
            app.manage(Daemon(Mutex::new(child)));

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..130 {
                    if healthy() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.eval(&format!(
                        "window.location.replace('http://127.0.0.1:{PORT}/')"
                    ));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building grove desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Only kill a daemon we spawned; an adopted one keeps running.
                let daemon = app.state::<Daemon>();
                let mut guard = daemon.0.lock().unwrap();
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
        });
}

use super::registry::{python_uv_command_args, ProviderRuntime};
use crate::commands::history::{
    archive_session_from_manifest, FileOutcome, SessionSummarySnapshot,
};
use crate::notifications;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

pub const SESSION_EVENT: &str = "transcription-event";
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub struct WorkerLauncher {
    app_handle: AppHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationPreferences {
    pub notifications_enabled: bool,
    pub notify_on_complete: bool,
    pub notify_on_error: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            notifications_enabled: true,
            notify_on_complete: true,
            notify_on_error: true,
        }
    }
}

#[allow(dead_code)]
pub struct WorkerProcess {
    pub child: Arc<Mutex<Child>>,
    pub stream_task: JoinHandle<()>,
}

struct ActiveProcess {
    session_id: String,
    manifest_path: PathBuf,
    queued_item_ids: Vec<String>,
    child: Arc<Mutex<Child>>,
}

static ACTIVE_PROCESS: LazyLock<Mutex<Option<ActiveProcess>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone, Copy, PartialEq)]
struct SessionSummary {
    total: u64,
    processed: u64,
    skipped: u64,
    failed: u64,
    duration_seconds: f64,
}

pub fn launch_command_for_runtime(runtime: &ProviderRuntime) -> Option<LaunchCommand> {
    match runtime {
        ProviderRuntime::SwiftNative { binary_path, .. } => Some(LaunchCommand {
            program: binary_path.to_string_lossy().to_string(),
            args: Vec::new(),
        }),
        ProviderRuntime::PythonUv {
            package,
            entry_point,
        } => Some(LaunchCommand {
            program: "uv".to_string(),
            args: python_uv_command_args(package, entry_point, &[]),
        }),
        ProviderRuntime::CloudAPI { .. } => None,
    }
}

fn infer_model_version_from_model_dir(model_dir: &Path) -> String {
    let lower = model_dir.to_string_lossy().to_ascii_lowercase();
    if lower.contains("v2") {
        "v2".to_string()
    } else {
        "v3".to_string()
    }
}

fn command_args_for_runtime(
    runtime: &ProviderRuntime,
    manifest_path: &Path,
    output_dir: &Path,
) -> Result<LaunchCommand, String> {
    let mut launch = launch_command_for_runtime(runtime)
        .ok_or_else(|| "Cloud API providers do not support local worker launching".to_string())?;

    if let ProviderRuntime::SwiftNative { model_dir, .. } = runtime {
        launch.args.extend([
            "--model-dir".to_string(),
            model_dir.to_string_lossy().to_string(),
            "--model-version".to_string(),
            infer_model_version_from_model_dir(model_dir),
        ]);
    }

    launch.args.extend([
        "--manifest".to_string(),
        manifest_path.to_string_lossy().to_string(),
        "--output-dir".to_string(),
        output_dir.to_string_lossy().to_string(),
    ]);

    Ok(launch)
}

fn parse_worker_line(line: &str) -> Result<Option<Value>, serde_json::Error> {
    if line.trim().is_empty() {
        return Ok(None);
    }

    serde_json::from_str::<Value>(line).map(Some)
}

fn parse_summary_event(value: &Value) -> Option<SessionSummary> {
    if value.get("event").and_then(Value::as_str) != Some("summary") {
        return None;
    }

    Some(SessionSummary {
        total: value.get("total").and_then(Value::as_u64).unwrap_or(0),
        processed: value.get("processed").and_then(Value::as_u64).unwrap_or(0),
        skipped: value.get("skipped").and_then(Value::as_u64).unwrap_or(0),
        failed: value.get("failed").and_then(Value::as_u64).unwrap_or(0),
        duration_seconds: value
            .get("duration_seconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

fn parse_fatal_error(value: &Value) -> Option<String> {
    if value.get("event").and_then(Value::as_str) != Some("fatal_error") {
        return None;
    }

    value
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn parse_file_outcome(value: &Value) -> Option<(String, FileOutcome)> {
    let event_name = value.get("event").and_then(Value::as_str)?;
    let file_path = value.get("file").and_then(Value::as_str)?.to_string();

    match event_name {
        "file_done" => {
            let output = value.get("output");
            Some((
                file_path,
                FileOutcome {
                    status: "success".to_string(),
                    transcript_path: output
                        .and_then(|entry| entry.get("txt"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    json_path: output
                        .and_then(|entry| entry.get("json"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    error: None,
                },
            ))
        }
        "file_skipped" => Some((
            file_path,
            FileOutcome {
                status: "skipped".to_string(),
                transcript_path: value
                    .get("output")
                    .and_then(|entry| entry.get("txt"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                json_path: value
                    .get("output")
                    .and_then(|entry| entry.get("json"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                error: value
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        )),
        "file_failed" => Some((
            file_path,
            FileOutcome {
                status: "failed".to_string(),
                transcript_path: None,
                json_path: None,
                error: value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        )),
        _ => None,
    }
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "0s".to_string();
    }

    let total_seconds = seconds.round() as u64;
    let mins = total_seconds / 60;
    let secs = total_seconds % 60;
    if mins == 0 {
        format!("{}s", secs)
    } else {
        format!("{}m {}s", mins, secs)
    }
}

fn show_completion_notification(summary: Option<SessionSummary>, output_dir: &Path) {
    let failed = summary.map(|entry| entry.failed).unwrap_or(0);
    let processed = summary.map(|entry| entry.processed).unwrap_or(0);
    let title = if failed > 0 {
        "Transcription Complete (with failures)"
    } else {
        "Transcription Complete"
    };
    let details = if let Some(metrics) = summary {
        if metrics.failed > 0 {
            format!(
                "{} succeeded, {} failed in {}.",
                metrics.processed,
                metrics.failed,
                format_duration(metrics.duration_seconds)
            )
        } else {
            format!(
                "{} file(s) transcribed in {}.",
                metrics.processed,
                format_duration(metrics.duration_seconds)
            )
        }
    } else if failed > 0 {
        format!("{} succeeded, {} failed.", processed, failed)
    } else {
        "Batch finished successfully.".to_string()
    };

    let body = format!("{} Output: {}", details, output_dir.display());
    let _ = notifications::send(title, &body);
}

fn show_failure_notification(exit_code: i32, fatal_error: Option<&str>) {
    let detail = match fatal_error {
        Some(error) if !error.trim().is_empty() => error.to_string(),
        _ => format!("Worker exited with code {}.", exit_code),
    };
    let _ = notifications::send("Transcription Failed", &detail);
}

fn maybe_show_session_notification(
    notification_preferences: NotificationPreferences,
    exit_code: i32,
    summary: Option<SessionSummary>,
    fatal_error: Option<&str>,
    output_dir: &Path,
) {
    if !notification_preferences.notifications_enabled {
        return;
    }

    if !notifications::check_permission() {
        return;
    }

    let completed = exit_code == 0 || exit_code == 2;
    if completed {
        if notification_preferences.notify_on_complete {
            show_completion_notification(summary, output_dir);
        }
        return;
    }

    if notification_preferences.notify_on_error {
        show_failure_notification(exit_code, fatal_error);
    }
}

fn stream_stderr(app: AppHandle, stderr: impl std::io::Read) {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        let _ = app.emit(
            SESSION_EVENT,
            json!({
                "event": "worker_stderr",
                "line": line,
            }),
        );
    }
}

fn wait_for_exit_code(child: &Arc<Mutex<Child>>) -> i32 {
    let mut guard = match child.lock() {
        Ok(guard) => guard,
        Err(_) => return -1,
    };

    guard
        .wait()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(-1)
}

fn clear_active_session_if_matches(session_id: &str) {
    if let Ok(mut active) = ACTIVE_PROCESS.lock() {
        let should_clear = active
            .as_ref()
            .map(|current| current.session_id == session_id)
            .unwrap_or(false);
        if should_clear {
            *active = None;
        }
    }
}

fn send_sigterm(child: &Arc<Mutex<Child>>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = {
            let guard = child
                .lock()
                .map_err(|_| "Failed to lock worker process for SIGTERM".to_string())?;
            guard.id()
        };

        let signaled = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        if signaled {
            return Ok(());
        }
    }

    let mut guard = child
        .lock()
        .map_err(|_| "Failed to lock worker process for termination".to_string())?;
    match guard.kill() {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
        Err(error) => Err(format!("Failed to terminate worker: {}", error)),
    }
}

fn force_kill(child: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut guard = child
        .lock()
        .map_err(|_| "Failed to lock worker process for forced termination".to_string())?;
    match guard.kill() {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
        Err(error) => Err(format!("Failed to force kill worker: {}", error)),
    }
}

impl WorkerLauncher {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    fn build_command(
        &self,
        provider: &ProviderRuntime,
        manifest_path: &Path,
        output_dir: &Path,
    ) -> Result<Command, String> {
        let launch = command_args_for_runtime(provider, manifest_path, output_dir)?;
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        Ok(command)
    }

    pub async fn launch(
        &self,
        provider: &ProviderRuntime,
        session_id: &str,
        manifest_path: &Path,
        output_dir: &Path,
        queued_item_ids: Vec<String>,
        notification_preferences: NotificationPreferences,
    ) -> Result<WorkerProcess, String> {
        {
            let active = ACTIVE_PROCESS
                .lock()
                .map_err(|_| "Failed to inspect active worker process".to_string())?;
            if active.is_some() {
                return Err("A transcription session is already running".to_string());
            }
        }

        self.app_handle
            .emit(
                SESSION_EVENT,
                json!({
                    "event": "worker_started",
                    "session_id": session_id,
                    "manifest_path": manifest_path.to_string_lossy(),
                    "output_dir": output_dir.to_string_lossy(),
                }),
            )
            .map_err(|error| format!("Failed to emit worker_started: {}", error))?;

        let mut child = self
            .build_command(provider, manifest_path, output_dir)?
            .spawn()
            .map_err(|error| format!("Failed to launch worker: {}", error))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture worker stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture worker stderr".to_string())?;

        let child = Arc::new(Mutex::new(child));

        {
            let mut active = ACTIVE_PROCESS
                .lock()
                .map_err(|_| "Failed to register active worker process".to_string())?;
            *active = Some(ActiveProcess {
                session_id: session_id.to_string(),
                manifest_path: manifest_path.to_path_buf(),
                queued_item_ids,
                child: child.clone(),
            });
        }

        let session_id_owned = session_id.to_string();
        let manifest_path_owned = manifest_path.to_path_buf();
        let output_dir_owned = output_dir.to_path_buf();
        let app_for_stream = self.app_handle.clone();
        let child_for_stream = child.clone();

        let stream_task = tokio::task::spawn_blocking(move || {
            let stderr_app = app_for_stream.clone();
            let stderr_handle = std::thread::spawn(move || stream_stderr(stderr_app, stderr));

            let reader = BufReader::new(stdout);
            let mut latest_summary: Option<SessionSummary> = None;
            let mut fatal_error: Option<String> = None;
            let mut file_outcomes: HashMap<String, FileOutcome> = HashMap::new();
            for line in reader.lines().map_while(Result::ok) {
                match parse_worker_line(&line) {
                    Ok(Some(value)) => {
                        if let Some(summary) = parse_summary_event(&value) {
                            latest_summary = Some(summary);
                        }
                        if let Some(error) = parse_fatal_error(&value) {
                            fatal_error = Some(error);
                        }
                        if let Some((file_path, outcome)) = parse_file_outcome(&value) {
                            file_outcomes.insert(file_path, outcome);
                        }
                        let _ = app_for_stream.emit(SESSION_EVENT, value);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        let _ = app_for_stream.emit(
                            SESSION_EVENT,
                            json!({
                                "event": "worker_stdout",
                                "line": line,
                            }),
                        );
                    }
                }
            }

            let _ = stderr_handle.join();

            let exit_code = wait_for_exit_code(&child_for_stream);
            let status = if exit_code == 0 || exit_code == 2 {
                "completed"
            } else {
                "failed"
            };
            let summary_snapshot = latest_summary.map(|summary| SessionSummarySnapshot {
                total: summary.total,
                processed: summary.processed,
                skipped: summary.skipped,
                failed: summary.failed,
                duration_seconds: summary.duration_seconds,
            });
            if let Err(error) = archive_session_from_manifest(
                &manifest_path_owned,
                &session_id_owned,
                summary_snapshot,
                exit_code,
                status,
                &file_outcomes,
            ) {
                eprintln!(
                    "[history] failed to archive session {}: {}",
                    session_id_owned, error
                );
            }

            let _ = app_for_stream.emit(
                SESSION_EVENT,
                json!({
                    "event": "worker_finished",
                    "session_id": session_id_owned.clone(),
                    "exit_code": exit_code,
                    "success": exit_code == 0 || exit_code == 2,
                }),
            );
            let _ = app_for_stream.emit(
                SESSION_EVENT,
                json!({
                    "event": "session_summary",
                    "session_id": session_id_owned.clone(),
                    "exit_code": exit_code,
                    "status": status,
                }),
            );

            maybe_show_session_notification(
                notification_preferences,
                exit_code,
                latest_summary,
                fatal_error.as_deref(),
                &output_dir_owned,
            );

            clear_active_session_if_matches(&session_id_owned);
        });

        Ok(WorkerProcess { child, stream_task })
    }

    pub async fn stop(&self, session_id: &str) -> Result<(), String> {
        let (child, manifest_path, queued_item_ids) = {
            let active = ACTIVE_PROCESS
                .lock()
                .map_err(|_| "Failed to access active worker process".to_string())?;

            let Some(active) = active.as_ref() else {
                return Ok(());
            };

            if active.session_id != session_id {
                return Err(format!(
                    "Session mismatch: active={}, requested={}",
                    active.session_id, session_id
                ));
            }

            (
                active.child.clone(),
                active.manifest_path.clone(),
                active.queued_item_ids.clone(),
            )
        };

        send_sigterm(&child)?;

        let deadline = Instant::now() + STOP_TIMEOUT;
        let mut graceful = false;

        loop {
            let finished = {
                let mut guard = child
                    .lock()
                    .map_err(|_| "Failed to poll active worker process".to_string())?;
                match guard.try_wait() {
                    Ok(Some(_status)) => true,
                    Ok(None) => false,
                    Err(error) => {
                        return Err(format!(
                            "Failed while waiting for worker shutdown: {}",
                            error
                        ));
                    }
                }
            };

            if finished {
                graceful = true;
                break;
            }

            if Instant::now() >= deadline {
                break;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        if !graceful {
            force_kill(&child)?;
        }

        clear_active_session_if_matches(session_id);
        let exit_code = wait_for_exit_code(&child);
        if let Err(error) = archive_session_from_manifest(
            &manifest_path,
            session_id,
            None,
            exit_code,
            "cancelled",
            &HashMap::new(),
        ) {
            eprintln!(
                "[history] failed to archive cancelled session {}: {}",
                session_id, error
            );
        }

        self.app_handle
            .emit(
                SESSION_EVENT,
                json!({
                    "event": "worker_stopped",
                    "session_id": session_id,
                    "reason": if graceful { "graceful" } else { "forced" },
                    "reset_item_ids": queued_item_ids,
                }),
            )
            .map_err(|error| format!("Failed to emit worker_stopped: {}", error))?;

        self.app_handle
            .emit(
                SESSION_EVENT,
                json!({
                    "event": "session_summary",
                    "session_id": session_id,
                    "exit_code": exit_code,
                    "status": "cancelled",
                    "reset_item_ids": queued_item_ids,
                }),
            )
            .map_err(|error| format!("Failed to emit cancellation summary: {}", error))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    fn spawn_long_running_child() -> Arc<Mutex<Child>> {
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("should spawn long-running process");
        Arc::new(Mutex::new(child))
    }

    #[cfg(unix)]
    fn wait_until_exited(child: &Arc<Mutex<Child>>, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let exited = {
                let mut guard = child.lock().expect("child lock should succeed");
                matches!(guard.try_wait(), Ok(Some(_)))
            };

            if exited {
                return true;
            }

            if Instant::now() >= deadline {
                return false;
            }

            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn maps_swift_runtime_to_binary_command() {
        let runtime = ProviderRuntime::SwiftNative {
            binary_path: PathBuf::from("/tmp/coreml-batch"),
            model_dir: PathBuf::from("/tmp/models/v3"),
        };

        let command = launch_command_for_runtime(&runtime).expect("swift runtime should map");

        assert_eq!(command.program, "/tmp/coreml-batch");
        assert!(command.args.is_empty());
    }

    #[test]
    fn maps_python_runtime_to_uv_command() {
        let runtime = ProviderRuntime::PythonUv {
            package: "whisper-batch".to_string(),
            entry_point: "whisper_batch".to_string(),
        };

        let command = launch_command_for_runtime(&runtime).expect("python runtime should map");

        assert_eq!(command.program, "uv");
        assert_eq!(command.args, python_uv_command_args("whisper-batch", "whisper_batch", &[]));
    }

    #[test]
    fn cloud_runtime_does_not_map_to_local_command() {
        let runtime = ProviderRuntime::CloudAPI {
            base_url: "https://api.example.com".to_string(),
            requires_key: true,
        };

        assert!(launch_command_for_runtime(&runtime).is_none());
    }

    #[test]
    fn appends_manifest_flags_for_swift_runtime() {
        let runtime = ProviderRuntime::SwiftNative {
            binary_path: PathBuf::from("/tmp/coreml-batch"),
            model_dir: PathBuf::from("/tmp/models/v2"),
        };

        let launch = command_args_for_runtime(
            &runtime,
            Path::new("/tmp/sessions/session-a.json"),
            Path::new("/tmp/out"),
        )
        .expect("swift runtime should produce args");

        assert_eq!(launch.program, "/tmp/coreml-batch");
        assert!(launch.args.contains(&"--manifest".to_string()));
        assert!(launch
            .args
            .contains(&"/tmp/sessions/session-a.json".to_string()));
        assert!(launch.args.contains(&"--output-dir".to_string()));
        assert!(launch.args.contains(&"/tmp/out".to_string()));
        assert!(launch.args.contains(&"--model-version".to_string()));
        assert!(launch.args.contains(&"v2".to_string()));
    }

    #[test]
    fn parses_worker_ndjson_and_rejects_malformed_lines() {
        let parsed = parse_worker_line(r#"{"event":"file_done","file":"a.wav"}"#)
            .expect("valid json should parse");

        assert_eq!(
            parsed.and_then(|value| value.get("event").cloned()),
            Some(Value::String("file_done".to_string()))
        );

        let error = parse_worker_line("not-json").expect_err("invalid json should fail");
        assert!(error.is_syntax() || error.is_data() || error.is_eof());
    }

    #[test]
    fn ignores_blank_worker_lines() {
        let parsed = parse_worker_line("   ").expect("blank lines should not fail");
        assert!(parsed.is_none());
    }

    #[test]
    fn parses_summary_event_for_notifications() {
        let value = json!({
            "event": "summary",
            "processed": 7,
            "failed": 2,
            "duration_seconds": 91.2
        });

        let summary = parse_summary_event(&value).expect("summary event should parse");
        assert_eq!(summary.processed, 7);
        assert_eq!(summary.failed, 2);
        assert_eq!(summary.duration_seconds, 91.2);
    }

    #[test]
    fn parses_fatal_error_event_for_notifications() {
        let value = json!({
            "event": "fatal_error",
            "error": "model unavailable"
        });

        assert_eq!(
            parse_fatal_error(&value),
            Some("model unavailable".to_string())
        );
    }

    #[test]
    fn formats_duration_for_notification_body() {
        assert_eq!(format_duration(0.2), "0s");
        assert_eq!(format_duration(5.4), "5s");
        assert_eq!(format_duration(61.0), "1m 1s");
    }

    #[test]
    fn parses_skipped_outcome_with_existing_output_paths() {
        let value = json!({
            "event": "file_skipped",
            "file": "/audio/input.wav",
            "reason": "outputs_exist",
            "output": {
                "txt": "/tmp/out/input.wav.txt",
                "json": "/tmp/out/input.wav.json"
            }
        });

        let (path, outcome) = parse_file_outcome(&value).expect("skipped outcome should parse");
        assert_eq!(path, "/audio/input.wav");
        assert_eq!(outcome.status, "skipped");
        assert_eq!(
            outcome.transcript_path.as_deref(),
            Some("/tmp/out/input.wav.txt")
        );
        assert_eq!(
            outcome.json_path.as_deref(),
            Some("/tmp/out/input.wav.json")
        );
        assert_eq!(outcome.error.as_deref(), Some("outputs_exist"));
    }

    #[cfg(unix)]
    #[test]
    fn send_sigterm_terminates_running_process() {
        let child = spawn_long_running_child();

        send_sigterm(&child).expect("SIGTERM should succeed");
        let exited = wait_until_exited(&child, Duration::from_secs(2));

        if !exited {
            let _ = force_kill(&child);
        }

        assert!(exited, "process should exit after SIGTERM");
    }

    #[cfg(unix)]
    #[test]
    fn force_kill_terminates_running_process() {
        let child = spawn_long_running_child();

        force_kill(&child).expect("force kill should succeed");
        let exited = wait_until_exited(&child, Duration::from_secs(2));

        assert!(exited, "process should exit after force kill");
    }
}

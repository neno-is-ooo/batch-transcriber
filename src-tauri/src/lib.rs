use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

mod commands;
mod notifications;
mod providers;

const BATCH_EVENT: &str = "batch-event";
const MODEL_EVENT: &str = "model-event";
const MENU_EVENT_FILES_SELECTED: &str = "files-selected";
const FILES_OPENED_EVENT: &str = "files-opened";
const MENU_EVENT_FOLDER_SELECTED: &str = "folder-selected";
const MENU_EVENT_START_TRANSCRIPTION: &str = "menu-start-transcription";
const MENU_EVENT_STOP_TRANSCRIPTION: &str = "menu-stop-transcription";
const MENU_EVENT_SHOW_PREFERENCES: &str = "show-preferences";
const MENU_EVENT_SHOW_MODEL_MANAGER: &str = "show-model-manager";
const MENU_EVENT_RUN_DIAGNOSTICS: &str = "run-diagnostics";
const MENU_ID_PREFERENCES: &str = "preferences";
const MENU_ID_ADD_FILES: &str = "add-files";
const MENU_ID_ADD_FOLDER: &str = "add-folder";
const MENU_ID_START: &str = "start";
const MENU_ID_STOP: &str = "stop";
const MENU_ID_DOCS: &str = "docs";
const MENU_ID_MODEL_MANAGER: &str = "model-manager";
const MENU_ID_DIAGNOSTICS: &str = "diagnostics";
const DOCUMENTATION_URL: &str = "https://github.com/neno/parakeet-stt-pipeline";
const SUPPORTED_AUDIO_EXTENSIONS: &[&str] =
    &["mp3", "wav", "m4a", "flac", "ogg", "aac", "aiff", "wma"];

#[derive(Debug, Clone, Copy, Default)]
struct MenuState {
    has_items: bool,
    is_processing: bool,
}

#[derive(Debug, Default)]
struct FileOpenState {
    inner: Mutex<FileOpenStateInner>,
}

#[derive(Debug, Default)]
struct FileOpenStateInner {
    pending_paths: Vec<String>,
    frontend_ready: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunBatchRequest {
    input_dir: String,
    output_dir: String,
    model_dir: String,
    model_version: String,
    output_format: String,
    recursive: bool,
    overwrite: bool,
    dry_run: bool,
    extensions: Vec<String>,
    max_retries: u32,
    ffmpeg_fallback: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallModelRequest {
    model_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveModelPathRequest {
    model_version: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct BatchSummary {
    total: u64,
    processed: u64,
    skipped: u64,
    failed: u64,
    duration_seconds: f64,
    failures: Vec<FailureItem>,
    exit_code: i32,
    failure_report_path: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FailureItem {
    file: String,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogEntry {
    id: String,
    model_version: String,
    display_name: String,
    description: String,
    size_hint: String,
    recommended_for: String,
    model_dir: String,
    installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveModelPathResult {
    id: String,
    model_version: String,
    model_dir: String,
    installed: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstallModelResult {
    id: String,
    model_version: String,
    model_dir: String,
    installed: bool,
    exit_code: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupDiagnosticsRequest {
    model_dir: String,
    model_version: String,
    output_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupDiagnosticsResult {
    healthy: bool,
    checks: Vec<DiagnosticCheck>,
    checked_output_path: String,
    available_disk_bytes: u64,
    recommended_disk_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthStatus {
    swift_ok: bool,
    whisper_ok: bool,
    ffprobe_ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticCheck {
    id: String,
    status: String,
    title: String,
    detail: String,
    action: String,
}

#[derive(Debug, Clone, Copy)]
struct ManagedModelDef {
    id: &'static str,
    model_version: &'static str,
    folder_name: &'static str,
    display_name: &'static str,
    description: &'static str,
    size_hint: &'static str,
    recommended_for: &'static str,
}

const MANAGED_MODELS: [ManagedModelDef; 2] = [
    ManagedModelDef {
        id: "parakeet-tdt-0.6b-v3-coreml",
        model_version: "v3",
        folder_name: "parakeet-tdt-0.6b-v3-coreml",
        display_name: "Parakeet TDT v3",
        description: "Multilingual model (English + 25 European languages).",
        size_hint: "Large (~0.6B params)",
        recommended_for: "Best overall accuracy",
    },
    ManagedModelDef {
        id: "parakeet-tdt-0.6b-v2-coreml",
        model_version: "v2",
        folder_name: "parakeet-tdt-0.6b-v2-coreml",
        display_name: "Parakeet TDT v2",
        description: "English-focused model with strong recall.",
        size_hint: "Large (~0.6B params)",
        recommended_for: "English-heavy workflows",
    },
];

fn model_by_version(model_version: &str) -> Result<ManagedModelDef, String> {
    MANAGED_MODELS
        .iter()
        .find(|def| def.model_version.eq_ignore_ascii_case(model_version))
        .copied()
        .ok_or_else(|| format!("Unsupported model version: {}", model_version))
}

fn fluid_models_root() -> Result<PathBuf, String> {
    let home =
        std::env::var("HOME").map_err(|_| "HOME environment variable is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("FluidAudio")
        .join("Models"))
}

fn model_dir_for(def: ManagedModelDef) -> Result<PathBuf, String> {
    Ok(fluid_models_root()?.join(def.folder_name))
}

fn is_model_installed(model_dir: &Path) -> bool {
    let required = [
        "Preprocessor.mlmodelc",
        "Encoder.mlmodelc",
        "Decoder.mlmodelc",
        "JointDecision.mlmodelc",
        "parakeet_vocab.json",
    ];

    required.iter().all(|name| model_dir.join(name).exists())
}

fn model_catalog_entry(def: ManagedModelDef) -> Result<ModelCatalogEntry, String> {
    let model_dir = model_dir_for(def)?;
    Ok(ModelCatalogEntry {
        id: def.id.to_string(),
        model_version: def.model_version.to_string(),
        display_name: def.display_name.to_string(),
        description: def.description.to_string(),
        size_hint: def.size_hint.to_string(),
        recommended_for: def.recommended_for.to_string(),
        model_dir: model_dir.to_string_lossy().to_string(),
        installed: is_model_installed(&model_dir),
    })
}

fn project_root() -> Result<PathBuf, String> {
    let src_tauri_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    src_tauri_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Failed to locate project root".to_string())
}

fn worker_dir() -> Result<PathBuf, String> {
    Ok(project_root()?.join("swift-worker"))
}

fn local_tool_binary_path(tool_name: &str) -> Result<PathBuf, String> {
    Ok(worker_dir()?.join(".build").join("release").join(tool_name))
}

fn bundled_tool_binary_path(app: &AppHandle, tool_name: &str) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to locate app resource directory: {}", e))?;

    let direct = resource_dir.join(tool_name);
    if direct.exists() {
        return Ok(direct);
    }

    // When `bundle.resources` points to a directory ("resources"), Tauri nests it.
    Ok(resource_dir.join("resources").join(tool_name))
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path.display(), e))?;
    let mut perms = metadata.permissions();
    let mode = perms.mode();
    if mode & 0o111 == 0 {
        perms.set_mode(mode | 0o755);
        std::fs::set_permissions(path, perms).map_err(|e| {
            format!(
                "Failed to mark bundled binary as executable ({}): {}",
                path.display(),
                e
            )
        })?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn run_command_capture<I, S>(program: &str, args: I, cwd: &Path) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to start {}: {}", program, e))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Command failed: {}\nstdout:\n{}\nstderr:\n{}",
        program, stdout, stderr
    ))
}

fn command_succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn nearest_existing_path(path: &Path) -> PathBuf {
    let mut candidate = path.to_path_buf();
    while !candidate.exists() {
        if !candidate.pop() {
            return PathBuf::from("/");
        }
    }
    candidate
}

fn format_bytes(value: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = value as f64;
    let mut unit = 0usize;

    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{} {}", value, UNITS[unit])
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

fn available_disk_bytes_for(path: &Path) -> Result<u64, String> {
    let target = nearest_existing_path(path);
    let output = Command::new("df")
        .arg("-k")
        .arg(&target)
        .output()
        .map_err(|e| format!("Failed to run df for {}: {}", target.display(), e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "df failed for {}: {}",
            target.display(),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .skip(1)
        .find(|candidate| !candidate.trim().is_empty())
        .ok_or_else(|| format!("Unexpected df output for {}", target.display()))?;

    let columns: Vec<&str> = line.split_whitespace().collect();
    if columns.len() < 4 {
        return Err(format!(
            "Unable to parse df output for {}: {}",
            target.display(),
            line
        ));
    }

    let available_kb = columns[3].parse::<u64>().map_err(|_| {
        format!(
            "Unable to parse available disk blocks from df output: {}",
            line
        )
    })?;
    Ok(available_kb.saturating_mul(1024))
}

fn ensure_local_tool_built(
    app: &AppHandle,
    event_channel: &str,
    tool_name: &str,
) -> Result<PathBuf, String> {
    let worker_dir = worker_dir()?;
    let tool_bin = local_tool_binary_path(tool_name)?;

    if tool_bin.exists() {
        return Ok(tool_bin);
    }

    app.emit(
        event_channel,
        serde_json::json!({
            "event": "build_started",
            "tool": tool_name,
            "message": "Building Swift tools (first run can take a while)..."
        }),
    )
    .map_err(|e| format!("Failed to emit build start event: {}", e))?;

    run_command_capture("swift", ["build", "-c", "release"], &worker_dir)?;

    if !tool_bin.exists() {
        return Err(format!(
            "Swift build completed but binary is missing: {}",
            tool_bin.display()
        ));
    }

    app.emit(
        event_channel,
        serde_json::json!({
            "event": "build_done",
            "tool": tool_name,
            "binary": tool_bin.to_string_lossy()
        }),
    )
    .map_err(|e| format!("Failed to emit build done event: {}", e))?;

    Ok(tool_bin)
}

fn resolve_tool_binary(
    app: &AppHandle,
    event_channel: &str,
    tool_name: &str,
) -> Result<PathBuf, String> {
    let bundled = bundled_tool_binary_path(app, tool_name)?;
    if bundled.exists() {
        ensure_executable(&bundled)?;
        app.emit(
            event_channel,
            serde_json::json!({
                "event": "tool_resolved",
                "tool": tool_name,
                "source": "bundled",
                "binary": bundled.to_string_lossy(),
            }),
        )
        .map_err(|e| format!("Failed to emit tool resolved event: {}", e))?;
        return Ok(bundled);
    }

    let built = ensure_local_tool_built(app, event_channel, tool_name)?;
    app.emit(
        event_channel,
        serde_json::json!({
            "event": "tool_resolved",
            "tool": tool_name,
            "source": "local_build",
            "binary": built.to_string_lossy(),
        }),
    )
    .map_err(|e| format!("Failed to emit tool resolved event: {}", e))?;
    Ok(built)
}

fn local_venv_path(venv_name: &str) -> Result<Option<PathBuf>, String> {
    let root = project_root()?;
    let path = match venv_name {
        "whisper-venv" => Some(root.join("workers").join("whisper-batch").join(".venv")),
        "faster-whisper-venv" => Some(
            root.join("workers")
                .join("faster-whisper-batch")
                .join(".venv"),
        ),
        _ => None,
    };
    Ok(path)
}

fn venv_exists(path: &Path) -> bool {
    path.exists() && path.join("bin").exists()
}

fn check_binary_exists(app: &AppHandle, tool_name: &str) -> bool {
    if let Ok(path) = bundled_tool_binary_path(app, tool_name) {
        if path.exists() {
            return true;
        }
    }

    local_tool_binary_path(tool_name)
        .map(|path| path.exists())
        .unwrap_or(false)
}

fn check_venv_exists(app: &AppHandle, venv_name: &str) -> bool {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let direct = resource_dir.join(venv_name);
        if venv_exists(&direct) {
            return true;
        }

        let nested = resource_dir.join("resources").join(venv_name);
        if venv_exists(&nested) {
            return true;
        }
    }

    local_venv_path(venv_name)
        .ok()
        .flatten()
        .map(|path| venv_exists(&path))
        .unwrap_or(false)
}

fn menu_enabled_flags(state: MenuState) -> (bool, bool) {
    let can_start = state.has_items && !state.is_processing;
    let can_stop = state.is_processing;
    (can_start, can_stop)
}

fn set_menu_item_enabled<R: Runtime>(
    menu: &Menu<R>,
    item_id: &str,
    enabled: bool,
) -> Result<(), String> {
    if let Some(item) = menu
        .get(item_id)
        .and_then(|entry| entry.as_menuitem().cloned())
    {
        item.set_enabled(enabled).map_err(|error| {
            format!(
                "Failed to set '{}' enabled state to {}: {}",
                item_id, enabled, error
            )
        })?;
    }

    Ok(())
}

fn update_menu_state_internal<R: Runtime>(
    app: &AppHandle<R>,
    state: MenuState,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };

    let (can_start, can_stop) = menu_enabled_flags(state);
    set_menu_item_enabled(&menu, MENU_ID_START, can_start)?;
    set_menu_item_enabled(&menu, MENU_ID_STOP, can_stop)?;
    Ok(())
}

fn file_path_to_string(path: FilePath) -> Option<String> {
    path.into_path()
        .ok()
        .map(|resolved| resolved.to_string_lossy().to_string())
}

fn is_supported_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .map(|ext| {
            SUPPORTED_AUDIO_EXTENSIONS
                .iter()
                .any(|candidate| *candidate == ext)
        })
        .unwrap_or(false)
}

fn filter_audio_file_paths(paths: Vec<PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| is_supported_audio_path(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn handle_opened_audio_paths<R: Runtime>(app: &AppHandle<R>, audio_paths: Vec<String>) {
    if audio_paths.is_empty() {
        return;
    }

    let should_emit = {
        let state = app.state::<FileOpenState>();
        let emit = match state.inner.lock() {
            Ok(mut locked) => {
                if locked.frontend_ready {
                    true
                } else {
                    locked.pending_paths.extend(audio_paths.iter().cloned());
                    false
                }
            }
            Err(error) => {
                eprintln!("[file-open] failed to lock pending state: {}", error);
                true
            }
        };
        emit
    };

    if should_emit {
        if let Err(error) = app.emit(FILES_OPENED_EVENT, audio_paths) {
            eprintln!("[file-open] failed to emit opened files: {}", error);
        }
    }

    focus_main_window(app);
}

fn pick_and_add_files<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter(
            "Audio",
            &["mp3", "wav", "m4a", "flac", "ogg", "aac", "aiff", "wma"],
        )
        .pick_files(move |paths| {
            let Some(paths) = paths else {
                return;
            };

            let selected = paths
                .into_iter()
                .filter_map(file_path_to_string)
                .collect::<Vec<String>>();

            if selected.is_empty() {
                return;
            }

            if let Err(error) = handle.emit(MENU_EVENT_FILES_SELECTED, selected) {
                eprintln!("[menu] failed to emit selected files: {}", error);
            }
        });
}

fn pick_and_add_folder<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.dialog().file().pick_folder(move |path| {
        let Some(path) = path else {
            return;
        };

        let Some(selected) = file_path_to_string(path) else {
            return;
        };

        if let Err(error) = handle.emit(MENU_EVENT_FOLDER_SELECTED, selected) {
            eprintln!("[menu] failed to emit selected folder: {}", error);
        }
    });
}

fn emit_menu_event<R: Runtime>(app: &AppHandle<R>, event_name: &str) {
    if let Err(error) = app.emit(event_name, ()) {
        eprintln!(
            "[menu] failed to emit '{}' event to frontend: {}",
            event_name, error
        );
    }
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_ID_ADD_FILES => pick_and_add_files(app),
        MENU_ID_ADD_FOLDER => pick_and_add_folder(app),
        MENU_ID_START => emit_menu_event(app, MENU_EVENT_START_TRANSCRIPTION),
        MENU_ID_STOP => emit_menu_event(app, MENU_EVENT_STOP_TRANSCRIPTION),
        MENU_ID_PREFERENCES => emit_menu_event(app, MENU_EVENT_SHOW_PREFERENCES),
        MENU_ID_DOCS => {
            if let Err(error) = app.opener().open_url(DOCUMENTATION_URL, None::<&str>) {
                eprintln!("[menu] failed to open docs url: {}", error);
            }
        }
        MENU_ID_MODEL_MANAGER => emit_menu_event(app, MENU_EVENT_SHOW_MODEL_MANAGER),
        MENU_ID_DIAGNOSTICS => emit_menu_event(app, MENU_EVENT_RUN_DIAGNOSTICS),
        _ => {}
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_name = app.package_info().name.clone();

    let app_menu = Submenu::with_items(
        app,
        app_name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                MENU_ID_PREFERENCES,
                "Preferences...",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(
                app,
                MENU_ID_ADD_FILES,
                "Add Files...",
                true,
                Some("CmdOrCtrl+O"),
            )?,
            &MenuItem::with_id(
                app,
                MENU_ID_ADD_FOLDER,
                "Add Folder...",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                MENU_ID_START,
                "Start Transcription",
                false,
                Some("CmdOrCtrl+R"),
            )?,
            &MenuItem::with_id(app, MENU_ID_STOP, "Stop", false, Some("CmdOrCtrl+."))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, MENU_ID_DOCS, "Documentation", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                MENU_ID_MODEL_MANAGER,
                "Model Manager",
                true,
                Some("CmdOrCtrl+Shift+M"),
            )?,
            &MenuItem::with_id(
                app,
                MENU_ID_DIAGNOSTICS,
                "Run Diagnostics",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &window_menu, &help_menu],
    )
}

#[tauri::command]
fn run_startup_diagnostics(
    request: StartupDiagnosticsRequest,
) -> Result<StartupDiagnosticsResult, String> {
    let managed = model_by_version(&request.model_version)?;
    let requested_model_dir = PathBuf::from(request.model_dir.clone());
    let expected_model_dir = model_dir_for(managed)?;
    let output_dir = PathBuf::from(request.output_dir.clone());
    let checked_output_path = nearest_existing_path(&output_dir);
    let available_disk_bytes = available_disk_bytes_for(&output_dir)?;

    let mut checks: Vec<DiagnosticCheck> = Vec::new();
    let ffmpeg_available = command_succeeds("/usr/bin/env", &["ffmpeg", "-version"]);
    if ffmpeg_available {
        checks.push(DiagnosticCheck {
            id: "ffmpeg".to_string(),
            status: "ok".to_string(),
            title: "ffmpeg fallback available".to_string(),
            detail: "Unsupported audio containers can be auto-transcoded before transcription."
                .to_string(),
            action: "No action needed.".to_string(),
        });
    } else {
        checks.push(DiagnosticCheck {
            id: "ffmpeg".to_string(),
            status: "warn".to_string(),
            title: "ffmpeg not found".to_string(),
            detail: "Some uncommon audio formats may fail when direct decode is unsupported."
                .to_string(),
            action: "Install ffmpeg (`brew install ffmpeg`) to enable fallback conversion."
                .to_string(),
        });
    }

    if !requested_model_dir.exists() {
        checks.push(DiagnosticCheck {
            id: "model_dir".to_string(),
            status: "error".to_string(),
            title: "Model directory not found".to_string(),
            detail: format!("Configured model path does not exist: {}", requested_model_dir.display()),
            action: "Use Model Manager to install the selected model or browse to an existing directory."
                .to_string(),
        });
    } else if is_model_installed(&requested_model_dir) {
        checks.push(DiagnosticCheck {
            id: "model_files".to_string(),
            status: "ok".to_string(),
            title: "Model files detected".to_string(),
            detail: format!(
                "Model {} appears complete at {}.",
                managed.model_version,
                requested_model_dir.display()
            ),
            action: "No action needed.".to_string(),
        });
    } else {
        checks.push(DiagnosticCheck {
            id: "model_files".to_string(),
            status: "error".to_string(),
            title: "Model files incomplete".to_string(),
            detail: format!(
                "Directory exists but required model files are missing: {}.",
                requested_model_dir.display()
            ),
            action: "Install/reinstall the model from Model Manager.".to_string(),
        });
    }

    if requested_model_dir != expected_model_dir {
        checks.push(DiagnosticCheck {
            id: "model_path_hint".to_string(),
            status: "warn".to_string(),
            title: "Using custom model path".to_string(),
            detail: format!(
                "Expected default for {} is {}.",
                managed.model_version,
                expected_model_dir.display()
            ),
            action: "Keep it if intentional; otherwise click 'Use This' in Model Manager to auto-fill the default path."
                .to_string(),
        });
    }

    let recommended_disk_bytes = if is_model_installed(&requested_model_dir) {
        3 * 1024_u64 * 1024_u64 * 1024_u64
    } else {
        7 * 1024_u64 * 1024_u64 * 1024_u64
    };
    let disk_status = if available_disk_bytes >= recommended_disk_bytes {
        "ok"
    } else if available_disk_bytes >= 1024 * 1024 * 1024 {
        "warn"
    } else {
        "error"
    };

    checks.push(DiagnosticCheck {
        id: "disk_space".to_string(),
        status: disk_status.to_string(),
        title: "Output disk capacity".to_string(),
        detail: format!(
            "{} free at {} (recommended at least {}).",
            format_bytes(available_disk_bytes),
            checked_output_path.display(),
            format_bytes(recommended_disk_bytes)
        ),
        action: "Pick an output directory on a larger volume or free disk space before running large batches."
            .to_string(),
    });

    let healthy = checks
        .iter()
        .all(|item| item.status == "ok" || item.status == "warn");

    Ok(StartupDiagnosticsResult {
        healthy,
        checks,
        checked_output_path: checked_output_path.to_string_lossy().to_string(),
        available_disk_bytes,
        recommended_disk_bytes,
    })
}

#[tauri::command]
async fn health_check(app: AppHandle) -> Result<HealthStatus, String> {
    Ok(HealthStatus {
        swift_ok: check_binary_exists(&app, "parakeet-batch"),
        whisper_ok: check_venv_exists(&app, "whisper-venv"),
        ffprobe_ok: command_succeeds("/usr/bin/env", &["ffprobe", "-version"]),
    })
}

#[tauri::command]
fn get_model_catalog() -> Result<Vec<ModelCatalogEntry>, String> {
    MANAGED_MODELS
        .iter()
        .map(|def| model_catalog_entry(*def))
        .collect()
}

#[tauri::command]
fn resolve_model_path(request: ResolveModelPathRequest) -> Result<ResolveModelPathResult, String> {
    let model = model_by_version(&request.model_version)?;
    let model_dir = model_dir_for(model)?;
    Ok(ResolveModelPathResult {
        id: model.id.to_string(),
        model_version: model.model_version.to_string(),
        model_dir: model_dir.to_string_lossy().to_string(),
        installed: is_model_installed(&model_dir),
    })
}

#[tauri::command]
async fn install_model(
    app: AppHandle,
    request: InstallModelRequest,
) -> Result<InstallModelResult, String> {
    let model = model_by_version(&request.model_version)?;
    let model_dir = model_dir_for(model)?;
    let modelctl_bin = resolve_tool_binary(&app, MODEL_EVENT, "parakeet-modelctl")?;

    let args = vec![
        "install".to_string(),
        "--model".to_string(),
        model.model_version.to_string(),
    ];

    app.emit(
        MODEL_EVENT,
        serde_json::json!({
            "event": "install_command_started",
            "tool": "parakeet-modelctl",
            "binary": modelctl_bin,
            "args": args,
        }),
    )
    .map_err(|e| format!("Failed to emit model install command start event: {}", e))?;

    let mut child = Command::new(modelctl_bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch model manager: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture model manager stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture model manager stderr".to_string())?;

    let stderr_app = app.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = stderr_app.emit(
                MODEL_EVENT,
                serde_json::json!({
                    "event": "modelctl_stderr",
                    "line": line,
                }),
            );
        }
    });

    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed reading model manager output: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => {
                app.emit(MODEL_EVENT, value)
                    .map_err(|e| format!("Failed to emit model event: {}", e))?;
            }
            Err(_) => {
                app.emit(
                    MODEL_EVENT,
                    serde_json::json!({
                        "event": "modelctl_stdout",
                        "line": line,
                    }),
                )
                .map_err(|e| format!("Failed to emit model stdout line event: {}", e))?;
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for model manager process: {}", e))?;
    let _ = stderr_handle.join();

    let result = InstallModelResult {
        id: model.id.to_string(),
        model_version: model.model_version.to_string(),
        model_dir: model_dir.to_string_lossy().to_string(),
        installed: is_model_installed(&model_dir),
        exit_code: status.code().unwrap_or(-1),
    };

    app.emit(
        MODEL_EVENT,
        serde_json::json!({
            "event": "install_command_finished",
            "id": result.id,
            "model_version": result.model_version,
            "model_dir": result.model_dir,
            "installed": result.installed,
            "exit_code": result.exit_code,
            "success": status.success(),
        }),
    )
    .map_err(|e| format!("Failed to emit model install finished event: {}", e))?;

    if status.success() {
        return Ok(result);
    }

    Err(format!(
        "Model install command failed with exit code {}",
        result.exit_code
    ))
}

#[tauri::command]
async fn run_batch_transcription(
    app: AppHandle,
    request: RunBatchRequest,
) -> Result<BatchSummary, String> {
    let worker_bin = resolve_tool_binary(&app, BATCH_EVENT, "parakeet-batch")?;

    if !Path::new(&request.input_dir).exists() {
        return Err(format!("Input directory not found: {}", request.input_dir));
    }

    let mut args: Vec<String> = vec![
        "--input-dir".into(),
        request.input_dir.clone(),
        "--output-dir".into(),
        request.output_dir.clone(),
        "--model-dir".into(),
        request.model_dir.clone(),
        "--model-version".into(),
        request.model_version.clone(),
        "--output-format".into(),
        request.output_format.clone(),
        "--extensions".into(),
        request.extensions.join(","),
        "--max-retries".into(),
        request.max_retries.to_string(),
    ];

    if !request.recursive {
        args.push("--no-recursive".into());
    }

    if request.overwrite {
        args.push("--overwrite".into());
    }

    if request.dry_run {
        args.push("--dry-run".into());
    }

    if !request.ffmpeg_fallback {
        args.push("--no-ffmpeg-fallback".into());
    }

    app.emit(
        BATCH_EVENT,
        serde_json::json!({
            "event": "worker_started",
            "binary": worker_bin,
            "args": args,
        }),
    )
    .map_err(|e| format!("Failed to emit worker started event: {}", e))?;

    let mut child = Command::new(worker_bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch worker: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture worker stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture worker stderr".to_string())?;

    let stderr_app = app.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = stderr_app.emit(
                BATCH_EVENT,
                serde_json::json!({
                    "event": "worker_stderr",
                    "line": line,
                }),
            );
        }
    });

    let mut summary = BatchSummary::default();
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read worker output: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => {
                if value.get("event") == Some(&serde_json::Value::String("summary".to_string())) {
                    summary.total = value.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
                    summary.processed =
                        value.get("processed").and_then(|v| v.as_u64()).unwrap_or(0);
                    summary.skipped = value.get("skipped").and_then(|v| v.as_u64()).unwrap_or(0);
                    summary.failed = value.get("failed").and_then(|v| v.as_u64()).unwrap_or(0);
                    summary.duration_seconds = value
                        .get("duration_seconds")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    summary.failures = value
                        .get("failures")
                        .and_then(|v| serde_json::from_value::<Vec<FailureItem>>(v.clone()).ok())
                        .unwrap_or_default();
                    summary.failure_report_path = value
                        .get("failure_report")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                }

                app.emit(BATCH_EVENT, value)
                    .map_err(|e| format!("Failed to emit batch event: {}", e))?;
            }
            Err(_) => {
                app.emit(
                    BATCH_EVENT,
                    serde_json::json!({
                        "event": "worker_stdout",
                        "line": line,
                    }),
                )
                .map_err(|e| format!("Failed to emit stdout line event: {}", e))?;
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed waiting for worker process: {}", e))?;
    let _ = stderr_handle.join();

    summary.exit_code = status.code().unwrap_or(-1);

    app.emit(
        BATCH_EVENT,
        serde_json::json!({
            "event": "worker_finished",
            "exit_code": summary.exit_code,
            "success": status.success(),
        }),
    )
    .map_err(|e| format!("Failed to emit worker finished event: {}", e))?;

    if status.success() || summary.exit_code == 2 {
        return Ok(summary);
    }

    Err(format!(
        "Worker failed with exit code {}",
        summary.exit_code
    ))
}

#[tauri::command]
async fn get_providers(app: AppHandle) -> Result<Vec<providers::registry::Provider>, String> {
    Ok(providers::registry::probe_all(&app))
}

#[tauri::command]
async fn resolve_provider_runtime(
    app: AppHandle,
    provider_id: String,
    model: String,
) -> Result<providers::registry::ProviderRuntime, String> {
    let settings = providers::resolver::ProviderSettings {
        swift_binary_override: Some(providers::registry::resolve_swift_binary_path(&app)),
        models_root_override: Some(providers::registry::default_models_root()),
        check_availability: true,
    };

    let runtime = providers::resolver::resolve_provider(&provider_id, &model, &settings)
        .map_err(|e| e.to_string())?;
    let _launch_command = providers::launcher::launch_command_for_runtime(&runtime);

    Ok(runtime)
}

#[tauri::command]
async fn start_transcription(
    app: AppHandle,
    items: Vec<providers::manifest::QueueItem>,
    provider: String,
    model: String,
    output_dir: String,
    settings: providers::manifest::TranscriptionSettings,
) -> Result<String, String> {
    if items.is_empty() {
        return Err("No queue items provided".to_string());
    }

    let output_dir = PathBuf::from(output_dir);
    std::fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "Failed to create output directory {}: {}",
            output_dir.display(),
            error
        )
    })?;

    let runtime_settings = providers::resolver::ProviderSettings {
        swift_binary_override: Some(providers::registry::resolve_swift_binary_path(&app)),
        models_root_override: Some(providers::registry::default_models_root()),
        check_availability: true,
    };

    let runtime = providers::resolver::resolve_provider(&provider, &model, &runtime_settings)
        .map_err(|error| error.to_string())?;

    let queued_item_ids = items
        .iter()
        .map(|item| item.id.clone())
        .collect::<Vec<String>>();

    let (session_id, manifest_path) =
        providers::manifest::generate_manifest(&provider, &model, &output_dir, &items, &settings)?;

    let notification_preferences = providers::launcher::NotificationPreferences {
        notifications_enabled: settings.notifications_enabled,
        notify_on_complete: settings.notify_on_complete,
        notify_on_error: settings.notify_on_error,
    };

    let launcher = providers::launcher::WorkerLauncher::new(app.clone());
    if let Err(error) = launcher
        .launch(
            &runtime,
            &session_id,
            &manifest_path,
            &output_dir,
            queued_item_ids,
            notification_preferences,
        )
        .await
    {
        let _ = providers::manifest::cleanup_manifest(&manifest_path);
        return Err(error);
    }

    app.emit(
        providers::launcher::SESSION_EVENT,
        serde_json::json!({
            "event": "start",
            "session_id": session_id.clone(),
            "provider": provider,
            "model": model
        }),
    )
    .map_err(|error| format!("Failed to emit start event: {}", error))?;

    Ok(session_id)
}

#[tauri::command]
async fn stop_transcription(app: AppHandle, session_id: String) -> Result<(), String> {
    let launcher = providers::launcher::WorkerLauncher::new(app);
    launcher.stop(&session_id).await
}

#[tauri::command]
fn update_menu_state(app: AppHandle, has_items: bool, is_processing: bool) -> Result<(), String> {
    update_menu_state_internal(
        &app,
        MenuState {
            has_items,
            is_processing,
        },
    )
}

#[tauri::command]
fn register_file_open_listener(
    state: tauri::State<'_, FileOpenState>,
) -> Result<Vec<String>, String> {
    let mut locked = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock file-open state".to_string())?;
    locked.frontend_ready = true;
    Ok(std::mem::take(&mut locked.pending_paths))
}

#[tauri::command]
fn read_transcript(path: String) -> Result<String, String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return Err("Transcript path is empty".to_string());
    }

    let transcript_path = PathBuf::from(normalized);
    if !transcript_path.exists() {
        return Err(format!(
            "Transcript not found: {}",
            transcript_path.display()
        ));
    }

    std::fs::read_to_string(&transcript_path).map_err(|error| {
        format!(
            "Failed to read transcript {}: {}",
            transcript_path.display(),
            error
        )
    })
}

#[tauri::command]
fn export_transcript(source_path: String, destination_path: String) -> Result<(), String> {
    let source_normalized = source_path.trim();
    if source_normalized.is_empty() {
        return Err("Source transcript path is empty".to_string());
    }

    let destination_normalized = destination_path.trim();
    if destination_normalized.is_empty() {
        return Err("Destination transcript path is empty".to_string());
    }

    let source = PathBuf::from(source_normalized);
    if !source.exists() {
        return Err(format!("Transcript not found: {}", source.display()));
    }

    let destination = PathBuf::from(destination_normalized);
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create destination directory {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
    }

    std::fs::copy(&source, &destination)
        .map_err(|error| {
            format!(
                "Failed to export transcript from {} to {}: {}",
                source.display(),
                destination.display(),
                error
            )
        })
        .map(|_| ())
}

#[tauri::command]
fn check_notification_permission() -> bool {
    notifications::check_permission()
}

#[tauri::command]
fn request_notification_permission() -> bool {
    notifications::request_permission()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(FileOpenState::default())
        .menu(build_menu)
        .on_menu_event(handle_menu_event)
        .setup(|app| {
            if let Err(error) = update_menu_state_internal(&app.handle(), MenuState::default()) {
                eprintln!("[menu] failed to initialize state: {}", error);
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            run_batch_transcription,
            get_model_catalog,
            resolve_model_path,
            install_model,
            run_startup_diagnostics,
            health_check,
            get_providers,
            resolve_provider_runtime,
            start_transcription,
            stop_transcription,
            update_menu_state,
            register_file_open_listener,
            read_transcript,
            export_transcript,
            commands::export::export_transcripts,
            commands::history::get_session_history,
            commands::history::delete_session,
            check_notification_permission,
            request_notification_permission,
            commands::scan::scan_files,
            commands::scan::scan_directory
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            let file_paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect::<Vec<PathBuf>>();
            let audio_paths = filter_audio_file_paths(file_paths);
            handle_opened_audio_paths(app_handle, audio_paths);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        filter_audio_file_paths, local_venv_path, menu_enabled_flags, venv_exists, MenuState,
    };
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("{}_{}", prefix, stamp))
    }

    #[test]
    fn menu_flags_disable_start_when_queue_empty() {
        let (can_start, can_stop) = menu_enabled_flags(MenuState {
            has_items: false,
            is_processing: false,
        });
        assert!(!can_start);
        assert!(!can_stop);
    }

    #[test]
    fn menu_flags_enable_stop_while_processing() {
        let (can_start, can_stop) = menu_enabled_flags(MenuState {
            has_items: true,
            is_processing: true,
        });
        assert!(!can_start);
        assert!(can_stop);
    }

    #[test]
    fn filter_audio_paths_keeps_supported_extensions() {
        let filtered = filter_audio_file_paths(vec![
            PathBuf::from("/tmp/demo.wav"),
            PathBuf::from("/tmp/ignore.txt"),
            PathBuf::from("/tmp/podcast.MP3"),
            PathBuf::from("/tmp/noext"),
        ]);

        assert_eq!(
            filtered,
            vec!["/tmp/demo.wav".to_string(), "/tmp/podcast.MP3".to_string()]
        );
    }

    #[test]
    fn local_venv_path_maps_known_worker_names() {
        let whisper = local_venv_path("whisper-venv")
            .expect("project root should resolve")
            .expect("known venv should map to a path");
        let faster = local_venv_path("faster-whisper-venv")
            .expect("project root should resolve")
            .expect("known venv should map to a path");
        let unknown = local_venv_path("unknown-venv").expect("project root should resolve");

        assert!(whisper.ends_with(Path::new("workers/whisper-batch/.venv")));
        assert!(faster.ends_with(Path::new("workers/faster-whisper-batch/.venv")));
        assert!(unknown.is_none());
    }

    #[test]
    fn venv_exists_requires_bin_directory() {
        let root = unique_test_dir("venv_exists_requires_bin_directory");
        fs::create_dir_all(&root).expect("test directory should be created");
        assert!(!venv_exists(&root));

        let with_bin = root.join("with-bin");
        fs::create_dir_all(with_bin.join("bin")).expect("venv bin directory should be created");
        assert!(venv_exists(&with_bin));
    }
}

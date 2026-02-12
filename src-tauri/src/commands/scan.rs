use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "flac", "ogg", "aac", "aiff", "wma"];
const SCAN_PROGRESS_EVENT: &str = "scan-progress";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_EMIT_STEP: u32 = 50;

static FFPROBE_AVAILABLE: OnceLock<bool> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    codec: Option<String>,
    bitrate: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemData {
    id: String,
    path: String,
    name: String,
    size: u64,
    duration: Option<f64>,
    format: String,
    status: String,
    progress: f64,
    metadata: Option<AudioMetadata>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    found: u32,
    scanned: u32,
    current_path: String,
}

#[derive(Debug, Default, PartialEq)]
struct MetadataResult {
    duration: Option<f64>,
    metadata: Option<AudioMetadata>,
}

fn normalize_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn is_supported_extension(path: &Path) -> bool {
    normalize_extension(path)
        .map(|ext| {
            SUPPORTED_EXTENSIONS
                .iter()
                .any(|candidate| *candidate == ext)
        })
        .unwrap_or(false)
}

fn validate_audio_extension(path: &Path) -> Result<String, String> {
    let extension = normalize_extension(path)
        .ok_or_else(|| format!("Missing file extension: {}", path.display()))?;

    if SUPPORTED_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == extension)
    {
        return Ok(extension);
    }

    Err(format!(
        "Unsupported audio format '{}': {}",
        extension,
        path.display()
    ))
}

fn ffprobe_available() -> bool {
    *FFPROBE_AVAILABLE.get_or_init(|| {
        Command::new("/usr/bin/env")
            .args(["ffprobe", "-version"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    })
}

fn parse_u32(value: Option<&serde_json::Value>) -> Option<u32> {
    match value {
        Some(serde_json::Value::Number(number)) => {
            number.as_u64().and_then(|raw| raw.try_into().ok())
        }
        Some(serde_json::Value::String(raw)) => raw.parse::<u32>().ok(),
        _ => None,
    }
}

fn parse_u8(value: Option<&serde_json::Value>) -> Option<u8> {
    match value {
        Some(serde_json::Value::Number(number)) => {
            number.as_u64().and_then(|raw| raw.try_into().ok())
        }
        Some(serde_json::Value::String(raw)) => raw.parse::<u8>().ok(),
        _ => None,
    }
}

fn parse_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_f64(),
        Some(serde_json::Value::String(raw)) => raw.parse::<f64>().ok(),
        _ => None,
    }
}

fn parse_metadata_payload(payload: &serde_json::Value) -> MetadataResult {
    let format = payload.get("format");
    let duration = parse_f64(format.and_then(|value| value.get("duration")));
    let bitrate = parse_u32(format.and_then(|value| value.get("bit_rate")));

    let audio_stream = payload
        .get("streams")
        .and_then(|value| value.as_array())
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| {
                    stream.get("codec_type").and_then(|value| value.as_str()) == Some("audio")
                })
                .or_else(|| streams.first())
        });

    let metadata = AudioMetadata {
        codec: audio_stream
            .and_then(|stream| stream.get("codec_name"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        bitrate,
        sample_rate: parse_u32(audio_stream.and_then(|stream| stream.get("sample_rate"))),
        channels: parse_u8(audio_stream.and_then(|stream| stream.get("channels"))),
    };

    let metadata = if metadata.codec.is_none()
        && metadata.bitrate.is_none()
        && metadata.sample_rate.is_none()
        && metadata.channels.is_none()
    {
        None
    } else {
        Some(metadata)
    };

    MetadataResult { duration, metadata }
}

fn extract_ffprobe_metadata(path: &Path) -> MetadataResult {
    if !ffprobe_available() {
        return MetadataResult::default();
    }

    let output = match Command::new("/usr/bin/env")
        .arg("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
    {
        Ok(output) => output,
        Err(_) => return MetadataResult::default(),
    };

    if !output.status.success() {
        return MetadataResult::default();
    }

    serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map(|payload| parse_metadata_payload(&payload))
        .unwrap_or_default()
}

fn queue_item_for_path(path: &Path) -> Result<QueueItemData, String> {
    if !path.exists() {
        return Err(format!("Path not found: {}", path.display()));
    }

    if !path.is_file() {
        return Err(format!("Path is not a file: {}", path.display()));
    }

    let format = validate_audio_extension(path)?;
    let file_info = std::fs::metadata(path).map_err(|error| {
        format!(
            "Failed to read file metadata for {}: {}",
            path.display(),
            error
        )
    })?;

    let extracted = extract_ffprobe_metadata(path);

    Ok(QueueItemData {
        id: Uuid::new_v4().to_string(),
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        size: file_info.len(),
        duration: extracted.duration,
        format,
        status: "idle".to_string(),
        progress: 0.0,
        metadata: extracted.metadata,
    })
}

fn emit_scan_progress(
    app: &AppHandle,
    found: u32,
    scanned: u32,
    current_path: &Path,
) -> Result<(), String> {
    let progress = ScanProgress {
        found,
        scanned,
        current_path: current_path.to_string_lossy().to_string(),
    };

    app.emit(SCAN_PROGRESS_EVENT, progress)
        .map_err(|error| format!("Failed to emit scan progress: {}", error))
}

#[tauri::command]
pub async fn scan_files(paths: Vec<String>) -> Result<Vec<QueueItemData>, String> {
    paths
        .into_iter()
        .map(PathBuf::from)
        .map(|path| queue_item_for_path(&path))
        .collect()
}

#[tauri::command]
pub async fn scan_directory(
    path: String,
    recursive: bool,
    app: AppHandle,
) -> Result<Vec<QueueItemData>, String> {
    let root = PathBuf::from(&path);

    if !root.exists() {
        return Err(format!("Directory not found: {}", root.display()));
    }

    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", root.display()));
    }

    let walker = if recursive {
        WalkDir::new(&root)
    } else {
        WalkDir::new(&root).max_depth(1)
    };

    let mut found = 0u32;
    let mut scanned = 0u32;
    let mut discovered: Vec<String> = Vec::new();
    let mut last_emit = Instant::now();

    for entry in walker.into_iter() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("scan_directory warning: {}", error);
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        scanned = scanned.saturating_add(1);
        let current_path = entry.path();

        if is_supported_extension(current_path) {
            found = found.saturating_add(1);
            discovered.push(current_path.to_string_lossy().to_string());
        }

        if scanned.is_multiple_of(PROGRESS_EMIT_STEP)
            || last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL
        {
            emit_scan_progress(&app, found, scanned, current_path)?;
            last_emit = Instant::now();
        }
    }

    emit_scan_progress(&app, found, scanned, &root)?;
    scan_files(discovered).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_extensions_case_insensitively() {
        assert!(is_supported_extension(Path::new("/tmp/test.WAV")));
        assert!(is_supported_extension(Path::new("/tmp/test.m4a")));
        assert!(is_supported_extension(Path::new("/tmp/test.AIFF")));
    }

    #[test]
    fn validates_and_rejects_unsupported_extensions() {
        assert_eq!(
            validate_audio_extension(Path::new("/tmp/test.flac"))
                .expect("expected flac to be supported"),
            "flac"
        );

        let error = validate_audio_extension(Path::new("/tmp/test.txt"))
            .expect_err("expected txt to be rejected");
        assert!(error.contains("Unsupported audio format"));
    }

    #[test]
    fn parses_ffprobe_payload_into_duration_and_metadata() {
        let payload = serde_json::json!({
            "format": {
                "duration": "12.5",
                "bit_rate": "192000"
            },
            "streams": [
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 2
                }
            ]
        });

        let parsed = parse_metadata_payload(&payload);

        assert_eq!(parsed.duration, Some(12.5));
        assert_eq!(
            parsed.metadata,
            Some(AudioMetadata {
                codec: Some("aac".to_string()),
                bitrate: Some(192_000),
                sample_rate: Some(48_000),
                channels: Some(2),
            })
        );
    }
}

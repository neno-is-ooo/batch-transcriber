use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn default_status() -> String {
    "queued".to_string()
}

fn default_extensions() -> Vec<String> {
    vec!["mp3".to_string(), "wav".to_string(), "m4a".to_string()]
}

fn default_output_format() -> String {
    "both".to_string()
}

fn default_true() -> bool {
    true
}

fn default_notifications_enabled() -> bool {
    true
}

fn default_notify_on_complete() -> bool {
    true
}

fn default_notify_on_error() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub path: PathBuf,
    #[serde(default = "default_status")]
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSettings {
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub max_retries: u32,
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
    #[serde(default = "default_true")]
    pub ffmpeg_fallback: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default = "default_notifications_enabled")]
    pub notifications_enabled: bool,
    #[serde(default = "default_notify_on_complete")]
    pub notify_on_complete: bool,
    #[serde(default = "default_notify_on_error")]
    pub notify_on_error: bool,
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            output_format: default_output_format(),
            recursive: true,
            overwrite: false,
            max_retries: 1,
            extensions: default_extensions(),
            ffmpeg_fallback: true,
            dry_run: false,
            notifications_enabled: default_notifications_enabled(),
            notify_on_complete: default_notify_on_complete(),
            notify_on_error: default_notify_on_error(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub path: PathBuf,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub session_id: String,
    pub created_at: String,
    pub provider: String,
    pub model: String,
    pub output_dir: PathBuf,
    pub settings: TranscriptionSettings,
    pub files: Vec<FileEntry>,
}

pub fn get_sessions_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    Ok(home.join(".aura").join("sessions"))
}

fn write_manifest_atomic(
    manifest: &SessionManifest,
    sessions_dir: &Path,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(sessions_dir).map_err(|error| {
        format!(
            "Failed to create sessions directory {}: {}",
            sessions_dir.display(),
            error
        )
    })?;

    let manifest_path = sessions_dir.join(format!("{}.json", manifest.session_id));
    let tmp_path = sessions_dir.join(format!("{}.tmp", manifest.session_id));

    let payload = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Failed to serialize session manifest: {}", error))?;

    {
        let mut file = std::fs::File::create(&tmp_path).map_err(|error| {
            format!(
                "Failed to create temporary manifest file {}: {}",
                tmp_path.display(),
                error
            )
        })?;
        file.write_all(payload.as_bytes()).map_err(|error| {
            format!(
                "Failed to write temporary manifest file {}: {}",
                tmp_path.display(),
                error
            )
        })?;
        file.flush().map_err(|error| {
            format!(
                "Failed to flush temporary manifest file {}: {}",
                tmp_path.display(),
                error
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "Failed to sync temporary manifest file {}: {}",
                tmp_path.display(),
                error
            )
        })?;
    }

    std::fs::rename(&tmp_path, &manifest_path).map_err(|error| {
        format!(
            "Failed to move manifest {} -> {}: {}",
            tmp_path.display(),
            manifest_path.display(),
            error
        )
    })?;

    Ok(manifest_path)
}

pub fn generate_manifest(
    provider: &str,
    model: &str,
    output_dir: &Path,
    items: &[QueueItem],
    settings: &TranscriptionSettings,
) -> Result<(String, PathBuf), String> {
    let session_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let files = items
        .iter()
        .map(|item| FileEntry {
            id: item.id.clone(),
            path: item.path.clone(),
            status: if item.status.trim().is_empty() {
                default_status()
            } else {
                item.status.clone()
            },
        })
        .collect();

    let manifest = SessionManifest {
        session_id: session_id.clone(),
        created_at,
        provider: provider.to_string(),
        model: model.to_string(),
        output_dir: output_dir.to_path_buf(),
        settings: settings.clone(),
        files,
    };

    let sessions_dir = get_sessions_dir()?;
    let path = write_manifest_atomic(&manifest, &sessions_dir)?;

    Ok((session_id, path))
}

pub fn cleanup_manifest(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove manifest {}: {}",
            path.display(),
            error
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sessions_dir() -> PathBuf {
        std::env::temp_dir().join(format!("coreml-manifest-tests-{}", Uuid::new_v4()))
    }

    fn fixture_manifest(session_id: &str) -> SessionManifest {
        SessionManifest {
            session_id: session_id.to_string(),
            created_at: "2026-02-12T00:00:00.000Z".to_string(),
            provider: "coreml-local".to_string(),
            model: "v3".to_string(),
            output_dir: PathBuf::from("/tmp/transcripts"),
            settings: TranscriptionSettings {
                output_format: "both".to_string(),
                recursive: true,
                overwrite: false,
                max_retries: 2,
                extensions: vec!["wav".to_string(), "mp3".to_string()],
                ffmpeg_fallback: true,
                dry_run: false,
                notifications_enabled: true,
                notify_on_complete: true,
                notify_on_error: true,
            },
            files: vec![FileEntry {
                id: "file-1".to_string(),
                path: PathBuf::from("/tmp/audio/a.wav"),
                status: "queued".to_string(),
            }],
        }
    }

    #[test]
    fn writes_valid_manifest_json() {
        let sessions_dir = test_sessions_dir();
        let manifest = fixture_manifest("session-a");

        let path = write_manifest_atomic(&manifest, &sessions_dir)
            .expect("manifest should be written successfully");

        assert_eq!(path, sessions_dir.join("session-a.json"));

        let payload = std::fs::read_to_string(&path).expect("manifest should be readable");
        let decoded = serde_json::from_str::<SessionManifest>(&payload)
            .expect("manifest should be valid json");

        assert_eq!(decoded.session_id, "session-a");
        assert_eq!(decoded.provider, "coreml-local");
        assert_eq!(decoded.files.len(), 1);
        assert_eq!(decoded.files[0].id, "file-1");
    }

    #[test]
    fn atomic_write_renames_tmp_to_final() {
        let sessions_dir = test_sessions_dir();
        let manifest = fixture_manifest("session-b");

        let path = write_manifest_atomic(&manifest, &sessions_dir)
            .expect("manifest should be written successfully");

        let tmp = sessions_dir.join("session-b.tmp");
        assert!(path.exists());
        assert!(!tmp.exists());
    }

    #[test]
    fn cleanup_manifest_removes_existing_manifest() {
        let sessions_dir = test_sessions_dir();
        std::fs::create_dir_all(&sessions_dir).expect("sessions directory should be created");

        let path = sessions_dir.join("session-c.json");
        std::fs::write(&path, "{}").expect("fixture manifest should be created");

        cleanup_manifest(&path).expect("cleanup should remove existing manifest");
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_manifest_is_idempotent_for_missing_file() {
        let path = test_sessions_dir().join("missing.json");
        cleanup_manifest(&path).expect("missing manifests should be ignored");
    }
}

use crate::providers::manifest::SessionManifest;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileRecord {
    pub id: String,
    pub path: String,
    pub name: String,
    pub status: String,
    pub transcript_path: Option<String>,
    pub json_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub created_at: i64,
    pub provider: String,
    pub model: String,
    pub output_dir: String,
    pub manifest_path: String,
    pub total: i32,
    pub processed: i32,
    pub skipped: i32,
    pub failed: i32,
    pub duration_seconds: f64,
    pub exit_code: i32,
    pub status: String,
    pub files: Vec<SessionFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileOutcome {
    pub status: String,
    pub transcript_path: Option<String>,
    pub json_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionSummarySnapshot {
    pub total: u64,
    pub processed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub duration_seconds: f64,
}

fn history_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let sessions_dir = home.join(".aura").join("sessions");
    std::fs::create_dir_all(&sessions_dir).map_err(|error| {
        format!(
            "Failed to create sessions directory {}: {}",
            sessions_dir.display(),
            error
        )
    })?;
    Ok(sessions_dir.join("history.db"))
}

pub fn init_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create history database directory {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
    }

    let connection = Connection::open(path).map_err(|error| {
        format!(
            "Failed to open history database {}: {}",
            path.display(),
            error
        )
    })?;

    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                output_dir TEXT NOT NULL,
                manifest_path TEXT NOT NULL,
                total INTEGER NOT NULL,
                processed INTEGER NOT NULL,
                skipped INTEGER NOT NULL,
                failed INTEGER NOT NULL,
                duration_seconds REAL NOT NULL,
                exit_code INTEGER NOT NULL,
                status TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);

            CREATE TABLE IF NOT EXISTS session_files (
                session_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                transcript_path TEXT,
                json_path TEXT,
                error TEXT,
                PRIMARY KEY(session_id, file_id, path),
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_files_session_id ON session_files(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_files_name ON session_files(name);
            ",
        )
        .map_err(|error| format!("Failed to initialize history database schema: {}", error))?;

    Ok(connection)
}

fn open_database(path: Option<&Path>) -> Result<Connection, String> {
    match path {
        Some(path) => init_database(path),
        None => {
            let resolved = history_db_path()?;
            init_database(&resolved)
        }
    }
}

fn parse_manifest(path: &Path) -> Result<SessionManifest, String> {
    let payload = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read session manifest {}: {}",
            path.display(),
            error
        )
    })?;
    serde_json::from_str::<SessionManifest>(&payload).map_err(|error| {
        format!(
            "Failed to parse session manifest {}: {}",
            path.display(),
            error
        )
    })
}

fn parse_created_at_unix(created_at: &str) -> i64 {
    DateTime::parse_from_rfc3339(created_at)
        .map(|value| value.timestamp())
        .unwrap_or_else(|_| Utc::now().timestamp())
}

fn normalize_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn to_i32(value: u64) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn summarize_from_files(files: &[SessionFileRecord]) -> SessionSummarySnapshot {
    let processed = files.iter().filter(|file| file.status == "success").count() as u64;
    let skipped = files.iter().filter(|file| file.status == "skipped").count() as u64;
    let failed = files.iter().filter(|file| file.status == "failed").count() as u64;

    SessionSummarySnapshot {
        total: files.len() as u64,
        processed,
        skipped,
        failed,
        duration_seconds: 0.0,
    }
}

fn build_session_record(
    manifest_path: &Path,
    manifest: SessionManifest,
    session_id: &str,
    summary: Option<SessionSummarySnapshot>,
    exit_code: i32,
    status: &str,
    outcomes: &HashMap<String, FileOutcome>,
) -> SessionRecord {
    let files = manifest
        .files
        .iter()
        .map(|entry| {
            let source_path = entry.path.to_string_lossy().to_string();
            let outcome = outcomes.get(&source_path);
            let file_status = outcome
                .map(|value| value.status.clone())
                .unwrap_or_else(|| {
                    if status == "cancelled" {
                        "cancelled".to_string()
                    } else if status == "failed" {
                        "failed".to_string()
                    } else {
                        entry.status.clone()
                    }
                });

            SessionFileRecord {
                id: entry.id.clone(),
                path: source_path.clone(),
                name: normalize_file_name(&entry.path),
                status: file_status,
                transcript_path: outcome.and_then(|value| value.transcript_path.clone()),
                json_path: outcome.and_then(|value| value.json_path.clone()),
                error: outcome.and_then(|value| value.error.clone()),
            }
        })
        .collect::<Vec<SessionFileRecord>>();

    let summary = summary.unwrap_or_else(|| summarize_from_files(&files));

    SessionRecord {
        id: session_id.to_string(),
        created_at: parse_created_at_unix(&manifest.created_at),
        provider: manifest.provider,
        model: manifest.model,
        output_dir: manifest.output_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        total: to_i32(summary.total),
        processed: to_i32(summary.processed),
        skipped: to_i32(summary.skipped),
        failed: to_i32(summary.failed),
        duration_seconds: summary.duration_seconds,
        exit_code,
        status: status.to_string(),
        files,
    }
}

fn save_session_record(connection: &mut Connection, session: &SessionRecord) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open history transaction: {}", error))?;

    transaction
        .execute(
            "
            INSERT OR REPLACE INTO sessions (
                id, created_at, provider, model, output_dir, manifest_path,
                total, processed, skipped, failed, duration_seconds, exit_code, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ",
            params![
                session.id,
                session.created_at,
                session.provider,
                session.model,
                session.output_dir,
                session.manifest_path,
                session.total,
                session.processed,
                session.skipped,
                session.failed,
                session.duration_seconds,
                session.exit_code,
                session.status
            ],
        )
        .map_err(|error| format!("Failed to persist session {}: {}", session.id, error))?;

    transaction
        .execute(
            "DELETE FROM session_files WHERE session_id = ?",
            params![session.id],
        )
        .map_err(|error| {
            format!(
                "Failed to clear existing session files {}: {}",
                session.id, error
            )
        })?;

    for file in &session.files {
        transaction
            .execute(
                "
                INSERT INTO session_files (
                    session_id, file_id, path, name, status, transcript_path, json_path, error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ",
                params![
                    session.id,
                    file.id,
                    file.path,
                    file.name,
                    file.status,
                    file.transcript_path,
                    file.json_path,
                    file.error
                ],
            )
            .map_err(|error| {
                format!(
                    "Failed to persist file {} for session {}: {}",
                    file.path, session.id, error
                )
            })?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit history transaction: {}", error))
}

fn load_session_files(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<SessionFileRecord>, String> {
    let mut statement = connection
        .prepare(
            "
            SELECT file_id, path, name, status, transcript_path, json_path, error
            FROM session_files
            WHERE session_id = ?
            ORDER BY name ASC
            ",
        )
        .map_err(|error| format!("Failed to prepare session file query: {}", error))?;

    let rows = statement
        .query_map(params![session_id], |row| {
            Ok(SessionFileRecord {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                status: row.get(3)?,
                transcript_path: row.get(4)?,
                json_path: row.get(5)?,
                error: row.get(6)?,
            })
        })
        .map_err(|error| format!("Failed to execute session file query: {}", error))?;

    let mut files = Vec::new();
    for row in rows {
        files.push(row.map_err(|error| format!("Failed to decode session file row: {}", error))?);
    }

    Ok(files)
}

fn get_sessions_with_path(path: Option<&Path>) -> Result<Vec<SessionRecord>, String> {
    let connection = open_database(path)?;
    let mut statement = connection
        .prepare(
            "
            SELECT
                id,
                created_at,
                provider,
                model,
                output_dir,
                manifest_path,
                total,
                processed,
                skipped,
                failed,
                duration_seconds,
                exit_code,
                status
            FROM sessions
            ORDER BY created_at DESC
            ",
        )
        .map_err(|error| format!("Failed to prepare history query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i32>(6)?,
                row.get::<_, i32>(7)?,
                row.get::<_, i32>(8)?,
                row.get::<_, i32>(9)?,
                row.get::<_, f64>(10)?,
                row.get::<_, i32>(11)?,
                row.get::<_, String>(12)?,
            ))
        })
        .map_err(|error| format!("Failed to execute history query: {}", error))?;

    let mut sessions = Vec::new();
    for row in rows {
        let (
            id,
            created_at,
            provider,
            model,
            output_dir,
            manifest_path,
            total,
            processed,
            skipped,
            failed,
            duration_seconds,
            exit_code,
            status,
        ) = row.map_err(|error| format!("Failed to decode session row: {}", error))?;

        let files = load_session_files(&connection, &id)?;
        sessions.push(SessionRecord {
            id,
            created_at,
            provider,
            model,
            output_dir,
            manifest_path,
            total,
            processed,
            skipped,
            failed,
            duration_seconds,
            exit_code,
            status,
            files,
        });
    }

    Ok(sessions)
}

fn delete_session_with_path(path: Option<&Path>, session_id: &str) -> Result<(), String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open delete transaction: {}", error))?;
    transaction
        .execute(
            "DELETE FROM session_files WHERE session_id = ?",
            params![session_id],
        )
        .map_err(|error| format!("Failed to delete session file rows: {}", error))?;
    transaction
        .execute("DELETE FROM sessions WHERE id = ?", params![session_id])
        .map_err(|error| format!("Failed to delete session row: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit delete transaction: {}", error))
}

fn archive_session_with_path(
    history_path: Option<&Path>,
    manifest_path: &Path,
    session_id: &str,
    summary: Option<SessionSummarySnapshot>,
    exit_code: i32,
    status: &str,
    outcomes: &HashMap<String, FileOutcome>,
) -> Result<(), String> {
    let manifest = parse_manifest(manifest_path)?;
    let record = build_session_record(
        manifest_path,
        manifest,
        session_id,
        summary,
        exit_code,
        status,
        outcomes,
    );

    let mut connection = open_database(history_path)?;
    save_session_record(&mut connection, &record)
}

pub fn archive_session_from_manifest(
    manifest_path: &Path,
    session_id: &str,
    summary: Option<SessionSummarySnapshot>,
    exit_code: i32,
    status: &str,
    outcomes: &HashMap<String, FileOutcome>,
) -> Result<(), String> {
    archive_session_with_path(
        None,
        manifest_path,
        session_id,
        summary,
        exit_code,
        status,
        outcomes,
    )
}

#[tauri::command]
pub fn get_session_history() -> Result<Vec<SessionRecord>, String> {
    get_sessions_with_path(None)
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("Session id is empty".to_string());
    }

    delete_session_with_path(None, session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::manifest::{FileEntry, SessionManifest, TranscriptionSettings};
    use uuid::Uuid;

    fn temp_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}-{}", prefix, Uuid::new_v4()))
    }

    fn fixture_settings() -> TranscriptionSettings {
        TranscriptionSettings {
            output_format: "both".to_string(),
            recursive: true,
            overwrite: false,
            max_retries: 1,
            extensions: vec!["wav".to_string()],
            ffmpeg_fallback: true,
            dry_run: false,
            notifications_enabled: true,
            notify_on_complete: true,
            notify_on_error: true,
        }
    }

    fn write_manifest(path: &Path, session_id: &str) {
        let manifest = SessionManifest {
            session_id: session_id.to_string(),
            created_at: "2026-02-12T00:00:00.000Z".to_string(),
            provider: "coreml-local".to_string(),
            model: "v3".to_string(),
            output_dir: PathBuf::from("/tmp/batch-transcripts"),
            settings: fixture_settings(),
            files: vec![
                FileEntry {
                    id: "file-a".to_string(),
                    path: PathBuf::from("/audio/a.wav"),
                    status: "queued".to_string(),
                },
                FileEntry {
                    id: "file-b".to_string(),
                    path: PathBuf::from("/audio/b.wav"),
                    status: "queued".to_string(),
                },
            ],
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("manifest parent directory should exist");
        }

        let payload = serde_json::to_vec_pretty(&manifest).expect("manifest should serialize");
        std::fs::write(path, payload).expect("manifest should be written");
    }

    #[test]
    fn archives_sessions_and_loads_history_records() {
        let root = temp_root("parakeet-history-db");
        let db_path = root.join("history.db");
        let manifest_path = root.join("sessions").join("session-a.json");
        write_manifest(&manifest_path, "session-a");

        let mut outcomes = HashMap::new();
        outcomes.insert(
            "/audio/a.wav".to_string(),
            FileOutcome {
                status: "success".to_string(),
                transcript_path: Some("/tmp/batch-transcripts/a.txt".to_string()),
                json_path: Some("/tmp/batch-transcripts/a.json".to_string()),
                error: None,
            },
        );
        outcomes.insert(
            "/audio/b.wav".to_string(),
            FileOutcome {
                status: "failed".to_string(),
                transcript_path: None,
                json_path: None,
                error: Some("decode failed".to_string()),
            },
        );

        archive_session_with_path(
            Some(&db_path),
            &manifest_path,
            "session-a",
            Some(SessionSummarySnapshot {
                total: 2,
                processed: 1,
                skipped: 0,
                failed: 1,
                duration_seconds: 12.4,
            }),
            1,
            "failed",
            &outcomes,
        )
        .expect("session should be archived");

        let sessions = get_sessions_with_path(Some(&db_path)).expect("history should load");
        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.id, "session-a");
        assert_eq!(session.provider, "coreml-local");
        assert_eq!(session.model, "v3");
        assert_eq!(session.total, 2);
        assert_eq!(session.processed, 1);
        assert_eq!(session.failed, 1);
        assert_eq!(session.status, "failed");
        assert_eq!(session.files.len(), 2);
        assert_eq!(
            session.files[0].status, "success",
            "files are ordered by filename"
        );
        assert_eq!(
            session.files[1].error.as_deref(),
            Some("decode failed"),
            "failed item keeps error details"
        );

        delete_session_with_path(Some(&db_path), "session-a")
            .expect("session delete should succeed");
        let remaining = get_sessions_with_path(Some(&db_path)).expect("history should reload");
        assert!(remaining.is_empty());
    }

    #[test]
    fn cancelled_sessions_default_file_status_to_cancelled() {
        let root = temp_root("parakeet-history-cancel");
        let db_path = root.join("history.db");
        let manifest_path = root.join("sessions").join("session-cancel.json");
        write_manifest(&manifest_path, "session-cancel");

        archive_session_with_path(
            Some(&db_path),
            &manifest_path,
            "session-cancel",
            None,
            -1,
            "cancelled",
            &HashMap::new(),
        )
        .expect("cancelled session should archive");

        let sessions = get_sessions_with_path(Some(&db_path)).expect("history should load");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "cancelled");
        assert!(sessions[0]
            .files
            .iter()
            .all(|file| file.status == "cancelled"));
    }

    #[test]
    fn failed_sessions_default_file_status_to_failed() {
        let root = temp_root("parakeet-history-failed");
        let db_path = root.join("history.db");
        let manifest_path = root.join("sessions").join("session-failed.json");
        write_manifest(&manifest_path, "session-failed");

        archive_session_with_path(
            Some(&db_path),
            &manifest_path,
            "session-failed",
            None,
            1,
            "failed",
            &HashMap::new(),
        )
        .expect("failed session should archive");

        let sessions = get_sessions_with_path(Some(&db_path)).expect("history should load");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "failed");
        assert_eq!(sessions[0].failed, 2);
        assert!(sessions[0].files.iter().all(|file| file.status == "failed"));
    }
}

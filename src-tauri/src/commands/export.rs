use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    #[default]
    Zip,
    Folder,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExportNaming {
    #[default]
    Preserve,
    Timestamp,
    Numbered,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default)]
    pub format: ExportFormat,
    #[serde(default)]
    pub naming: ExportNaming,
    #[serde(default = "default_true")]
    pub include_metadata: bool,
    #[serde(default)]
    pub preserve_structure: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Zip,
            naming: ExportNaming::Preserve,
            include_metadata: true,
            preserve_structure: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub id: String,
    pub status: String,
    pub relative_path: Option<String>,
    pub transcript_path: Option<String>,
    pub json_path: Option<String>,
}

#[derive(Debug, Clone)]
struct PreparedExportFile {
    source_path: PathBuf,
    export_path: String,
    item_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportMetadata {
    exported_at: String,
    total_items: usize,
    completed_items: usize,
    failed_items: usize,
    exported_files: usize,
    entries: Vec<ExportMetadataEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportMetadataEntry {
    item_id: String,
    source_path: String,
    exported_path: String,
}

fn default_true() -> bool {
    true
}

fn normalize_export_name(path: &str) -> String {
    path.replace('\\', "/")
}

fn sanitize_parent_path(relative_path: Option<&str>) -> PathBuf {
    let mut sanitized = PathBuf::new();
    let Some(raw) = relative_path else {
        return sanitized;
    };

    let parent = Path::new(raw).parent().unwrap_or_else(|| Path::new(""));
    for component in parent.components() {
        if let Component::Normal(segment) = component {
            sanitized.push(segment);
        }
    }

    sanitized
}

fn split_file_name(path: &str) -> (String, String) {
    let candidate = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path);

    if let Some((stem, extension)) = candidate.rsplit_once('.') {
        if !stem.is_empty() && !extension.is_empty() {
            return (stem.to_string(), extension.to_string());
        }
    }

    (candidate.to_string(), String::new())
}

fn dedupe_path(candidate: String, used_paths: &mut HashSet<String>) -> String {
    if used_paths.insert(candidate.clone()) {
        return candidate;
    }

    let normalized = normalize_export_name(&candidate);
    let mut parent = String::new();
    let mut file_name = normalized.as_str();
    if let Some((path_parent, path_file)) = normalized.rsplit_once('/') {
        parent = path_parent.to_string();
        file_name = path_file;
    }

    let (stem, extension) = split_file_name(file_name);
    let mut index = 2;
    loop {
        let next_file = if extension.is_empty() {
            format!("{}-{}", stem, index)
        } else {
            format!("{}-{}.{}", stem, index, extension)
        };

        let next = if parent.is_empty() {
            next_file
        } else {
            format!("{}/{}", parent, next_file)
        };

        if used_paths.insert(next.clone()) {
            return next;
        }

        index += 1;
    }
}

fn export_name_for(
    source_path: &Path,
    naming: &ExportNaming,
    sequence: usize,
    timestamp_prefix: &str,
) -> Result<String, String> {
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid transcript file name: {}", source_path.display()))?;

    let named = match naming {
        ExportNaming::Preserve => file_name.to_string(),
        ExportNaming::Timestamp => format!("{}_{}", timestamp_prefix, file_name),
        ExportNaming::Numbered => format!("{:04}_{}", sequence, file_name),
    };

    Ok(named)
}

fn collect_export_sources(
    items: &[ExportItem],
    options: &ExportOptions,
) -> Result<Vec<PreparedExportFile>, String> {
    let mut prepared = Vec::new();
    let mut used_paths = HashSet::new();
    let timestamp_prefix = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut sequence = 1usize;

    for item in items
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("completed"))
    {
        let mut sources = Vec::new();
        if let Some(path) = item.transcript_path.as_ref().map(|value| value.trim()) {
            if !path.is_empty() {
                sources.push(PathBuf::from(path));
            }
        }
        if let Some(path) = item.json_path.as_ref().map(|value| value.trim()) {
            if !path.is_empty() {
                sources.push(PathBuf::from(path));
            }
        }

        if sources.is_empty() {
            continue;
        }

        let parent = if options.preserve_structure {
            sanitize_parent_path(item.relative_path.as_deref())
        } else {
            PathBuf::new()
        };

        for source in sources {
            if !source.exists() {
                return Err(format!("Transcript file not found: {}", source.display()));
            }

            let file_name = export_name_for(&source, &options.naming, sequence, &timestamp_prefix)?;
            sequence += 1;

            let export_path = normalize_export_name(&dedupe_path(
                parent.join(file_name).to_string_lossy().to_string(),
                &mut used_paths,
            ));

            prepared.push(PreparedExportFile {
                source_path: source,
                export_path,
                item_id: item.id.clone(),
            });
        }
    }

    Ok(prepared)
}

fn build_metadata(items: &[ExportItem], files: &[PreparedExportFile]) -> ExportMetadata {
    let completed_items = items
        .iter()
        .filter(|item| item.status.eq_ignore_ascii_case("completed"))
        .count();
    let failed_items = items
        .iter()
        .filter(|item| item.status.eq_ignore_ascii_case("error"))
        .count();

    ExportMetadata {
        exported_at: Utc::now().to_rfc3339(),
        total_items: items.len(),
        completed_items,
        failed_items,
        exported_files: files.len(),
        entries: files
            .iter()
            .map(|entry| ExportMetadataEntry {
                item_id: entry.item_id.clone(),
                source_path: entry.source_path.to_string_lossy().to_string(),
                exported_path: entry.export_path.clone(),
            })
            .collect(),
    }
}

fn ensure_parent_directory(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create export directory {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
    }

    Ok(())
}

fn export_as_zip(
    destination: &Path,
    files: &[PreparedExportFile],
    metadata: Option<&ExportMetadata>,
) -> Result<(), String> {
    ensure_parent_directory(destination)?;
    let file = File::create(destination).map_err(|error| {
        format!(
            "Failed to create archive {}: {}",
            destination.display(),
            error
        )
    })?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    for entry in files {
        let content = fs::read(&entry.source_path).map_err(|error| {
            format!(
                "Failed to read transcript {}: {}",
                entry.source_path.display(),
                error
            )
        })?;

        zip.start_file(&entry.export_path, options)
            .map_err(|error| {
                format!(
                    "Failed to add archive entry {}: {}",
                    entry.export_path, error
                )
            })?;
        zip.write_all(&content).map_err(|error| {
            format!(
                "Failed to write archive entry {}: {}",
                entry.export_path, error
            )
        })?;
    }

    if let Some(metadata) = metadata {
        let payload = serde_json::to_vec_pretty(metadata)
            .map_err(|error| format!("Failed to serialize export metadata: {}", error))?;
        zip.start_file("metadata.json", options)
            .map_err(|error| format!("Failed to add metadata.json to archive: {}", error))?;
        zip.write_all(&payload)
            .map_err(|error| format!("Failed to write metadata.json to archive: {}", error))?;
    }

    zip.finish()
        .map_err(|error| {
            format!(
                "Failed to finalize archive {}: {}",
                destination.display(),
                error
            )
        })
        .map(|_| ())
}

fn export_as_folder(
    destination: &Path,
    files: &[PreparedExportFile],
    metadata: Option<&ExportMetadata>,
) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Failed to create export destination {}: {}",
            destination.display(),
            error
        )
    })?;

    for entry in files {
        let destination_file = destination.join(&entry.export_path);
        ensure_parent_directory(&destination_file)?;
        fs::copy(&entry.source_path, &destination_file).map_err(|error| {
            format!(
                "Failed to copy transcript {} -> {}: {}",
                entry.source_path.display(),
                destination_file.display(),
                error
            )
        })?;
    }

    if let Some(metadata) = metadata {
        let metadata_path = destination.join("metadata.json");
        let payload = serde_json::to_vec_pretty(metadata)
            .map_err(|error| format!("Failed to serialize export metadata: {}", error))?;
        fs::write(&metadata_path, payload).map_err(|error| {
            format!(
                "Failed to write metadata file {}: {}",
                metadata_path.display(),
                error
            )
        })?;
    }

    Ok(())
}

#[tauri::command]
pub fn export_transcripts(
    items: Vec<ExportItem>,
    destination: String,
    options: ExportOptions,
) -> Result<String, String> {
    let destination = destination.trim();
    if destination.is_empty() {
        return Err("Export destination is empty".to_string());
    }

    let prepared = collect_export_sources(&items, &options)?;
    if prepared.is_empty() {
        return Err("No completed transcript files available for export".to_string());
    }

    let metadata = options
        .include_metadata
        .then(|| build_metadata(&items, &prepared));
    let destination_path = PathBuf::from(destination);

    match options.format {
        ExportFormat::Zip => export_as_zip(&destination_path, &prepared, metadata.as_ref())?,
        ExportFormat::Folder => export_as_folder(&destination_path, &prepared, metadata.as_ref())?,
    }

    Ok(destination.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use zip::ZipArchive;

    fn temp_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}-{}", prefix, Uuid::new_v4()))
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dir should be created");
        }
        std::fs::write(path, content.as_bytes()).expect("fixture file should be written");
    }

    #[test]
    fn exports_zip_with_completed_transcripts_and_metadata() {
        let root = temp_root("parakeet-export-zip");
        let transcript = root.join("a.txt");
        let json = root.join("a.json");
        let skipped = root.join("b.txt");
        write_file(&transcript, "hello world");
        write_file(&json, "{\"text\":\"hello world\"}");
        write_file(&skipped, "should not export");

        let destination = root.join("bundle.zip");
        let result = export_transcripts(
            vec![
                ExportItem {
                    id: "item-a".to_string(),
                    status: "completed".to_string(),
                    relative_path: Some("nested/a.wav".to_string()),
                    transcript_path: Some(transcript.to_string_lossy().to_string()),
                    json_path: Some(json.to_string_lossy().to_string()),
                },
                ExportItem {
                    id: "item-b".to_string(),
                    status: "error".to_string(),
                    relative_path: Some("nested/b.wav".to_string()),
                    transcript_path: Some(skipped.to_string_lossy().to_string()),
                    json_path: None,
                },
            ],
            destination.to_string_lossy().to_string(),
            ExportOptions {
                format: ExportFormat::Zip,
                naming: ExportNaming::Preserve,
                include_metadata: true,
                preserve_structure: false,
            },
        )
        .expect("zip export should succeed");

        assert_eq!(result, destination.to_string_lossy().to_string());

        let file = File::open(&destination).expect("archive should exist");
        let mut archive = ZipArchive::new(file).expect("archive should be readable");

        {
            let txt = archive.by_name("a.txt").expect("txt should be included");
            assert_eq!(txt.size(), 11);
        }
        archive.by_name("a.json").expect("json should be included");
        {
            let metadata = archive
                .by_name("metadata.json")
                .expect("metadata should be included");
            assert!(metadata.size() > 0);
        }
        assert!(archive.by_name("b.txt").is_err());
    }

    #[test]
    fn exports_folder_with_numbered_names_and_structure() {
        let root = temp_root("parakeet-export-folder");
        let transcript_a = root.join("audio").join("a.txt");
        let transcript_b = root.join("audio").join("b.txt");
        write_file(&transcript_a, "alpha");
        write_file(&transcript_b, "beta");

        let destination = root.join("exported");
        export_transcripts(
            vec![
                ExportItem {
                    id: "item-a".to_string(),
                    status: "completed".to_string(),
                    relative_path: Some("batch-one/a.wav".to_string()),
                    transcript_path: Some(transcript_a.to_string_lossy().to_string()),
                    json_path: None,
                },
                ExportItem {
                    id: "item-b".to_string(),
                    status: "completed".to_string(),
                    relative_path: Some("batch-one/deep/b.wav".to_string()),
                    transcript_path: Some(transcript_b.to_string_lossy().to_string()),
                    json_path: None,
                },
            ],
            destination.to_string_lossy().to_string(),
            ExportOptions {
                format: ExportFormat::Folder,
                naming: ExportNaming::Numbered,
                include_metadata: false,
                preserve_structure: true,
            },
        )
        .expect("folder export should succeed");

        let first = destination.join("batch-one").join("0001_a.txt");
        let second = destination
            .join("batch-one")
            .join("deep")
            .join("0002_b.txt");
        assert_eq!(
            std::fs::read_to_string(first).expect("first file should exist"),
            "alpha"
        );
        assert_eq!(
            std::fs::read_to_string(second).expect("second file should exist"),
            "beta"
        );
        assert!(!destination.join("metadata.json").exists());
    }

    #[test]
    fn rejects_export_when_no_completed_transcripts_exist() {
        let root = temp_root("parakeet-export-empty");
        let destination = root.join("bundle.zip");

        let result = export_transcripts(
            vec![ExportItem {
                id: "item-a".to_string(),
                status: "error".to_string(),
                relative_path: None,
                transcript_path: None,
                json_path: None,
            }],
            destination.to_string_lossy().to_string(),
            ExportOptions::default(),
        );

        assert!(result.is_err());
    }
}

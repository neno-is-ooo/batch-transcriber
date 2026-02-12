use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub const COREML_PROVIDER_ID: &str = "coreml-local";
pub const LEGACY_COREML_PROVIDER_ID: &str = "parakeet-coreml";
pub const WHISPER_OPENAI_PROVIDER_ID: &str = "whisper-openai";
pub const FASTER_WHISPER_PROVIDER_ID: &str = "faster-whisper";
pub const SWIFT_TOOL_NAME: &str = "coreml-batch";
pub const LEGACY_SWIFT_TOOL_NAME: &str = "parakeet-batch";
pub const SWIFT_MODELCTL_TOOL_NAME: &str = "coreml-modelctl";
pub const LEGACY_SWIFT_MODELCTL_TOOL_NAME: &str = "parakeet-modelctl";

const CAPABILITY_TIMEOUT: Duration = Duration::from_secs(5);
const UV_INSTALL_URL: &str = "https://docs.astral.sh/uv/getting-started/installation/";
type AvailabilityRunner = dyn Fn(&str, &[String]) -> bool;
type CapabilityRunner = dyn Fn(&str, &[String], Duration) -> Option<Vec<u8>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub runtime: ProviderRuntime,
    pub available: bool,
    pub capabilities: Option<Capabilities>,
    pub install_instructions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ProviderRuntime {
    SwiftNative {
        #[serde(rename = "binaryPath")]
        binary_path: PathBuf,
        #[serde(rename = "modelDir")]
        model_dir: PathBuf,
    },
    PythonUv {
        package: String,
        #[serde(rename = "entryPoint")]
        entry_point: String,
    },
    CloudAPI {
        #[serde(rename = "baseUrl")]
        base_url: String,
        #[serde(rename = "requiresKey")]
        requires_key: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    #[serde(default, alias = "supported_models")]
    pub supported_models: Vec<String>,
    #[serde(default, alias = "supported_formats")]
    pub supported_formats: Vec<String>,
    #[serde(alias = "max_file_size")]
    pub max_file_size: Option<u64>,
    #[serde(alias = "concurrent_files")]
    pub concurrent_files: Option<u32>,
    #[serde(alias = "word_timestamps")]
    pub word_timestamps: Option<bool>,
    #[serde(alias = "speaker_diarization")]
    pub speaker_diarization: Option<bool>,
    #[serde(alias = "language_detection")]
    pub language_detection: Option<bool>,
    #[serde(alias = "translation")]
    pub translation: Option<bool>,
}

fn cloud_capabilities() -> Capabilities {
    Capabilities {
        supported_models: Vec::new(),
        supported_formats: vec!["wav".to_string(), "mp3".to_string()],
        max_file_size: None,
        concurrent_files: Some(1),
        word_timestamps: Some(true),
        speaker_diarization: Some(false),
        language_detection: Some(true),
        translation: Some(false),
    }
}

fn command_status_success(program: &str, args: &[String]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn command_output_with_timeout(
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Option<Vec<u8>> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let output = child.wait_with_output().ok()?;
    if output.status.success() {
        Some(output.stdout)
    } else {
        None
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.exists()
}

fn parse_capabilities_output(output: &[u8]) -> Option<Capabilities> {
    serde_json::from_slice::<Capabilities>(output).ok()
}

fn binary_supports_capabilities_with(path: &Path, command_runner: &CapabilityRunner) -> bool {
    if !path.exists() || !path.is_file() || !is_executable(path) {
        return false;
    }

    let program = path.to_string_lossy().to_string();
    let args = vec!["--capabilities".to_string()];
    command_runner(&program, &args, CAPABILITY_TIMEOUT)
        .and_then(|output| parse_capabilities_output(&output))
        .is_some()
}

fn binary_supports_capabilities(path: &Path) -> bool {
    binary_supports_capabilities_with(path, &command_output_with_timeout)
}

fn worker_project_dir(package: &str) -> Option<PathBuf> {
    let relative = match package {
        "whisper-batch" => "workers/whisper-batch",
        "faster-whisper-batch" => "workers/faster-whisper-batch",
        _ => return None,
    };

    Some(PathBuf::from(relative))
}

pub(crate) fn python_uv_command_args(
    package: &str,
    entry_point: &str,
    entry_args: &[String],
) -> Vec<String> {
    let mut args = if let Some(project_dir) = worker_project_dir(package) {
        if project_dir.join("pyproject.toml").exists() {
            vec![
                "--directory".to_string(),
                project_dir.to_string_lossy().to_string(),
                "run".to_string(),
                entry_point.to_string(),
            ]
        } else {
            vec![
                "run".to_string(),
                "--package".to_string(),
                package.to_string(),
                entry_point.to_string(),
            ]
        }
    } else {
        vec![
            "run".to_string(),
            "--package".to_string(),
            package.to_string(),
            entry_point.to_string(),
        ]
    };

    args.extend_from_slice(entry_args);
    args
}

fn check_available_with(
    runtime: &ProviderRuntime,
    command_runner: &AvailabilityRunner,
    capability_runner: &CapabilityRunner,
) -> bool {
    match runtime {
        ProviderRuntime::SwiftNative { binary_path, .. } => {
            binary_supports_capabilities_with(binary_path, capability_runner)
        }
        ProviderRuntime::PythonUv {
            package,
            entry_point,
        } => {
            let args =
                python_uv_command_args(package, entry_point, &[String::from("--capabilities")]);
            command_runner("uv", &args)
        }
        ProviderRuntime::CloudAPI { .. } => true,
    }
}

fn query_capabilities_with(
    runtime: &ProviderRuntime,
    command_runner: &CapabilityRunner,
) -> Option<Capabilities> {
    match runtime {
        ProviderRuntime::SwiftNative { binary_path, .. } => {
            let program = binary_path.to_string_lossy().to_string();
            let args = vec!["--capabilities".to_string()];
            command_runner(&program, &args, CAPABILITY_TIMEOUT)
                .and_then(|output| parse_capabilities_output(&output))
        }
        ProviderRuntime::PythonUv {
            package,
            entry_point,
        } => {
            let args =
                python_uv_command_args(package, entry_point, &[String::from("--capabilities")]);
            command_runner("uv", &args, CAPABILITY_TIMEOUT)
                .and_then(|output| parse_capabilities_output(&output))
        }
        ProviderRuntime::CloudAPI { .. } => Some(cloud_capabilities()),
    }
}

pub(crate) fn default_models_root() -> PathBuf {
    crate::fluid_models_root().unwrap_or_else(|_| {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("FluidAudio")
                .join("Models");
        }

        PathBuf::from("~/Library/Application Support/FluidAudio/Models")
    })
}

fn default_local_swift_binary_path() -> PathBuf {
    crate::local_tool_binary_path(SWIFT_TOOL_NAME)
        .unwrap_or_else(|_| PathBuf::from("swift-worker/.build/release").join(SWIFT_TOOL_NAME))
}

fn legacy_local_swift_binary_path() -> PathBuf {
    crate::local_tool_binary_path(LEGACY_SWIFT_TOOL_NAME).unwrap_or_else(|_| {
        PathBuf::from("swift-worker/.build/release").join(LEGACY_SWIFT_TOOL_NAME)
    })
}

fn select_first_capable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| binary_supports_capabilities(candidate))
        .cloned()
}

fn select_first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|candidate| candidate.exists()).cloned()
}

fn bundled_swift_binary_candidates(app: &AppHandle) -> Vec<PathBuf> {
    [SWIFT_TOOL_NAME, LEGACY_SWIFT_TOOL_NAME]
        .iter()
        .filter_map(|tool| crate::bundled_tool_binary_path(app, tool).ok())
        .collect()
}

fn local_swift_binary_candidates() -> Vec<PathBuf> {
    vec![default_local_swift_binary_path(), legacy_local_swift_binary_path()]
}

pub(crate) fn normalize_provider_id(id: &str) -> &str {
    if id == LEGACY_COREML_PROVIDER_ID {
        COREML_PROVIDER_ID
    } else {
        id
    }
}

pub(crate) fn resolve_swift_binary_path(app: &AppHandle) -> PathBuf {
    let local_candidates = local_swift_binary_candidates();
    let bundled_candidates = bundled_swift_binary_candidates(app);

    if let Some(local) = select_first_capable(&local_candidates) {
        return local;
    }

    if let Some(bundled) = select_first_capable(&bundled_candidates) {
        return bundled;
    }

    if let Some(local) = select_first_existing(&local_candidates) {
        return local;
    }

    if let Some(bundled) = select_first_existing(&bundled_candidates) {
        return bundled;
    }

    default_local_swift_binary_path()
}

fn install_instructions(runtime: &ProviderRuntime, uv_available: bool) -> String {
    match runtime {
        ProviderRuntime::SwiftNative { .. } => {
            "Build the Swift worker with `cd swift-worker && swift build -c release`, then retry."
                .to_string()
        }
        ProviderRuntime::PythonUv { package, .. } if !uv_available => {
            format!("Install uv ({UV_INSTALL_URL}) and then run provider setup for `{package}`.")
        }
        ProviderRuntime::PythonUv { package, .. } => {
            let probe_cmd = match worker_project_dir(package) {
                Some(project_dir) => format!(
                    "uv --directory {} run {} --capabilities",
                    project_dir.display(),
                    package.replace('-', "_")
                ),
                None => format!("uv run --package {package} {package} --capabilities"),
            };
            format!("Install or fix the `{package}` runtime so `{probe_cmd}` succeeds.")
        }
        ProviderRuntime::CloudAPI { .. } => {
            "Set the API base URL and credentials in settings before use.".to_string()
        }
    }
}

fn known_providers(swift_binary_path: PathBuf, models_root: PathBuf) -> Vec<Provider> {
    vec![
        Provider {
            id: COREML_PROVIDER_ID.to_string(),
            name: "CoreML Local".to_string(),
            runtime: ProviderRuntime::SwiftNative {
                binary_path: swift_binary_path,
                model_dir: models_root,
            },
            available: false,
            capabilities: None,
            install_instructions: None,
        },
        Provider {
            id: WHISPER_OPENAI_PROVIDER_ID.to_string(),
            name: "Whisper (OpenAI)".to_string(),
            runtime: ProviderRuntime::PythonUv {
                package: "whisper-batch".to_string(),
                entry_point: "whisper_batch".to_string(),
            },
            available: false,
            capabilities: None,
            install_instructions: None,
        },
        Provider {
            id: FASTER_WHISPER_PROVIDER_ID.to_string(),
            name: "Faster Whisper".to_string(),
            runtime: ProviderRuntime::PythonUv {
                package: "faster-whisper-batch".to_string(),
                entry_point: "faster_whisper_batch".to_string(),
            },
            available: false,
            capabilities: None,
            install_instructions: None,
        },
    ]
}

fn probe_with(
    mut providers: Vec<Provider>,
    uv_available: bool,
    availability_checker: &dyn Fn(&ProviderRuntime) -> bool,
    capabilities_query: &dyn Fn(&ProviderRuntime) -> Option<Capabilities>,
) -> Vec<Provider> {
    for provider in &mut providers {
        if let ProviderRuntime::SwiftNative { binary_path, .. } = &provider.runtime {
            if binary_path.exists() {
                let _ = crate::ensure_executable(binary_path);
            }
        }

        let available = match &provider.runtime {
            ProviderRuntime::PythonUv { .. } if !uv_available => false,
            runtime => availability_checker(runtime),
        };

        provider.available = available;

        if available {
            provider.install_instructions = None;
            provider.capabilities = capabilities_query(&provider.runtime);
            if provider.capabilities.is_none() {
                eprintln!(
                    "provider probe warning: failed to query capabilities for {}",
                    provider.id
                );
            }
        } else {
            provider.capabilities = None;
            provider.install_instructions =
                Some(install_instructions(&provider.runtime, uv_available));
        }
    }

    providers
}

pub fn check_available(runtime: &ProviderRuntime) -> bool {
    check_available_with(runtime, &command_status_success, &command_output_with_timeout)
}

pub fn query_capabilities(runtime: &ProviderRuntime) -> Option<Capabilities> {
    query_capabilities_with(runtime, &command_output_with_timeout)
}

pub fn probe_all(app: &AppHandle) -> Vec<Provider> {
    let swift_binary = resolve_swift_binary_path(app);
    let providers = known_providers(swift_binary, default_models_root());
    let uv_available = crate::command_succeeds("uv", &["--version"]);

    probe_with(
        providers,
        uv_available,
        &check_available,
        &query_capabilities,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();

        std::env::temp_dir().join(format!(
            "provider-registry-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn write_test_binary(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent directory");
        }

        std::fs::write(
            path,
            "#!/bin/sh\nif [ \"$1\" = \"--capabilities\" ]; then\n  echo '{\"supported_models\":[\"v3\"],\"supported_formats\":[\"wav\"],\"concurrent_files\":1,\"word_timestamps\":true,\"speaker_diarization\":false,\"language_detection\":true,\"translation\":false}'\n  exit 0\nfi\nexit 0\n",
        )
        .expect("write test binary");

        #[cfg(unix)]
        {
            let metadata = std::fs::metadata(path).expect("read metadata");
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).expect("set executable permission");
        }
    }

    fn write_legacy_test_binary(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent directory");
        }

        std::fs::write(path, "#!/bin/sh\nexit 1\n").expect("write legacy test binary");

        #[cfg(unix)]
        {
            let metadata = std::fs::metadata(path).expect("read metadata");
            let mut perms = metadata.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).expect("set executable permission");
        }
    }

    #[test]
    fn prefers_local_swift_binary_when_both_are_capable() {
        let root = unique_temp_path("bundled");
        let bundled = root.join("Resources/coreml-batch");
        let local = root.join("swift-worker/.build/release/coreml-batch");

        write_test_binary(&bundled);
        write_test_binary(&local);

        let selected =
            select_first_capable(&[local.clone(), bundled.clone()]).expect("capable binary");
        assert_eq!(selected, local);
    }

    #[test]
    fn prefers_local_swift_binary_when_bundled_is_legacy() {
        let root = unique_temp_path("bundled-legacy");
        let bundled = root.join("Resources/coreml-batch");
        let local = root.join("swift-worker/.build/release/coreml-batch");

        write_legacy_test_binary(&bundled);
        write_test_binary(&local);

        let selected =
            select_first_capable(&[local.clone(), bundled.clone()]).expect("capable binary");
        assert_eq!(selected, local);
    }

    #[test]
    fn swift_runtime_unavailable_when_binary_missing() {
        let runtime = ProviderRuntime::SwiftNative {
            binary_path: PathBuf::from("/tmp/definitely-not-real/swift-binary"),
            model_dir: PathBuf::from("/tmp/models"),
        };

        assert!(!check_available(&runtime));
    }

    #[test]
    fn python_uv_availability_depends_on_uv_runner_status() {
        let runtime = ProviderRuntime::PythonUv {
            package: "whisper-batch".to_string(),
            entry_point: "whisper_batch".to_string(),
        };

        let expected_args = python_uv_command_args(
            "whisper-batch",
            "whisper_batch",
            &[String::from("--capabilities")],
        );

        let available = check_available_with(
            &runtime,
            &move |program, args| program == "uv" && args == expected_args,
            &|_, _, _| None,
        );

        assert!(available);

        let unavailable = check_available_with(&runtime, &|_, _| false, &|_, _, _| None);
        assert!(!unavailable);
    }

    #[test]
    fn parses_capabilities_json_payload() {
        let raw = br#"{
            "supported_models": ["v2", "v3"],
            "supported_formats": ["wav", "mp3"],
            "max_file_size": 524288000,
            "concurrent_files": 3,
            "word_timestamps": true,
            "speaker_diarization": false,
            "language_detection": true,
            "translation": false
        }"#;

        let capabilities =
            parse_capabilities_output(raw).expect("capabilities JSON should parse successfully");

        assert_eq!(capabilities.supported_models, vec!["v2", "v3"]);
        assert_eq!(capabilities.supported_formats, vec!["wav", "mp3"]);
        assert_eq!(capabilities.max_file_size, Some(524288000));
        assert_eq!(capabilities.concurrent_files, Some(3));
        assert_eq!(capabilities.word_timestamps, Some(true));
    }

    #[test]
    fn generates_install_instructions_for_missing_python_runtime() {
        let runtime = ProviderRuntime::PythonUv {
            package: "faster-whisper-batch".to_string(),
            entry_point: "faster_whisper_batch".to_string(),
        };

        let instructions = install_instructions(&runtime, false);
        assert!(instructions.contains("Install uv"));
    }

    #[test]
    fn probe_with_marks_unavailable_and_sets_install_instructions() {
        let missing_swift = Provider {
            id: COREML_PROVIDER_ID.to_string(),
            name: "CoreML Local".to_string(),
            runtime: ProviderRuntime::SwiftNative {
                binary_path: PathBuf::from("/tmp/missing/coreml-batch"),
                model_dir: PathBuf::from("/tmp/models"),
            },
            available: true,
            capabilities: Some(Capabilities::default()),
            install_instructions: None,
        };

        let probed = probe_with(vec![missing_swift], true, &check_available, &|_| {
            Some(Capabilities::default())
        });

        assert!(!probed[0].available);
        assert!(probed[0].capabilities.is_none());
        assert!(probed[0]
            .install_instructions
            .as_ref()
            .is_some_and(|instructions| instructions.contains("swift build")));
    }

    #[test]
    fn probe_with_fetches_capabilities_for_available_provider() {
        let executable = unique_temp_path("swift-runtime").join("coreml-batch");
        write_test_binary(&executable);

        let provider = Provider {
            id: COREML_PROVIDER_ID.to_string(),
            name: "CoreML Local".to_string(),
            runtime: ProviderRuntime::SwiftNative {
                binary_path: executable,
                model_dir: PathBuf::from("/tmp/models"),
            },
            available: false,
            capabilities: None,
            install_instructions: Some("placeholder".to_string()),
        };

        let expected_caps = Capabilities {
            supported_models: vec!["v3".to_string()],
            supported_formats: vec!["wav".to_string()],
            max_file_size: None,
            concurrent_files: Some(1),
            word_timestamps: Some(true),
            speaker_diarization: Some(false),
            language_detection: Some(true),
            translation: Some(false),
        };

        let probed = probe_with(vec![provider], true, &|_| true, &|_| {
            Some(expected_caps.clone())
        });

        assert!(probed[0].available);
        assert_eq!(probed[0].capabilities, Some(expected_caps));
        assert!(probed[0].install_instructions.is_none());
    }

    #[test]
    fn normalize_provider_id_maps_legacy_value() {
        assert_eq!(normalize_provider_id(LEGACY_COREML_PROVIDER_ID), COREML_PROVIDER_ID);
        assert_eq!(normalize_provider_id(WHISPER_OPENAI_PROVIDER_ID), WHISPER_OPENAI_PROVIDER_ID);
    }
}

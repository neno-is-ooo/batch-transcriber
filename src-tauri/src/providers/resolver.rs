use super::registry::{
    check_available, normalize_provider_id, ProviderRuntime, FASTER_WHISPER_PROVIDER_ID,
    COREML_PROVIDER_ID, SWIFT_TOOL_NAME, WHISPER_OPENAI_PROVIDER_ID,
};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ProviderSettings {
    pub swift_binary_override: Option<PathBuf>,
    pub models_root_override: Option<PathBuf>,
    pub check_availability: bool,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            swift_binary_override: None,
            models_root_override: None,
            check_availability: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    NotFound(String),
    Unavailable(String),
    InvalidModel(String),
}

impl Display for ProviderError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(provider_id) => write!(f, "Provider not found: {provider_id}"),
            Self::Unavailable(provider_id) => write!(f, "Provider is unavailable: {provider_id}"),
            Self::InvalidModel(model) => write!(f, "Invalid model value: {model}"),
        }
    }
}

impl Error for ProviderError {}

const COREML_V3_FOLDER: &str = "parakeet-tdt-0.6b-v3-coreml";
const COREML_V2_FOLDER: &str = "parakeet-tdt-0.6b-v2-coreml";

fn default_models_root() -> PathBuf {
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

fn default_swift_binary_path() -> PathBuf {
    crate::local_tool_binary_path(SWIFT_TOOL_NAME)
        .unwrap_or_else(|_| PathBuf::from("swift-worker/.build/release").join(SWIFT_TOOL_NAME))
}

fn validate_model(model: &str) -> Result<&str, ProviderError> {
    let trimmed = model.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(ProviderError::InvalidModel(model.to_string()));
    }

    Ok(trimmed)
}

fn resolve_coreml_model_dir(models_root: &std::path::Path, model: &str) -> PathBuf {
    let normalized = model.trim().to_ascii_lowercase();
    let folder = match normalized.as_str() {
        "v3" | COREML_V3_FOLDER => COREML_V3_FOLDER,
        "v2" | COREML_V2_FOLDER => COREML_V2_FOLDER,
        _ => model,
    };

    models_root.join(folder)
}

pub fn resolve_provider(
    id: &str,
    model: &str,
    settings: &ProviderSettings,
) -> Result<ProviderRuntime, ProviderError> {
    let normalized_id = normalize_provider_id(id);
    let validated_model = validate_model(model)?;
    let models_root = settings
        .models_root_override
        .clone()
        .unwrap_or_else(default_models_root);
    let swift_binary = settings
        .swift_binary_override
        .clone()
        .unwrap_or_else(default_swift_binary_path);

    let runtime = match normalized_id {
        COREML_PROVIDER_ID => ProviderRuntime::SwiftNative {
            binary_path: swift_binary,
            model_dir: resolve_coreml_model_dir(&models_root, validated_model),
        },
        WHISPER_OPENAI_PROVIDER_ID => ProviderRuntime::PythonUv {
            package: "whisper-batch".to_string(),
            entry_point: "whisper_batch".to_string(),
        },
        FASTER_WHISPER_PROVIDER_ID => ProviderRuntime::PythonUv {
            package: "faster-whisper-batch".to_string(),
            entry_point: "faster_whisper_batch".to_string(),
        },
        _ => {
            return Err(ProviderError::NotFound(id.to_string()));
        }
    };

    if settings.check_availability && !check_available(&runtime) {
        return Err(ProviderError::Unavailable(id.to_string()));
    }

    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_coreml_runtime_with_model_directory() {
        let settings = ProviderSettings {
            swift_binary_override: Some(PathBuf::from("/tmp/swift/coreml-batch")),
            models_root_override: Some(PathBuf::from("/tmp/models")),
            check_availability: false,
        };

        let runtime = resolve_provider(COREML_PROVIDER_ID, "v3", &settings)
            .expect("provider should resolve");

        assert_eq!(
            runtime,
            ProviderRuntime::SwiftNative {
                binary_path: PathBuf::from("/tmp/swift/coreml-batch"),
                model_dir: PathBuf::from("/tmp/models/parakeet-tdt-0.6b-v3-coreml"),
            }
        );
    }

    #[test]
    fn maps_v2_and_v3_model_aliases_to_managed_folder_names() {
        let settings = ProviderSettings {
            swift_binary_override: Some(PathBuf::from("/tmp/swift/coreml-batch")),
            models_root_override: Some(PathBuf::from("/tmp/models")),
            check_availability: false,
        };

        let v2_runtime = resolve_provider(COREML_PROVIDER_ID, "v2", &settings)
            .expect("v2 alias should resolve");
        let v3_runtime = resolve_provider(COREML_PROVIDER_ID, "v3", &settings)
            .expect("v3 alias should resolve");

        assert_eq!(
            v2_runtime,
            ProviderRuntime::SwiftNative {
                binary_path: PathBuf::from("/tmp/swift/coreml-batch"),
                model_dir: PathBuf::from("/tmp/models/parakeet-tdt-0.6b-v2-coreml"),
            }
        );
        assert_eq!(
            v3_runtime,
            ProviderRuntime::SwiftNative {
                binary_path: PathBuf::from("/tmp/swift/coreml-batch"),
                model_dir: PathBuf::from("/tmp/models/parakeet-tdt-0.6b-v3-coreml"),
            }
        );
    }

    #[test]
    fn resolves_python_uv_runtimes_for_known_providers() {
        let settings = ProviderSettings {
            check_availability: false,
            ..ProviderSettings::default()
        };

        let whisper = resolve_provider(WHISPER_OPENAI_PROVIDER_ID, "base", &settings)
            .expect("whisper provider should resolve");
        let faster = resolve_provider(FASTER_WHISPER_PROVIDER_ID, "large-v3", &settings)
            .expect("faster whisper provider should resolve");

        assert_eq!(
            whisper,
            ProviderRuntime::PythonUv {
                package: "whisper-batch".to_string(),
                entry_point: "whisper_batch".to_string(),
            }
        );
        assert_eq!(
            faster,
            ProviderRuntime::PythonUv {
                package: "faster-whisper-batch".to_string(),
                entry_point: "faster_whisper_batch".to_string(),
            }
        );
    }

    #[test]
    fn resolves_legacy_coreml_provider_id_for_backward_compatibility() {
        let settings = ProviderSettings {
            swift_binary_override: Some(PathBuf::from("/tmp/swift/coreml-batch")),
            models_root_override: Some(PathBuf::from("/tmp/models")),
            check_availability: false,
        };

        let runtime = resolve_provider("parakeet-coreml", "v3", &settings)
            .expect("legacy coreml provider id should resolve");

        assert_eq!(
            runtime,
            ProviderRuntime::SwiftNative {
                binary_path: PathBuf::from("/tmp/swift/coreml-batch"),
                model_dir: PathBuf::from("/tmp/models/parakeet-tdt-0.6b-v3-coreml"),
            }
        );
    }

    #[test]
    fn returns_not_found_for_unknown_provider_id() {
        let settings = ProviderSettings {
            check_availability: false,
            ..ProviderSettings::default()
        };

        let error = resolve_provider("unknown-provider", "v3", &settings)
            .expect_err("unknown providers should fail");

        assert_eq!(
            error,
            ProviderError::NotFound("unknown-provider".to_string())
        );
    }

    #[test]
    fn rejects_invalid_model_values() {
        let settings = ProviderSettings {
            check_availability: false,
            ..ProviderSettings::default()
        };

        let error = resolve_provider(COREML_PROVIDER_ID, "../escape", &settings)
            .expect_err("path traversal model should be rejected");

        assert_eq!(error, ProviderError::InvalidModel("../escape".to_string()));
    }

    #[test]
    fn returns_unavailable_when_runtime_is_not_available() {
        let settings = ProviderSettings {
            swift_binary_override: Some(PathBuf::from("/tmp/not-present/coreml-batch")),
            models_root_override: Some(PathBuf::from("/tmp/models")),
            check_availability: true,
        };

        let error = resolve_provider(COREML_PROVIDER_ID, "v3", &settings)
            .expect_err("missing runtime should be marked unavailable");

        assert_eq!(
            error,
            ProviderError::Unavailable(COREML_PROVIDER_ID.to_string())
        );
    }
}

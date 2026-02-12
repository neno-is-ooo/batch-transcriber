import FluidAudio
import Foundation

private enum CliError: Error, CustomStringConvertible {
    case invalidUsage(String)
    case invalidModel(String)

    var description: String {
        switch self {
        case .invalidUsage(let message): return message
        case .invalidModel(let model): return "Unsupported model: \(model)"
        }
    }
}

private enum ManagedModel: String, CaseIterable {
    case v3
    case v2

    var asrVersion: AsrModelVersion {
        switch self {
        case .v3: return .v3
        case .v2: return .v2
        }
    }

    var id: String {
        "parakeet-tdt-0.6b-\(rawValue)-coreml"
    }

    var modelDir: URL {
        AsrModels.defaultCacheDirectory(for: asrVersion)
    }
}

private struct InstalledEntry: Codable {
    let id: String
    let modelVersion: String
    let path: String
    let installed: Bool
}

private func emit(_ event: String, fields: [String: Any] = [:]) {
    var payload: [String: Any] = [
        "event": event,
        "timestamp": ISO8601DateFormatter.string(
            from: Date(),
            timeZone: TimeZone(secondsFromGMT: 0) ?? .current,
            formatOptions: [.withInternetDateTime, .withFractionalSeconds]
        ),
    ]

    for (key, value) in fields {
        payload[key] = value
    }

    guard JSONSerialization.isValidJSONObject(payload) else {
        fputs("Invalid JSON payload for event \(event)\n", stderr)
        return
    }

    do {
        let data = try JSONSerialization.data(withJSONObject: payload)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        fputs("Failed to emit event \(event): \(error)\n", stderr)
    }
}

private func usage() -> String {
    """
    coreml-modelctl

    Commands:
      coreml-modelctl list-installed
      coreml-modelctl install --model <v2|v3>
      coreml-modelctl resolve --model <v2|v3>
    """
}

private func parseModelFlag(_ args: ArraySlice<String>) throws -> ManagedModel {
    var i = args.startIndex
    while i < args.endIndex {
        let arg = args[i]
        if arg == "--model" {
            let next = args.index(after: i)
            guard next < args.endIndex else {
                throw CliError.invalidUsage("Missing value for --model")
            }
            guard let model = ManagedModel(rawValue: args[next].lowercased()) else {
                throw CliError.invalidModel(args[next])
            }
            return model
        }
        i = args.index(after: i)
    }

    throw CliError.invalidUsage("Missing --model <v2|v3>")
}

private func listInstalled() {
    let entries = ManagedModel.allCases.map { model in
        InstalledEntry(
            id: model.id,
            modelVersion: model.rawValue,
            path: model.modelDir.path,
            installed: AsrModels.modelsExist(at: model.modelDir, version: model.asrVersion)
        )
    }

    let encoded: [[String: Any]] = entries.map { entry in
        [
            "id": entry.id,
            "model_version": entry.modelVersion,
            "path": entry.path,
            "installed": entry.installed,
        ]
    }

    emit("installed_models", fields: ["models": encoded])
}

private func resolveModel(args: ArraySlice<String>) throws {
    let model = try parseModelFlag(args)
    let installed = AsrModels.modelsExist(at: model.modelDir, version: model.asrVersion)

    emit("resolved", fields: [
        "id": model.id,
        "model_version": model.rawValue,
        "path": model.modelDir.path,
        "installed": installed,
    ])
}

private func installModel(args: ArraySlice<String>) async throws {
    let model = try parseModelFlag(args)
    let installed = AsrModels.modelsExist(at: model.modelDir, version: model.asrVersion)

    emit("install_started", fields: [
        "id": model.id,
        "model_version": model.rawValue,
        "path": model.modelDir.path,
        "already_installed": installed,
    ])

    if installed {
        emit("install_done", fields: [
            "id": model.id,
            "model_version": model.rawValue,
            "path": model.modelDir.path,
            "already_installed": true,
        ])
        return
    }

    _ = try await AsrModels.download(to: model.modelDir, version: model.asrVersion)

    let installedAfter = AsrModels.modelsExist(at: model.modelDir, version: model.asrVersion)
    guard installedAfter else {
        throw CliError.invalidUsage("Model download completed but files are incomplete: \(model.modelDir.path)")
    }

    emit("install_done", fields: [
        "id": model.id,
        "model_version": model.rawValue,
        "path": model.modelDir.path,
        "already_installed": false,
    ])
}

@main
private struct CoreMLModelCtl {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else {
                print(usage())
                Foundation.exit(1)
            }

            switch command {
            case "list-installed":
                listInstalled()
                Foundation.exit(0)
            case "resolve":
                try resolveModel(args: args.dropFirst())
                Foundation.exit(0)
            case "install":
                try await installModel(args: args.dropFirst())
                Foundation.exit(0)
            case "--help", "-h", "help":
                print(usage())
                Foundation.exit(0)
            default:
                throw CliError.invalidUsage("Unknown command: \(command)")
            }
        } catch {
            fputs("\(usage())\n\n", stderr)
            fputs("Error: \(error)\n", stderr)
            emit("fatal_error", fields: ["error": String(describing: error)])
            Foundation.exit(1)
        }
    }
}

import FluidAudio
import Foundation

private enum CliError: Error, CustomStringConvertible {
    case missingValue(String)
    case invalidValue(String)
    case missingRequired(String)

    var description: String {
        switch self {
        case .missingValue(let flag):
            return "Missing value for \(flag)"
        case .invalidValue(let message):
            return message
        case .missingRequired(let name):
            return "Missing required argument: \(name)"
        }
    }
}

private enum OutputFormat: String {
    case txt
    case json
    case both

    var writesTxt: Bool {
        self == .txt || self == .both
    }

    var writesJson: Bool {
        self == .json || self == .both
    }
}

private enum ModelVersion: String {
    case v2
    case v3

    var asrVersion: AsrModelVersion {
        switch self {
        case .v2: return .v2
        case .v3: return .v3
        }
    }
}

private struct Config {
    let inputDir: URL?
    let manifestPath: URL?
    let manifest: SessionManifest?
    let outputDir: URL
    let modelDir: URL
    let modelVersion: ModelVersion
    let recursive: Bool
    let skipExisting: Bool
    let outputFormat: OutputFormat
    let dryRun: Bool
    let extensionFilter: Set<String>?
    let ffmpegFallback: Bool
    let maxRetries: Int
}

private struct ManifestSettings {
    let modelDir: String?
    let outputFormat: String?
    let recursive: Bool?
    let overwrite: Bool?
    let maxRetries: Int?
    let extensions: [String]?
    let ffmpegFallback: Bool?
    let dryRun: Bool?
}

private struct ItemSettings {
    let outputFormat: String?
}

private struct ManifestFileEntry {
    let id: String?
    let path: String
    let status: String?
    let relative: String?
    let settings: ItemSettings?
}

private struct SessionManifest {
    let sessionId: String
    let createdAt: Date?
    let provider: String
    let model: String
    let outputDir: String
    let settings: ManifestSettings
    let files: [ManifestFileEntry]
}

private struct V2TranscriptionSettings: Decodable {
    let modelDir: String?
    let outputFormat: String?
    let overwrite: Bool?
    let ffmpegFallback: Bool?
    let maxRetries: Int?

    enum CodingKeys: String, CodingKey {
        case modelDir = "model_dir"
        case outputFormat = "output_format"
        case overwrite
        case ffmpegFallback = "ffmpeg_fallback"
        case maxRetries = "max_retries"
    }
}

private struct V2ItemSettings: Decodable {
    let outputFormat: String?

    enum CodingKeys: String, CodingKey {
        case outputFormat = "output_format"
    }
}

private struct V2FileEntry: Decodable {
    let path: String
    let relative: String?
    let settings: V2ItemSettings?
}

private struct V2SessionManifest: Decodable {
    let sessionId: String
    let createdAt: Date?
    let provider: String
    let model: String
    let outputDir: String
    let settings: V2TranscriptionSettings
    let files: [V2FileEntry]

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case createdAt = "created_at"
        case provider
        case model
        case outputDir = "output_dir"
        case settings
        case files
    }
}

private struct LegacyManifestSettings: Decodable {
    let outputFormat: String?
    let recursive: Bool?
    let overwrite: Bool?
    let maxRetries: Int?
    let extensions: [String]?
    let ffmpegFallback: Bool?
    let dryRun: Bool?
}

private struct LegacyManifestFileEntry: Decodable {
    let id: String
    let path: String
    let status: String
}

private struct LegacySessionManifest: Decodable {
    let sessionId: String
    let createdAt: String
    let provider: String
    let model: String
    let outputDir: String
    let settings: LegacyManifestSettings
    let files: [LegacyManifestFileEntry]
}

private struct WorkerCapabilities: Codable {
    let supportedModels: [String]
    let supportedFormats: [String]
    let concurrentFiles: Int
    let wordTimestamps: Bool
    let speakerDiarization: Bool
    let languageDetection: Bool
    let translation: Bool
    let languages: [String]
    let speedEstimate: Double

    enum CodingKeys: String, CodingKey {
        case supportedModels = "supported_models"
        case supportedFormats = "supported_formats"
        case concurrentFiles = "concurrent_files"
        case wordTimestamps = "word_timestamps"
        case speakerDiarization = "speaker_diarization"
        case languageDetection = "language_detection"
        case translation
        case languages
        case speedEstimate = "speed_estimate"
    }
}

private struct InputFile {
    let id: String?
    let url: URL
    let relativePath: String
    let outputFormatOverride: OutputFormat?
}

private struct TranscriptJson: Codable {
    let sourcePath: String
    let relativePath: String
    let text: String
    let confidence: Float
    let durationSeconds: TimeInterval
    let processingSeconds: TimeInterval
    let rtfx: Float
    let tokenTimings: [TokenTiming]?
}

private struct BatchStats {
    var total: Int
    var processed: Int
    var skipped: Int
    var failed: Int
}

private struct FailureRecord: Codable {
    let file: String
    let relativePath: String
    let error: String
    let attempts: Int
}

private struct BatchRunReport: Codable {
    let generatedAt: String
    let inputDir: String
    let outputDir: String
    let modelDir: String
    let modelVersion: String
    let outputFormat: String
    let ffmpegFallback: Bool
    let maxRetries: Int
    let total: Int
    let processed: Int
    let skipped: Int
    let failed: Int
    let durationSeconds: TimeInterval
    let failures: [FailureRecord]
}

private struct ProcessResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

private extension SessionManifest {
    init(from parsed: V2SessionManifest) {
        settings = ManifestSettings(
            modelDir: parsed.settings.modelDir,
            outputFormat: parsed.settings.outputFormat,
            recursive: nil,
            overwrite: parsed.settings.overwrite,
            maxRetries: parsed.settings.maxRetries,
            extensions: nil,
            ffmpegFallback: parsed.settings.ffmpegFallback,
            dryRun: nil
        )

        files = parsed.files.map { entry in
            ManifestFileEntry(
                id: nil,
                path: entry.path,
                status: nil,
                relative: entry.relative,
                settings: ItemSettings(outputFormat: entry.settings?.outputFormat)
            )
        }

        sessionId = parsed.sessionId
        createdAt = parsed.createdAt
        provider = parsed.provider
        model = parsed.model
        outputDir = parsed.outputDir
    }

    init(from parsed: LegacySessionManifest) {
        settings = ManifestSettings(
            modelDir: nil,
            outputFormat: parsed.settings.outputFormat,
            recursive: parsed.settings.recursive,
            overwrite: parsed.settings.overwrite,
            maxRetries: parsed.settings.maxRetries,
            extensions: parsed.settings.extensions,
            ffmpegFallback: parsed.settings.ffmpegFallback,
            dryRun: parsed.settings.dryRun
        )

        files = parsed.files.map { entry in
            ManifestFileEntry(
                id: entry.id,
                path: entry.path,
                status: entry.status,
                relative: nil,
                settings: nil
            )
        }

        sessionId = parsed.sessionId
        createdAt = parseManifestDate(parsed.createdAt)
        provider = parsed.provider
        model = parsed.model
        outputDir = parsed.outputDir
    }
}

private func expandTilde(_ path: String) -> String {
    (path as NSString).expandingTildeInPath
}

private func defaultModelDirectoryURL() -> URL {
    URL(
        fileURLWithPath: expandTilde(
            "~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml"
        ),
        isDirectory: true
    )
}

private func parseManifestDate(_ value: String) -> Date? {
    let withFractionalSeconds = ISO8601DateFormatter()
    withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    withFractionalSeconds.timeZone = TimeZone(secondsFromGMT: 0)

    if let parsed = withFractionalSeconds.date(from: value) {
        return parsed
    }

    let withoutFractionalSeconds = ISO8601DateFormatter()
    withoutFractionalSeconds.formatOptions = [.withInternetDateTime]
    withoutFractionalSeconds.timeZone = TimeZone(secondsFromGMT: 0)
    return withoutFractionalSeconds.date(from: value)
}

private func manifestDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        guard let parsed = parseManifestDate(rawValue) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO8601 date: \(rawValue)"
            )
        }
        return parsed
    }
    return decoder
}

private func iso8601Now() -> String {
    ISO8601DateFormatter.string(
        from: Date(),
        timeZone: TimeZone(secondsFromGMT: 0) ?? .current,
        formatOptions: [.withInternetDateTime, .withFractionalSeconds]
    )
}

private func filenameTimestamp(_ date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter.string(from: date)
}

private enum Events {
    static func emit(_ event: String, fields: [String: Any] = [:]) {
        var payload: [String: Any] = [
            "event": event,
            "timestamp": iso8601Now()
        ]
        for (key, value) in fields {
            payload[key] = value
        }

        guard JSONSerialization.isValidJSONObject(payload) else {
            fputs("Invalid event payload for \(event)\n", stderr)
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
}

private func usage() -> String {
    return """
    coreml-batch

    Usage:
      coreml-batch --capabilities
      coreml-batch (--input-dir <path> | --manifest <path>) [--output-dir <path>] [options]

    Required:
      --input-dir <path>         Directory containing audio files (directory mode).
      --manifest <path>          Session manifest JSON file (manifest mode).
      --output-dir <path>        Directory where transcripts are written (required for --input-dir).
                                 In manifest mode, defaults to manifest output_dir.

    Options:
      --model-dir <path>         CoreML model directory.
                                 Default: ~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml
      --model-version <v2|v3>    Model version. Default: v3
      --output-format <txt|json|both>
                                 Output format. Default: both
      --extensions <csv>         Extensions to include. Use all|*|any to scan everything.
                                 Default: all
      --no-recursive             Disable recursive scanning.
      --overwrite                Overwrite existing transcript files.
      --dry-run                  Scan and report only.
      --max-retries <n>          Retry count per file after first failure. Default: 1
      --no-ffmpeg-fallback       Disable ffmpeg conversion fallback.
      --capabilities             Print runtime capabilities JSON and exit.
      --help                     Show this message.
    """
}

private func normalizedExtensions(_ rawExtensions: [String]) throws -> Set<String>? {
    let parsed = rawExtensions
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
        .filter { !$0.isEmpty }

    guard !parsed.isEmpty else {
        throw CliError.invalidValue("--extensions cannot be empty")
    }

    if parsed.contains(where: { $0 == "all" || $0 == "*" || $0 == "any" }) {
        return nil
    }

    return Set(parsed)
}

private func parseOutputFormat(_ value: String, source: String) throws -> OutputFormat {
    guard let parsed = OutputFormat(rawValue: value.lowercased()) else {
        throw CliError.invalidValue(
            "Invalid output format from \(source): \(value). Use txt, json, or both")
    }
    return parsed
}

private func emitCapabilitiesAndExit() -> Never {
    do {
        let capabilities = WorkerCapabilities(
            supportedModels: ["v2", "v3"],
            supportedFormats: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aiff", "aif", "caf", "mp4", "mov", "m4v", "webm"],
            concurrentFiles: 1,
            wordTimestamps: true,
            speakerDiarization: false,
            languageDetection: false,
            translation: false,
            languages: ["en"],
            speedEstimate: 0.3
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(capabilities)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        Foundation.exit(0)
    } catch {
        fputs("Failed to encode capabilities: \(error)\n", stderr)
        Foundation.exit(1)
    }
}

private func parseManifest(at path: URL) throws -> SessionManifest {
    let data = try Data(contentsOf: path)
    let decoder = manifestDecoder()

    if let parsed = try? decoder.decode(V2SessionManifest.self, from: data) {
        return SessionManifest(from: parsed)
    }

    if let legacy = try? decoder.decode(LegacySessionManifest.self, from: data) {
        return SessionManifest(from: legacy)
    }

    let parsed = try decoder.decode(V2SessionManifest.self, from: data)
    return SessionManifest(from: parsed)
}

private func parseArgs(_ args: ArraySlice<String>) throws -> Config {
    var inputDir: URL?
    var manifestPath: URL?
    var manifest: SessionManifest?
    var outputDir: URL?
    var modelDir = defaultModelDirectoryURL()
    var modelVersion: ModelVersion = .v3
    var recursive = true
    var skipExisting = true
    var outputFormat: OutputFormat = .both
    var dryRun = false
    var extensionFilter: Set<String>? = nil
    var ffmpegFallback = true
    var maxRetries = 1
    var capabilitiesMode = false

    var outputDirFromCli = false
    var modelDirFromCli = false
    var modelVersionFromCli = false
    var recursiveFromCli = false
    var overwriteFromCli = false
    var outputFormatFromCli = false
    var dryRunFromCli = false
    var extensionFilterFromCli = false
    var ffmpegFallbackFromCli = false
    var maxRetriesFromCli = false

    var i = args.startIndex
    while i < args.endIndex {
        let arg = args[i]

        switch arg {
        case "--help", "-h":
            print(usage())
            Foundation.exit(0)
        case "--input-dir":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            inputDir = URL(fileURLWithPath: expandTilde(args[next]), isDirectory: true)
            i = next
        case "--manifest":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            manifestPath = URL(fileURLWithPath: expandTilde(args[next]), isDirectory: false)
            i = next
        case "--output-dir":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            outputDir = URL(fileURLWithPath: expandTilde(args[next]), isDirectory: true)
            outputDirFromCli = true
            i = next
        case "--model-dir":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            modelDir = URL(fileURLWithPath: expandTilde(args[next]), isDirectory: true)
            modelDirFromCli = true
            i = next
        case "--model-version":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            guard let parsed = ModelVersion(rawValue: args[next].lowercased()) else {
                throw CliError.invalidValue("Invalid model version: \(args[next]). Use v2 or v3")
            }
            modelVersion = parsed
            modelVersionFromCli = true
            i = next
        case "--output-format":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            outputFormat = try parseOutputFormat(args[next], source: "--output-format")
            outputFormatFromCli = true
            i = next
        case "--extensions":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            let csvValues = args[next].split(separator: ",").map(String.init)
            extensionFilter = try normalizedExtensions(csvValues)
            extensionFilterFromCli = true
            i = next
        case "--no-recursive":
            recursive = false
            recursiveFromCli = true
        case "--overwrite":
            skipExisting = false
            overwriteFromCli = true
        case "--dry-run":
            dryRun = true
            dryRunFromCli = true
        case "--max-retries":
            let next = args.index(after: i)
            guard next < args.endIndex else { throw CliError.missingValue(arg) }
            guard let parsed = Int(args[next]), parsed >= 0 else {
                throw CliError.invalidValue("Invalid max retries: \(args[next]). Use a non-negative integer.")
            }
            maxRetries = min(parsed, 10)
            maxRetriesFromCli = true
            i = next
        case "--no-ffmpeg-fallback":
            ffmpegFallback = false
            ffmpegFallbackFromCli = true
        case "--capabilities":
            capabilitiesMode = true
        default:
            throw CliError.invalidValue("Unknown argument: \(arg)")
        }

        i = args.index(after: i)
    }

    if capabilitiesMode {
        emitCapabilitiesAndExit()
    }

    let hasInputDir = inputDir != nil
    let hasManifest = manifestPath != nil

    if hasInputDir == hasManifest {
        throw CliError.invalidValue("Exactly one of --input-dir or --manifest is required.")
    }

    if let manifestPath {
        let parsedManifest = try parseManifest(at: manifestPath)
        manifest = parsedManifest

        if !outputDirFromCli {
            outputDir = URL(
                fileURLWithPath: expandTilde(parsedManifest.outputDir),
                isDirectory: true
            )
        }

        if !modelDirFromCli, let manifestModelDir = parsedManifest.settings.modelDir {
            modelDir = URL(
                fileURLWithPath: expandTilde(manifestModelDir),
                isDirectory: true
            )
        }

        if !outputFormatFromCli, let rawFormat = parsedManifest.settings.outputFormat {
            outputFormat = try parseOutputFormat(rawFormat, source: "--manifest settings.output_format")
        }

        if !recursiveFromCli, let recursiveOverride = parsedManifest.settings.recursive {
            recursive = recursiveOverride
        }

        if !overwriteFromCli, let overwriteOverride = parsedManifest.settings.overwrite {
            skipExisting = !overwriteOverride
        }

        if !maxRetriesFromCli, let retries = parsedManifest.settings.maxRetries {
            maxRetries = min(max(0, retries), 10)
        }

        if !extensionFilterFromCli, let extensionsOverride = parsedManifest.settings.extensions {
            extensionFilter = try normalizedExtensions(extensionsOverride)
        }

        if !ffmpegFallbackFromCli, let ffmpegOverride = parsedManifest.settings.ffmpegFallback {
            ffmpegFallback = ffmpegOverride
        }

        if !dryRunFromCli, let dryRunOverride = parsedManifest.settings.dryRun {
            dryRun = dryRunOverride
        }

        if !modelVersionFromCli,
            let parsed = ModelVersion(rawValue: parsedManifest.model.lowercased())
        {
            modelVersion = parsed
        }
    }

    guard let outputDir else { throw CliError.missingRequired("--output-dir") }

    return Config(
        inputDir: inputDir,
        manifestPath: manifestPath,
        manifest: manifest,
        outputDir: outputDir,
        modelDir: modelDir,
        modelVersion: modelVersion,
        recursive: recursive,
        skipExisting: skipExisting,
        outputFormat: outputFormat,
        dryRun: dryRun,
        extensionFilter: extensionFilter,
        ffmpegFallback: ffmpegFallback,
        maxRetries: maxRetries
    )
}

private func validateConfig(_ config: Config) throws {
    var isDirectory = ObjCBool(false)
    let fm = FileManager.default

    if let inputDir = config.inputDir {
        guard fm.fileExists(atPath: inputDir.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw CliError.invalidValue("Input directory not found: \(inputDir.path)")
        }
    }

    if let manifestPath = config.manifestPath {
        guard fm.fileExists(atPath: manifestPath.path) else {
            throw CliError.invalidValue("Manifest file not found: \(manifestPath.path)")
        }

        if let manifest = config.manifest {
            for entry in manifest.files {
                let resolvedPath = expandTilde(entry.path)
                if fm.fileExists(atPath: resolvedPath) {
                    continue
                }

                Events.emit("manifest_validation_error", fields: [
                    "file": resolvedPath,
                    "relative": entry.relative ?? URL(fileURLWithPath: resolvedPath).lastPathComponent
                ])
                throw CliError.invalidValue("Manifest references a missing file: \(resolvedPath)")
            }
        }
    }

    if !fm.fileExists(atPath: config.outputDir.path, isDirectory: &isDirectory) {
        try fm.createDirectory(at: config.outputDir, withIntermediateDirectories: true)
    }

    guard fm.fileExists(atPath: config.modelDir.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw CliError.invalidValue("Model directory not found: \(config.modelDir.path)")
    }
}

private func shouldIncludeFile(_ url: URL, config: Config) -> Bool {
    guard let filter = config.extensionFilter else {
        return true
    }

    let ext = url.pathExtension.lowercased()
    return filter.contains(ext)
}

private func discoverFiles(config: Config) throws -> [InputFile] {
    if let manifest = config.manifest {
        var files: [InputFile] = []

        for entry in manifest.files {
            if let status = entry.status?.lowercased(), status == "completed" {
                continue
            }

            let resolvedPath = expandTilde(entry.path)
            let url = URL(fileURLWithPath: resolvedPath, isDirectory: false)
            guard shouldIncludeFile(url, config: config) else { continue }

            let relativePath: String
            if let manifestRelative = entry.relative?.trimmingCharacters(in: .whitespacesAndNewlines),
                !manifestRelative.isEmpty
            {
                relativePath = manifestRelative
            } else {
                relativePath = url.lastPathComponent
            }

            let outputFormatOverride: OutputFormat?
            if let rawFormat = entry.settings?.outputFormat {
                outputFormatOverride = try parseOutputFormat(
                    rawFormat,
                    source: "manifest file \(entry.path)"
                )
            } else {
                outputFormatOverride = nil
            }

            files.append(
                InputFile(
                    id: entry.id,
                    url: url,
                    relativePath: relativePath,
                    outputFormatOverride: outputFormatOverride
                )
            )
        }

        return files.sorted { $0.url.path < $1.url.path }
    }

    guard let inputDir = config.inputDir else {
        return []
    }

    let fm = FileManager.default
    var files: [InputFile] = []

    if config.recursive {
        guard
            let enumerator = fm.enumerator(
                at: inputDir,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            )
        else {
            return []
        }

        for case let url as URL in enumerator {
            let resourceValues = try url.resourceValues(forKeys: [.isRegularFileKey])
            guard resourceValues.isRegularFile == true else { continue }
            guard shouldIncludeFile(url, config: config) else { continue }
            files.append(
                InputFile(
                    id: nil,
                    url: url,
                    relativePath: relativePath(of: url, from: inputDir),
                    outputFormatOverride: nil
                )
            )
        }
    } else {
        let urls = try fm.contentsOfDirectory(
            at: inputDir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )

        for url in urls {
            let resourceValues = try url.resourceValues(forKeys: [.isRegularFileKey])
            guard resourceValues.isRegularFile == true else { continue }
            guard shouldIncludeFile(url, config: config) else { continue }
            files.append(
                InputFile(
                    id: nil,
                    url: url,
                    relativePath: relativePath(of: url, from: inputDir),
                    outputFormatOverride: nil
                )
            )
        }
    }

    return files.sorted { $0.url.path < $1.url.path }
}

private func relativePath(of file: URL, from base: URL) -> String {
    let basePath = base.standardizedFileURL.path
    let filePath = file.standardizedFileURL.path

    if filePath == basePath {
        return file.lastPathComponent
    }

    let prefix = basePath.hasSuffix("/") ? basePath : "\(basePath)/"
    if filePath.hasPrefix(prefix) {
        return String(filePath.dropFirst(prefix.count))
    }

    return file.lastPathComponent
}

private func outputPaths(for inputFile: InputFile, config: Config) -> (txt: URL, json: URL, relative: String) {
    let relative = inputFile.relativePath
    let txt = config.outputDir.appendingPathComponent(relative + ".txt")
    let json = config.outputDir.appendingPathComponent(relative + ".json")
    return (txt, json, relative)
}

private func effectiveOutputFormat(for inputFile: InputFile, config: Config) -> OutputFormat {
    inputFile.outputFormatOverride ?? config.outputFormat
}

private func shouldSkip(outputs: (txt: URL, json: URL), outputFormat: OutputFormat, skipExisting: Bool) -> Bool {
    guard skipExisting else { return false }

    let fm = FileManager.default
    let txtReady = !outputFormat.writesTxt || fm.fileExists(atPath: outputs.txt.path)
    let jsonReady = !outputFormat.writesJson || fm.fileExists(atPath: outputs.json.path)
    return txtReady && jsonReady
}

private func ensureParentDirectory(for fileURL: URL) throws {
    let parent = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
}

private func writeOutputs(
    result: ASRResult,
    source: URL,
    relativePath: String,
    outputs: (txt: URL, json: URL),
    outputFormat: OutputFormat
) throws {
    if outputFormat.writesTxt {
        try ensureParentDirectory(for: outputs.txt)
        try result.text.write(to: outputs.txt, atomically: true, encoding: .utf8)
    }

    if outputFormat.writesJson {
        try ensureParentDirectory(for: outputs.json)
        let payload = TranscriptJson(
            sourcePath: source.path,
            relativePath: relativePath,
            text: result.text,
            confidence: result.confidence,
            durationSeconds: result.duration,
            processingSeconds: result.processingTime,
            rtfx: result.rtfx,
            tokenTimings: result.tokenTimings
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(payload)
        try data.write(to: outputs.json)
    }
}

private func runProcess(executable: String, arguments: [String]) throws -> ProcessResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    try process.run()
    process.waitUntilExit()

    let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

    return ProcessResult(
        status: process.terminationStatus,
        stdout: String(decoding: stdoutData, as: UTF8.self),
        stderr: String(decoding: stderrData, as: UTF8.self)
    )
}

private func isFfmpegAvailable() -> Bool {
    do {
        let result = try runProcess(executable: "/usr/bin/env", arguments: ["ffmpeg", "-version"])
        return result.status == 0
    } catch {
        return false
    }
}

private func transcodeArchiveDirectory(config: Config) -> URL {
    config.outputDir
        .appendingPathComponent("_archive", isDirectory: true)
        .appendingPathComponent("coreml-transcode-cache", isDirectory: true)
}

private func reportsDirectory(config: Config) -> URL {
    config.outputDir
        .appendingPathComponent("_reports", isDirectory: true)
}

private func reportInputPath(config: Config) -> String {
    if let inputDir = config.inputDir {
        return inputDir.path
    }

    if let manifestPath = config.manifestPath {
        return "manifest:\(manifestPath.path)"
    }

    return ""
}

private func fileEventFields(
    file: InputFile,
    index: Int,
    total: Int,
    relativePath: String,
    extra: [String: Any] = [:]
) -> [String: Any] {
    var fields: [String: Any] = [
        "index": index + 1,
        "total": total,
        "file": file.url.path,
        "relative": relativePath
    ]

    if let id = file.id {
        fields["file_id"] = id
    }

    for (key, value) in extra {
        fields[key] = value
    }

    return fields
}

private func writeRunReport(
    config: Config,
    startedAt: Date,
    stats: BatchStats,
    failures: [FailureRecord]
) throws -> URL {
    let reportURL = reportsDirectory(config: config)
        .appendingPathComponent("run-\(filenameTimestamp(startedAt)).json")

    let report = BatchRunReport(
        generatedAt: iso8601Now(),
        inputDir: reportInputPath(config: config),
        outputDir: config.outputDir.path,
        modelDir: config.modelDir.path,
        modelVersion: config.modelVersion.rawValue,
        outputFormat: config.outputFormat.rawValue,
        ffmpegFallback: config.ffmpegFallback,
        maxRetries: config.maxRetries,
        total: stats.total,
        processed: stats.processed,
        skipped: stats.skipped,
        failed: stats.failed,
        durationSeconds: Date().timeIntervalSince(startedAt),
        failures: failures
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(report)
    try ensureParentDirectory(for: reportURL)
    try data.write(to: reportURL)
    return reportURL
}

private func transcodeOutputURL(for source: URL, relativePath: String, config: Config) -> URL {
    let base = transcodeArchiveDirectory(config: config)
    return base.appendingPathComponent(relativePath + ".wav")
}

private func transcodeToWavWithFfmpeg(source: URL, relativePath: String, config: Config) throws -> URL {
    let outputURL = transcodeOutputURL(for: source, relativePath: relativePath, config: config)

    if FileManager.default.fileExists(atPath: outputURL.path) {
        return outputURL
    }

    try ensureParentDirectory(for: outputURL)

    let result = try runProcess(
        executable: "/usr/bin/env",
        arguments: [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-nostdin",
            "-i",
            source.path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            outputURL.path,
        ]
    )

    guard result.status == 0 else {
        let detail = result.stderr.isEmpty ? result.stdout : result.stderr
        throw CliError.invalidValue(
            "ffmpeg conversion failed for \(source.path): \(detail.trimmingCharacters(in: .whitespacesAndNewlines))"
        )
    }

    return outputURL
}

private func transcribeWithFallback(
    manager: AsrManager,
    source: URL,
    relativePath: String,
    config: Config,
    ffmpegAvailable: Bool
) async throws -> (result: ASRResult, usedFfmpegFallback: Bool, fallbackInput: URL?) {
    do {
        let result = try await manager.transcribe(source)
        return (result, false, nil)
    } catch {
        let directError = String(describing: error)

        guard config.ffmpegFallback else {
            throw error
        }

        guard ffmpegAvailable else {
            throw CliError.invalidValue(
                "Direct decode failed for \(source.path): \(directError). ffmpeg fallback is enabled but ffmpeg is not available."
            )
        }

        let fallbackInput = try transcodeToWavWithFfmpeg(
            source: source,
            relativePath: relativePath,
            config: config
        )

        do {
            let result = try await manager.transcribe(fallbackInput)
            return (result, true, fallbackInput)
        } catch {
            throw CliError.invalidValue(
                "Direct decode failed for \(source.path): \(directError). ffmpeg fallback failed: \(String(describing: error))"
            )
        }
    }
}

@main
private struct CoreMLBatchWorker {
    static func main() async {
        let startedAt = Date()

        do {
            let config = try parseArgs(Array(CommandLine.arguments.dropFirst())[...])
            try validateConfig(config)

            var startFields: [String: Any] = [
                "input_dir": config.inputDir?.path ?? "",
                "output_dir": config.outputDir.path,
                "model_dir": config.modelDir.path,
                "model_version": config.modelVersion.rawValue,
                "recursive": config.recursive,
                "skip_existing": config.skipExisting,
                "resume_enabled": config.skipExisting,
                "output_format": config.outputFormat.rawValue,
                "dry_run": config.dryRun,
                "extensions_mode": config.extensionFilter == nil ? "all" : "filtered",
                "extensions": config.extensionFilter?.sorted() ?? [],
                "ffmpeg_fallback": config.ffmpegFallback,
                "max_retries": config.maxRetries
            ]

            if let manifestPath = config.manifestPath {
                startFields["manifest"] = manifestPath.path
                startFields["source_mode"] = "manifest"
            } else {
                startFields["source_mode"] = "input_dir"
            }

            if let sessionId = config.manifest?.sessionId {
                startFields["session_id"] = sessionId
            }

            Events.emit("start", fields: startFields)

            if let manifest = config.manifest {
                Events.emit("manifest_loaded", fields: [
                    "session_id": manifest.sessionId,
                    "total": manifest.files.count
                ])
            }

            let ffmpegAvailable = config.ffmpegFallback ? isFfmpegAvailable() : false
            Events.emit("ffmpeg_status", fields: [
                "requested": config.ffmpegFallback,
                "available": ffmpegAvailable
            ])

            let files = try discoverFiles(config: config)
            Events.emit("scanned", fields: ["total": files.count])

            var stats = BatchStats(total: files.count, processed: 0, skipped: 0, failed: 0)
            var failures: [FailureRecord] = []

            if config.dryRun {
                Events.emit("summary", fields: [
                    "total": stats.total,
                    "processed": stats.processed,
                    "skipped": stats.skipped,
                    "failed": stats.failed,
                    "duration_seconds": Date().timeIntervalSince(startedAt),
                    "failures": [],
                    "failure_report": ""
                ])
                Foundation.exit(0)
            }

            let models = try await AsrModels.load(from: config.modelDir, version: config.modelVersion.asrVersion)
            let manager = AsrManager(config: .default)
            try await manager.initialize(models: models)
            Events.emit("models_loaded")

            for (index, file) in files.enumerated() {
                let source = file.url
                let outputs = outputPaths(for: file, config: config)
                let fileOutputFormat = effectiveOutputFormat(for: file, config: config)

                if shouldSkip(
                    outputs: (outputs.txt, outputs.json),
                    outputFormat: fileOutputFormat,
                    skipExisting: config.skipExisting
                ) {
                    stats.skipped += 1
                    Events.emit(
                        "file_skipped",
                        fields: fileEventFields(
                            file: file,
                            index: index,
                            total: stats.total,
                            relativePath: outputs.relative,
                            extra: [
                                "reason": "outputs_exist",
                                "output": [
                                    "txt": outputs.txt.path,
                                    "json": outputs.json.path
                                ]
                            ]
                        )
                    )
                    continue
                }

                Events.emit(
                    "file_started",
                    fields: fileEventFields(
                        file: file,
                        index: index,
                        total: stats.total,
                        relativePath: outputs.relative
                    )
                )
                Events.emit(
                    "file_progress",
                    fields: fileEventFields(
                        file: file,
                        index: index,
                        total: stats.total,
                        relativePath: outputs.relative,
                        extra: [
                            "progress": 0,
                            "rtfx": 0
                        ]
                    )
                )

                do {
                    let perFileStart = Date()
                    let maxAttempts = max(1, config.maxRetries + 1)
                    var transcription: (result: ASRResult, usedFfmpegFallback: Bool, fallbackInput: URL?)?
                    var lastError: Error?
                    var attempts = 0

                    for attempt in 1...maxAttempts {
                        attempts = attempt
                        do {
                            let result = try await transcribeWithFallback(
                                manager: manager,
                                source: source,
                                relativePath: outputs.relative,
                                config: config,
                                ffmpegAvailable: ffmpegAvailable
                            )
                            transcription = result
                            break
                        } catch {
                            lastError = error
                            if attempt < maxAttempts {
                                Events.emit(
                                    "file_retry",
                                    fields: fileEventFields(
                                        file: file,
                                        index: index,
                                        total: stats.total,
                                        relativePath: outputs.relative,
                                        extra: [
                                            "attempt": attempt,
                                            "max_attempts": maxAttempts,
                                            "reason": String(describing: error),
                                            "error": String(describing: error)
                                        ]
                                    )
                                )
                            }
                        }
                    }

                    guard let transcription else {
                        throw lastError ?? CliError.invalidValue("Unknown transcription failure.")
                    }

                    try writeOutputs(
                        result: transcription.result,
                        source: source,
                        relativePath: outputs.relative,
                        outputs: (outputs.txt, outputs.json),
                        outputFormat: fileOutputFormat
                    )

                    var output: [String: String] = [:]
                    if fileOutputFormat.writesTxt {
                        output["txt"] = outputs.txt.path
                    }
                    if fileOutputFormat.writesJson {
                        output["json"] = outputs.json.path
                    }

                    Events.emit(
                        "file_progress",
                        fields: fileEventFields(
                            file: file,
                            index: index,
                            total: stats.total,
                            relativePath: outputs.relative,
                            extra: [
                                "progress": 100,
                                "rtfx": transcription.result.rtfx
                            ]
                        )
                    )

                    stats.processed += 1
                    Events.emit(
                        "file_done",
                        fields: fileEventFields(
                            file: file,
                            index: index,
                            total: stats.total,
                            relativePath: outputs.relative,
                            extra: [
                                "duration_seconds": transcription.result.duration,
                                "processing_seconds": transcription.result.processingTime,
                                "rtfx": transcription.result.rtfx,
                                "confidence": transcription.result.confidence,
                                "wall_seconds": Date().timeIntervalSince(perFileStart),
                                "text_output": output["txt"] ?? "",
                                "json_output": output["json"] ?? "",
                                "output": output,
                                "output_format": fileOutputFormat.rawValue,
                                "attempts": attempts,
                                "ffmpeg_fallback_used": transcription.usedFfmpegFallback,
                                "ffmpeg_fallback_input": transcription.fallbackInput?.path ?? ""
                            ]
                        )
                    )
                } catch {
                    stats.failed += 1
                    let maxAttempts = max(1, config.maxRetries + 1)
                    failures.append(FailureRecord(
                        file: source.path,
                        relativePath: outputs.relative,
                        error: String(describing: error),
                        attempts: maxAttempts
                    ))
                    Events.emit(
                        "file_failed",
                        fields: fileEventFields(
                            file: file,
                            index: index,
                            total: stats.total,
                            relativePath: outputs.relative,
                            extra: [
                                "attempts": max(1, config.maxRetries + 1),
                                "error": String(describing: error)
                            ]
                        )
                    )
                }
            }

            manager.cleanup()

            let reportPath: String
            do {
                let reportURL = try writeRunReport(
                    config: config,
                    startedAt: startedAt,
                    stats: stats,
                    failures: failures
                )
                reportPath = reportURL.path
                Events.emit("report_written", fields: [
                    "report_path": reportPath
                ])
            } catch {
                reportPath = ""
                Events.emit("report_write_failed", fields: [
                    "error": String(describing: error)
                ])
            }

            let failurePayload = failures.map { item in
                [
                    "file": item.file,
                    "relative_path": item.relativePath,
                    "error": item.error,
                    "attempts": item.attempts
                ]
            }

            Events.emit("summary", fields: [
                "total": stats.total,
                "processed": stats.processed,
                "skipped": stats.skipped,
                "failed": stats.failed,
                "duration_seconds": Date().timeIntervalSince(startedAt),
                "failures": failurePayload,
                "failure_report": reportPath
            ])
            Foundation.exit(stats.failed > 0 ? 2 : 0)
        } catch {
            fputs("\(usage())\n\n", stderr)
            fputs("Error: \(error)\n", stderr)
            Events.emit("fatal_error", fields: ["error": String(describing: error)])
            Foundation.exit(1)
        }
    }
}

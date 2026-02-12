import Foundation
import XCTest

final class CoreMLBatchCliTests: XCTestCase {
    private struct CommandResult {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    private func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func makeTempDirectory(_ name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("coreml-batch-tests")
            .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func writeJSON(_ value: Any, to path: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: path)
    }

    private func buildWorkerBinaryIfNeeded() throws {
        let root = packageRoot()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "swift",
            "build",
            "--disable-sandbox",
            "-c",
            "debug",
            "--product",
            "coreml-batch",
        ]
        process.currentDirectoryURL = root

        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: "/tmp/swift-home", isDirectory: true),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: "/tmp/clang-module-cache", isDirectory: true),
            withIntermediateDirectories: true
        )

        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = "/tmp/swift-home"
        environment["SWIFT_MODULECACHE_PATH"] = "/tmp/clang-module-cache"
        environment["CLANG_MODULE_CACHE_PATH"] = "/tmp/clang-module-cache"
        process.environment = environment

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let stderr = String(decoding: stderrPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            XCTFail("Failed to build coreml-batch test binary: \(stderr)")
            return
        }
    }

    private func workerBinaryURL() throws -> URL {
        if let explicit = ProcessInfo.processInfo.environment["COREML_BATCH_BIN"],
            FileManager.default.isExecutableFile(atPath: explicit)
        {
            return URL(fileURLWithPath: explicit)
        }

        let root = packageRoot()
        let candidates = [
            root.appendingPathComponent(".build/debug/coreml-batch"),
            root.appendingPathComponent(".build/release/coreml-batch"),
            root.appendingPathComponent(".build/arm64-apple-macosx/debug/coreml-batch"),
            root.appendingPathComponent(".build/arm64-apple-macosx/release/coreml-batch"),
            root.appendingPathComponent(".build/x86_64-apple-macosx/debug/coreml-batch"),
            root.appendingPathComponent(".build/x86_64-apple-macosx/release/coreml-batch"),
        ]

        if let first = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) {
            return first
        }

        try buildWorkerBinaryIfNeeded()

        if let first = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) {
            return first
        }

        throw NSError(
            domain: "CoreMLBatchCliTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Could not locate coreml-batch executable"]
        )
    }

    private func runWorker(_ args: [String]) throws -> CommandResult {
        let process = Process()
        process.executableURL = try workerBinaryURL()
        process.arguments = args
        process.currentDirectoryURL = packageRoot()

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        try process.run()
        process.waitUntilExit()

        let stdout = String(decoding: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let stderr = String(decoding: stderrPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return CommandResult(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    private func ndjsonEvents(from stdout: String) -> [[String: Any]] {
        stdout
            .split(whereSeparator: \.isNewline)
            .compactMap { line in
                guard let data = line.data(using: .utf8) else {
                    return nil
                }
                return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
    }

    private func firstEvent(named eventName: String, in events: [[String: Any]]) -> [String: Any]? {
        events.first(where: { $0["event"] as? String == eventName })
    }

    func testCapabilitiesOutputsMachineReadableJson() throws {
        let result = try runWorker(["--capabilities"])

        XCTAssertEqual(result.status, 0)

        let data = try XCTUnwrap(result.stdout.data(using: .utf8))
        let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(payload["word_timestamps"] as? Bool, true)
        XCTAssertEqual(payload["speaker_diarization"] as? Bool, false)
        XCTAssertEqual(payload["translation"] as? Bool, false)
        XCTAssertEqual(payload["concurrent_files"] as? Int, 1)

        let models = payload["supported_models"] as? [String]
        XCTAssertEqual(models ?? [], ["v2", "v3"])
    }

    func testRejectsManifestAndInputDirTogether() throws {
        let root = try makeTempDirectory("mixed-mode")
        let inputDir = root.appendingPathComponent("in", isDirectory: true)
        let outputDir = root.appendingPathComponent("out", isDirectory: true)
        let modelDir = root.appendingPathComponent("model", isDirectory: true)
        let manifestPath = root.appendingPathComponent("session.json", isDirectory: false)
        let audioPath = inputDir.appendingPathComponent("sample.wav", isDirectory: false)

        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
        try Data("test".utf8).write(to: audioPath)

        try writeJSON(
            [
                "session_id": "session-mixed",
                "created_at": "2026-02-12T00:00:00.000Z",
                "provider": "coreml-local",
                "model": "v3",
                "output_dir": outputDir.path,
                "settings": [
                    "model_dir": modelDir.path,
                    "output_format": "both",
                    "overwrite": false,
                    "ffmpeg_fallback": true,
                    "max_retries": 1,
                ],
                "files": [
                    [
                        "path": audioPath.path,
                        "relative": "sample.wav",
                    ]
                ],
            ],
            to: manifestPath
        )

        let result = try runWorker([
            "--input-dir", inputDir.path,
            "--manifest", manifestPath.path,
            "--output-dir", outputDir.path,
            "--model-dir", modelDir.path,
            "--dry-run",
        ])

        XCTAssertEqual(result.status, 1)
        XCTAssertTrue(result.stderr.contains("Exactly one of --input-dir or --manifest is required."))
    }

    func testInputDirectoryModeStillWorksInDryRun() throws {
        let root = try makeTempDirectory("input-dir")
        let inputDir = root.appendingPathComponent("in", isDirectory: true)
        let outputDir = root.appendingPathComponent("out", isDirectory: true)
        let modelDir = root.appendingPathComponent("model", isDirectory: true)

        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: inputDir.appendingPathComponent("sample.wav"))

        let result = try runWorker([
            "--input-dir", inputDir.path,
            "--output-dir", outputDir.path,
            "--model-dir", modelDir.path,
            "--dry-run",
        ])

        XCTAssertEqual(result.status, 0, result.stderr)

        let events = ndjsonEvents(from: result.stdout)
        let start = try XCTUnwrap(firstEvent(named: "start", in: events))
        XCTAssertEqual(start["source_mode"] as? String, "input_dir")

        let scanned = try XCTUnwrap(firstEvent(named: "scanned", in: events))
        XCTAssertEqual(scanned["total"] as? Int, 1)

        let summary = try XCTUnwrap(firstEvent(named: "summary", in: events))
        XCTAssertEqual(summary["total"] as? Int, 1)
        XCTAssertEqual(summary["processed"] as? Int, 0)
        XCTAssertEqual(summary["failed"] as? Int, 0)
    }

    func testManifestModeSupportsNewSchemaWithoutCliOutputOverride() throws {
        let root = try makeTempDirectory("manifest-v2")
        let outputDir = root.appendingPathComponent("out", isDirectory: true)
        let modelDir = root.appendingPathComponent("model", isDirectory: true)
        let audioPath = root.appendingPathComponent("input.wav", isDirectory: false)
        let manifestPath = root.appendingPathComponent("session.json", isDirectory: false)

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: audioPath)

        try writeJSON(
            [
                "session_id": "session-v2",
                "created_at": "2026-02-12T00:00:00.000Z",
                "provider": "coreml-local",
                "model": "v3",
                "output_dir": outputDir.path,
                "settings": [
                    "model_dir": modelDir.path,
                    "output_format": "both",
                    "overwrite": false,
                    "ffmpeg_fallback": true,
                    "max_retries": 2,
                ],
                "files": [
                    [
                        "path": audioPath.path,
                        "relative": "nested/input.wav",
                        "settings": [
                            "output_format": "txt",
                        ],
                    ]
                ],
            ],
            to: manifestPath
        )

        let result = try runWorker([
            "--manifest", manifestPath.path,
            "--dry-run",
        ])

        XCTAssertEqual(result.status, 0, result.stderr)

        let events = ndjsonEvents(from: result.stdout)
        let start = try XCTUnwrap(firstEvent(named: "start", in: events))
        XCTAssertEqual(start["source_mode"] as? String, "manifest")
        XCTAssertEqual(start["session_id"] as? String, "session-v2")
        XCTAssertEqual(start["output_dir"] as? String, outputDir.path)

        let manifestLoaded = try XCTUnwrap(firstEvent(named: "manifest_loaded", in: events))
        XCTAssertEqual(manifestLoaded["session_id"] as? String, "session-v2")
        XCTAssertEqual(manifestLoaded["total"] as? Int, 1)

        let scanned = try XCTUnwrap(firstEvent(named: "scanned", in: events))
        XCTAssertEqual(scanned["total"] as? Int, 1)
    }

    func testLegacyManifestModeRemainsSupported() throws {
        let root = try makeTempDirectory("manifest-legacy")
        let outputDir = root.appendingPathComponent("out", isDirectory: true)
        let modelDir = root.appendingPathComponent("model", isDirectory: true)
        let audioPath = root.appendingPathComponent("legacy.wav", isDirectory: false)
        let manifestPath = root.appendingPathComponent("legacy-session.json", isDirectory: false)

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: audioPath)

        try writeJSON(
            [
                "sessionId": "session-legacy",
                "createdAt": "2026-02-12T00:00:00.000Z",
                "provider": "coreml-local",
                "model": "v3",
                "outputDir": outputDir.path,
                "settings": [
                    "outputFormat": "both",
                    "recursive": true,
                    "overwrite": false,
                    "maxRetries": 1,
                    "extensions": ["wav"],
                    "ffmpegFallback": true,
                    "dryRun": true,
                ],
                "files": [
                    [
                        "id": "file-1",
                        "path": audioPath.path,
                        "status": "queued",
                    ]
                ],
            ],
            to: manifestPath
        )

        let result = try runWorker([
            "--manifest", manifestPath.path,
            "--output-dir", outputDir.path,
            "--model-dir", modelDir.path,
            "--dry-run",
        ])

        XCTAssertEqual(result.status, 0, result.stderr)

        let events = ndjsonEvents(from: result.stdout)
        let start = try XCTUnwrap(firstEvent(named: "start", in: events))
        XCTAssertEqual(start["source_mode"] as? String, "manifest")
        XCTAssertEqual(start["session_id"] as? String, "session-legacy")

        let scanned = try XCTUnwrap(firstEvent(named: "scanned", in: events))
        XCTAssertEqual(scanned["total"] as? Int, 1)
    }

    func testManifestRejectsInvalidPerFileOutputFormat() throws {
        let root = try makeTempDirectory("manifest-invalid-file-settings")
        let outputDir = root.appendingPathComponent("out", isDirectory: true)
        let modelDir = root.appendingPathComponent("model", isDirectory: true)
        let audioPath = root.appendingPathComponent("invalid.wav", isDirectory: false)
        let manifestPath = root.appendingPathComponent("invalid-session.json", isDirectory: false)

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: modelDir, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: audioPath)

        try writeJSON(
            [
                "session_id": "session-invalid",
                "created_at": "2026-02-12T00:00:00.000Z",
                "provider": "coreml-local",
                "model": "v3",
                "output_dir": outputDir.path,
                "settings": [
                    "model_dir": modelDir.path,
                    "output_format": "both",
                    "overwrite": false,
                    "ffmpeg_fallback": true,
                    "max_retries": 1,
                ],
                "files": [
                    [
                        "path": audioPath.path,
                        "relative": "invalid.wav",
                        "settings": [
                            "output_format": "yaml",
                        ],
                    ]
                ],
            ],
            to: manifestPath
        )

        let result = try runWorker([
            "--manifest", manifestPath.path,
            "--dry-run",
        ])

        XCTAssertEqual(result.status, 1)
        XCTAssertTrue(result.stderr.contains("Invalid output format from manifest file"))
    }
}

/**
 * ohwow Audio Capture — ScreenCaptureKit system audio recorder.
 *
 * Captures system audio (or a specific app's audio) and writes 30-second
 * WAV chunks to an output directory. macOS 13+ required.
 *
 * Usage:
 *   ohwow-capture --output-dir /tmp/chunks [--app us.zoom.xos] [--chunk-seconds 30]
 *
 * Exits cleanly on SIGTERM/SIGINT, writing a DONE sentinel file.
 */

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// MARK: - CLI argument parsing

let args = CommandLine.arguments
func argValue(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

guard let outputDir = argValue("--output-dir") else {
    fputs("Error: --output-dir is required\n", stderr)
    exit(1)
}

let targetApp = argValue("--app")
let chunkSeconds = Double(argValue("--chunk-seconds") ?? "30") ?? 30.0

// MARK: - WAV writer

class WAVWriter {
    let sampleRate: Int
    let channels: Int
    let bitsPerSample: Int
    private var buffer = Data()

    init(sampleRate: Int = 48000, channels: Int = 2, bitsPerSample: Int = 16) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitsPerSample = bitsPerSample
    }

    func append(_ pcmData: Data) {
        buffer.append(pcmData)
    }

    var byteCount: Int { buffer.count }

    func writeToFile(_ path: String) throws {
        let byteRate = sampleRate * channels * (bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = UInt32(buffer.count)
        let fileSize = 36 + dataSize

        var header = Data()
        header.append(contentsOf: "RIFF".utf8)
        header.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        header.append(contentsOf: "WAVE".utf8)
        header.append(contentsOf: "fmt ".utf8)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })  // PCM
        header.append(contentsOf: withUnsafeBytes(of: UInt16(channels).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(byteRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(blockAlign).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(bitsPerSample).littleEndian) { Array($0) })
        header.append(contentsOf: "data".utf8)
        header.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

        var fileData = header
        fileData.append(buffer)
        try fileData.write(to: URL(fileURLWithPath: path))
    }

    func reset() {
        buffer = Data()
    }
}

// MARK: - Audio capture delegate

class AudioCaptureHandler: NSObject, SCStreamOutput {
    let outputDir: String
    let chunkDuration: Double
    private var writer = WAVWriter()
    private var chunkIndex = 0
    private var chunkStartTime: Date = Date()
    private var stopped = false
    private let lock = NSLock()

    init(outputDir: String, chunkDuration: Double) {
        self.outputDir = outputDir
        self.chunkDuration = chunkDuration
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        lock.lock()
        defer { lock.unlock() }
        if stopped { return }

        guard let blockBuffer = sampleBuffer.dataBuffer else { return }
        let length = CMBlockBufferGetDataLength(blockBuffer)
        var data = Data(count: length)
        data.withUnsafeMutableBytes { rawBuffer in
            guard let ptr = rawBuffer.baseAddress else { return }
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: ptr)
        }

        // Convert Float32 interleaved → Int16
        let floatCount = length / MemoryLayout<Float>.size
        let int16Data = data.withUnsafeBytes { rawBuffer -> Data in
            let floats = rawBuffer.bindMemory(to: Float.self)
            var int16s = Data(capacity: floatCount * 2)
            for i in 0..<floatCount {
                let clamped = max(-1.0, min(1.0, floats[i]))
                var sample = Int16(clamped * Float(Int16.max))
                int16s.append(contentsOf: withUnsafeBytes(of: &sample) { Array($0) })
            }
            return int16s
        }

        writer.append(int16Data)

        // Check if chunk duration elapsed
        if Date().timeIntervalSince(chunkStartTime) >= chunkDuration {
            flushChunk()
        }
    }

    private func flushChunk() {
        guard writer.byteCount > 0 else { return }
        let filename = String(format: "chunk-%03d.wav", chunkIndex)
        let path = (outputDir as NSString).appendingPathComponent(filename)
        do {
            try writer.writeToFile(path)
            fputs("CHUNK:\(filename)\n", stdout)
            fflush(stdout)
            chunkIndex += 1
            writer.reset()
            chunkStartTime = Date()
        } catch {
            fputs("Error writing chunk: \(error)\n", stderr)
        }
    }

    func finalize() {
        lock.lock()
        stopped = true
        flushChunk()
        lock.unlock()
        // Write DONE sentinel
        let donePath = (outputDir as NSString).appendingPathComponent("DONE")
        FileManager.default.createFile(atPath: donePath, contents: nil)
        fputs("DONE\n", stdout)
        fflush(stdout)
    }
}

// MARK: - Main

let semaphore = DispatchSemaphore(value: 0)
var captureStream: SCStream?
var handler: AudioCaptureHandler?

// Signal handling for clean shutdown
func setupSignalHandler() {
    let signalCallback: @convention(c) (Int32) -> Void = { _ in
        handler?.finalize()
        if let stream = captureStream {
            let stopSemaphore = DispatchSemaphore(value: 0)
            stream.stopCapture { _ in stopSemaphore.signal() }
            _ = stopSemaphore.wait(timeout: .now() + 2)
        }
        exit(0)
    }
    signal(SIGTERM, signalCallback)
    signal(SIGINT, signalCallback)
}

setupSignalHandler()

Task {
    do {
        // Get shareable content
        let content = try await SCShareableContent.current

        // Build filter
        let filter: SCContentFilter
        if let bundleId = targetApp {
            guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleId }) else {
                fputs("Error: app '\(bundleId)' not found. Available apps:\n", stderr)
                for app in content.applications.prefix(20) {
                    fputs("  \(app.bundleIdentifier) — \(app.applicationName)\n", stderr)
                }
                exit(1)
            }
            // Capture just this app's audio
            filter = SCContentFilter(desktopIndependentWindow: app.windows.first ?? content.windows[0])
            fputs("Capturing audio from: \(app.applicationName) (\(bundleId))\n", stderr)
        } else {
            // Capture all system audio (exclude self)
            let selfApp = content.applications.first { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
            let excludedApps = selfApp.map { [$0] } ?? []
            filter = SCContentFilter(display: content.displays[0], excludingApplications: excludedApps, exceptingWindows: [])
            fputs("Capturing all system audio\n", stderr)
        }

        // Configure stream (audio only)
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        // Minimize video capture (required by API but we ignore it)
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps minimum

        handler = AudioCaptureHandler(outputDir: outputDir, chunkDuration: chunkSeconds)
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(handler!, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))

        captureStream = stream
        try await stream.startCapture()
        fputs("READY\n", stdout)
        fflush(stdout)

    } catch {
        fputs("Error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

// Keep the process alive
dispatchMain()

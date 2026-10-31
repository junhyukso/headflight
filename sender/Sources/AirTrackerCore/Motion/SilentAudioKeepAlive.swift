import AVFoundation
import Foundation

/// Plays digital silence to the default output. Measured on AirPods Pro under macOS 15.5:
/// gaps of about 160 ms in the motion stream fall from 6 per 1,000 samples without audio to
/// about 1 per 2,000 with it. The engine stops itself on route changes, so it is restarted then.
public final class SilentAudioKeepAlive: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let source = AVAudioSourceNode { _, _, _, bufferList in
        for buffer in UnsafeMutableAudioBufferListPointer(bufferList) {
            if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
        }
        return noErr
    }
    private var observer: NSObjectProtocol?

    public init() {
        engine.attach(source)
    }

    public func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            self?.run()
        }
        run()
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine.stop()
    }

    private func run() {
        engine.stop()
        engine.connect(source, to: engine.mainMixerNode, format: nil)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            FileHandle.standardError.write(Data("warning: silent keep-alive failed: \(error)\n".utf8))
        }
    }
}

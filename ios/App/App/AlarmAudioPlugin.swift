import Foundation
import Capacitor
import AVFoundation

/**
 * AlarmAudioPlugin — Keeps the foreground/background Anchor Watch tone alive.
 *
 * `.playback` audio is not silenced by the Ring/Silent switch and the app declares
 * the audio background mode. Actual audibility still depends on the selected
 * output route, system volume, Focus settings, and iOS allowing the app to run.
 * This is ordinary app audio, not a Critical Alert; the pre-arm sound check and
 * time-sensitive local notifications remain independent safety layers.
 */
@objc(AlarmAudioPlugin)
public class AlarmAudioPlugin: CAPPlugin, AVAudioPlayerDelegate {

    private struct SavedSessionConfiguration {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    private enum AlarmAudioError: LocalizedError {
        case playerCouldNotStart

        var errorDescription: String? {
            switch self {
            case .playerCouldNotStart:
                return "The alarm audio player could not start."
            }
        }
    }

    private var alarmPlayer: AVAudioPlayer?
    private var alarmRequested = false
    private var isPlaying = false
    private var interruptedWhileAlarmRequested = false
    private var savedSessionConfiguration: SavedSessionConfiguration?
    private var notificationTokens: [NSObjectProtocol] = []
    private var resumeRetryWorkItem: DispatchWorkItem?

    /**
     * One 1.5-second PCM loop: 880 Hz for 0.4 s, 1320 Hz for 0.4 s,
     * then 0.7 s of silence. AVAudioPlayer loops this single retained
     * resource continuously, so playback does not depend on a run-loop Timer.
     */
    private static let alarmWaveData: Data = {
        let sampleRate: UInt32 = 44_100
        let channelCount: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let loopFrameCount = Int(Double(sampleRate) * 1.5)
        let toneFrameCount = Int(Double(sampleRate) * 0.4)
        let fadeFrameCount = max(1, Int(Double(sampleRate) * 0.006))
        let dataByteCount = UInt32(loopFrameCount * Int(channelCount) * Int(bitsPerSample / 8))

        func appendUInt16(_ value: UInt16, to data: inout Data) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }

        func appendUInt32(_ value: UInt32, to data: inout Data) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }

        var wave = Data()
        wave.reserveCapacity(44 + Int(dataByteCount))
        wave.append(contentsOf: "RIFF".utf8)
        appendUInt32(36 + dataByteCount, to: &wave)
        wave.append(contentsOf: "WAVE".utf8)
        wave.append(contentsOf: "fmt ".utf8)
        appendUInt32(16, to: &wave)
        appendUInt16(1, to: &wave) // Linear PCM
        appendUInt16(channelCount, to: &wave)
        appendUInt32(sampleRate, to: &wave)
        appendUInt32(sampleRate * UInt32(channelCount) * UInt32(bitsPerSample / 8), to: &wave)
        appendUInt16(channelCount * (bitsPerSample / 8), to: &wave)
        appendUInt16(bitsPerSample, to: &wave)
        wave.append(contentsOf: "data".utf8)
        appendUInt32(dataByteCount, to: &wave)

        for frame in 0..<loopFrameCount {
            var amplitude: Float = 0
            if frame < toneFrameCount * 2 {
                let frameWithinTone = frame % toneFrameCount
                let frequency: Float = frame < toneFrameCount ? 880 : 1_320
                let phase = 2 * Float.pi * frequency * Float(frameWithinTone) / Float(sampleRate)
                let attack = min(1, Float(frameWithinTone) / Float(fadeFrameCount))
                let release = min(1, Float(toneFrameCount - 1 - frameWithinTone) / Float(fadeFrameCount))
                amplitude = sin(phase) * 0.85 * max(0, min(attack, release))
            }
            var sample = Int16((amplitude * Float(Int16.max)).rounded()).littleEndian
            withUnsafeBytes(of: &sample) { wave.append(contentsOf: $0) }
        }

        return wave
    }()

    public override func load() {
        let center = NotificationCenter.default
        notificationTokens.append(
            center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                self?.handleAudioSessionInterruption(notification)
            }
        )
        notificationTokens.append(
            center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.handleMediaServicesReset()
            }
        )
    }

    deinit {
        resumeRetryWorkItem?.cancel()
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: - Start Alarm

    @objc func startAlarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            if self.alarmRequested {
                if self.isPlaying {
                    call.resolve(["playing": true])
                    return
                }

                do {
                    // A bridge call needs a definitive answer. Do not enqueue a
                    // background retry and then reject while that retry can
                    // later resurrect playback behind JavaScript's back.
                    try self.resumeAlarmImmediately(reason: "explicit start retry")
                    call.resolve(["playing": true])
                } catch {
                    self.cancelRequestedAlarmAndRestoreSession()
                    print("[AlarmAudio] Explicit resume failed: \(error)")
                    call.reject("Alarm audio is active but could not resume playback.")
                }
                return
            }

            do {
                self.resumeRetryWorkItem?.cancel()
                self.resumeRetryWorkItem = nil
                try self.configureAndActivateAudioSession(capturePreviousConfiguration: true)
                try self.startLoopingAlarmPlayer()
                self.alarmRequested = true
                self.isPlaying = true

                call.resolve(["playing": true])
                print("[AlarmAudio] Continuous alarm playback started")
            } catch {
                self.cancelRequestedAlarmAndRestoreSession()
                print("[AlarmAudio] Failed to start alarm: \(error)")
                call.reject("Failed to start alarm audio: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Stop Alarm

    @objc func stopAlarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            self.cancelRequestedAlarmAndRestoreSession()

            call.resolve(["stopped": true])
            print("[AlarmAudio] Alarm stopped")
        }
    }

    // MARK: - Check Status

    @objc func isAlarmPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            call.resolve(["playing": self.alarmRequested && self.isPlaying])
        }
    }

    // MARK: - Continuous Playback

    private func startLoopingAlarmPlayer() throws {
        stopLoopingAlarmPlayer()
        let player = try AVAudioPlayer(data: Self.alarmWaveData)
        player.delegate = self
        player.numberOfLoops = -1
        player.volume = 1
        guard player.prepareToPlay() else {
            throw AlarmAudioError.playerCouldNotStart
        }
        alarmPlayer = player
        guard player.play() else {
            alarmPlayer = nil
            throw AlarmAudioError.playerCouldNotStart
        }
    }

    private func stopLoopingAlarmPlayer() {
        alarmPlayer?.stop()
        alarmPlayer?.delegate = nil
        alarmPlayer = nil
    }

    private func configureAndActivateAudioSession(capturePreviousConfiguration: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        if capturePreviousConfiguration && savedSessionConfiguration == nil {
            savedSessionConfiguration = SavedSessionConfiguration(
                category: session.category,
                mode: session.mode,
                options: session.categoryOptions
            )
        }
        try session.setCategory(.playback, mode: .default, options: [.duckOthers])
        try session.setActive(true)
    }

    private func handleAudioSessionInterruption(_ notification: Notification) {
        guard
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else {
            return
        }

        switch type {
        case .began:
            guard alarmRequested else { return }
            interruptedWhileAlarmRequested = true
            isPlaying = false
            alarmPlayer?.pause()
            print("[AlarmAudio] Playback interrupted by iOS")

        case .ended:
            guard alarmRequested && interruptedWhileAlarmRequested else { return }
            interruptedWhileAlarmRequested = false
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            if !options.contains(.shouldResume) {
                // Anchor Watch remains explicitly armed until the skipper stops it,
                // so an ended phone/Siri interruption does not silently disarm audio.
                print("[AlarmAudio] Interruption ended without a resume hint; retrying active safety audio")
            }
            resumeAlarmAfterSystemEvent(reason: "interruption")

        @unknown default:
            break
        }
    }

    private func handleMediaServicesReset() {
        guard alarmRequested else { return }
        isPlaying = false
        stopLoopingAlarmPlayer()
        resumeAlarmAfterSystemEvent(reason: "media-services reset")
    }

    private func resumeAlarmAfterSystemEvent(reason: String, retryDelay: TimeInterval = 1) {
        resumeRetryWorkItem?.cancel()
        resumeRetryWorkItem = nil
        guard alarmRequested else { return }

        do {
            try resumeAlarmImmediately(reason: reason)
        } catch {
            isPlaying = false
            print("[AlarmAudio] Resume after \(reason) failed: \(error)")
            // A retained owner lease still requests safety audio. Keep a
            // single bounded-backoff recovery task alive until playback comes
            // back or explicit stop cancels it; never silently diverge native
            // requested state from JavaScript's live lease.
            let nextDelay = min(30, retryDelay * 2)
            let workItem = DispatchWorkItem { [weak self] in
                guard let self = self, self.alarmRequested, !self.isPlaying else { return }
                self.resumeRetryWorkItem = nil
                self.resumeAlarmAfterSystemEvent(
                    reason: reason,
                    retryDelay: nextDelay
                )
            }
            resumeRetryWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay, execute: workItem)
        }
    }

    private func resumeAlarmImmediately(reason: String) throws {
        resumeRetryWorkItem?.cancel()
        resumeRetryWorkItem = nil
        try configureAndActivateAudioSession(capturePreviousConfiguration: false)
        try startLoopingAlarmPlayer()
        isPlaying = true
        print("[AlarmAudio] Alarm resumed after \(reason)")
    }

    private func cancelRequestedAlarmAndRestoreSession() {
        alarmRequested = false
        interruptedWhileAlarmRequested = false
        resumeRetryWorkItem?.cancel()
        resumeRetryWorkItem = nil
        stopLoopingAlarmPlayer()
        restoreAudioSession()
        isPlaying = false
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard player === alarmPlayer, alarmRequested else { return }
        isPlaying = false
        resumeAlarmAfterSystemEvent(reason: "unexpected player completion")
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard player === alarmPlayer, alarmRequested else { return }
        isPlaying = false
        print("[AlarmAudio] Decode error: \(error?.localizedDescription ?? "unknown error")")
        resumeAlarmAfterSystemEvent(reason: "decoder error")
    }

    private func restoreAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("[AlarmAudio] Failed to deactivate audio session: \(error)")
        }
        if let previous = savedSessionConfiguration {
            do {
                try session.setCategory(previous.category, mode: previous.mode, options: previous.options)
            } catch {
                print("[AlarmAudio] Failed to restore audio-session category: \(error)")
            }
        }
        savedSessionConfiguration = nil
    }
}

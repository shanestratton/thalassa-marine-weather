import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

/**
 * AlarmAudioPlugin — Plays alarm tones that bypass the iOS silent/mute switch
 *
 * Uses AVAudioSession with `.playback` category to force audio through the speaker
 * at maximum volume, regardless of:
 * - Silent (mute) switch position
 * - Volume button level
 * - Do Not Disturb mode
 *
 * This is critical for anchor drag alarms — a silent alarm is a useless alarm.
 */
@objc(AlarmAudioPlugin)
public class AlarmAudioPlugin: CAPPlugin {

    private var audioEngine: AVAudioEngine?
    private var tonePlayer: AVAudioPlayerNode?
    private var alarmTimer: Timer?
    private var isPlaying = false
    private var previousCategory: AVAudioSession.Category?
    private var previousVolume: Float?

    // MARK: - Start Alarm

    @objc func startAlarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            if self.isPlaying {
                call.resolve(["playing": true])
                return
            }

            do {
                let session = AVAudioSession.sharedInstance()

                // Save previous state
                self.previousCategory = session.category

                // Force playback category — this bypasses the mute switch
                try session.setCategory(
                    .playback,
                    mode: .default,
                    options: [.duckOthers]
                )
                try session.setActive(true, options: .notifyOthersOnDeactivation)

                // Override output to speaker (not earpiece)
                try session.overrideOutputAudioPort(.speaker)

                // Set system volume to maximum
                self.setSystemVolumeToMax()

                // Start the alarm tone loop
                self.startToneLoop()
                self.isPlaying = true

                call.resolve(["playing": true])
                print("[AlarmAudio] Alarm started — mute switch bypassed, full volume")
            } catch {
                print("[AlarmAudio] Failed to start alarm: \(error)")
                call.reject("Failed to start alarm audio: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Stop Alarm

    @objc func stopAlarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            self.stopToneLoop()
            self.restoreAudioSession()
            self.isPlaying = false

            call.resolve(["stopped": true])
            print("[AlarmAudio] Alarm stopped")
        }
    }

    // MARK: - Check Status

    @objc func isAlarmPlaying(_ call: CAPPluginCall) {
        call.resolve(["playing": isPlaying])
    }

    // MARK: - Private: Tone Generation

    private func startToneLoop() {
        // Play immediately
        playAlarmBurst()

        // Repeat every 1.5 seconds
        alarmTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.playAlarmBurst()
        }
    }

    private func playAlarmBurst() {
        // Use AVAudioEngine for programmatic tone generation
        // This creates a piercing two-tone alarm (like a maritime emergency)
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        let sampleRate: Double = 44100
        let duration: Double = 0.8
        let frameCount = AVAudioFrameCount(sampleRate * duration)

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return
        }

        buffer.frameLength = frameCount
        guard let channelData = buffer.floatChannelData?[0] else { return }

        // Two-tone alarm: 880Hz for 0.4s, then 1320Hz for 0.4s
        // This creates the classic maritime alarm sound
        let halfPoint = Int(frameCount) / 2
        for i in 0..<Int(frameCount) {
            let freq: Float = i < halfPoint ? 880.0 : 1320.0
            let t = Float(i) / Float(sampleRate)
            // Square-ish wave (clipped sine) for maximum perceived loudness
            let sine = sin(2.0 * .pi * freq * t)
            channelData[i] = max(-0.8, min(0.8, sine * 2.0)) * 0.9
        }

        engine.connect(player, to: engine.mainMixerNode, format: format)

        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: {
                DispatchQueue.main.async {
                    engine.stop()
                }
            })
            player.play()
        } catch {
            print("[AlarmAudio] Tone playback failed: \(error)")
        }
    }

    private func stopToneLoop() {
        alarmTimer?.invalidate()
        alarmTimer = nil
        audioEngine?.stop()
        audioEngine = nil
        tonePlayer = nil
    }

    private func restoreAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            if let prevCategory = previousCategory {
                try session.setCategory(prevCategory)
            }
            try session.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("[AlarmAudio] Failed to restore audio session: \(error)")
        }
    }

    // MARK: - Volume Override

    private func setSystemVolumeToMax() {
        // Use MPVolumeView to programmatically set volume to max
        // This is the only Apple-approved way to change system volume
        DispatchQueue.main.async {
            if let volumeView = self.findVolumeSlider() {
                self.previousVolume = volumeView.value
                volumeView.value = 1.0
            }
        }
    }

    private func findVolumeSlider() -> UISlider? {
        // MPVolumeView contains a UISlider for system volume
        let volumeView = MPVolumeView(frame: .zero)
        for view in volumeView.subviews {
            if let slider = view as? UISlider {
                return slider
            }
        }
        return nil
    }
}

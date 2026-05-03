/**
 * AppleMusicPlugin — TTS playback bridge for Calypso.
 *
 * Reduced 2026-05-04: MusicKit refactor (catalog search, library
 * playlists, ApplicationMusicPlayer transport) was reverted by the
 * skipper after Swift compile errors with `ApplicationMusicPlayer.Queue`
 * initialiser signatures. We're stripping all music surfaces here and
 * keeping ONLY the TTS playback path — that's what makes Calypso
 * sound right (native AVAudioPlayer in our app's `.playback +
 * .mixWithOthers` session, bypassing WKWebView's HTML5 Audio black box).
 *
 * Plugin name `AppleMusic` retained so existing Capacitor registration
 * (`bridge.registerPluginInstance(AppleMusicPlugin())` in
 * ThalassaBridgeViewController) and the JS side
 * (`Capacitor.Plugins.AppleMusic.playTtsAudio` in ttsClient.ts)
 * continue to resolve without reshuffling. We can rename later if we
 * want to be tidy.
 *
 * Surfaces:
 *   - playTtsAudio(audio_b64) — plays MP3 via AVAudioPlayer
 *   - cancelTtsAudio          — stops mid-playback
 */

import Foundation
import Capacitor
import AVFoundation

@objc(AppleMusicPlugin)
public class AppleMusicPlugin: CAPPlugin {

    // ── TTS playback state ───────────────────────────────────────────
    private var ttsPlayer: AVAudioPlayer?
    private var ttsPlayerDelegate: TtsPlayerDelegate?

    // MARK: - TTS

    /**
     * Play a base64-encoded MP3 (typically Calypso's voice from
     * ElevenLabs) through native AVAudioPlayer. Routes through our
     * app's `.playback + .mixWithOthers` audio session set up at
     * launch in ThalassaBridgeViewController.capacitorDidLoad().
     *
     * Single-utterance: if a previous TTS clip is still playing when
     * this is called, the previous one is stopped first. The
     * CAPPluginCall resolves when the clip finishes naturally (or
     * errors out), so the JS side can `await` it.
     */
    @objc func playTtsAudio(_ call: CAPPluginCall) {
        guard let b64 = call.getString("audio_b64"), !b64.isEmpty else {
            call.reject("audio_b64 is required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Cancel any in-flight TTS — single utterance at a time.
            if let prev = self.ttsPlayer {
                prev.stop()
                self.ttsPlayer = nil
            }
            self.ttsPlayerDelegate = nil

            guard let data = Data(base64Encoded: b64) else {
                call.reject("invalid base64 audio")
                return
            }

            do {
                let player = try AVAudioPlayer(data: data)
                player.volume = 1.0
                let delegate = TtsPlayerDelegate { [weak self] in
                    NSLog("[AppleMusic] playTtsAudio: playback finished")
                    DispatchQueue.main.async {
                        self?.ttsPlayer = nil
                        self?.ttsPlayerDelegate = nil
                        call.resolve(["status": "finished"])
                    }
                }
                player.delegate = delegate
                self.ttsPlayerDelegate = delegate
                self.ttsPlayer = player
                if !player.play() {
                    call.reject("AVAudioPlayer.play() returned false")
                    self.ttsPlayer = nil
                    self.ttsPlayerDelegate = nil
                    return
                }
                NSLog("[AppleMusic] playTtsAudio: started (\(data.count)B, \(String(format: "%.1f", player.duration))s)")
            } catch {
                NSLog("[AppleMusic] playTtsAudio: AVAudioPlayer init failed: \(error)")
                call.reject("AVAudioPlayer init failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func cancelTtsAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.ttsPlayer?.stop()
            self?.ttsPlayer = nil
            self?.ttsPlayerDelegate = nil
            call.resolve(["status": "cancelled"])
        }
    }
}

/**
 * AVAudioPlayerDelegate that fires a closure when playback finishes
 * (or errors out). Used by playTtsAudio to resolve its CAPPluginCall
 * at the right moment.
 */
private final class TtsPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish()
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        NSLog("[AppleMusic] TtsPlayer decode error: \(String(describing: error))")
        onFinish()
    }
}

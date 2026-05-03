import UIKit
import Capacitor
import AVFoundation

/**
 * ThalassaBridgeViewController — the app's CAPBridgeViewController subclass,
 * used as the root view controller in Main.storyboard.
 *
 * Why this file exists
 * ────────────────────
 * Capacitor's iOS CLI (`npx cap sync ios`) auto-populates the
 * `packageClassList` in capacitor.config.json by scanning installed npm
 * plugin packages for `@objc(...)` / `CAP_PLUGIN(...)` declarations.
 *
 * Our app-local Swift plugins (living in ios/App/App/) aren't
 * npm packages — they're part of the app target itself. The CLI has no
 * way to discover them, so they never get added to packageClassList,
 * and Capacitor's auto-registration never asks the Obj-C runtime for
 * them. Result: every call from JS to an app-local plugin returns
 * Capacitor's generic "plugin is not implemented on ios" error.
 *
 * All sorts of things were confirmed before landing on this:
 *   - The .m files ARE compiled (+load NSLog fires)
 *   - The Swift classes ARE linked (@objc(X) registers them with Obj-C)
 *   - CAP_PLUGIN category IS added to the class
 *   - -ObjC is set on the Debug linker flags
 * …but none of that matters if Capacitor doesn't ASK for the class.
 *
 * Fix: override `capacitorDidLoad()` (called after the bridge is
 * initialized, before the web view loads) and register each app-local
 * plugin instance manually via `bridge.registerPluginInstance(...)`.
 * This is Capacitor's documented escape hatch for local plugins.
 *
 * If you add a new Swift Capacitor plugin in ios/App/App/,
 * instantiate it here.
 */
public class ThalassaBridgeViewController: CAPBridgeViewController {

    public override func capacitorDidLoad() {
        // ── Audio session: coexist with system music player ─────────
        // When Calypso speaks while Apple Music is playing through
        // MPMusicPlayerController.systemMusicPlayer, we want her TTS
        // to DUCK the music (lower it briefly) rather than INTERRUPT
        // it. By default WKWebView's audio session category interrupts
        // other apps' audio when our app plays sound — which is why
        // calling play_music + Calypso narrating "playing 8 tracks"
        // killed the music after a tiny intro. Setting `.playback`
        // with `.mixWithOthers + .duckOthers` lets Calypso's TTS play
        // alongside the music, lowering the music briefly while she
        // speaks; music returns to full volume after.
        //
        // AlarmAudioPlugin still saves + restores the previous category
        // for full-volume mute-bypassed alarm tones, so this baseline
        // doesn't break anchor watch behaviour.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
            try session.setActive(true, options: [])
            print("[Audio] Session configured: .playback + .mixWithOthers + .duckOthers")
        } catch {
            print("[Audio] Failed to configure audio session at launch: \(error)")
        }

        // ── Register all app-local Swift plugins ────────────────────
        // Each needs to match the Swift `@objc(ClassName)` name and be
        // a fresh instance. Capacitor owns the lifecycle after this.
        bridge?.registerPluginInstance(WeatherKitPlugin())
        bridge?.registerPluginInstance(AlarmAudioPlugin())
        bridge?.registerPluginInstance(BackgroundLocationPlugin())
        bridge?.registerPluginInstance(DataScannerPlugin())
        bridge?.registerPluginInstance(LightningPlugin())
        bridge?.registerPluginInstance(AppleMusicPlugin())
        // SshClientPlugin + WatchConnectivityPlugin not added yet:
        // their .swift/.m files exist on disk but aren't in the
        // pbxproj build graph yet (separate fix).
    }
}

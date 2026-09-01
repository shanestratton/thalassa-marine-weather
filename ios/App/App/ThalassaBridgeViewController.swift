import UIKit
import Capacitor
import AVFoundation

// BUILD-MARKER 2026-05-15T22:55Z — touching this comment forces Xcode
// to recompile the Swift target, which forces a re-link and a fresh
// Resources copy phase (including the JS bundle in public/). Without
// this, incremental builds were silently skipping the public/ copy
// and the device kept running stale JS chunks. See related fix in
// public/sw.js + index.tsx (Service Worker bypass on native).

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
        // ⚠️ BUILD-MARKER — unmissable native-side proof of WHICH .app
        // bundle is actually running. If you don't see this line in the
        // Xcode console at launch, the device is running an older .app
        // than the one Xcode just built (i.e. Xcode reported success but
        // didn't actually push).
        //
        // DERIVED, never hand-written (2026-08-07). This used to be a
        // hardcoded timestamp with a comment asking whoever built to update
        // it. Nobody did — it read 2026-05-15 for months, so the one line
        // whose entire job is proving freshness was itself the stalest thing
        // on screen, and it made every fresh build look stale.
        //
        // TIMESTAMP SOURCE: the .app BUNDLE, not the executable. The
        // executable's mtime only moves when Swift actually relinks — so a
        // `cap sync` that swapped the whole web bundle, with no native change,
        // left the marker reading an older build and made a genuinely fresh
        // app look stale. That is what "the times are not correct most of the
        // time" was. The bundle directory's mtime moves whenever ANY resource
        // is copied in, web assets included, which is what the skipper
        // actually wants to know.
        //
        // Local time, no UTC offset: this is read by a human standing next to
        // the machine that built it, and "+10:00" is noise on that line.
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        // NEWEST of several in-bundle files, ignoring epoch-0.
        //
        // No single file is reliable. The .app DIRECTORY reports 1970-01-01 on
        // device — iOS does not preserve it through install, which is what
        // produced "built 1970-01-01 10:00:00". The EXECUTABLE only moves when
        // Swift relinks, so a `cap sync` that replaced the whole web bundle
        // left it reading an older build. Taking the latest of the executable,
        // Info.plist and the web bundle's index.html covers native-only,
        // resource-only and mixed rebuilds alike, and the epoch guard means a
        // meaningless zero can never win.
        var newest: Date?
        var candidatePaths: [String] = [Bundle.main.bundlePath + "/Info.plist"]
        if let executable = Bundle.main.executableURL { candidatePaths.append(executable.path) }
        if let webIndex = Bundle.main.url(forResource: "public/index", withExtension: "html") {
            candidatePaths.append(webIndex.path)
        }
        for path in candidatePaths {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                  let modified = attributes[.modificationDate] as? Date,
                  modified.timeIntervalSince1970 > 1 else { continue }
            if newest == nil || modified > newest! { newest = modified }
        }

        var builtAt = "unknown"
        if let modified = newest {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
            formatter.timeZone = TimeZone.current
            formatter.locale = Locale(identifier: "en_US_POSIX")
            builtAt = formatter.string(from: modified)
        }
        NSLog("[BUILD-MARKER-SWIFT] thalassa v\(version) build \(build) — built \(builtAt) — capacitorDidLoad")

        // ── Audio session: input-capable, but inactive, at launch ──
        // The diary and Bosun both capture through WKWebView's
        // getUserMedia path. Leaving the shared session in .playback makes
        // that capture unreliable on iOS: a recorder can appear to start
        // while the input route is unavailable, producing an empty memo and
        // no live dictation. Keep the app input-capable from launch, without
        // activating the session or taking ownership of the microphone.
        // CRITICAL: do NOT call setActive(true) here. Eager activation
        // was found to block the system music player from taking the
        // audio output — confirmed by the skipper noting that pressing
        // play in iOS Control Center worked when our programmatic
        // play() call didn't. Holding the session active stops other
        // apps from playing.
        //
        // Each playback path that NEEDS the session active will
        // activate it explicitly (HTML5 Audio in WKWebView does this
        // automatically; AlarmAudioPlugin does it manually for alarm
        // tones).
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP]
            )
            print("[Audio] Session category configured: .playAndRecord + speaker/Bluetooth (NOT activated)")
        } catch {
            print("[Audio] Failed to set audio session category at launch: \(error)")
        }

        // ── Register all app-local Swift plugins ────────────────────
        // Each needs to match the Swift `@objc(ClassName)` name and be
        // a fresh instance. Capacitor owns the lifecycle after this.
        bridge?.registerPluginInstance(WeatherKitPlugin())
        bridge?.registerPluginInstance(AlarmAudioPlugin())
        bridge?.registerPluginInstance(BackgroundLocationPlugin())
        bridge?.registerPluginInstance(DataScannerPlugin())
        bridge?.registerPluginInstance(LightningPlugin())
        bridge?.registerPluginInstance(MdnsBrowserPlugin())
        bridge?.registerPluginInstance(WatchConnectivityPlugin())
        bridge?.registerPluginInstance(AppleMusicPlugin())
        bridge?.registerPluginInstance(AppleCredentialStatePlugin())
        bridge?.registerPluginInstance(GoogleOAuthPlugin())
        bridge?.registerPluginInstance(SecureStoragePlugin())
        bridge?.registerPluginInstance(AnchorWatchStoragePlugin())
        bridge?.registerPluginInstance(EncryptedLargeStoragePlugin())
        bridge?.registerPluginInstance(AnchorSafetyNotificationPlugin())
        bridge?.registerPluginInstance(PiTlsPlugin())
        bridge?.registerPluginInstance(BarometerPlugin())
        bridge?.registerPluginInstance(MemoryGaugePlugin())
        bridge?.registerPluginInstance(NetworkInterfacesPlugin())
        // SshClientPlugin not added yet: its .swift/.m files exist on
        // disk but aren't in the pbxproj build graph yet (separate fix).
    }
}

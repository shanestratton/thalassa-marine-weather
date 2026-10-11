// Separate research application. No production plugins or target.
import UIKit
import Capacitor

final class ResearchBridgeViewController: CAPBridgeViewController {
    // One stable plugin/host for the same owned window and every native callback.
    private let authPlugin = ScuttlebuttResearchAuthPlugin()
    @MainActor var onScenePresentationClosed: (() -> Void)? {
        get { authPlugin.onScenePresentationClosed }
        set { authPlugin.onScenePresentationClosed = newValue }
    }
    @MainActor func suspendSceneAuthority() { authPlugin.suspendSceneAuthority() }
    @MainActor func sceneBecameActive() -> Bool { authPlugin.sceneBecameActive() }
    func sceneAuthorityDescriptor() -> ResearchSceneAuthority.Descriptor { authPlugin.nativeSceneDescriptor() }
#if E2EE_LOCAL_UI_FIXTURE
    private var localUiFixtureReady = false
#endif
    override func capacitorDidLoad() {
#if E2EE_FULL_APP_PROTECTED_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("bridge-created")
        guard let bridge, let webView else {
            ResearchLocalUiFixture.notePhase("fixture-install-failed")
            return
        }
        do {
            let httpFence = try ResearchFullAppProtectedHttpFence.install(on: bridge)
            bridge.registerPluginInstance(authPlugin)
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
            try ResearchFullAppSceneUiFixture.install(in: webView)
#endif
            try ResearchFullAppProtectedUiFixture.install(in: webView, httpFence: httpFence)
            localUiFixtureReady = true
            ResearchLocalUiFixture.notePhase("fixture-installed")
        } catch { ResearchLocalUiFixture.notePhase("fixture-install-failed") }
#elseif E2EE_FULL_APP_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("bridge-created")
        guard let bridge, let webView else {
            ResearchLocalUiFixture.notePhase("fixture-install-failed")
            return
        }
        do {
            // Replace both cached native HTTP routes before the first document.
            // A failed fixture never falls through to the ordinary loader.
            let httpFence = try ResearchFullAppHttpFence.install(on: bridge)
            bridge.registerPluginInstance(authPlugin)
            try ResearchLocalUiFixture.install(in: webView, fullAppHttpFence: httpFence)
            localUiFixtureReady = true
            ResearchLocalUiFixture.notePhase("fixture-installed")
        } catch { ResearchLocalUiFixture.notePhase("fixture-install-failed") }
#else
        bridge?.registerPluginInstance(authPlugin)
#if E2EE_LOCAL_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("bridge-created")
        if let webView {
            do {
                // Capacitor's real content controller now exists, but its first
                // document has not loaded. The shim precedes every app module.
                try ResearchLocalUiFixture.install(in: webView)
                localUiFixtureReady = true
                ResearchLocalUiFixture.notePhase("fixture-installed")
            } catch { ResearchLocalUiFixture.notePhase("fixture-install-failed") }
        }
#endif
#endif
    }
#if E2EE_LOCAL_UI_FIXTURE
    override func viewDidLoad() {
        guard localUiFixtureReady else {
            // Never fall through to real SDK/network when fixture setup fails.
            webView?.loadHTMLString("<!doctype html><html><body><p>Local Research UI fixture unavailable.</p></body></html>",
                baseURL: nil)
            return
        }
        super.viewDidLoad()
    }
#endif
}

@main
final class ResearchApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        do { try ResearchFullAppSceneUiFixture.startApplication() }
        catch { ResearchLocalUiFixture.notePhase("fixture-install-failed"); return false }
#endif
#if E2EE_LOCAL_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("application-launched")
#endif
        return true
    }

#if E2EE_FULL_APP_SCENE_UI_FIXTURE
    func applicationWillTerminate(_ application: UIApplication) {
        ResearchFullAppSceneUiFixture.observeTermination()
    }
#endif

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Research Window",
            sessionRole: connectingSceneSession.role)
        configuration.sceneClass = UIWindowScene.self
        configuration.delegateClass = ResearchSceneDelegate.self
        return configuration
    }
}

// UIKit 27 requires scene-based launch. Use one scene for the same isolated
// bridge; this does not create a second Auth host or change any saved identity.
@objc(ResearchSceneDelegate)
final class ResearchSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var privacyCover: UIView?
    private weak var coveredContentView: UIView?
    private var coveredContentWasHidden: Bool?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        // Ignore noninteractive external-display sessions: only the main app
        // window may create the bridge and its isolated Auth host.
        guard session.role == .windowApplication,
              let windowScene = scene as? UIWindowScene else { return }
#if E2EE_LOCAL_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("scene-connected")
#endif
        let window = UIWindow(windowScene: windowScene)
        let controller = ResearchBridgeViewController()
        controller.onScenePresentationClosed = { [weak self, weak scene] in
            guard let self else { return }
            self.hidePrivacyCover()
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
            if let scene { ResearchFullAppSceneUiFixture.presentationClosed(scene: scene, delegate: self) }
#endif
        }
        window.rootViewController = controller
        self.window = window
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        do { try ResearchFullAppSceneUiFixture.attachScene(scene, delegate: self) }
        catch { ResearchLocalUiFixture.notePhase("fixture-install-failed"); return }
#endif
        window.makeKeyAndVisible()
    }

    // Synchronous UIKit presentation fence. Do not wait for WKWebView's
    // visibility event before covering an inactive scene's sensitive content.
    func sceneWillResignActive(_ scene: UIScene) {
        showPrivacyCover()
        (window?.rootViewController as? ResearchBridgeViewController)?.suspendSceneAuthority()
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        ResearchFullAppSceneUiFixture.observe(.willResignActive, scene: scene, delegate: self)
#endif
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        showPrivacyCover()
        (window?.rootViewController as? ResearchBridgeViewController)?.suspendSceneAuthority()
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        ResearchFullAppSceneUiFixture.observe(.didEnterBackground, scene: scene, delegate: self)
#endif
    }

#if E2EE_FULL_APP_SCENE_UI_FIXTURE
    func sceneWillEnterForeground(_ scene: UIScene) {
        ResearchFullAppSceneUiFixture.observe(.willEnterForeground, scene: scene, delegate: self)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        ResearchFullAppSceneUiFixture.observe(.sceneDisconnected, scene: scene, delegate: self)
    }

    func sceneLifecycleCoverFacts() -> ResearchSceneLifecycleEvidence.CoverFacts {
        guard let window else { return .absent }
        let cover = privacyCover
        return .init(present: cover != nil && cover?.isHidden == false,
            opaque: cover?.isOpaque == true && cover?.alpha == 1 && cover?.backgroundColor?.cgColor.alpha == 1,
            attachedToOwnedWindow: cover?.superview === window,
            coversOwnedWindowBounds: cover?.frame == window.bounds,
            accessibilityModal: cover?.accessibilityViewIsModal == true,
            contentAccessibilityHidden: window.rootViewController?.viewIfLoaded?.accessibilityElementsHidden == true)
    }
#endif

    func sceneDidBecomeActive(_ scene: UIScene) {
        // First startup may be eligible. A real inactive epoch remains covered
        // until same-WK actual closed-DOM acknowledgement succeeds natively.
        if (window?.rootViewController as? ResearchBridgeViewController)?.sceneBecameActive() == true {
            hidePrivacyCover()
        }
#if E2EE_FULL_APP_SCENE_UI_FIXTURE
        ResearchFullAppSceneUiFixture.observe(.didBecomeActive, scene: scene, delegate: self)
#endif
    }

    private func showPrivacyCover() {
        guard let window else { return }
        window.endEditing(true)
        if coveredContentView == nil, let content = window.rootViewController?.viewIfLoaded {
            coveredContentWasHidden = content.accessibilityElementsHidden
            coveredContentView = content
            content.accessibilityElementsHidden = true
        }
        let cover: UIView
        if let existing = privacyCover {
            cover = existing
            cover.frame = window.bounds
        } else {
            cover = UIView(frame: window.bounds)
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            cover.backgroundColor = UIColor(white: 0.07, alpha: 1)
            cover.isOpaque = true
            cover.isUserInteractionEnabled = true
            cover.isAccessibilityElement = true
            cover.accessibilityLabel = "Private message test hidden"
            cover.accessibilityTraits = .staticText
            cover.accessibilityViewIsModal = true
            privacyCover = cover
        }
        if cover.superview !== window { window.addSubview(cover) }
        window.bringSubviewToFront(cover)
        window.layoutIfNeeded()
    }

    private func hidePrivacyCover() {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
        if let previous = coveredContentWasHidden {
            coveredContentView?.accessibilityElementsHidden = previous
        }
        coveredContentView = nil
        coveredContentWasHidden = nil
    }
}

// Separate research application. No production plugins or target.
import UIKit
import Capacitor

final class ResearchBridgeViewController: CAPBridgeViewController {
#if E2EE_LOCAL_UI_FIXTURE
    private var localUiFixtureReady = false
#endif
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScuttlebuttResearchAuthPlugin())
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
#if E2EE_LOCAL_UI_FIXTURE
        ResearchLocalUiFixture.notePhase("application-launched")
#endif
        return true
    }

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
        window.rootViewController = ResearchBridgeViewController()
        self.window = window
        window.makeKeyAndVisible()
    }

    // Synchronous UIKit presentation fence. Do not wait for WKWebView's
    // visibility event before covering an inactive scene's sensitive content.
    func sceneWillResignActive(_ scene: UIScene) {
        showPrivacyCover()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        showPrivacyCover()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        hidePrivacyCover()
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

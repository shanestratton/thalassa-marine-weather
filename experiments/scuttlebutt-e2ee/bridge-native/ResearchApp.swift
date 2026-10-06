// Separate research application. No production plugins or target.
import UIKit
import Capacitor

final class ResearchBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScuttlebuttResearchAuthPlugin())
    }
}

@main
final class ResearchApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
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

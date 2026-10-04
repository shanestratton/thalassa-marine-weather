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
}

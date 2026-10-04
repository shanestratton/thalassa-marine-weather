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
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ResearchBridgeViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

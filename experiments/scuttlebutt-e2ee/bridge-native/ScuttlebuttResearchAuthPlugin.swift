// AUTH-ONLY isolated app bridge. This is NOT PrivateMessageNativePort and
// never exposes native keys, stores, pickles, coordinator handles or tokens.
import Foundation
import Capacitor

@objc(ScuttlebuttResearchAuthPlugin)
public final class ScuttlebuttResearchAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScuttlebuttResearchAuthPlugin"
    public let jsName = "ScuttlebuttResearchAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configuration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fenceSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentAccount", returnType: CAPPluginReturnPromise),
    ]
    private let hostLock = NSLock()
    private var host: ResearchAuthHost?
    private var trusted: ResearchAuthConfiguration?
    private static let unavailable: [String: Any] = ["status": "unavailable", "reason": "unavailable"]

    public override func load() {
        trusted = try? ResearchAuthConfiguration.bundled()
    }

    private func facade() throws -> VodozemacSessionFacade {
        hostLock.lock(); defer { hostLock.unlock() }
        guard let configuration = trusted else { throw ResearchAuthHostError.unavailable }
        if let host { return host.facade }
        let opened = try ResearchAuthHost(configuration: configuration)
        host = opened
        return opened.facade
    }

    private func exactOptions(_ call: CAPPluginCall, _ names: Set<String>) -> Bool {
        Set(call.jsObjectRepresentation.keys) == names
    }

    @objc public func configuration(_ call: CAPPluginCall) {
        guard exactOptions(call, []), let configuration = trusted else {
            call.resolve(Self.unavailable); return
        }
        call.resolve(["status": "configured", "research": true,
            "label": "Encryption test—not reviewed", "supabaseUrl": ResearchAuthConfiguration.origin,
            "publicApiKey": configuration.publicApiKey])
    }

    @objc public func fenceSession(_ call: CAPPluginCall) {
        guard exactOptions(call, ["mode"]), let mode = call.getString("mode"),
              mode == "verify" || mode == "sign_out" else { call.resolve(Self.unavailable); return }
        do {
            // Durable native fence completes before the SDK is allowed to get a
            // token. No lock remains held across the later authentication await.
            let fence = try facade().fenceSession(mode: mode == "verify" ? .verify : .signOut)
            call.resolve(["status": "fenced", "authFence": fence.authFence])
        } catch { call.resolve(Self.unavailable) }
    }

    @objc public func authenticate(_ call: CAPPluginCall) {
        guard exactOptions(call, ["accessToken", "authFence"]),
              let bearer = call.getString("accessToken"), (1...8192).contains(bearer.utf8.count),
              let fence = call.getString("authFence"), fence.count == 36,
              UUID(uuidString: fence)?.uuidString.lowercased() == fence,
              let facade = try? facade() else { call.resolve(Self.unavailable); return }
        Task {
            do {
                let account = try await facade.authenticate(accessToken: bearer, authFence: fence)
                call.resolve(Self.result(account))
            } catch { call.resolve(Self.unavailable) }
        }
    }

    @objc public func currentAccount(_ call: CAPPluginCall) {
        guard exactOptions(call, []), let facade = try? facade(), let account = facade.currentAccount() else {
            call.resolve(Self.unavailable); return
        }
        call.resolve(Self.result(account))
    }

    private static func result(_ account: DmSessionAccount) -> [String: Any] {
        ["status": "authenticated", "account": ["accountId": account.accountId,
            "deviceId": account.deviceId, "credentialBinding": account.credentialBinding,
            "serverVerified": account.serverVerified]]
    }
}

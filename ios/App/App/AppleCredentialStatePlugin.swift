import AuthenticationServices
import Capacitor
import Foundation
import Security

/**
 * Native Sign in with Apple credential-state monitor.
 *
 * Apple does not deliver every account-deletion case as a live notification,
 * so this plugin combines ASAuthorizationAppleIDProvider's revoked-credential
 * notification with a cold-start getCredentialState check. The opaque Apple
 * user ID is retained in this-device-only Keychain storage; no token or Apple
 * developer credential is stored on the device.
 */
@objc(AppleCredentialStatePlugin)
public class AppleCredentialStatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleCredentialStatePlugin"
    public let jsName = "AppleCredentialState"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "bindCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkCredentialState", returnType: CAPPluginReturnPromise)
    ]

    private let provider = ASAuthorizationAppleIDProvider()
    private let keychainAccount = "sign-in-with-apple-user-id"
    private var revokedObserver: NSObjectProtocol?

    public override func load() {
        revokedObserver = NotificationCenter.default.addObserver(
            forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.checkPersistedCredential(reason: "credential_revoked_notification", emitRevoked: true)
        }

        // Apple documents that permanent Apple Account deletion may not emit
        // the live notification. Reconcile the Keychain-bound identity at
        // every cold bridge start and retain the event until JavaScript binds.
        checkPersistedCredential(reason: "cold_start", emitRevoked: true)
    }

    deinit {
        if let revokedObserver {
            NotificationCenter.default.removeObserver(revokedObserver)
        }
    }

    @objc func bindCredential(_ call: CAPPluginCall) {
        guard let userID = call.getString("userId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !userID.isEmpty,
              userID.utf8.count <= 1024,
              !userID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            call.reject("A valid Apple user identifier is required")
            return
        }

        do {
            try saveUserID(userID)
        } catch {
            call.reject("Could not secure the Apple credential binding")
            return
        }

        checkCredentialState(userID: userID, reason: "sign_in", emitRevoked: true) { state, error in
            if let error {
                call.reject("Could not verify the Apple credential state", nil, error)
                return
            }
            guard state == "authorized" else {
                call.reject("Apple credential is not authorized")
                return
            }
            call.resolve(["state": state])
        }
    }

    @objc func clearCredential(_ call: CAPPluginCall) {
        do {
            try deleteUserID()
            call.resolve()
        } catch {
            call.reject("Could not clear the Apple credential binding")
        }
    }

    @objc func checkCredentialState(_ call: CAPPluginCall) {
        guard let userID = readUserID() else {
            call.resolve(["state": "not_bound"])
            return
        }
        checkCredentialState(userID: userID, reason: "explicit_check", emitRevoked: true) { state, error in
            if let error {
                call.reject("Could not verify the Apple credential state", nil, error)
                return
            }
            call.resolve(["state": state])
        }
    }

    private func checkPersistedCredential(reason: String, emitRevoked: Bool) {
        guard let userID = readUserID() else { return }
        checkCredentialState(userID: userID, reason: reason, emitRevoked: emitRevoked) { _, _ in }
    }

    private func checkCredentialState(
        userID: String,
        reason: String,
        emitRevoked: Bool,
        completion: @escaping (String, Error?) -> Void
    ) {
        provider.getCredentialState(forUserID: userID) { [weak self] credentialState, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    completion("unknown", error)
                    return
                }

                let state = self.stateLabel(credentialState)
                if emitRevoked && state != "authorized" {
                    self.notifyListeners(
                        "credentialRevoked",
                        data: ["state": state, "reason": reason, "userId": userID],
                        retainUntilConsumed: true
                    )
                    // A non-authorized binding must not silently become the
                    // identity checked on another account's future session.
                    try? self.deleteUserID()
                }
                completion(state, nil)
            }
        }
    }

    private func stateLabel(_ state: ASAuthorizationAppleIDProvider.CredentialState) -> String {
        switch state {
        case .authorized:
            return "authorized"
        case .revoked:
            return "revoked"
        case .notFound:
            return "not_found"
        case .transferred:
            return "transferred"
        @unknown default:
            return "unknown"
        }
    }

    private var keychainService: String {
        "\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").apple-credential-state"
    }

    private func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
    }

    private func saveUserID(_ userID: String) throws {
        try? deleteUserID()
        var query = keychainQuery()
        query[kSecValueData as String] = Data(userID.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private func readUserID() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteUserID() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

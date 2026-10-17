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
 *
 * Build 131 (131-01): one Keychain item per account, keyed by its Supabase
 * user id, so one account's sign-out, or a stale event for it, never deletes
 * another account's binding on the same phone. Older builds kept one fixed
 * item for the whole phone. It is still checked as before until it moves,
 * once, to the account it belongs to: when JavaScript checks a signed-in
 * account whose Apple identity is the one in it, or when an Apple sign-in
 * replaces it, as every sign-in did.
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
    /// The fixed item older builds kept; an account's own is this, ":" and its Supabase user id.
    private let keychainAccount = "sign-in-with-apple-user-id"
    private var revokedObserver: NSObjectProtocol?
    /// The account JavaScript last bound or checked: the live notification re-checks its binding too.
    private var activeAccountID: String?

    public override func load() {
        revokedObserver = NotificationCenter.default.addObserver(
            forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.checkPersistedCredentials(reason: "credential_revoked_notification", emitRevoked: true)
        }

        // Apple documents that permanent Apple Account deletion may not emit
        // the live notification. Reconcile the Keychain-bound identity at
        // every cold bridge start and retain the event until JavaScript binds.
        // Until JavaScript names the signed-in account only the older builds'
        // item is known here; JavaScript's explicit check covers the account's.
        checkPersistedCredentials(reason: "cold_start", emitRevoked: true)
    }

    deinit {
        if let revokedObserver {
            NotificationCenter.default.removeObserver(revokedObserver)
        }
    }

    @objc func bindCredential(_ call: CAPPluginCall) {
        guard let userID = validIdentifier(call.getString("userId")) else {
            call.reject("A valid Apple user identifier is required")
            return
        }
        guard let accountID = validIdentifier(call.getString("accountId")) else {
            call.reject("A valid account identifier is required")
            return
        }

        do {
            try saveUserID(userID, accountID: accountID)
        } catch {
            call.reject("Could not secure the Apple credential binding")
            return
        }
        // A sign-in replaced the older builds' one item, whoever's it was.
        try? deleteUserID(accountID: nil)
        activeAccountID = accountID

        checkCredentialState(userID: userID, accountID: accountID, reason: "sign_in", emitRevoked: true) { state, error in
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
        // The caller's own binding, never another account's.
        guard let accountID = validIdentifier(call.getString("accountId")) else {
            call.reject("A valid account identifier is required")
            return
        }
        do {
            try deleteUserID(accountID: accountID)
            if activeAccountID == accountID {
                activeAccountID = nil
            }
            call.resolve()
        } catch {
            call.reject("Could not clear the Apple credential binding")
        }
    }

    @objc func checkCredentialState(_ call: CAPPluginCall) {
        // The signed-in account's binding; with no account named, the older builds' item.
        let accountID = validIdentifier(call.getString("accountId"))
        if let accountID {
            activeAccountID = accountID
            adoptLegacyBinding(accountID: accountID, appleUserIDs: call.getArray("userIds", String.self) ?? [])
        }
        guard let userID = readUserID(accountID: accountID) else {
            call.resolve(["state": "not_bound"])
            return
        }
        checkCredentialState(userID: userID, accountID: accountID, reason: "explicit_check", emitRevoked: true) { state, error in
            if let error {
                call.reject("Could not verify the Apple credential state", nil, error)
                return
            }
            call.resolve(["state": state])
        }
    }

    /// The older builds' item while it remains, and the active account's own.
    private func checkPersistedCredentials(reason: String, emitRevoked: Bool) {
        var accountIDs: [String?] = [nil]
        if let activeAccountID {
            accountIDs.append(activeAccountID)
        }
        for accountID in accountIDs {
            guard let userID = readUserID(accountID: accountID) else { continue }
            checkCredentialState(userID: userID, accountID: accountID, reason: reason, emitRevoked: emitRevoked) { _, _ in }
        }
    }

    /// Once: the older builds' item becomes this account's own when the Apple
    /// identity in it is one of this account's. Anyone else's stays where it
    /// is, checked at each cold start, until its own account signs in again.
    private func adoptLegacyBinding(accountID: String, appleUserIDs: [String]) {
        guard let legacyUserID = readUserID(accountID: nil), appleUserIDs.contains(legacyUserID) else { return }
        if readUserID(accountID: accountID) == nil {
            do {
                try saveUserID(legacyUserID, accountID: accountID)
            } catch {
                return
            }
        }
        try? deleteUserID(accountID: nil)
    }

    private func checkCredentialState(
        userID: String,
        accountID: String?,
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
                    try? self.deleteUserID(accountID: accountID)
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

    /// An identifier from JavaScript, trimmed, or nil when it is empty, too long or carries control characters.
    private func validIdentifier(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              value.utf8.count <= 1024,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
        return value
    }

    private var keychainService: String {
        "\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").apple-credential-state"
    }

    /// One account's item, or the older builds' fixed one (accountID nil).
    private func keychainQuery(accountID: String?) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: accountID.map { "\(keychainAccount):\($0)" } ?? keychainAccount
        ]
    }

    private func saveUserID(_ userID: String, accountID: String) throws {
        try? deleteUserID(accountID: accountID)
        var query = keychainQuery(accountID: accountID)
        query[kSecValueData as String] = Data(userID.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private func readUserID(accountID: String?) -> String? {
        var query = keychainQuery(accountID: accountID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteUserID(accountID: String?) throws {
        let status = SecItemDelete(keychainQuery(accountID: accountID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

import Capacitor
import Foundation
import Security

/**
 * Narrow Keychain storage for bearer-session material.
 *
 * This is deliberately not a general preferences replacement. Only reviewed
 * keys are accepted, values are bounded, and records never migrate through an
 * iCloud/device backup. `AfterFirstUnlock` keeps token refresh available to
 * legitimate background work after the user has unlocked the phone once.
 */
@objc(SecureStoragePlugin)
public final class SecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStoragePlugin"
    public let jsName = "SecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let allowedKeys: Set<String> = [
        "thalassa-auth-session",
        "thalassa-auth-session-code-verifier",
        "thalassa-auth-session-user"
    ]
    private let maximumValueBytes = 256 * 1024

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Could not read secure storage")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("A secure-storage value is required")
            return
        }
        let data = Data(value.utf8)
        guard data.count <= maximumValueBytes else {
            call.reject("Secure-storage value is too large")
            return
        }

        let updateStatus = SecItemUpdate(
            baseQuery(key) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        guard updateStatus == errSecItemNotFound else {
            call.reject("Could not update secure storage")
            return
        }

        var add = baseQuery(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
            call.reject("Could not create secure storage")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not clear secure storage")
            return
        }
        call.resolve()
    }

    private func validatedKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), allowedKeys.contains(key) else {
            call.reject("Secure-storage key is not allowed")
            return nil
        }
        return key
    }

    private var service: String {
        "\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").secure-storage"
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}

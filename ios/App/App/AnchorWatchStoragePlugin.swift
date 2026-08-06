import Capacitor
import CryptoKit
import Foundation
import Security

/**
 * Keychain-backed crash recovery for Anchor Watch.
 *
 * Anchor positions are safety data and precise location data. This plugin is
 * intentionally narrower than a general key/value store: JavaScript can only
 * address the device recovery record or an identity-scoped recovery record.
 * Identity names are hashed before becoming Keychain account names and every
 * value is kept on this device only.
 */
@objc(AnchorWatchStoragePlugin)
public final class AnchorWatchStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AnchorWatchStoragePlugin"
    public let jsName = "AnchorWatchStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearScoped", returnType: CAPPluginReturnPromise)
    ]

    private let maximumValueBytes = 64 * 1024
    private let installMarkerKey = "thalassa.anchor-watch-keychain-install-v1"
    private var installBoundaryChecked = false

    @objc func get(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let account = validatedAccount(call) else { return }

        var query = baseQuery(account)
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
            call.reject("Could not read Anchor Watch recovery storage")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let account = validatedAccount(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("An Anchor Watch recovery value is required")
            return
        }
        let data = Data(value.utf8)
        guard data.count <= maximumValueBytes else {
            call.reject("Anchor Watch recovery value is too large")
            return
        }

        let updateStatus = SecItemUpdate(
            baseQuery(account) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        guard updateStatus == errSecItemNotFound else {
            call.reject("Could not update Anchor Watch recovery storage")
            return
        }

        var add = baseQuery(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
            call.reject("Could not create Anchor Watch recovery storage")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let account = validatedAccount(call) else { return }
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not clear Anchor Watch recovery storage")
            return
        }
        call.resolve()
    }

    /** Remove every prior identity-scoped watch while retaining the device envelope. */
    @objc func clearScoped(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call) else { return }
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: scopedService
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not clear scoped Anchor Watch recovery storage")
            return
        }
        call.resolve()
    }

    /**
     * Keychain records can survive uninstall while the app sandbox cannot.
     * A sandbox marker therefore fences a fresh install from adopting a prior
     * install's physical-watch state. On an ordinary upgrade the marker stays.
     */
    private func prepareInstallBoundary(_ call: CAPPluginCall) -> Bool {
        if installBoundaryChecked { return true }

        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: installMarkerKey) {
            let deviceStatus = SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: deviceService
            ] as CFDictionary)
            let scopedStatus = SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: scopedService
            ] as CFDictionary)
            guard (deviceStatus == errSecSuccess || deviceStatus == errSecItemNotFound),
                  (scopedStatus == errSecSuccess || scopedStatus == errSecItemNotFound) else {
                call.reject("Could not establish the Anchor Watch install boundary")
                return false
            }
            defaults.set(true, forKey: installMarkerKey)
            guard defaults.synchronize(), defaults.bool(forKey: installMarkerKey) else {
                call.reject("Could not persist the Anchor Watch install boundary")
                return false
            }
        }
        installBoundaryChecked = true
        return true
    }

    private func validatedAccount(_ call: CAPPluginCall) -> String? {
        guard let slot = call.getString("slot") else {
            call.reject("An Anchor Watch recovery slot is required")
            return nil
        }
        if slot == "device" { return "device-recovery" }
        guard slot == "scoped", let identityKey = call.getString("identityKey"),
              isValidIdentityKey(identityKey) else {
            call.reject("Anchor Watch recovery identity is invalid")
            return nil
        }
        let digest = SHA256.hash(data: Data(identityKey.utf8))
        return "scope:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    private func isValidIdentityKey(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 256 else { return false }
        if value == "anonymous" { return true }
        guard value.hasPrefix("user:"), value.count > 5 else { return false }
        return value.unicodeScalars.allSatisfy { $0.properties.generalCategory != .control }
    }

    private var serviceBase: String {
        "\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").anchor-watch-recovery"
    }

    private var deviceService: String {
        serviceBase + ".device"
    }

    private var scopedService: String {
        serviceBase + ".scoped"
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: account == "device-recovery" ? deviceService : scopedService,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }
}

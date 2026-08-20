import Capacitor
import CryptoKit
import Foundation
import Security

/**
 * Encrypted, bounded storage for Thalassa's reviewed large-cache families.
 *
 * This is intentionally not a general-purpose filesystem bridge. JavaScript
 * supplies a logical key, but only the exact weather/voyage/track/SmartPolar/
 * SatLink key families below are accepted. Logical keys are SHA-256 hashed for
 * filenames and are also authenticated as AES-GCM associated data, so neither
 * filenames nor ciphertext can be moved between cache identities.
 */
@objc(EncryptedLargeStoragePlugin)
public final class EncryptedLargeStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "EncryptedLargeStoragePlugin"
    public let jsName = "EncryptedLargeStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let exactKeys: Set<String> = [
        "thalassa_weather_cache_v9",
        "thalassa_voyage_cache_v2",
        "thalassa_history_cache_v3",
        "thalassa_weather_cache_schema",
        "thalassa_next_update",
        "thalassa_cache_version",
        "thalassa_smart_polars_v1",
        "thalassa_grib_download_state"
    ]
    private let scopedBaseKeys: Set<String> = [
        "thalassa_weather_cache_v9",
        "thalassa_voyage_cache_v2",
        "thalassa_history_cache_v3",
        "thalassa_weather_cache_schema",
        "thalassa_next_update"
    ]
    private let trackPrefix = "thalassa_track_v3_"

    // Eight independently bounded 4 MB voyage tracks plus working headroom
    // for weather/history/voyage/SmartPolar/SatLink state.
    private let maximumValueBytes = 5 * 1024 * 1024
    private let maximumFileCount = 64
    private let maximumAggregateBytes = 48 * 1024 * 1024
    private let envelopeMagic = Data([0x54, 0x4c, 0x53, 0x43, 0x01]) // TLSC v1

    /// All storage work runs on this plugin-private serial queue. Capacitor
    /// executes plugin methods inline on ONE shared serial queue for the whole
    /// app, so our AES-GCM decrypt + JSON validation of multi-MB blobs
    /// (~180-850 ms measured) was stalling every other plugin call behind it —
    /// and, symmetrically, blocking plugins (TCP socket reads) stalled us
    /// (a 128 KB cache read measured at 7200 ms on-device, 2026-08-20).
    /// Serial on purpose: the install-boundary check and per-key read/write
    /// ordering stay race-free without touching the method bodies.
    private let workQueue = DispatchQueue(label: "encrypted-large-storage.work")

    private let installDefaultsKey = "thalassa.encrypted-large-storage.install-id-v1"
    private let installMarkerAccount = "install-marker-v1"
    private let encryptionKeyAccount = "aes-gcm-key-v1"
    private var installBoundaryChecked = false

    @objc func get(_ call: CAPPluginCall) {
        workQueue.async { [weak self] in self?.getOnQueue(call) }
    }

    private func getOnQueue(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let key = validatedKey(call) else { return }
        do {
            if let value = try readEncryptedValue(key) {
                try scrubLegacyDocument(for: key)
                call.resolve(["value": value])
                return
            }
            if let migrated = try migrateLegacyDocument(for: key) {
                call.resolve(["value": migrated])
                return
            }
            call.resolve(["value": NSNull()])
        } catch {
            do {
                try scrubLegacyDocument(for: key)
            } catch {
                call.reject("Could not reject and clear invalid encrypted large storage")
                return
            }
            call.reject("Could not read encrypted large storage")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        workQueue.async { [weak self] in self?.setOnQueue(call) }
    }

    private func setOnQueue(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let key = validatedKey(call) else { return }
        guard let value = call.getString("value") else {
            call.reject("An encrypted-storage value is required")
            return
        }
        do {
            try validatePlaintext(value, for: key)
            try writeEncryptedValue(value, for: key)
            try scrubLegacyDocument(for: key)
            call.resolve()
        } catch {
            do {
                try scrubLegacyDocument(for: key)
            } catch {
                call.reject("Could not reject and clear invalid encrypted large storage")
                return
            }
            call.reject("Could not write encrypted large storage")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        workQueue.async { [weak self] in self?.removeOnQueue(call) }
    }

    private func removeOnQueue(_ call: CAPPluginCall) {
        guard prepareInstallBoundary(call), let key = validatedKey(call) else { return }
        do {
            try removeItemStrict(at: try encryptedURL(for: key))
            try scrubLegacyDocument(for: key)
            call.resolve()
        } catch {
            call.reject("Could not clear encrypted large storage")
        }
    }

    // MARK: - Install and device boundary

    /**
     * Keychain survives uninstall while UserDefaults and the app sandbox do
     * not. A marker in both places distinguishes the first encrypted-storage
     * rollout (both absent, legacy migration allowed) from reinstall (Keychain
     * only) and device restore/Keychain loss (UserDefaults only). Any mismatch
     * destroys old keys, encrypted files, and reviewed legacy plaintext before
     * a fresh boundary is established.
     */
    private func prepareInstallBoundary(_ call: CAPPluginCall) -> Bool {
        if installBoundaryChecked { return true }
        do {
            let defaults = UserDefaults.standard
            let defaultsMarker = defaults.string(forKey: installDefaultsKey)
            let keychainMarker = try readKeychainData(account: installMarkerAccount)
                .flatMap { String(data: $0, encoding: .utf8) }

            let firstRollout = defaultsMarker == nil && keychainMarker == nil
            let boundaryMatches = defaultsMarker != nil && defaultsMarker == keychainMarker
            if !firstRollout && !boundaryMatches {
                try purgeStorageDirectory()
                try purgeReviewedLegacyDocuments()
                try deleteKeychainData(account: encryptionKeyAccount)
                try deleteKeychainData(account: installMarkerAccount)
            } else if firstRollout {
                // Refuse to adopt an orphaned encryption key even on the first
                // rollout, while retaining reviewed Documents data to migrate.
                try deleteKeychainData(account: encryptionKeyAccount)
            }

            if !boundaryMatches {
                let freshMarker = UUID().uuidString.lowercased()
                try writeKeychainData(Data(freshMarker.utf8), account: installMarkerAccount)
                defaults.set(freshMarker, forKey: installDefaultsKey)
                guard defaults.synchronize(), defaults.string(forKey: installDefaultsKey) == freshMarker else {
                    throw StorageError.installBoundary
                }
            }

            try ensureStorageDirectory()
            try removeStaleTemporaryFiles()
            installBoundaryChecked = true
            return true
        } catch {
            call.reject("Could not establish encrypted-storage install boundary")
            return false
        }
    }

    // MARK: - Encryption

    private func readEncryptedValue(_ key: String) throws -> String? {
        let url = try encryptedURL(for: key)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard try isRegularNonSymbolicFile(url) else {
            try removeItemStrict(at: url)
            throw StorageError.invalidFile
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let fileBytes = (attributes[.size] as? NSNumber)?.intValue ?? maximumValueBytes + 1
        guard fileBytes <= maximumValueBytes + 128 else {
            try removeItemStrict(at: url)
            throw StorageError.oversized
        }
        let envelope = try Data(contentsOf: url, options: [.mappedIfSafe])
        do {
            let plaintext = try decrypt(envelope, for: key)
            guard let value = String(data: plaintext, encoding: .utf8) else { throw StorageError.invalidData }
            try validatePlaintext(value, for: key)
            return value
        } catch {
            try removeItemStrict(at: url)
            throw error
        }
    }

    private func writeEncryptedValue(_ value: String, for key: String) throws {
        let plaintext = Data(value.utf8)
        let destination = try encryptedURL(for: key)
        try ensureStorageDirectory()
        try enforceCapacity(replacing: destination, incomingPlaintextBytes: plaintext.count)

        let symmetricKey = try encryptionKey()
        let sealed = try AES.GCM.seal(plaintext, using: symmetricKey, authenticating: Data(key.utf8))
        guard let combined = sealed.combined else { throw StorageError.encryption }
        var envelope = envelopeMagic
        envelope.append(combined)

        do {
            try envelope.write(
                to: destination,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            try excludeFromBackup(destination)
            let verifiedEnvelope = try Data(contentsOf: destination, options: [.mappedIfSafe])
            let verified = try decrypt(verifiedEnvelope, for: key)
            guard verified == plaintext else { throw StorageError.verification }
        } catch {
            try? removeItemStrict(at: destination)
            throw error
        }
    }

    private func decrypt(_ envelope: Data, for key: String) throws -> Data {
        guard envelope.count > envelopeMagic.count,
              envelope.prefix(envelopeMagic.count) == envelopeMagic else {
            throw StorageError.invalidData
        }
        let combined = envelope.dropFirst(envelopeMagic.count)
        let sealedBox = try AES.GCM.SealedBox(combined: combined)
        let plaintext = try AES.GCM.open(
            sealedBox,
            using: encryptionKey(),
            authenticating: Data(key.utf8)
        )
        guard plaintext.count <= maximumValueBytes else { throw StorageError.oversized }
        return plaintext
    }

    private func encryptionKey() throws -> SymmetricKey {
        if let existing = try readKeychainData(account: encryptionKeyAccount) {
            guard existing.count == 32 else { throw StorageError.invalidKey }
            return SymmetricKey(data: existing)
        }

        // Missing device-only key can never be paired with old ciphertext.
        let existingFiles = try storageFiles()
        if !existingFiles.isEmpty { try purgeStorageDirectory() }
        try ensureStorageDirectory()
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, 32, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw StorageError.random }
        try writeKeychainData(bytes, account: encryptionKeyAccount)
        guard try readKeychainData(account: encryptionKeyAccount) == bytes else {
            throw StorageError.verification
        }
        return SymmetricKey(data: bytes)
    }

    // MARK: - Bounds and key validation

    private func validatedKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), isAllowedKey(key) else {
            call.reject("Encrypted-storage key is not allowed")
            return nil
        }
        return key
    }

    private func isAllowedKey(_ key: String) -> Bool {
        guard !key.isEmpty, key.utf8.count <= 4096,
              key.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control }) else {
            return false
        }
        if exactKeys.contains(key) { return true }
        for base in scopedBaseKeys where key.hasPrefix(base + "::") {
            let encodedScope = String(key.dropFirst(base.count + 2))
            guard let decodedScope = encodedScope.removingPercentEncoding else { return false }
            return isAllowedIdentityScope(decodedScope)
        }
        guard key.hasPrefix(trackPrefix) else { return false }
        let remainder = key.dropFirst(trackPrefix.count)
        let parts = remainder.split(separator: "_", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let scope = decodeFileToken(String(parts[0])),
              let voyageID = decodeFileToken(String(parts[1])) else { return false }
        return isAllowedIdentityScope(scope)
            && !voyageID.isEmpty
            && voyageID.utf8.count <= 256
            && voyageID.unicodeScalars.allSatisfy { $0.properties.generalCategory != .control }
    }

    private func isAllowedIdentityScope(_ value: String) -> Bool {
        if value == "anonymous" { return true }
        guard value.hasPrefix("user:"), UUID(uuidString: String(value.dropFirst(5))) != nil else { return false }
        return true
    }

    private func decodeFileToken(_ token: String) -> String? {
        guard !token.isEmpty, token.utf8.count <= 2048 else { return nil }
        var decoded = ""
        for component in token.split(separator: "-", omittingEmptySubsequences: false) {
            guard !component.isEmpty, component.count <= 6,
                  component.allSatisfy({ $0.isHexDigit }),
                  let scalarValue = UInt32(component, radix: 16),
                  let scalar = UnicodeScalar(scalarValue) else { return nil }
            decoded.unicodeScalars.append(scalar)
        }
        return decoded
    }

    private func validatePlaintext(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        guard data.count <= maximumValueBytes else { throw StorageError.oversized }
        if key != "thalassa_cache_version" {
            _ = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } else {
            guard !value.isEmpty, value.utf8.count <= 1024,
                  value.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control }) else {
                throw StorageError.invalidData
            }
        }
    }

    private func enforceCapacity(replacing destination: URL, incomingPlaintextBytes: Int) throws {
        let files = try storageFiles()
        var count = 0
        var aggregate = 0
        for file in files {
            guard try isRegularNonSymbolicFile(file) else { throw StorageError.invalidFile }
            count += 1
            if file != destination {
                let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
                aggregate += (attributes[.size] as? NSNumber)?.intValue ?? maximumAggregateBytes + 1
            }
        }
        if !FileManager.default.fileExists(atPath: destination.path) { count += 1 }
        guard count <= maximumFileCount,
              aggregate + incomingPlaintextBytes + 64 <= maximumAggregateBytes else {
            throw StorageError.capacity
        }
    }

    // MARK: - Reviewed legacy migration

    private func migrateLegacyDocument(for key: String) throws -> String? {
        let legacy = try legacyDocumentURL(for: key)
        guard FileManager.default.fileExists(atPath: legacy.path) else { return nil }
        do {
            guard try isRegularNonSymbolicFile(legacy) else { throw StorageError.invalidFile }
            let attributes = try FileManager.default.attributesOfItem(atPath: legacy.path)
            let byteCount = (attributes[.size] as? NSNumber)?.intValue ?? maximumValueBytes + 1
            guard byteCount <= maximumValueBytes else { throw StorageError.oversized }
            let data = try Data(contentsOf: legacy, options: [.mappedIfSafe])
            guard let value = String(data: data, encoding: .utf8) else { throw StorageError.invalidData }
            try validatePlaintext(value, for: key)
            try writeEncryptedValue(value, for: key)
            guard try readEncryptedValue(key) == value else { throw StorageError.verification }
            try removeItemStrict(at: legacy)
            return value
        } catch {
            try? removeItemStrict(at: encryptedURL(for: key))
            do {
                try removeItemStrict(at: legacy)
            } catch {
                throw StorageError.deletion
            }
            throw error
        }
    }

    private func scrubLegacyDocument(for key: String) throws {
        try removeItemStrict(at: legacyDocumentURL(for: key))
    }

    private func legacyDocumentURL(for key: String) throws -> URL {
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        )
        let filename = key == "thalassa_cache_version" ? "thalassa_cache_version.txt" : "\(key).json"
        return documents.appendingPathComponent(filename, isDirectory: false)
    }

    private func purgeReviewedLegacyDocuments() throws {
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false
        )
        guard FileManager.default.fileExists(atPath: documents.path) else { return }
        for url in try FileManager.default.contentsOfDirectory(
            at: documents,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ) {
            let key: String?
            if url.lastPathComponent == "thalassa_cache_version.txt" {
                key = "thalassa_cache_version"
            } else if url.pathExtension == "json" {
                key = url.deletingPathExtension().lastPathComponent
            } else {
                key = nil
            }
            if let key, isAllowedKey(key) { try removeItemStrict(at: url) }
        }
    }

    // MARK: - Filesystem

    private var storageDirectory: URL {
        get throws {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            return support.appendingPathComponent("ThalassaEncryptedLargeStorage", isDirectory: true)
        }
    }

    private func ensureStorageDirectory() throws {
        let directory = try storageDirectory
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        try excludeFromBackup(directory)
    }

    private func encryptedURL(for key: String) throws -> URL {
        let digest = SHA256.hash(data: Data(key.utf8))
        let filename = digest.map { String(format: "%02x", $0) }.joined() + ".tlsc"
        let directory = try storageDirectory
        return directory.appendingPathComponent(filename, isDirectory: false)
    }

    private func storageFiles() throws -> [URL] {
        let directory = try storageDirectory
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ).filter { $0.pathExtension == "tlsc" }
    }

    private func removeStaleTemporaryFiles() throws {
        let directory = try storageDirectory
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.pathExtension == "tmp" {
            try removeItemStrict(at: url)
        }
    }

    private func purgeStorageDirectory() throws {
        let directory = try storageDirectory
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
            guard !FileManager.default.fileExists(atPath: directory.path) else { throw StorageError.deletion }
        }
    }

    private func isRegularNonSymbolicFile(_ url: URL) throws -> Bool {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        return values.isRegularFile == true && values.isSymbolicLink != true
    }

    private func removeItemStrict(at url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw StorageError.deletion }
    }

    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
    }

    // MARK: - Keychain

    private var keychainService: String {
        "\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").encrypted-large-storage"
    }

    private func keychainQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func readKeychainData(account: String) throws -> Data? {
        var query = keychainQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StorageError.keychain }
        return data
    }

    private func writeKeychainData(_ data: Data, account: String) throws {
        let update = SecItemUpdate(
            keychainQuery(account: account) as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw StorageError.keychain }
        var add = keychainQuery(account: account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw StorageError.keychain }
    }

    private func deleteKeychainData(account: String) throws {
        let status = SecItemDelete(keychainQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError.keychain }
        guard try readKeychainData(account: account) == nil else { throw StorageError.deletion }
    }

    private enum StorageError: Error {
        case capacity
        case deletion
        case encryption
        case installBoundary
        case invalidData
        case invalidFile
        case invalidKey
        case keychain
        case oversized
        case random
        case verification
    }
}

// ISOLATED RESEARCH AUTH/MESSAGING HOST. Never imported by the ordinary target.
// The Keychain locator survives reinstall; losing its matching native files
// refuses reopening rather than implicitly enrolling a replacement identity.
import Foundation
import Security
import LocalAuthentication
import Darwin

enum ResearchAuthHostError: Error { case unavailable }

struct ResearchAuthConfiguration {
    static let bundleID = "app.thalassa.research.scuttlebutt-auth"
    static let origin = "https://kmtupdvwdgbhtssqqova.supabase.co"
    static let conversation = "thalassa-e2ee-pilot-auth-v1"
    let publicApiKey: String
    let authenticator: VodozemacSupabaseAuth

    static func bundled() throws -> ResearchAuthConfiguration {
        guard Bundle.main.bundleIdentifier == bundleID,
              let url = Bundle.main.url(forResource: "research-config", withExtension: "json"),
              let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              (1...16384).contains(size),
              let config = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
              Set(config.keys) == ["projectOrigin", "publicApiKey", "conversationId"],
              config["projectOrigin"] as? String == origin,
              config["conversationId"] as? String == conversation,
              let key = config["publicApiKey"] as? String else { throw ResearchAuthHostError.unavailable }
        // Reject accidental privileged credentials before exposing public config.
        let verifier = try VodozemacSupabaseAuth(projectOrigin: origin, publicApiKey: key)
        return ResearchAuthConfiguration(publicApiKey: key, authenticator: verifier)
    }
}

final class ResearchAuthHost {
    let facade: VodozemacSessionFacade
    private static let service = "app.thalassa.research.scuttlebutt-auth.installation-v1"
    private static let locatorName = "directory-id"

    init(configuration: ResearchAuthConfiguration) throws {
        let manager = FileManager.default
        // This URL comes only from the native sandbox, never a JS option.
        let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                      appropriateFor: nil, create: true)
        let root = support.appendingPathComponent("ScuttlebuttResearchAuth", isDirectory: true)
        let marker = try Self.readMarker()
        let rootExists = manager.fileExists(atPath: root.path)
        let directory: VodozemacAccountDirectory
        switch (marker, rootExists) {
        case (nil, false):
            // Reserve Keychain first. A crash leaves an unusable partial install;
            // never delete/reset it to make a retry appear like a clean install.
            try Self.reserveMarker()
            try manager.createDirectory(at: root, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
            try Self.protect(root, directory: true)
            directory = try VodozemacAccountDirectory.create(parentDirectory: root,
                authenticator: configuration.authenticator, conversationId: ResearchAuthConfiguration.conversation)
            let id = directory.directoryURL.lastPathComponent
            guard Self.canonicalID(id) else { throw ResearchAuthHostError.unavailable }
            let bytes = Data((id + "\n").utf8)
            let locator = root.appendingPathComponent(Self.locatorName)
            try bytes.write(to: locator, options: [.withoutOverwriting, .completeFileProtection])
            try Self.protect(locator, directory: false)
            let file = try FileHandle(forWritingTo: locator)
            defer { try? file.close() }
            try file.synchronize()
            try Self.sync(root)
            try Self.sync(support)
            try Self.finishMarker(bytes)
        case (let bytes?, true):
            // Validate public locator against the device-only Keychain value.
            // Neither locator alone grants authority; Directory reopens a sealed
            // project/conversation-bound index and refuses missing store keys.
            try Self.require(root, directory: true)
            guard bytes.count == 37, let value = String(data: bytes, encoding: .utf8),
                  value.hasSuffix("\n"), Self.canonicalID(String(value.dropLast())) else {
                throw ResearchAuthHostError.unavailable
            }
            let locator = root.appendingPathComponent(Self.locatorName)
            try Self.require(locator, directory: false)
            guard try locator.resourceValues(forKeys: [.fileSizeKey]).fileSize == 37,
                  try Data(contentsOf: locator) == bytes else { throw ResearchAuthHostError.unavailable }
            let id = String(value.dropLast())
            let children = try manager.contentsOfDirectory(atPath: root.path)
            guard Set(children) == [Self.locatorName, id] else { throw ResearchAuthHostError.unavailable }
            let container = root.appendingPathComponent(id, isDirectory: true)
            try Self.require(container, directory: true)
            directory = try VodozemacAccountDirectory.reopen(directory: container,
                authenticator: configuration.authenticator, conversationId: ResearchAuthConfiguration.conversation)
        default:
            // Missing marker, orphaned files, reinstall or partial init. No
            // automatic migration, identity replacement or recovery is offered.
            throw ResearchAuthHostError.unavailable
        }
        // Reopen restores sealed state, NEVER credentials/readiness. A later
        // verify may continue only an exact selected/ready/active owner after
        // fresh same-account Auth. Logout, replacement and partial installation
        // are not restart continuity and cannot be silently repaired here.
        facade = VodozemacSessionFacade(directory: directory)
    }

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "directory-v1",
         kSecAttrSynchronizable as String: false]
    }

    private static func readMarker() throws -> Data? {
        var request = query()
        request[kSecReturnData as String] = true
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext(); context.interactionNotAllowed = true
        request[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let attributes = result as? [String: Any],
              let data = attributes[kSecValueData as String] as? Data, data.count <= 64,
              attributes[kSecAttrAccessible as String] as? String == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String),
              (attributes[kSecAttrSynchronizable as String] as? Bool ?? false) == false else {
            throw ResearchAuthHostError.unavailable
        }
        return data
    }

    private static func reserveMarker() throws {
        var request = query()
        request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        request[kSecValueData as String] = Data("initializing\n".utf8)
        guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw ResearchAuthHostError.unavailable }
    }

    private static func finishMarker(_ bytes: Data) throws {
        guard try readMarker() == Data("initializing\n".utf8),
              SecItemUpdate(query() as CFDictionary, [kSecValueData as String: bytes] as CFDictionary) == errSecSuccess,
              try readMarker() == bytes else { throw ResearchAuthHostError.unavailable }
    }

    private static func canonicalID(_ value: String) -> Bool {
        value.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }

    private static func require(_ url: URL, directory: Bool) throws {
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey])
        guard values.isSymbolicLink != true,
              directory ? values.isDirectory == true : values.isRegularFile == true else {
            throw ResearchAuthHostError.unavailable
        }
    }

    private static func protect(_ url: URL, directory: Bool) throws {
        try require(url, directory: directory)
        try FileManager.default.setAttributes([.posixPermissions: directory ? 0o700 : 0o600,
            .protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        var mutable = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try mutable.setResourceValues(values)
    }

    private static func sync(_ directory: URL) throws {
        let descriptor = directory.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard descriptor >= 0 else { throw ResearchAuthHostError.unavailable }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw ResearchAuthHostError.unavailable }
    }
}

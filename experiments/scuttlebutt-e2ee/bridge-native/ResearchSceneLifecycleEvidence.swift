// Unwired, simulator-only passive diagnostic building block. No UIKit, Auth,
// message, fencing or permission operation is performed by this observer.
// Direct calls are not proof of an OS transition: reviewed wiring and an owned
// driver must establish that separately. Raw nonce/data must stay private.
#if E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST || (E2EE_SCENE_LIFECYCLE_EVIDENCE && targetEnvironment(simulator))
import Foundation
import Darwin

enum ResearchSceneLifecycleEvidenceError: Error { case unavailable }

@MainActor
final class ResearchSceneLifecycleEvidence {
    static let maximumEvents = 64
    static let maximumReceiptBytes = 65536
    private static let nativeProcessEpoch = UUID().uuidString.lowercased()

    enum Event: String, CaseIterable {
        case processStarted = "process-started"
        case applicationLaunched = "application-launched"
        case sceneConnected = "scene-connected"
        case protectedReady = "protected-ready"
        case willResignActive = "will-resign-active"
        case didEnterBackground = "did-enter-background"
        case willEnterForeground = "will-enter-foreground"
        case didBecomeActive = "did-become-active"
        case foregroundUiClosed = "foreground-ui-closed"
        case sceneDisconnected = "scene-disconnected"
        case willTerminate = "will-terminate"
    }
    enum ActivationState: String, CaseIterable {
        case unattached
        case foregroundActive = "foreground-active"
        case foregroundInactive = "foreground-inactive"
        case background
        case unknown
    }
    enum ObservationStatus: String { case unavailable, observed }

    struct CoverFacts {
        let present: Bool
        let opaque: Bool
        let attachedToOwnedWindow: Bool
        let coversOwnedWindowBounds: Bool
        let accessibilityModal: Bool
        let contentAccessibilityHidden: Bool
        static let absent = CoverFacts(present: false, opaque: false,
            attachedToOwnedWindow: false, coversOwnedWindowBounds: false,
            accessibilityModal: false, contentAccessibilityHidden: false)
        fileprivate var json: [String: Any] {
            ["present": present, "opaque": opaque, "attachedToOwnedWindow": attachedToOwnedWindow,
             "coversOwnedWindowBounds": coversOwnedWindowBounds, "accessibilityModal": accessibilityModal,
             "contentAccessibilityHidden": contentAccessibilityHidden]
        }
    }

    struct AuthorityFacts {
        let observationStatus: ObservationStatus
        let facadeObserved: Bool
        let originalSnapshotObserved: Bool
        let accountPresent: Bool?
        let originalSnapshotCurrent: Bool?
        // Read only an actual successful native .verify completion counter.
        // An attempted plugin call or a lease expiry cannot substitute for it.
        let verifyFenceCompletions: Int?
        static let unavailable = AuthorityFacts(observationStatus: .unavailable,
            facadeObserved: false, originalSnapshotObserved: false,
            accountPresent: nil, originalSnapshotCurrent: nil, verifyFenceCompletions: nil)

        fileprivate var valid: Bool {
            if let count = verifyFenceCompletions, !(0...10000).contains(count) { return false }
            if observationStatus == .unavailable {
                return !facadeObserved && !originalSnapshotObserved && accountPresent == nil
                    && originalSnapshotCurrent == nil && verifyFenceCompletions == nil
            }
            return facadeObserved && accountPresent != nil
                && originalSnapshotObserved == (originalSnapshotCurrent != nil)
        }
        fileprivate var json: [String: Any] {
            ["observationStatus": observationStatus.rawValue, "facadeObserved": facadeObserved,
             "originalSnapshotObserved": originalSnapshotObserved,
             "accountPresent": accountPresent.map { $0 as Any } ?? NSNull(),
             "originalSnapshotCurrent": originalSnapshotCurrent.map { $0 as Any } ?? NSNull(),
             "verifyFenceCompletions": verifyFenceCompletions.map { $0 as Any } ?? NSNull()]
        }
    }

    private struct Snapshot {
        let index: Int
        let event: Event
        let activationState: ActivationState
        let cover: CoverFacts
        let authority: AuthorityFacts
        var json: [String: Any] {
            ["index": index, "sequence": index + 1, "event": event.rawValue,
             "activationState": activationState.rawValue, "cover": cover.json, "authority": authority.json]
        }
    }

    let processID: Int
    let processEpoch: String
    private let runID: String
    private let nonce: String
    private let resourceSHA256: String
    private var snapshots: [Snapshot] = []
    private var capacityRefused = false
    private var observing = false
    private var outputDirectory: URL?

    // Syntax binding only: the host must first validate its actual resource and
    // independently measure its hash. No PID/epoch injection exists in this API.
    init(runID: String, nonce: String, resourceSHA256: String) throws {
        guard Self.uuid(runID), Self.digest(nonce), Self.digest(resourceSHA256) else {
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
        self.runID = runID; self.nonce = nonce; self.resourceSHA256 = resourceSHA256
        processID = Int(ProcessInfo.processInfo.processIdentifier)
        processEpoch = Self.nativeProcessEpoch
        guard (1...2147483647).contains(processID) else { throw ResearchSceneLifecycleEvidenceError.unavailable }
        snapshots.append(Snapshot(index: 0, event: .processStarted, activationState: .unknown,
            cover: .absent, authority: .unavailable))
    }

    // The caller must be read-only and compare one immutable original snapshot.
    // Neither the closure nor any actor/scene/facade/snapshot object is retained.
    func record(event: Event, activationState: ActivationState, cover: CoverFacts,
                observeAuthority: () throws -> AuthorityFacts = { .unavailable }) throws {
        guard event != .processStarted, !observing else { throw ResearchSceneLifecycleEvidenceError.unavailable }
        guard !capacityRefused, snapshots.count < Self.maximumEvents else {
            capacityRefused = true
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
        observing = true; defer { observing = false }
        let facts: AuthorityFacts
        do { facts = try observeAuthority() }
        catch { facts = .unavailable } // Unknown never becomes an observed absence.
        guard facts.valid else { throw ResearchSceneLifecycleEvidenceError.unavailable }
        snapshots.append(Snapshot(index: snapshots.count, event: event,
            activationState: activationState, cover: cover, authority: facts))
    }

    func record(eventName: String, activationState: ActivationState, cover: CoverFacts,
                observeAuthority: () throws -> AuthorityFacts = { .unavailable }) throws {
        guard eventName.utf8.count <= 48, let event = Event(rawValue: eventName) else {
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
        try record(event: event, activationState: activationState, cover: cover, observeAuthority: observeAuthority)
    }

    func serializedReceipt() throws -> Data {
#if E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST
        let category = "synthetic-direct-calls"
#else
        let category = "simulator-native-observations"
#endif
        let row: [String: Any] = ["version": 1, "kind": "research-scene-lifecycle-observations",
            "runID": runID, "nonce": nonce, "resourceSHA256": resourceSHA256,
            "process": ["pid": processID, "epoch": processEpoch], "evidenceCategory": category,
            "status": capacityRefused ? "capacity-refused" : "recording",
            "eventCount": snapshots.count, "events": snapshots.map { $0.json },
            "osLifecycleProved": false, "authorityMutated": false]
        do {
            let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            guard data.count <= Self.maximumReceiptBytes else { throw ResearchSceneLifecycleEvidenceError.unavailable }
            return data
        } catch { throw ResearchSceneLifecycleEvidenceError.unavailable }
    }

    // Optional private artifact output, not account-store persistence/reuse.
    // Every process creates its own NEW directory; failed partial output is kept,
    // never deleted/reset and never reused by another observer.
    func persist(inNativeDocumentsRoot root: URL) throws -> URL {
        do {
            try Self.requireDirectory(root)
#if E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST
            let temporary = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
                .resolvingSymlinksInPath().path
            guard root.path.hasPrefix(temporary + "/thalassa-") || root.path.hasPrefix("/private/tmp/thalassa-") else {
                throw ResearchSceneLifecycleEvidenceError.unavailable
            }
            guard try Self.permissions(root) == 0o700 else { throw ResearchSceneLifecycleEvidenceError.unavailable }
#else
            let native = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: false).resolvingSymlinksInPath()
            guard root.path == native.path else { throw ResearchSceneLifecycleEvidenceError.unavailable }
#endif
            let directory = root.appendingPathComponent("research-scene-lifecycle-" + runID + "-" + processEpoch,
                isDirectory: true)
            let file = directory.appendingPathComponent("scene-observer.json")
            let bytes = try serializedReceipt()
            if let existing = outputDirectory {
                guard existing.path == directory.path else { throw ResearchSceneLifecycleEvidenceError.unavailable }
                try Self.requireDirectory(directory)
                guard try Self.permissions(directory) == 0o700 else { throw ResearchSceneLifecycleEvidenceError.unavailable }
                try Self.requireReceipt(file)
#if targetEnvironment(simulator) && !E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST
                try bytes.write(to: file, options: [.atomic, .completeFileProtection])
#else
                try bytes.write(to: file, options: [.atomic])
#endif
            } else {
                // POSIX mkdir refuses EEXIST: Foundation createDirectory may
                // otherwise accept a pre-existing directory without an error.
                guard directory.path.withCString({ mkdir($0, 0o700) }) == 0 else {
                    throw ResearchSceneLifecycleEvidenceError.unavailable
                }
                try Self.requireDirectory(directory)
#if targetEnvironment(simulator) && !E2EE_SCENE_LIFECYCLE_EVIDENCE_TEST
                try bytes.write(to: file, options: [.withoutOverwriting, .completeFileProtection])
#else
                try bytes.write(to: file, options: [.withoutOverwriting])
#endif
                outputDirectory = directory
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            try Self.requireReceipt(file)
            return file
        } catch { throw ResearchSceneLifecycleEvidenceError.unavailable }
    }

    private static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    }
    private static func digest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func requireAncestors(_ url: URL) throws {
        // Foundation standardization can change a private-prefix spelling even
        // without a symlink. POSIX realpath/lstat keep the actual path policy:
        // no alias, dot component or symlink ancestor is silently accepted.
        let path = url.path
        guard url.isFileURL, url.query == nil, url.fragment == nil, path.hasPrefix("/"),
              !path.utf8.contains(0), path.utf8.count <= 4096,
              let resolved = path.withCString({ realpath($0, nil) }) else {
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
        defer { free(resolved) }
        guard String(cString: resolved) == path else { throw ResearchSceneLifecycleEvidenceError.unavailable }
        var cursor = path
        while cursor != "/" {
            var metadata = stat()
            guard cursor.withCString({ lstat($0, &metadata) }) == 0,
                  (UInt32(metadata.st_mode) & UInt32(S_IFMT)) != UInt32(S_IFLNK),
                  let slash = cursor.lastIndex(of: "/") else {
                throw ResearchSceneLifecycleEvidenceError.unavailable
            }
            cursor = slash == cursor.startIndex ? "/" : String(cursor[..<slash])
        }
    }
    private static func requireDirectory(_ url: URL) throws {
        try requireAncestors(url)
        let info = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard info.isDirectory == true, info.isSymbolicLink == false,
              let owner = try FileManager.default.attributesOfItem(atPath: url.path)[.ownerAccountID] as? NSNumber,
              owner.uint32Value == getuid() else { throw ResearchSceneLifecycleEvidenceError.unavailable }
    }
    private static func permissions(_ url: URL) throws -> Int {
        guard let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber else {
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
        return mode.intValue
    }
    private static func requireReceipt(_ url: URL) throws {
        try requireAncestors(url)
        let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink == false,
              let size = info.fileSize, (1...maximumReceiptBytes).contains(size),
              let owner = try FileManager.default.attributesOfItem(atPath: url.path)[.ownerAccountID] as? NSNumber,
              owner.uint32Value == getuid(), try permissions(url) == 0o600 else {
            throw ResearchSceneLifecycleEvidenceError.unavailable
        }
    }
}
#endif

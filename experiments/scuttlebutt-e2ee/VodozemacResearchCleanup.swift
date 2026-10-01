// ISOLATED RESEARCH ONLY. Recovery of one disposable simulator run, never an
// application account, arbitrary directory, or Keychain-prefix deletion.
import Foundation
import Darwin

private enum ResearchCleanup {
    static let knownStoreFiles: Set<String> = ["snapshot.sqlite", "snapshot.sqlite-wal", "snapshot.sqlite-shm"]

    static func requireType(_ url: URL, _ type: FileAttributeType) throws {
        // attributesOfItem uses the item itself, including a dangling symlink.
        // fileExists alone would silently miss dangling links.
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == type else {
            throw VodozemacSealedStoreError.invalidInput
        }
    }

    static func requireDirectChild(_ child: URL, of parent: URL) throws {
        guard child.isFileURL, parent.isFileURL,
              child.deletingLastPathComponent().standardizedFileURL.path == parent.standardizedFileURL.path,
              child.resolvingSymlinksInPath().deletingLastPathComponent().path == parent.resolvingSymlinksInPath().path else {
            throw VodozemacSealedStoreError.invalidInput
        }
    }

    static func requireStoreLeaf(_ leaf: URL, root: URL) throws -> UUID {
        try requireDirectChild(leaf, of: root)
        try requireType(leaf, .typeDirectory)
        let name = leaf.lastPathComponent
        guard let id = UUID(uuidString: name), name == id.uuidString || name == id.uuidString.lowercased() else {
            throw VodozemacSealedStoreError.invalidInput
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: leaf.path)
        guard names.contains("snapshot.sqlite"), Set(names).isSubset(of: knownStoreFiles) else {
            throw VodozemacSealedStoreError.invalidInput
        }
        for name in names {
            let file = leaf.appendingPathComponent(name)
            try requireDirectChild(file, of: leaf)
            try requireType(file, .typeRegular)
        }
        return id
    }

    static func removeEmptyRoot(_ root: URL, documents: URL) throws {
        try requireDirectChild(root, of: documents)
        try requireType(root, .typeDirectory)
        guard try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty else {
            throw VodozemacSealedStoreError.invalidInput
        }
        // rmdir refuses a nonempty directory even if another writer races the
        // check. FileManager.removeItem would be recursive in that situation.
        guard root.path.withCString({ Darwin.rmdir($0) }) == 0 else {
            throw VodozemacSealedStoreError.invalidInput
        }
    }
}

func runResearchCleanup(runID: UUID) throws {
    let fm = FileManager.default
    guard let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first else {
        throw VodozemacSealedStoreError.invalidInput
    }
    try ResearchCleanup.requireType(documents, .typeDirectory)
    let rootNames = ["e2ee-research-", "dm-e2ee-research-", "relay-e2ee-research-"]
        .map { $0 + runID.uuidString }
    let publicNames = ["relay-input-", "relay-output-"]
        .map { $0 + runID.uuidString.lowercased() + ".json" }
    let initialNames = Set(try fm.contentsOfDirectory(atPath: documents.path))
    var roots: [URL] = []
    var candidates: [(root: URL, leaf: URL, id: UUID)] = []
    var ids: Set<UUID> = []
    var publicFiles: [URL] = []

    // Validate every target before any deletion. No glob, directory prefix
    // traversal, recursive removal, or unverified Keychain fallback is used.
    for name in rootNames where initialNames.contains(name) {
        let root = documents.appendingPathComponent(name)
        try ResearchCleanup.requireDirectChild(root, of: documents)
        try ResearchCleanup.requireType(root, .typeDirectory)
        let leaves = try fm.contentsOfDirectory(atPath: root.path).sorted()
        for name in leaves {
            let leaf = root.appendingPathComponent(name)
            let id = try ResearchCleanup.requireStoreLeaf(leaf, root: root)
            // Two directories referring to the same store key are ambiguous.
            guard ids.insert(id).inserted else { throw VodozemacSealedStoreError.invalidInput }
            candidates.append((root: root, leaf: leaf, id: id))
        }
        roots.append(root)
    }
    for name in publicNames where initialNames.contains(name) {
        let file = documents.appendingPathComponent(name)
        try ResearchCleanup.requireDirectChild(file, of: documents)
        try ResearchCleanup.requireType(file, .typeRegular)
        publicFiles.append(file)
    }

    var stores: [(root: URL, leaf: URL, id: UUID, store: VodozemacSealedStore)] = []
    defer { for item in stores { item.store.close() } }
    // Reopen authenticates each UUID-bound encrypted snapshot and exact
    // existing Keychain key. A missing key, corrupt DB, or foreign store refuses
    // cleanup before any store is destroyed; no replacement key is generated.
    for item in candidates {
        let store = try VodozemacSealedStore.reopen(directory: item.leaf, storeID: item.id)
        stores.append((root: item.root, leaf: item.leaf, id: item.id, store: store))
    }
    for item in stores {
        try ResearchCleanup.requireDirectChild(item.root, of: documents)
        try ResearchCleanup.requireType(item.root, .typeDirectory)
        guard try ResearchCleanup.requireStoreLeaf(item.leaf, root: item.root) == item.id else {
            throw VodozemacSealedStoreError.invalidInput
        }
        try item.store.destroyForTesting()
    }
    for root in roots { try ResearchCleanup.removeEmptyRoot(root, documents: documents) }
    for file in publicFiles {
        try ResearchCleanup.requireDirectChild(file, of: documents)
        try ResearchCleanup.requireType(file, .typeRegular)
        // Only unlink one checked fixture file; never recurse if its type changes.
        guard file.path.withCString({ Darwin.unlink($0) }) == 0 else {
            throw VodozemacSealedStoreError.invalidInput
        }
    }
    let remaining = Set(try fm.contentsOfDirectory(atPath: documents.path))
    guard remaining.isDisjoint(with: Set(rootNames + publicNames)) else {
        throw VodozemacSealedStoreError.invalidInput
    }
    print("PASS exact disposable research namespace cleanup; no application keys or accounts touched")
}

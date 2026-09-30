// ISOLATED RESEARCH ONLY. Never compiled into Thalassa; synthetic bytes only.
// Plain SQLite is NOT an encrypted or production secure store. Production gates:
// reviewed encryption/key custody in Keychain, iOS file protection (DB/WAL/SHM),
// locked-device behaviour, backup/restore rollback protection, secure deletion,
// and provider integration. This proof does not implement any of those gates.
// The caller supplies opaque state/output: this proves persistence atomicity,
// not provider encryption or atomicity of libsignal's own store callbacks.
import Foundation
import SQLite3

enum AtomicStoreError: Error, Equatable {
    case invalidInput, staleAccount, staleIdentity, staleRevision, missingSession
    case sessionExists, recordConflict, recordCancelled, generationExhausted
    case database(Int32), unsupportedDatabase
}

struct StoreAccount: Equatable {
    let ownerID: String
    let senderDeviceID: String
    let generation: Int64
}

struct StoreScope: Equatable {
    let account: StoreAccount
    let recipientID: String
    let recipientDeviceID: String
    let identityKeyID: String
    let identityGeneration: Int64
}

struct StoreSession: Equatable {
    let revision: Int64
    let opaqueState: Data
}

struct StoreOutput: Equatable {
    let scope: StoreScope
    let clientMessageID: String
    let originalRevision: Int64
    // Exact bytes to retry, including whatever envelope/type a provider adapter
    // eventually chooses. This store does not parse or authenticate the bytes.
    let exactCiphertext: Data
}

struct StoredOutput: Equatable {
    let output: StoreOutput
    let cancelled: Bool
}

/// One active account/device per database, matching the single-device experiment.
/// All operations lock this connection and take a SQLite transaction, so guards
/// and writes/read results share one snapshot even across multiple connections.
/// No returned bytes authorize a future network send: dispatch must revalidate
/// owner/trust and the server must still enforce its own authorization.
final class AtomicOutboxStore {
    static let maxStateBytes = 1_048_576
    static let maxCiphertextBytes = 262_144
    private var db: OpaquePointer?
    private let lock = NSLock()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private enum Value {
        case text(String), integer(Int64), bytes(Data)
    }

    init(path: String) throws {
        guard !path.isEmpty, !path.utf8.contains(0), path.utf8.count <= 4096 else {
            throw AtomicStoreError.invalidInput
        }
        let result = sqlite3_open_v2(path, &db,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard result == SQLITE_OK else {
            if let db { sqlite3_close(db) }
            db = nil
            throw AtomicStoreError.database(result)
        }
        do {
            try checked(sqlite3_busy_timeout(db, 2000))
            // Refuse an unrelated existing DB. This prototype has no migrations.
            let version = try integers("PRAGMA user_version").first ?? -1
            let application = try integers("PRAGMA application_id").first ?? -1
            if version == 0 && application == 0 {
                guard try integers("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").first == 0 else {
                    throw AtomicStoreError.unsupportedDatabase
                }
            } else if version != 1 || application != 1413824817 {
                throw AtomicStoreError.unsupportedDatabase
            }
            let mode = try query("PRAGMA journal_mode=WAL") { row in self.string(row, 0) }
            guard mode == ["wal"] else { throw AtomicStoreError.unsupportedDatabase }
            try execute("PRAGMA synchronous=FULL")
            guard try integers("PRAGMA synchronous") == [2] else { throw AtomicStoreError.unsupportedDatabase }
            if version == 0 {
                try transaction {
                    try self.execute("""
                        CREATE TABLE account (
                            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                            owner TEXT NOT NULL, sender TEXT NOT NULL,
                            generation INTEGER NOT NULL CHECK(generation>0),
                            active INTEGER NOT NULL CHECK(active IN (0,1)))
                        """)
                    try self.execute("""
                        CREATE TABLE peers (
                            recipient TEXT NOT NULL, device TEXT NOT NULL,
                            identity_key TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
                            PRIMARY KEY(recipient,device))
                        """)
                    try self.execute("""
                        CREATE TABLE sessions (
                            recipient TEXT NOT NULL, device TEXT NOT NULL,
                            revision INTEGER NOT NULL CHECK(revision>=0),
                            state BLOB NOT NULL CHECK(length(state) BETWEEN 1 AND 1048576),
                            PRIMARY KEY(recipient,device))
                        """)
                    try self.execute("""
                        CREATE TABLE outbox (
                            owner TEXT NOT NULL, sender TEXT NOT NULL, owner_generation INTEGER NOT NULL,
                            recipient TEXT NOT NULL, device TEXT NOT NULL,
                            identity_key TEXT NOT NULL, identity_generation INTEGER NOT NULL,
                            message_id TEXT NOT NULL, original_revision INTEGER NOT NULL,
                            ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 1 AND 262144),
                            cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)),
                            PRIMARY KEY(owner,sender,message_id,device))
                        """)
                    try self.execute("PRAGMA application_id=1413824817")
                    try self.execute("PRAGMA user_version=1")
                }
            }
        } catch {
            sqlite3_close(db)
            db = nil
            throw error
        }
    }

    deinit { if let db { sqlite3_close(db) } }

    /// Calling again while the same account is active resumes its durable epoch.
    /// Logout or any account/device switch creates a strictly newer epoch.
    func activate(ownerID: String, senderDeviceID: String) throws -> StoreAccount {
        try identifiers(ownerID, senderDeviceID)
        return try transaction {
            let old = try self.accountRow()
            if let old, old.active, old.account.ownerID == ownerID, old.account.senderDeviceID == senderDeviceID {
                return old.account
            }
            let generation = try self.next(old?.account.generation ?? 0)
            try self.cancelAndClear()
            try self.execute("INSERT OR REPLACE INTO account VALUES(1,?,?,?,1)",
                [.text(ownerID), .text(senderDeviceID), .integer(generation)])
            return StoreAccount(ownerID: ownerID, senderDeviceID: senderDeviceID, generation: generation)
        }
    }

    func logout(account: StoreAccount) throws {
        try validate(account)
        try transaction {
            try self.requireAccount(account)
            try self.execute("UPDATE account SET generation=?,active=0 WHERE singleton=1",
                [.integer(try self.next(account.generation))])
            try self.cancelAndClear()
        }
    }

    /// Explicit local trust acceptance, never an automatic response to server data.
    /// Every call advances this peer's generation, including an A -> B -> A change.
    func acceptIdentity(account: StoreAccount, recipientID: String, recipientDeviceID: String,
                        identityKeyID: String) throws -> StoreScope {
        try validate(account)
        try identifiers(recipientID, recipientDeviceID, identityKeyID)
        return try transaction {
            try self.requireAccount(account)
            let keys: [Value] = [.text(recipientID), .text(recipientDeviceID)]
            let prior = try self.integers("SELECT generation FROM peers WHERE recipient=? AND device=?", keys).first ?? 0
            let generation = try self.next(prior)
            try self.execute("UPDATE outbox SET cancelled=1 WHERE recipient=? AND device=? AND cancelled=0", keys)
            try self.execute("DELETE FROM sessions WHERE recipient=? AND device=?", keys)
            try self.execute("INSERT OR REPLACE INTO peers VALUES(?,?,?,?)",
                keys + [.text(identityKeyID), .integer(generation)])
            return StoreScope(account: account, recipientID: recipientID, recipientDeviceID: recipientDeviceID,
                identityKeyID: identityKeyID, identityGeneration: generation)
        }
    }

    func initializeSession(scope: StoreScope, opaqueState: Data) throws {
        try validate(scope)
        try bytes(opaqueState, maximum: Self.maxStateBytes)
        try transaction {
            try self.requireScope(scope)
            guard try self.sessionRow(scope) == nil else { throw AtomicStoreError.sessionExists }
            try self.execute("INSERT INTO sessions VALUES(?,?,0,?)",
                [.text(scope.recipientID), .text(scope.recipientDeviceID), .bytes(opaqueState)])
        }
    }

    func session(scope: StoreScope) throws -> StoreSession {
        try validate(scope)
        return try transaction {
            try self.requireScope(scope)
            guard let session = try self.sessionRow(scope) else { throw AtomicStoreError.missingSession }
            return session
        }
    }

    /// Returns the committed output. A byte-identical existing output is an
    /// idempotent retry; the validated nextState is ignored and no ratchet write
    /// occurs then. Use pending() to resend stored bytes without preparing state.
    /// Old ratchet states are deliberately NOT retained in the outbox for retry
    /// comparisons. A production store still needs WAL/backup erasure analysis.
    /// probeAfterWrites is fault injection in this isolated proof, not app API.
    func commitSend(_ output: StoreOutput, nextState: Data,
                    probeAfterWrites: (() throws -> Void)? = nil) throws -> StoreOutput {
        try validate(output.scope)
        try identifiers(output.clientMessageID)
        guard output.originalRevision >= 0 else { throw AtomicStoreError.invalidInput }
        try bytes(output.exactCiphertext, maximum: Self.maxCiphertextBytes)
        try bytes(nextState, maximum: Self.maxStateBytes)
        return try transaction {
            // Check epochs before checking retries. Cancelled/stale output cannot
            // be revived by logging back in or accepting an old identity again.
            try self.requireScope(output.scope)
            if let stored = try self.outputRow(output) {
                guard stored.output == output else { throw AtomicStoreError.recordConflict }
                guard !stored.cancelled else { throw AtomicStoreError.recordCancelled }
                return stored.output
            }
            guard let current = try self.sessionRow(output.scope) else { throw AtomicStoreError.missingSession }
            guard current.revision == output.originalRevision else { throw AtomicStoreError.staleRevision }
            let revision = try self.next(current.revision)
            try self.execute("UPDATE sessions SET revision=?,state=? WHERE recipient=? AND device=? AND revision=?",
                [.integer(revision), .bytes(nextState), .text(output.scope.recipientID),
                 .text(output.scope.recipientDeviceID), .integer(current.revision)])
            guard sqlite3_changes(self.db) == 1 else { throw AtomicStoreError.staleRevision }
            try self.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?,0)", self.values(output))
            try probeAfterWrites?()
            return output
        }
    }

    func pending(account: StoreAccount, limit: Int = 100) throws -> [StoreOutput] {
        try validate(account)
        guard (1...100).contains(limit) else { throw AtomicStoreError.invalidInput }
        return try transaction {
            try self.requireAccount(account)
            return try self.query("""
                SELECT o.* FROM outbox o JOIN peers p ON o.recipient=p.recipient AND o.device=p.device
                WHERE o.owner=? AND o.sender=? AND o.owner_generation=? AND o.cancelled=0
                AND o.identity_key=p.identity_key AND o.identity_generation=p.generation
                ORDER BY o.rowid LIMIT ?
                """, [.text(account.ownerID), .text(account.senderDeviceID), .integer(account.generation), .integer(Int64(limit))]) {
                    self.decodeOutput($0).output
                }
        }
    }

    /// Audit lookup includes cancelled records; it is never a dispatch API.
    /// Requires current account ownership and does not expose other owners' rows.
    func inspectOutput(account: StoreAccount, clientMessageID: String, recipientDeviceID: String) throws -> StoredOutput? {
        try validate(account)
        try identifiers(clientMessageID, recipientDeviceID)
        return try transaction {
            try self.requireAccount(account)
            return try self.query("SELECT * FROM outbox WHERE owner=? AND sender=? AND message_id=? AND device=?",
                [.text(account.ownerID), .text(account.senderDeviceID), .text(clientMessageID), .text(recipientDeviceID)]) {
                    self.decodeOutput($0)
                }.first
        }
    }

    private func cancelAndClear() throws {
        try execute("UPDATE outbox SET cancelled=1 WHERE cancelled=0")
        try execute("DELETE FROM sessions")
        try execute("DELETE FROM peers")
    }

    private func accountRow() throws -> (account: StoreAccount, active: Bool)? {
        try query("SELECT owner,sender,generation,active FROM account WHERE singleton=1") {
            (StoreAccount(ownerID: self.string($0, 0), senderDeviceID: self.string($0, 1),
                generation: sqlite3_column_int64($0, 2)), sqlite3_column_int($0, 3) == 1)
        }.first
    }

    private func requireAccount(_ account: StoreAccount) throws {
        guard let current = try accountRow(), current.active, current.account == account else {
            throw AtomicStoreError.staleAccount
        }
    }

    private func requireScope(_ scope: StoreScope) throws {
        try requireAccount(scope.account)
        let peer = try query("SELECT identity_key,generation FROM peers WHERE recipient=? AND device=?",
            [.text(scope.recipientID), .text(scope.recipientDeviceID)]) { (self.string($0, 0), sqlite3_column_int64($0, 1)) }.first
        guard let peer, peer.0 == scope.identityKeyID, peer.1 == scope.identityGeneration else {
            throw AtomicStoreError.staleIdentity
        }
    }

    private func sessionRow(_ scope: StoreScope) throws -> StoreSession? {
        try query("SELECT revision,state FROM sessions WHERE recipient=? AND device=?",
            [.text(scope.recipientID), .text(scope.recipientDeviceID)]) {
                StoreSession(revision: sqlite3_column_int64($0, 0), opaqueState: self.data($0, 1))
            }.first
    }

    private func outputRow(_ output: StoreOutput) throws -> StoredOutput? {
        try query("SELECT * FROM outbox WHERE owner=? AND sender=? AND message_id=? AND device=?",
            [.text(output.scope.account.ownerID), .text(output.scope.account.senderDeviceID),
             .text(output.clientMessageID), .text(output.scope.recipientDeviceID)]) { self.decodeOutput($0) }.first
    }

    private func values(_ output: StoreOutput) -> [Value] {
        let scope = output.scope
        return [.text(scope.account.ownerID), .text(scope.account.senderDeviceID), .integer(scope.account.generation),
                .text(scope.recipientID), .text(scope.recipientDeviceID), .text(scope.identityKeyID),
                .integer(scope.identityGeneration), .text(output.clientMessageID), .integer(output.originalRevision),
                .bytes(output.exactCiphertext)]
    }

    private func decodeOutput(_ row: OpaquePointer) -> StoredOutput {
        let account = StoreAccount(ownerID: string(row, 0), senderDeviceID: string(row, 1), generation: sqlite3_column_int64(row, 2))
        let scope = StoreScope(account: account, recipientID: string(row, 3), recipientDeviceID: string(row, 4),
            identityKeyID: string(row, 5), identityGeneration: sqlite3_column_int64(row, 6))
        return StoredOutput(output: StoreOutput(scope: scope, clientMessageID: string(row, 7),
            originalRevision: sqlite3_column_int64(row, 8), exactCiphertext: data(row, 9)), cancelled: sqlite3_column_int(row, 10) == 1)
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func identifiers(_ values: String...) throws {
        for value in values {
            guard (1...128).contains(value.utf8.count), value.utf8.allSatisfy({
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 58, 95].contains($0)
            }) else { throw AtomicStoreError.invalidInput }
        }
    }

    private func validate(_ account: StoreAccount) throws {
        try identifiers(account.ownerID, account.senderDeviceID)
        guard account.generation > 0 else { throw AtomicStoreError.invalidInput }
    }

    private func validate(_ scope: StoreScope) throws {
        try validate(scope.account)
        try identifiers(scope.recipientID, scope.recipientDeviceID, scope.identityKeyID)
        guard scope.identityGeneration > 0 else { throw AtomicStoreError.invalidInput }
    }

    private func bytes(_ value: Data, maximum: Int) throws {
        guard !value.isEmpty, value.count <= maximum else { throw AtomicStoreError.invalidInput }
    }

    private func next(_ value: Int64) throws -> Int64 {
        guard value < Int64.max else { throw AtomicStoreError.generationExhausted }
        return value + 1
    }

    private func checked(_ result: Int32) throws {
        guard result == SQLITE_OK else { throw AtomicStoreError.database(result) }
    }

    private func prepare(_ sql: String, _ values: [Value]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        try checked(sqlite3_prepare_v2(db, sql, -1, &statement, nil))
        guard let statement else { throw AtomicStoreError.database(SQLITE_MISUSE) }
        do {
            for (offset, value) in values.enumerated() {
                let index = Int32(offset + 1)
                switch value {
                case let .text(text): try checked(sqlite3_bind_text(statement, index, text, -1, transient))
                case let .integer(integer): try checked(sqlite3_bind_int64(statement, index, integer))
                case let .bytes(bytes):
                    try bytes.withUnsafeBytes { pointer in
                        try checked(sqlite3_bind_blob(statement, index, pointer.baseAddress, Int32(pointer.count), transient))
                    }
                }
            }
            return statement
        } catch {
            sqlite3_finalize(statement)
            throw error
        }
    }

    private func execute(_ sql: String, _ values: [Value] = []) throws {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE else { throw AtomicStoreError.database(result) }
    }

    private func query<T>(_ sql: String, _ values: [Value] = [], decode: (OpaquePointer) -> T) throws -> [T] {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        var result: [T] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW else { throw AtomicStoreError.database(status) }
            result.append(decode(statement))
        }
    }

    private func integers(_ sql: String, _ values: [Value] = []) throws -> [Int64] {
        try query(sql, values) { sqlite3_column_int64($0, 0) }
    }

    private func string(_ row: OpaquePointer, _ column: Int32) -> String {
        String(cString: sqlite3_column_text(row, column))
    }

    private func data(_ row: OpaquePointer, _ column: Int32) -> Data {
        guard let bytes = sqlite3_column_blob(row, column) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(row, column)))
    }
}

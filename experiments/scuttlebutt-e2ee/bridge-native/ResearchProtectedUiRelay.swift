// Simulator-only protected UI evidence. Auth and the relay are
// synthetic in-memory fixtures; provider encryption and native persistence are
// exercised by their callers. This is not live Auth, a hosted relay or admission.
#if E2EE_LOCAL_UI_FIXTURE
import Foundation
import CoreFoundation
import CryptoKit

private enum ResearchProtectedUiRelayError: Error { case unavailable }

enum ResearchProtectedUiRelay {
    static let peerBearer = "research-protected-peer-fixture-bearer"
    static let peerUserID = "93000000-0000-4000-8000-000000000002"
    private static let basePath = "/functions/v1/scuttlebutt-e2ee-pilot"
    private static let shared = ResearchProtectedUiRelayState()

    private static func requireSimulator() throws {
#if targetEnvironment(simulator)
        guard Bundle.main.bundleIdentifier == ResearchAuthConfiguration.bundleID else {
            throw ResearchProtectedUiRelayError.unavailable
        }
#else
        // A mistakenly flagged physical build cannot reach either real endpoint.
        throw ResearchProtectedUiRelayError.unavailable
#endif
    }

    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        // Catch every request. A malformed URL is a refusal, never network I/O.
        configuration.protocolClasses = [ResearchProtectedUiRelayProtocol.self]
        return configuration
    }

    static func authenticator() throws -> VodozemacSupabaseAuth {
        try requireSimulator()
        return try VodozemacSupabaseAuth(projectOrigin: ResearchAuthConfiguration.origin,
            publicApiKey: ResearchLocalUiFixture.publicApiKey, deadlineSeconds: 5,
            configurationForResearch: { configuration() })
    }

    static func transport() throws -> VodozemacRelayTransport {
        try requireSimulator()
        return try VodozemacRelayTransport(serviceOrigin: ResearchAuthConfiguration.origin,
            serviceBasePath: basePath, deadlineSeconds: 5,
            configurationForResearch: { configuration() })
    }

    // Native trusted evidence only. No facade, coordinator, callbacks, raw
    // request/response bodies, public keys, bearers or plaintext cross this API.
    static func evidence() throws -> [String: Any] {
        try requireSimulator()
        return shared.evidence()
    }

    fileprivate static func response(for request: URLRequest) throws -> Data {
        try requireSimulator()
        return try shared.response(for: request)
    }
}

private final class ResearchProtectedUiRelayState: @unchecked Sendable {
    private static let requestLimit = 128
    private static let sendLimit = 16
    private static let claimLimit = 16
    private static let allowedActions = ["require-protected", "account-mode", "policy", "claim", "send", "list"]
    // Source-only fixed canaries. Their values are never part of evidence.
    private static let canaries: [(String, Data)] = [
        ("outgoing", Data("Protected UI outgoing canary".utf8)),
        ("peer", Data("Protected UI peer canary".utf8)),
        ("opener", Data("Protected UI opener canary".utf8))
    ]
    private let lock = NSLock()
    private var requestCount = 0
    private var methods = ["auth": 0, "register": 0, "dispatch": 0, "unexpected": 0]
    private var authCounters = ["host": 0, "peer": 0]
    private var actions = Dictionary(uniqueKeysWithValues: ResearchProtectedUiRelayState.allowedActions.map { ($0, 0) })
    private var signatures = ["registration": 0, "dispatch": 0]
    private var canaryAbsence = ["outgoing": true, "peer": true, "opener": true]
    private var registrations: [String: Registration] = [:]
    private var protectedUsers = Set<String>()
    private var requests: [RequestKey: SavedRequest] = [:]
    private var claims: [ClaimKey: SavedClaim] = [:]
    private var sends: [SendKey: SavedSend] = [:]
    private var acceptedSends: [SavedSend] = []

    private struct Registration {
        let bundle: DmRelayBundle
        let wire: String
    }
    private struct Frame: Decodable {
        let version: Int
        let protocolName: String
        let userId: String
        let deviceId: String
        let action: String
        let requestId: String
        let expiresAt: Int64
        let payload: String
        let signature: String
        private enum CodingKeys: String, CodingKey {
            case version, userId, deviceId, action, requestId, expiresAt, payload, signature
            case protocolName = "protocol"
        }
    }
    private struct RequestKey: Hashable { let user: String; let device: String; let id: String }
    private struct SavedRequest { let wire: Data; let result: Data }
    private struct ClaimKey: Hashable { let user: String; let device: String; let id: String }
    private struct SavedClaim {
        let targetUser: String
        let targetDevice: String
        let targetPrekeyID: String
        let result: Data
    }
    private struct SendKey: Hashable {
        let user: String
        let device: String
        let message: String
        let recipientDevice: String
    }
    private struct SavedSend {
        let serverID: Int64
        let record: DmOutboxRecord
        let envelope: DmEnvelope
        let result: Data
        let hash: String
    }
    private enum Payload {
        case mode
        case policy([String])
        case claim([String])
        case send(DmOutboxRecord, DmEnvelope)
        case list(Int64, Int)
    }

    func evidence() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["version": 1, "methodCounters": methods, "authCounters": authCounters,
            "actionCounters": actions, "acceptedEnvelopeSHA256": acceptedSends.map { $0.hash },
            "signatureVerificationCounts": signatures, "canaryAbsence": canaryAbsence,
            "acceptedSendCount": acceptedSends.count]
    }

    func response(for request: URLRequest) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        requestCount = min(Self.requestLimit + 1, requestCount + 1)
        do {
            guard requestCount <= Self.requestLimit, let url = request.url,
                  let principal = principal(request) else { throw unavailable }
            let authURL = ResearchAuthConfiguration.origin + "/auth/v1/user"
            let relayURL = ResearchAuthConfiguration.origin + "/functions/v1/scuttlebutt-e2ee-pilot"
            let result: Data
            if url.absoluteString == authURL {
                increment("auth", in: &methods)
                guard request.httpMethod == "GET", request.httpBody == nil, request.httpBodyStream == nil,
                      request.value(forHTTPHeaderField: "apikey") == ResearchLocalUiFixture.publicApiKey,
                      request.value(forHTTPHeaderField: "Accept") == "application/json" else { throw unavailable }
                increment(principal.alias, in: &authCounters)
                result = try json(["id": principal.user])
            } else if url.absoluteString == relayURL + "/v1/register" {
                increment("register", in: &methods)
                try requireRelayHeaders(request)
                let body = try body(request, limit: 4096)
                try checkCanaries(body)
                result = try wrapped(register(body, user: principal.user))
            } else if url.absoluteString == relayURL + "/v1/dispatch" {
                increment("dispatch", in: &methods)
                try requireRelayHeaders(request)
                let body = try body(request, limit: DmRelayCodec.maxRequestBytes)
                try checkCanaries(body)
                result = try wrapped(dispatch(body, user: principal.user))
            } else { throw unavailable }
            try checkCanaries(result)
            return result
        } catch {
            increment("unexpected", in: &methods)
            // The caller gets one fixed failure and cannot observe parser details.
            throw unavailable
        }
    }

    private var unavailable: ResearchProtectedUiRelayError { .unavailable }

    private func increment(_ name: String, in counts: inout [String: Int]) {
        counts[name] = min(Self.requestLimit + 1, (counts[name] ?? 0) + 1)
    }

    private func principal(_ request: URLRequest) -> (user: String, alias: String)? {
        switch request.value(forHTTPHeaderField: "Authorization") {
        case "Bearer " + ResearchLocalUiFixture.bearer: return (ResearchLocalUiFixture.userID, "host")
        case "Bearer " + ResearchProtectedUiRelay.peerBearer: return (ResearchProtectedUiRelay.peerUserID, "peer")
        default: return nil
        }
    }

    private func requireRelayHeaders(_ request: URLRequest) throws {
        guard request.httpMethod == "POST",
              request.value(forHTTPHeaderField: "Content-Type") == "application/json",
              request.value(forHTTPHeaderField: "Accept") == "application/json" else { throw unavailable }
    }

    private func body(_ request: URLRequest, limit: Int) throws -> Data {
        if let bytes = request.httpBody {
            guard request.httpBodyStream == nil, !bytes.isEmpty, bytes.count <= limit else { throw unavailable }
            return bytes
        }
        guard let stream = request.httpBodyStream else { throw unavailable }
        stream.open(); defer { stream.close() }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: min(buffer.count, limit - bytes.count + 1))
            guard count >= 0 else { throw unavailable }
            if count == 0 { break }
            guard count <= limit - bytes.count else { throw unavailable }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard !bytes.isEmpty else { throw unavailable }
        return bytes
    }

    private func checkCanaries(_ data: Data) throws {
        for (name, value) in Self.canaries where data.range(of: value) != nil { canaryAbsence[name] = false }
        guard canaryAbsence.values.allSatisfy({ $0 }) else { throw unavailable }
    }

    private func register(_ body: Data, user: String) throws -> Data {
        guard let wire = String(data: body, encoding: .utf8) else { throw unavailable }
        let bundle = try DmRelayCodec.verifyBundle(wire, now: now())
        guard bundle.userId == user,
              registrations.values.allSatisfy({ $0.bundle.userId == user || $0.bundle.deviceId != bundle.deviceId }) else {
            throw unavailable
        }
        increment("registration", in: &signatures)
        if let saved = registrations[user] {
            guard saved.wire.utf8.elementsEqual(wire.utf8) else { throw unavailable }
        } else {
            guard registrations.count < 2 else { throw unavailable }
            registrations[user] = Registration(bundle: bundle, wire: wire)
        }
        return try json(["registered": true, "userId": user, "deviceId": bundle.deviceId])
    }

    private func dispatch(_ body: Data, user: String) throws -> Data {
        let frame = try JSONDecoder().decode(Frame.self, from: body)
        guard frame.version == 1, frame.protocolName == "olm-v1", frame.userId == user,
              Self.allowedActions.contains(frame.action), let registration = registrations[user],
              registration.bundle.deviceId == frame.deviceId else { throw unavailable }
        let owner = DmOwnerContext(userId: user, deviceId: frame.deviceId, generation: 0)
        try DmRelayCodec.expiry(frame.expiresAt, now: now(), maximum: 300)
        guard try DmRelayCodec.requestWire(owner: owner, action: frame.action, requestId: frame.requestId,
            expiresAt: frame.expiresAt, payload: frame.payload, signature: frame.signature).utf8.elementsEqual(body) else {
            throw unavailable
        }
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: DmRelayCodec.keyBytes(registration.bundle.signingKey))
        guard key.isValidSignature(try DmRelayCodec.keyBytes(frame.signature, count: 64),
            for: try DmRelayCodec.requestSigningBytes(owner: owner, action: frame.action,
                requestId: frame.requestId, expiresAt: frame.expiresAt, payload: frame.payload)) else { throw unavailable }
        increment("dispatch", in: &signatures)
        let payload = try validatePayload(frame)
        increment(frame.action, in: &actions)
        let requestKey = RequestKey(user: user, device: frame.deviceId, id: frame.requestId)
        if let saved = requests[requestKey] {
            guard saved.wire == body else { throw unavailable }
            if case .claim(let target) = payload {
                // A cached nonce cannot make an expired target prekey usable.
                let current = try claim(target, owner: frame)
                guard current == saved.result else { throw unavailable }
            }
            // Mode/policy diagnostics always describe current state. Mutation,
            // claim and list replays retain their exact immutable result bytes.
            if frame.action != "account-mode" && frame.action != "policy" { return saved.result }
        }
        let result: Data
        switch payload {
        case .mode:
            if frame.action == "require-protected" { protectedUsers.insert(user) }
            result = try json(["requestId": frame.requestId, "ownerUserId": user,
                "ownerDeviceId": frame.deviceId,
                "mode": protectedUsers.contains(user) ? "protected-required" : "legacy-permitted"])
        case .policy(let target):
            let peer = try targetRegistration(target, owner: frame, identityKey: true)
            result = try json(["requestId": frame.requestId, "ownerUserId": user, "ownerDeviceId": frame.deviceId,
                "peerUserId": peer.bundle.userId, "peerDeviceId": peer.bundle.deviceId,
                "peerIdentityKeyId": peer.bundle.identityKeyId,
                "ownerRevoked": false, "peerRevoked": false, "blockedByMe": false, "blockedByPeer": false])
        case .claim(let target):
            result = try claim(target, owner: frame)
        case .send(let record, let envelope):
            result = try send(record, envelope: envelope, owner: frame)
        case .list(let afterID, let batch):
            guard protectedUsers.contains(user) else { throw unavailable }
            let rows = acceptedSends.filter { $0.serverID > afterID && $0.record.recipientUserId == user
                && $0.envelope.recipientDeviceId == frame.deviceId }.prefix(batch)
            result = try json(rows.map { saved -> [String: Any] in
                var fields = recordFields(saved.record)
                fields["accepted"] = true; fields["serverId"] = saved.serverID
                return fields
            })
        }
        guard requests.count < Self.requestLimit || requests[requestKey] != nil else { throw unavailable }
        requests[requestKey] = SavedRequest(wire: body, result: result)
        return result
    }

    private func validatePayload(_ frame: Frame) throws -> Payload {
        switch frame.action {
        case "require-protected", "account-mode":
            guard frame.payload == "[]" else { throw unavailable }
            return .mode
        case "claim", "policy":
            guard let target = try JSONSerialization.jsonObject(with: Data(frame.payload.utf8)) as? [String],
                  target.count == 3 else { throw unavailable }
            for value in target { try DmContentCodec.validateIdentifier(value) }
            let canonical = "[" + (try target.map(DmRelayCodec.quote)).joined(separator: ",") + "]"
            guard canonical.utf8.elementsEqual(frame.payload.utf8), target[0] != frame.userId,
                  target[1] != frame.deviceId else { throw unavailable }
            return frame.action == "claim" ? .claim(target) : .policy(target)
        case "send":
            // Same public verification semantics as dmScopedEnrollmentSendRecord:
            // authenticate the frame, canonical record and sender-device envelope.
            let record = try JSONDecoder().decode(DmOutboxRecord.self, from: Data(frame.payload.utf8))
            let envelope = try DmEnvelope.decode(record.serializedEnvelope)
            guard let providerBytes = Data(base64Encoded: envelope.ciphertext) else { throw unavailable }
            try checkCanaries(providerBytes)
            guard record.ownerUserId == frame.userId, record.ownerUserId != record.recipientUserId,
                  envelope.senderDeviceId == frame.deviceId, envelope.recipientDeviceId != frame.deviceId,
                  try DmRelayCodec.outboxWire(record).utf8.elementsEqual(frame.payload.utf8) else { throw unavailable }
            return .send(record, envelope)
        case "list":
            guard let parts = try JSONSerialization.jsonObject(with: Data(frame.payload.utf8)) as? [Any], parts.count == 2,
                  let afterID = integer(parts[0], range: 0...DmRelayCodec.maxSafeInteger),
                  let batch = integer(parts[1], range: 1...16),
                  frame.payload == "[\(afterID),\(batch)]" else { throw unavailable }
            return .list(afterID, Int(batch))
        default: throw unavailable
        }
    }

    private func targetRegistration(_ target: [String], owner: Frame, identityKey: Bool) throws -> Registration {
        guard let peer = registrations[target[0]], peer.bundle.deviceId == target[1],
              peer.bundle.userId != owner.userId, peer.bundle.deviceId != owner.deviceId,
              !identityKey || peer.bundle.identityKeyId == target[2] else { throw unavailable }
        return peer
    }

    private func claim(_ target: [String], owner: Frame) throws -> Data {
        let peer = try targetRegistration(target, owner: owner, identityKey: false)
        guard owner.deviceId.utf8.lexicographicallyPrecedes(peer.bundle.deviceId.utf8),
              peer.bundle.expiresAt > now(), protectedUsers.contains(owner.userId),
              protectedUsers.contains(peer.bundle.userId) else { throw unavailable }
        let key = ClaimKey(user: owner.userId, device: owner.deviceId, id: target[2])
        if let saved = claims[key] {
            guard saved.targetUser == peer.bundle.userId, saved.targetDevice == peer.bundle.deviceId,
                  saved.targetPrekeyID == peer.bundle.prekeyId else { throw unavailable }
            return saved.result
        }
        guard claims.count < Self.claimLimit,
              !claims.values.contains(where: { $0.targetDevice == peer.bundle.deviceId }) else { throw unavailable }
        let result = try json(["signedBundle": peer.wire, "prekeyId": peer.bundle.prekeyId, "prekey": peer.bundle.prekey])
        claims[key] = SavedClaim(targetUser: peer.bundle.userId, targetDevice: peer.bundle.deviceId,
            targetPrekeyID: peer.bundle.prekeyId, result: result)
        return result
    }

    private func send(_ record: DmOutboxRecord, envelope: DmEnvelope, owner: Frame) throws -> Data {
        guard let peer = registrations[record.recipientUserId], peer.bundle.deviceId == envelope.recipientDeviceId,
              peer.bundle.identityKeyId == record.recipientIdentityKeyId,
              protectedUsers.contains(owner.userId), protectedUsers.contains(peer.bundle.userId),
              claims.contains(where: { entry in
                  (entry.key.user == owner.userId && entry.key.device == owner.deviceId
                    && entry.value.targetUser == peer.bundle.userId && entry.value.targetDevice == peer.bundle.deviceId)
                  || (entry.key.user == peer.bundle.userId && entry.key.device == peer.bundle.deviceId
                    && entry.value.targetUser == owner.userId && entry.value.targetDevice == owner.deviceId)
              }), envelope.messageType != "prekey"
                || owner.deviceId.utf8.lexicographicallyPrecedes(peer.bundle.deviceId.utf8) else { throw unavailable }
        let key = SendKey(user: owner.userId, device: owner.deviceId, message: envelope.clientMessageId,
            recipientDevice: envelope.recipientDeviceId)
        if let saved = sends[key] {
            guard saved.record == record else { throw unavailable }
            return saved.result
        }
        guard acceptedSends.count < Self.sendLimit else { throw unavailable }
        if acceptedSends.isEmpty { guard envelope.messageType == "prekey" else { throw unavailable } }
        var fields = recordFields(record); fields["accepted"] = true
        let result = try json(fields)
        let hash = SHA256.hash(data: Data(record.serializedEnvelope.utf8)).map { String(format: "%02x", $0) }.joined()
        let saved = SavedSend(serverID: Int64(acceptedSends.count + 1), record: record, envelope: envelope,
            result: result, hash: hash)
        sends[key] = saved; acceptedSends.append(saved)
        return result
    }

    private func recordFields(_ record: DmOutboxRecord) -> [String: Any] {
        ["ownerUserId": record.ownerUserId, "ownerSessionGeneration": record.ownerSessionGeneration,
            "recipientUserId": record.recipientUserId, "recipientIdentityKeyId": record.recipientIdentityKeyId,
            "recipientIdentityGeneration": record.recipientIdentityGeneration, "serializedEnvelope": record.serializedEnvelope]
    }

    private func integer(_ value: Any, range: ClosedRange<Int64>) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue == Double(number.int64Value),
              range.contains(number.int64Value) else { return nil }
        return number.int64Value
    }

    private func now() -> Int64 { Int64(Date().timeIntervalSince1970) }

    private func json(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func wrapped(_ result: Data) throws -> Data {
        var bytes = Data("{\"version\":1,\"result\":".utf8)
        bytes.append(result); bytes.append(Data("}".utf8))
        guard bytes.count <= DmRelayResultCodec.maxResponseBytes else { throw unavailable }
        return bytes
    }
}

private final class ResearchProtectedUiRelayProtocol: URLProtocol {
    private let stateLock = NSRecursiveLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let data = try ResearchProtectedUiRelay.response(for: request)
            guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json",
                    "Cache-Control": "no-store", "Content-Length": String(data.count)]) else {
                throw ResearchProtectedUiRelayError.unavailable
            }
            stateLock.lock(); defer { stateLock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            guard !stopped else { return }
            client?.urlProtocol(self, didLoad: data)
            guard !stopped else { return }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            stateLock.lock(); defer { stateLock.unlock() }
            if !stopped { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)) }
        }
    }

    override func stopLoading() {
        stateLock.lock(); stopped = true; stateLock.unlock()
    }
}
#endif

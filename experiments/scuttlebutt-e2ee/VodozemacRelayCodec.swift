// ISOLATED RESEARCH. Public wire codecs only, never private key or pickle transport.
// Array domains and object ordering deliberately match relay/*.ts byte for byte.
import Foundation
import CryptoKit

struct DmRelayBundle: Codable {
    let version: Int
    let `protocol`: String
    let userId: String
    let deviceId: String
    let identityKeyId: String
    let signingKey: String
    let curveKey: String
    let prekeyId: String
    let prekey: String
    let expiresAt: Int64
    let signature: String
}

enum DmRelayCodec {
    static let maxRequestBytes = 100 * 1024
    static let maxSafeInteger: Int64 = 9_007_199_254_740_991

    static func quote(_ value: String) throws -> String {
        guard value.utf8.allSatisfy({ (32...126).contains($0) }) else { throw DmCoordinatorError.invalidInput }
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        guard let result = String(data: bytes, encoding: .utf8) else { throw DmCoordinatorError.invalidInput }
        return result
    }

    static func keyBytes(_ value: String, count: Int = 32) throws -> Data {
        let padding = count == 32 ? "=" : "=="
        guard value.utf8.count == (count == 32 ? 43 : 86), let bytes = Data(base64Encoded: value + padding),
              bytes.count == count, bytes.base64EncodedString() == value + padding else { throw DmCoordinatorError.invalidInput }
        return bytes
    }

    static func expiry(_ expiresAt: Int64, now: Int64, maximum: Int64) throws {
        guard now > 0, now <= maxSafeInteger - maximum,
              expiresAt > now, expiresAt <= now + maximum else { throw DmCoordinatorError.invalidInput }
    }

    static func bundleUnsigned(_ identity: DmPublicIdentity, prekeyId: String, expiresAt: Int64) throws -> [String] {
        for value in [identity.userId, identity.deviceId, identity.identityKeyId, prekeyId] {
            try DmContentCodec.validateIdentifier(value)
        }
        for key in [identity.signingKey, identity.curve, identity.prekey] { _ = try keyBytes(key) }
        return ["1", try quote("olm-v1"), try quote(identity.userId), try quote(identity.deviceId),
                try quote(identity.identityKeyId), try quote(identity.signingKey), try quote(identity.curve),
                try quote(prekeyId), try quote(identity.prekey), String(expiresAt)]
    }

    static func bundleSigningBytes(_ identity: DmPublicIdentity, prekeyId: String, expiresAt: Int64) throws -> Data {
        Data(("[" + ([(try quote("thalassa-device-bundle"))] + (try bundleUnsigned(identity, prekeyId: prekeyId, expiresAt: expiresAt))).joined(separator: ",") + "]").utf8)
    }

    static func bundleWire(_ identity: DmPublicIdentity, prekeyId: String, expiresAt: Int64, signature: String) throws -> String {
        _ = try keyBytes(signature, count: 64)
        let names = ["version", "protocol", "userId", "deviceId", "identityKeyId", "signingKey", "curveKey", "prekeyId", "prekey", "expiresAt", "signature"]
        let values = try bundleUnsigned(identity, prekeyId: prekeyId, expiresAt: expiresAt) + [quote(signature)]
        return "{" + (try zip(names, values).map { try quote($0.0) + ":" + $0.1 }).joined(separator: ",") + "}"
    }

    // Verification is not first-use authentication. Caller must compare the
    // claimed bundle to an independently pinned identity before using its keys.
    static func verifyBundle(_ wire: String, now: Int64) throws -> DmRelayBundle {
        let bundle = try verifyStoredBundle(wire)
        try expiry(bundle.expiresAt, now: now, maximum: 7 * 24 * 60 * 60)
        return bundle
    }

    // Check immutable saved bytes, not their present-day usability. An expired
    // previously verified claim remains readable historical evidence; opening
    // the store must not silently replace its identity or renew its prekey.
    static func verifyStoredBundle(_ wire: String) throws -> DmRelayBundle {
        guard wire.utf8.count <= 4096, wire.utf8.allSatisfy({ (32...126).contains($0) }) else { throw DmCoordinatorError.invalidInput }
        let bundle: DmRelayBundle
        do { bundle = try JSONDecoder().decode(DmRelayBundle.self, from: Data(wire.utf8)) }
        catch { throw DmCoordinatorError.invalidInput }
        guard bundle.version == 1, bundle.protocol == "olm-v1",
              (1...maxSafeInteger).contains(bundle.expiresAt) else { throw DmCoordinatorError.invalidInput }
        let identity = DmPublicIdentity(userId: bundle.userId, deviceId: bundle.deviceId, identityKeyId: bundle.identityKeyId,
                                      signingKey: bundle.signingKey, curve: bundle.curveKey, prekey: bundle.prekey)
        let canonical = try bundleWire(identity, prekeyId: bundle.prekeyId, expiresAt: bundle.expiresAt, signature: bundle.signature)
        guard canonical.utf8.elementsEqual(wire.utf8) else { throw DmCoordinatorError.invalidInput }
        do {
            let key = try Curve25519.Signing.PublicKey(rawRepresentation: keyBytes(bundle.signingKey))
            guard key.isValidSignature(try keyBytes(bundle.signature, count: 64),
                for: try bundleSigningBytes(identity, prekeyId: bundle.prekeyId, expiresAt: bundle.expiresAt)) else {
                throw DmCoordinatorError.invalidInput
            }
        } catch { throw DmCoordinatorError.invalidInput }
        return bundle
    }

    static func outboxWire(_ record: DmOutboxRecord) throws -> String {
        for id in [record.ownerUserId, record.recipientUserId, record.recipientIdentityKeyId] { try DmContentCodec.validateIdentifier(id) }
        _ = try DmEnvelope.decode(record.serializedEnvelope)
        guard (0...maxSafeInteger).contains(record.ownerSessionGeneration),
              (0...maxSafeInteger).contains(record.recipientIdentityGeneration) else { throw DmCoordinatorError.invalidInput }
        return "{\"ownerUserId\":" + (try quote(record.ownerUserId)) + ",\"ownerSessionGeneration\":" + String(record.ownerSessionGeneration)
            + ",\"recipientUserId\":" + (try quote(record.recipientUserId)) + ",\"recipientIdentityKeyId\":" + (try quote(record.recipientIdentityKeyId))
            + ",\"recipientIdentityGeneration\":" + String(record.recipientIdentityGeneration)
            + ",\"serializedEnvelope\":" + (try quote(record.serializedEnvelope)) + "}"
    }

    static func requestValues(owner: DmOwnerContext, action: String, requestId: String, expiresAt: Int64, payload: String) throws -> [String] {
        for id in [owner.userId, owner.deviceId, requestId] { try DmContentCodec.validateIdentifier(id) }
        guard ["claim", "send", "list", "block", "revoke", "policy", "require-protected", "account-mode"].contains(action),
              !["require-protected", "account-mode"].contains(action) || payload == "[]",
              payload.utf8.count <= maxRequestBytes, payload.utf8.allSatisfy({ (32...126).contains($0) }) else { throw DmCoordinatorError.invalidInput }
        return ["1", try quote("olm-v1"), try quote(owner.userId), try quote(owner.deviceId),
                try quote(action), try quote(requestId), String(expiresAt), try quote(payload)]
    }

    static func requestSigningBytes(owner: DmOwnerContext, action: String, requestId: String, expiresAt: Int64, payload: String) throws -> Data {
        let values = try requestValues(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt, payload: payload)
        let bytes = Data(("[" + ([try quote("thalassa-relay-request")] + values).joined(separator: ",") + "]").utf8)
        guard bytes.count <= maxRequestBytes else { throw DmCoordinatorError.invalidInput }
        return bytes
    }

    static func requestWire(owner: DmOwnerContext, action: String, requestId: String, expiresAt: Int64, payload: String, signature: String) throws -> String {
        _ = try keyBytes(signature, count: 64)
        let names = ["version", "protocol", "userId", "deviceId", "action", "requestId", "expiresAt", "payload", "signature"]
        let values = try requestValues(owner: owner, action: action, requestId: requestId, expiresAt: expiresAt, payload: payload) + [quote(signature)]
        let wire = "{" + (try zip(names, values).map { try quote($0.0) + ":" + $0.1 }).joined(separator: ",") + "}"
        guard wire.utf8.count <= maxRequestBytes else { throw DmCoordinatorError.invalidInput }
        return wire
    }
}

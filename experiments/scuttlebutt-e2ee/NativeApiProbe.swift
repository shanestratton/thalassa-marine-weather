// Research only. Not compiled into Thalassa. Fresh in-memory identities, no user keys.
import Foundation
import LibSignalClient

private enum ProbeFailure: Error { case assertion, unsupportedMessage }
private func require(_ condition: Bool) throws {
    if !condition { throw ProbeFailure.assertion }
}

private final class Participant {
    let address: ProtocolAddress
    let store = InMemorySignalProtocolStore()
    let context = NullContext()
    init(name: String) throws { address = try ProtocolAddress(name: name, deviceId: 1) }

    func bundle() throws -> PreKeyBundle {
        let oneTime = PrivateKey.generate()
        let signed = PrivateKey.generate()
        let kem = KEMKeyPair.generate()
        let identity = try store.identityKeyPair(context: context)
        let signature = identity.privateKey.generateSignature(message: signed.publicKey.serialize())
        let kemSignature = identity.privateKey.generateSignature(message: kem.publicKey.serialize())
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        try store.storePreKey(PreKeyRecord(id: 1, privateKey: oneTime), id: 1, context: context)
        try store.storeSignedPreKey(
            SignedPreKeyRecord(id: 2, timestamp: timestamp, privateKey: signed, signature: signature),
            id: 2, context: context)
        try store.storeKyberPreKey(
            KyberPreKeyRecord(id: 3, timestamp: timestamp, keyPair: kem, signature: kemSignature),
            id: 3, context: context)
        return try PreKeyBundle(
            registrationId: store.localRegistrationId(context: context), deviceId: 1,
            prekeyId: 1, prekey: oneTime.publicKey,
            signedPrekeyId: 2, signedPrekey: signed.publicKey, signedPrekeySignature: signature,
            identity: identity.identityKey,
            kyberPrekeyId: 3, kyberPrekey: kem.publicKey, kyberPrekeySignature: kemSignature)
    }

    func establish(with peer: Participant) throws {
        try processPreKeyBundle(peer.bundle(), for: peer.address, ourAddress: address,
            sessionStore: store, identityStore: store, context: context)
    }
    func encrypt(_ value: Data, to peer: Participant) throws -> CiphertextMessage {
        // This is NOT a negotiated-suite getter or fingerprint verification.
        guard let session = try store.loadSession(for: peer.address, context: context),
              session.hasCurrentState else { throw ProbeFailure.assertion }
        return try signalEncrypt(message: value, for: peer.address, localAddress: address,
            sessionStore: store, identityStore: store, context: context)
    }
    func decrypt(_ bytes: Data, type: CiphertextMessage.MessageType, from peer: Participant) throws -> Data {
        switch type {
        case .preKey:
            return try signalDecryptPreKey(message: PreKeySignalMessage(bytes: bytes),
                from: peer.address, localAddress: address, sessionStore: store, identityStore: store,
                preKeyStore: store, signedPreKeyStore: store, kyberPreKeyStore: store, context: context)
        case .whisper:
            return try signalDecrypt(message: SignalMessage(bytes: bytes), from: peer.address,
                to: address, sessionStore: store, identityStore: store, context: context)
        default: throw ProbeFailure.unsupportedMessage
        }
    }
}

private func rejects(_ attempt: () throws -> Void) throws {
    var rejected = false
    do { try attempt() } catch { rejected = true }
    try require(rejected)
}

@main
private enum NativeApiProbe {
    static func main() throws {
        let first = try Participant(name: "native-probe-first")
        let second = try Participant(name: "native-probe-second")
        try first.establish(with: second)
        let openingText = Data("Synthetic native handshake".utf8)
        let opening = try first.encrypt(openingText, to: second)
        try require(opening.messageType == .preKey)
        try require(second.decrypt(opening.serialize(), type: opening.messageType, from: first) == openingText)
        let replyText = Data("Synthetic native reply".utf8)
        let reply = try second.encrypt(replyText, to: first)
        try require(reply.messageType == .whisper)
        try require(first.decrypt(reply.serialize(), type: reply.messageType, from: second) == replyText)
        try rejects { _ = try first.decrypt(reply.serialize(), type: reply.messageType, from: second) }
        let older = try first.encrypt(Data([1]), to: second)
        let newer = try first.encrypt(Data([2]), to: second)
        try require(second.decrypt(newer.serialize(), type: newer.messageType, from: first) == Data([2]))
        try require(second.decrypt(older.serialize(), type: older.messageType, from: first) == Data([1]))
        let valid = try second.encrypt(Data([3]), to: first)
        var damaged = valid.serialize()
        damaged[damaged.count - 1] ^= 0x01
        try rejects { _ = try first.decrypt(damaged, type: valid.messageType, from: second) }
        try require(first.decrypt(valid.serialize(), type: valid.messageType, from: second) == Data([3]))
        for round in 0..<40 {
            let text = Data("Synthetic round \(round)".utf8)
            let outgoing = try first.encrypt(text, to: second)
            try require(second.decrypt(outgoing.serialize(), type: outgoing.messageType, from: first) == text)
            let incoming = try second.encrypt(text, to: first)
            try require(first.decrypt(incoming.serialize(), type: incoming.messageType, from: second) == text)
        }
        let replacement = try Participant(name: "native-probe-second")
        try rejects { try first.establish(with: replacement) }
        print("PASS native provider exchange, replay, tamper, ordering, identity-change checks")
        print("Research only: in-memory stores; not two iPhones or a negotiated-suite UI assertion")
    }
}

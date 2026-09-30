// Isolated research framing only. The unchanged provider authenticates/encrypts
// this content; outer JSON alone establishes neither secrecy nor sender trust.
import Foundation

enum DmFrameError: Error { case invalidInput }

struct DmEnvelope: Codable, Equatable {
    let version: Int
    let protocolName: String
    let messageType: String
    let clientMessageId: String
    let senderDeviceId: String
    let recipientDeviceId: String
    let ciphertext: String

    enum CodingKeys: String, CodingKey {
        case version, messageType, clientMessageId, senderDeviceId, recipientDeviceId, ciphertext
        case protocolName = "protocol"
    }

    private static let maxBase64Bytes = 4 * ((DmContentCodec.maxWireBytes + 2) / 3)
    private static let maxEnvelopeBytes = maxBase64Bytes + 3 * 128 + 1024

    init(clientMessageId: String, senderDeviceId: String, recipientDeviceId: String,
         wire: WireMessage) throws {
        guard wire.messageType <= 1, !wire.body.isEmpty,
              wire.body.count <= DmContentCodec.maxWireBytes else { throw DmFrameError.invalidInput }
        version = 2
        protocolName = "olm-v1"
        messageType = wire.messageType == 0 ? "prekey" : "session"
        self.clientMessageId = clientMessageId
        self.senderDeviceId = senderDeviceId
        self.recipientDeviceId = recipientDeviceId
        ciphertext = wire.body.base64EncodedString()
        _ = try validatedBody()
    }

    // Match encodeDirectMessageEnvelope's field order and JSON spelling exactly.
    // Validated IDs and padded Base64 contain no JSON escaping characters.
    func serialized() throws -> String {
        _ = try validatedBody()
        return "{\"version\":2,\"protocol\":\"olm-v1\",\"messageType\":\"\(messageType)\",\"clientMessageId\":\"\(clientMessageId)\",\"senderDeviceId\":\"\(senderDeviceId)\",\"recipientDeviceId\":\"\(recipientDeviceId)\",\"ciphertext\":\"\(ciphertext)\"}"
    }

    static func decode(_ value: String) throws -> DmEnvelope {
        // Bound UTF-8 input before allocating a parser or decoded provider bytes.
        guard value.utf8.count <= maxEnvelopeBytes else { throw DmFrameError.invalidInput }
        do {
            let input = Data(value.utf8)
            let frame = try JSONDecoder().decode(DmEnvelope.self, from: input)
            // Exact bytes reject unknown/duplicate keys, alternate order, escaped
            // spellings, whitespace and noncanonical JSON numbers. String ==
            // would instead permit Unicode canonical equivalence.
            guard Data(try frame.serialized().utf8) == input else { throw DmFrameError.invalidInput }
            return frame
        } catch { throw DmFrameError.invalidInput }
    }

    var wire: WireMessage {
        get throws {
            WireMessage(messageType: messageType == "prekey" ? 0 : 1, body: try validatedBody())
        }
    }

    private func validatedBody() throws -> Data {
        guard version == 2, protocolName == "olm-v1",
              messageType == "prekey" || messageType == "session",
              !ciphertext.isEmpty, ciphertext.utf8.count <= Self.maxBase64Bytes else {
            throw DmFrameError.invalidInput
        }
        try DmContentCodec.validateIdentifier(clientMessageId)
        try DmContentCodec.validateIdentifier(senderDeviceId)
        try DmContentCodec.validateIdentifier(recipientDeviceId)
        guard let body = Data(base64Encoded: ciphertext), !body.isEmpty,
              body.count <= DmContentCodec.maxWireBytes,
              body.base64EncodedString() == ciphertext else { throw DmFrameError.invalidInput }
        return body
    }
}

struct DmAuthenticatedContext: Codable, Equatable {
    let conversationId: String
    let clientMessageId: String
    let senderUserId: String
    let senderDeviceId: String
    let recipientUserId: String
    let recipientDeviceId: String
    let senderIdentityKeyId: String
    let recipientIdentityKeyId: String
    let senderCurve: String
    let recipientCurve: String
    let sessionId: String
}

enum DmContentCodec {
    static let maxTextBytes = 16 * 1024
    static let maxWireBytes = 65 * 1024
    private static let maxContentBytes = 64 * 1024

    static func encode(context: DmAuthenticatedContext, text: String) throws -> Data {
        try validateContext(context)
        guard text.utf8.count <= maxTextBytes else { throw DmFrameError.invalidInput }
        do {
            let bytes = try JSONEncoder().encode(AuthenticatedContent(context: context, text: text))
            guard bytes.count <= maxContentBytes else { throw DmFrameError.invalidInput }
            return bytes
        } catch { throw DmFrameError.invalidInput }
    }

    static func decode(_ data: Data, expected: DmAuthenticatedContext) throws -> String {
        guard data.count <= maxContentBytes else { throw DmFrameError.invalidInput }
        try validateContext(expected)
        do {
            let content = try JSONDecoder().decode(AuthenticatedContent.self, from: data)
            try validateContext(content.context)
            guard content.context == expected, content.text.utf8.count <= maxTextBytes else {
                throw DmFrameError.invalidInput
            }
            return content.text
        } catch { throw DmFrameError.invalidInput }
    }

    static func validateIdentifier(_ value: String) throws {
        guard (1...128).contains(value.utf8.count), value.utf8.allSatisfy({ byte in
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
                || byte == 46 || byte == 95 || byte == 58 || byte == 45
        }) else { throw DmFrameError.invalidInput }
    }

    private static func validateContext(_ context: DmAuthenticatedContext) throws {
        for identifier in [context.conversationId, context.clientMessageId,
                           context.senderUserId, context.senderDeviceId,
                           context.recipientUserId, context.recipientDeviceId,
                           context.senderIdentityKeyId, context.recipientIdentityKeyId] {
            try validateIdentifier(identifier)
        }
        // Provider session IDs, like Curve25519 public keys, are canonical
        // unpadded Base64 for 32 bytes, not application identifiers.
        for encoded in [context.senderCurve, context.recipientCurve, context.sessionId] {
            guard encoded.utf8.count == 43, let bytes = Data(base64Encoded: encoded + "="),
                  bytes.count == 32, bytes.base64EncodedString() == encoded + "=" else {
                throw DmFrameError.invalidInput
            }
        }
    }

    // A fixed positional array has no duplicate object-key interpretation. The
    // schema/domain/suite/type prefix is authenticated along with every context
    // field. This is a Thalassa payload, not a provider or Matrix event format.
    private struct AuthenticatedContent: Codable {
        let context: DmAuthenticatedContext
        let text: String

        init(context: DmAuthenticatedContext, text: String) {
            self.context = context
            self.text = text
        }

        init(from decoder: Decoder) throws {
            var fields = try decoder.unkeyedContainer()
            guard fields.count == 17,
                  try fields.decode(String.self) == "thalassa-private-dm",
                  try fields.decode(Int.self) == 1,
                  try fields.decode(Int.self) == 2,
                  try fields.decode(String.self) == "olm-v1",
                  try fields.decode(String.self) == "text" else { throw DmFrameError.invalidInput }
            context = try DmAuthenticatedContext(
                conversationId: fields.decode(String.self), clientMessageId: fields.decode(String.self),
                senderUserId: fields.decode(String.self), senderDeviceId: fields.decode(String.self),
                recipientUserId: fields.decode(String.self), recipientDeviceId: fields.decode(String.self),
                senderIdentityKeyId: fields.decode(String.self), recipientIdentityKeyId: fields.decode(String.self),
                senderCurve: fields.decode(String.self), recipientCurve: fields.decode(String.self),
                sessionId: fields.decode(String.self))
            text = try fields.decode(String.self)
            guard fields.isAtEnd else { throw DmFrameError.invalidInput }
        }

        func encode(to encoder: Encoder) throws {
            var fields = encoder.unkeyedContainer()
            try fields.encode("thalassa-private-dm")
            try fields.encode(1)
            try fields.encode(2)
            try fields.encode("olm-v1")
            try fields.encode("text")
            for field in [context.conversationId, context.clientMessageId,
                          context.senderUserId, context.senderDeviceId,
                          context.recipientUserId, context.recipientDeviceId,
                          context.senderIdentityKeyId, context.recipientIdentityKeyId,
                          context.senderCurve, context.recipientCurve, context.sessionId, text] {
                try fields.encode(field)
            }
        }
    }
}

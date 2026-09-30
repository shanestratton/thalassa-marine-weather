// Synthetic parsing assertions only; invoked by the isolated native probe.
import Foundation

private enum DmFrameProbeFailure: Error { case assertion(UInt) }

private func frameRequire(_ condition: @autoclosure () throws -> Bool, line: UInt = #line) throws {
    if try !condition() { throw DmFrameProbeFailure.assertion(line) }
}

private func frameReject(line: UInt = #line, _ operation: () throws -> Void) throws {
    do { try operation() }
    catch DmFrameError.invalidInput { return }
    throw DmFrameProbeFailure.assertion(line)
}

func runDmFrameProbe() throws {
    let original = WireMessage(messageType: 0, body: Data([0xfb, 0xef, 0xff, 0x01]))
    let envelope = try DmEnvelope(clientMessageId: "msg.1:retry-0", senderDeviceId: "alice_1",
                                  recipientDeviceId: "bob-1", wire: original)
    let canonical = "{\"version\":2,\"protocol\":\"olm-v1\",\"messageType\":\"prekey\",\"clientMessageId\":\"msg.1:retry-0\",\"senderDeviceId\":\"alice_1\",\"recipientDeviceId\":\"bob-1\",\"ciphertext\":\"++//AQ==\"}"
    try frameRequire(try envelope.serialized() == canonical)
    let decoded = try DmEnvelope.decode(canonical)
    try frameRequire(decoded == envelope)
    let wire = try decoded.wire
    try frameRequire(wire.messageType == original.messageType && wire.body == original.body)
    let session = try DmEnvelope(clientMessageId: "next", senderDeviceId: "alice", recipientDeviceId: "bob",
                                 wire: WireMessage(messageType: 1, body: original.body))
    try frameRequire(try DmEnvelope.decode(session.serialized()).wire.messageType == 1)

    for altered in [
        " " + canonical,
        canonical + "\n",
        canonical.replacingOccurrences(of: "\"version\":2", with: "\"version\":2.0"),
        canonical.replacingOccurrences(of: "\"version\":2", with: "\"version\":true"),
        canonical.replacingOccurrences(of: "\"version\":2", with: "\"version\":2,\"version\":2"),
        canonical.replacingOccurrences(of: "\"version\":2", with: "\"version\":2,\"extra\":\"field\""),
        canonical.replacingOccurrences(of: "\"version\":2,\"protocol\":\"olm-v1\"",
                                       with: "\"protocol\":\"olm-v1\",\"version\":2"),
        canonical.replacingOccurrences(of: "\"version\":2", with: "\"version\":1"),
        canonical.replacingOccurrences(of: "olm-v1", with: "signal-triple-ratchet"),
        canonical.replacingOccurrences(of: "\"prekey\"", with: "\"normal\""),
        canonical.replacingOccurrences(of: "msg.1:retry-0", with: "msg/invalid"),
        canonical.replacingOccurrences(of: "msg.1:retry-0", with: "\\u006dsg.1:retry-0"),
        canonical.replacingOccurrences(of: "alice_1", with: "alice🚤"),
        canonical.replacingOccurrences(of: "++//AQ==", with: "++//AR=="),
        canonical.replacingOccurrences(of: "++//AQ==", with: "++//AQ"),
        canonical.replacingOccurrences(of: "++//AQ==", with: "++//AQ==\\n"),
        canonical.replacingOccurrences(of: "++//AQ==", with: "")
    ] {
        try frameReject { _ = try DmEnvelope.decode(altered) }
    }
    try frameReject { _ = try DmEnvelope.decode(String(repeating: " ", count: 100_000) + canonical) }
    for badWire in [WireMessage(messageType: 2, body: original.body), WireMessage(messageType: 0, body: Data()),
                    WireMessage(messageType: 1, body: Data(repeating: 0, count: DmContentCodec.maxWireBytes + 1))] {
        try frameReject {
            _ = try DmEnvelope(clientMessageId: "m", senderDeviceId: "a", recipientDeviceId: "b", wire: badWire)
        }
    }
    let maximum = try DmEnvelope(clientMessageId: String(repeating: "a", count: 128), senderDeviceId: "a",
                                recipientDeviceId: "b", wire: WireMessage(messageType: 1,
                                body: Data(repeating: 0, count: DmContentCodec.maxWireBytes)))
    try frameRequire(try DmEnvelope.decode(maximum.serialized()).wire.body.count == DmContentCodec.maxWireBytes)
    for identifier in ["", String(repeating: "a", count: 129), "a b", "a\nb", "é", "a/b", "a+b", "a=", "a\"b"] {
        try frameReject { try DmContentCodec.validateIdentifier(identifier) }
    }
    try DmContentCodec.validateIdentifier("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")

    let key = String(Data(repeating: 0xfb, count: 32).base64EncodedString().dropLast())
    let otherKey = String(Data(repeating: 0xef, count: 32).base64EncodedString().dropLast())
    let context = DmAuthenticatedContext(conversationId: "conversation", clientMessageId: "message",
        senderUserId: "alice", senderDeviceId: "alice-device", recipientUserId: "bob", recipientDeviceId: "bob-device",
        senderIdentityKeyId: "alice-key", recipientIdentityKeyId: "bob-key", senderCurve: key,
        recipientCurve: otherKey, sessionId: key)
    let text = "synthetic unicode 🚤 e\u{301} and \"quotes\" / slash\nline"
    let content = try DmContentCodec.encode(context: context, text: text)
    try frameRequire(try DmContentCodec.decode(content, expected: context) == text)
    guard let fields = try JSONSerialization.jsonObject(with: content) as? [Any] else {
        throw DmFrameProbeFailure.assertion(#line)
    }
    try frameRequire(fields.count == 17)
    try frameRequire(try DmContentCodec.decode(JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted]),
                                               expected: context) == text)
    // Every individually well-formed context substitution must fail comparison,
    // including app IDs, both public keys and the provider's session identifier.
    for index in 5..<16 {
        var changed = fields
        changed[index] = index >= 13 ? (index == 14 ? key : otherKey) : "other-valid-id"
        let bytes = try JSONSerialization.data(withJSONObject: changed)
        try frameReject { _ = try DmContentCodec.decode(bytes, expected: context) }
    }
    for (index, value) in [(0, "other-domain" as Any), (1, 2), (1, true), (2, 1),
                            (3, "olm-v2"), (4, "attachment"), (5, 42), (13, key + "="),
                            (15, "invalid-session-id"), (16, 42)] {
        var changed = fields
        changed[index] = value
        let bytes = try JSONSerialization.data(withJSONObject: changed)
        try frameReject { _ = try DmContentCodec.decode(bytes, expected: context) }
    }
    for changed in [Array(fields.dropLast()), fields + ["extra"]] {
        let bytes = try JSONSerialization.data(withJSONObject: changed)
        try frameReject { _ = try DmContentCodec.decode(bytes, expected: context) }
    }
    try frameReject { _ = try DmContentCodec.decode(Data("{}".utf8), expected: context) }
    try frameReject { _ = try DmContentCodec.decode(Data([0xff, 0xfe]), expected: context) }
    try frameReject { _ = try DmContentCodec.decode(Data(repeating: 32, count: 64 * 1024 + 1), expected: context) }

    let maxText = String(repeating: "é", count: DmContentCodec.maxTextBytes / 2)
    let maxContent = try DmContentCodec.encode(context: context, text: maxText)
    try frameRequire(try DmContentCodec.decode(maxContent, expected: context) == maxText)
    try frameReject { _ = try DmContentCodec.encode(context: context, text: maxText + "a") }
    var oversizedText = fields
    oversizedText[16] = maxText + "a"
    let oversizedContent = try JSONSerialization.data(withJSONObject: oversizedText)
    try frameReject { _ = try DmContentCodec.decode(oversizedContent, expected: context) }
    // JSON escaping can exceed the total provider plaintext cap even when text
    // itself fits; that representation must be rejected before provider input.
    try frameReject {
        _ = try DmContentCodec.encode(context: context, text: String(repeating: "\0", count: DmContentCodec.maxTextBytes))
    }
}

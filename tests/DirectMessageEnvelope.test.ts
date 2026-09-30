import { describe, expect, it } from 'vitest';
import {
    decodeDirectMessageEnvelope,
    DM_ENVELOPE_PROTOCOL,
    DM_ENVELOPE_VERSION,
    encodeDirectMessageEnvelope,
    InvalidDirectMessageEnvelopeError,
    MAX_DM_CIPHERTEXT_BYTES,
    MAX_DM_ENVELOPE_CHARS,
    type DirectMessageEnvelope,
} from '../services/chat/e2ee/directMessageEnvelope';

// Framing fixture only. These bytes are NOT encrypted by a real provider.
const frame: DirectMessageEnvelope = {
    version: DM_ENVELOPE_VERSION,
    protocol: DM_ENVELOPE_PROTOCOL,
    messageType: 'prekey',
    clientMessageId: 'message-1',
    senderDeviceId: 'sender-ios',
    recipientDeviceId: 'recipient-ios',
    ciphertext: 'AQIDBA==',
};

describe('experimental encrypted DM transport framing (not cryptography)', () => {
    it('matches the native Swift framing golden fixture and wire ceiling', () => {
        // Same noncryptographic fixture as runDmFrameProbe: escaping/order and
        // padding must not diverge across the TypeScript/native boundary.
        const native =
            '{"version":2,"protocol":"olm-v1","messageType":"prekey","clientMessageId":"msg.1:retry-0","senderDeviceId":"alice_1","recipientDeviceId":"bob-1","ciphertext":"++//AQ=="}';
        expect(encodeDirectMessageEnvelope(decodeDirectMessageEnvelope(native))).toBe(native);
        expect(MAX_DM_CIPHERTEXT_BYTES).toBe(65 * 1024);
    });
    it('round trips opaque provider bytes and preserves retry identity', () => {
        expect(decodeDirectMessageEnvelope(encodeDirectMessageEnvelope(frame))).toEqual(frame);
        expect(encodeDirectMessageEnvelope(frame)).toBe(encodeDirectMessageEnvelope({ ...frame }));
    });

    it.each(['hello sailor', '{', 'null', '[]', '{}', '42', JSON.stringify({ message: 'private text' })])(
        'rejects legacy or malformed input: %s',
        (serialized) => {
            expect(() => decodeDirectMessageEnvelope(serialized)).toThrow(InvalidDirectMessageEnvelopeError);
        },
    );

    it.each([
        { version: 1 },
        { version: 3 },
        { version: '1' },
        { protocol: 'double-ratchet' },
        { protocol: 'signal-triple-ratchet' },
        { protocol: 'olm-v2' },
        { protocol: 'megolm-v1' },
        { protocol: 'plaintext' },
        { protocol: null },
        { messageType: 'plaintext' },
        { messageType: 'senderKey' },
        { messageType: null },
        { clientMessageId: '' },
        { clientMessageId: 'x'.repeat(129) },
        { senderDeviceId: 'sender\nsecret' },
        { recipientDeviceId: null },
        { ciphertext: '' },
        { ciphertext: 'not base64' },
        { ciphertext: 'AQIDBA' },
        { ciphertext: 'AR==' }, // Non-canonical padding bits.
        { ciphertext: '____' },
        { ciphertext: 123 },
    ])('rejects unsupported protocol or invalid fields: %j', (patch) => {
        expect(() => decodeDirectMessageEnvelope(JSON.stringify({ ...frame, ...patch }))).toThrow(
            InvalidDirectMessageEnvelopeError,
        );
    });

    it.each(['message', 'plaintext', 'preview', 'privateKey', 'sessionState', 'debug', 'toJSON'])(
        'refuses extra field %s on both send and receive without echoing its contents',
        (field) => {
            const unsafe = { ...frame, [field]: 'TOP SECRET' };
            for (const attempt of [
                () => encodeDirectMessageEnvelope(unsafe),
                () => decodeDirectMessageEnvelope(JSON.stringify(unsafe)),
            ]) {
                expect(attempt).toThrow(InvalidDirectMessageEnvelopeError);
                try {
                    attempt();
                } catch (error) {
                    expect(String(error)).not.toContain('TOP SECRET');
                }
            }
        },
    );

    it('requires every field', () => {
        for (const key of Object.keys(frame)) {
            const incomplete: Record<string, unknown> = { ...frame };
            delete incomplete[key];
            expect(() => decodeDirectMessageEnvelope(JSON.stringify(incomplete))).toThrow(
                InvalidDirectMessageEnvelopeError,
            );
        }
    });

    it('preserves the session-message dispatch type', () => {
        const sessionFrame = { ...frame, messageType: 'session' as const };
        expect(decodeDirectMessageEnvelope(encodeDirectMessageEnvelope(sessionFrame))).toEqual(sessionFrame);
    });

    it('does not relabel or migrate old Signal research frames into Olm', () => {
        const retired = { ...frame, version: 1, protocol: 'signal-triple-ratchet' };
        expect(() => decodeDirectMessageEnvelope(JSON.stringify(retired))).toThrow(InvalidDirectMessageEnvelopeError);
        expect(() => encodeDirectMessageEnvelope(retired as DirectMessageEnvelope)).toThrow(
            InvalidDirectMessageEnvelopeError,
        );
        expect(DM_ENVELOPE_VERSION).toBe(2);
        expect(DM_ENVELOPE_PROTOCOL).toBe('olm-v1');
    });

    it('bounds decoded size even when padded base64 lengths match', () => {
        const largest = {
            ...frame,
            clientMessageId: 'm'.repeat(128),
            senderDeviceId: 's'.repeat(128),
            recipientDeviceId: 'r'.repeat(128),
            ciphertext: btoa('a'.repeat(MAX_DM_CIPHERTEXT_BYTES)),
        };
        expect(decodeDirectMessageEnvelope(encodeDirectMessageEnvelope(largest))).toEqual(largest);
        const tooLarge = { ...frame, ciphertext: btoa('a'.repeat(MAX_DM_CIPHERTEXT_BYTES + 1)) };
        expect(() => encodeDirectMessageEnvelope(tooLarge)).toThrow(InvalidDirectMessageEnvelopeError);
        expect(() => decodeDirectMessageEnvelope(JSON.stringify(tooLarge))).toThrow(InvalidDirectMessageEnvelopeError);
    });

    it('rejects oversized serialized frames before parsing', () => {
        expect(() => decodeDirectMessageEnvelope(' '.repeat(MAX_DM_ENVELOPE_CHARS + 1))).toThrow(
            InvalidDirectMessageEnvelopeError,
        );
    });
});

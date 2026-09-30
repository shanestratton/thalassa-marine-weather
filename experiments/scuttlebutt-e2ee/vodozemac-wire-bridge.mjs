/**
 * Test-only bridge: upstream Olm JSON -> Thalassa framing -> upstream Olm JSON.
 * Invoked by synthetic Rust tests, never imported by the app. Node 24 is required
 * to load the isolated TypeScript validator. This is NOT a native crypto adapter.
 */
import assert from 'node:assert/strict';
import {
    decodeDirectMessageEnvelope,
    DM_ENVELOPE_PROTOCOL,
    DM_ENVELOPE_VERSION,
    encodeDirectMessageEnvelope,
    MAX_DM_CIPHERTEXT_BYTES,
} from '../../services/chat/e2ee/directMessageEnvelope.ts';

try {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
        length += chunk.length;
        assert(length <= 400_000, 'Bounded synthetic input');
        chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(input && typeof input === 'object' && !Array.isArray(input));
    assert.deepEqual(Object.keys(input).sort(), ['body', 'type']);
    assert(input.type === 0 || input.type === 1);
    assert.equal(typeof input.body, 'string');
    const bytes = Buffer.from(input.body, 'base64');
    assert(bytes.length > 0 && bytes.length <= MAX_DM_CIPHERTEXT_BYTES);
    assert.equal(bytes.toString('base64').replace(/=+$/, ''), input.body, 'Canonical upstream unpadded base64');
    const serialized = encodeDirectMessageEnvelope({
        version: DM_ENVELOPE_VERSION,
        protocol: DM_ENVELOPE_PROTOCOL,
        messageType: input.type === 0 ? 'prekey' : 'session',
        clientMessageId: 'synthetic-wire-proof',
        senderDeviceId: 'synthetic-sender',
        recipientDeviceId: 'synthetic-recipient',
        ciphertext: bytes.toString('base64'),
    });
    const decoded = decodeDirectMessageEnvelope(serialized);
    const result = {
        type: decoded.messageType === 'prekey' ? 0 : 1,
        body: Buffer.from(decoded.ciphertext, 'base64').toString('base64').replace(/=+$/, ''),
    };
    assert.deepEqual(result, input, 'The envelope must preserve exact provider bytes and dispatch');
    process.stdout.write(JSON.stringify(result)); // Pipe back to the Rust test, not a user-facing log.
} catch {
    process.stderr.write('Synthetic Olm framing bridge failed\n');
    process.exitCode = 1;
}

// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createResearchGateway,
    encodeResearchOutbox,
    ResearchGatewayError,
    type ResearchGatewayDependencies,
} from '../experiments/scuttlebutt-e2ee/relay/gateway';
import {
    deviceBundleSigningBytes,
    encodeDeviceBundle,
    type UnsignedDeviceBundle,
} from '../experiments/scuttlebutt-e2ee/relay/deviceBundle';
import { encodeDirectMessageEnvelope } from '../services/chat/e2ee/directMessageEnvelope';
import type { EncryptedDmOutboxRecord } from '../services/chat/e2ee/encryptedDmDelivery';

// Wiring tests only. Auth and SQL are explicitly mocked; these are not JWT,
// database authorization, transaction, device-authentication, or encryption tests.
// Registration signatures use real Ed25519, while the frame bytes below do not
// come from an encryption provider. The database harness covers SQL separately.
const CREDENTIAL = 'fixture-credential-not-a-jwt';
const OWNER = 'alice';
const NOW = 1_800_000_000;
const SECRET = 'PRIVATE fixture error contents';
const frame = {
    version: 2 as const,
    protocol: 'olm-v1' as const,
    messageType: 'prekey' as const,
    clientMessageId: 'message-1',
    senderDeviceId: 'alice-ios',
    recipientDeviceId: 'bob-ios',
    ciphertext: 'AQIDBA==',
};
const outbox: EncryptedDmOutboxRecord = {
    ownerUserId: OWNER,
    ownerSessionGeneration: 7,
    recipientUserId: 'bob',
    recipientIdentityKeyId: 'bob-key-1',
    recipientIdentityGeneration: 2,
    serializedEnvelope: encodeDirectMessageEnvelope(frame),
};
const wire = JSON.stringify(outbox);
let registration: string;
let otherRegistration: string;
let expiredRegistration: string;

beforeAll(async () => {
    const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const signingKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey))
        .toString('base64')
        .replace(/=+$/, '');
    async function signed(userId: string, expiresAt: number) {
        const unsigned: UnsignedDeviceBundle = {
            version: 1,
            protocol: 'olm-v1',
            userId,
            deviceId: 'alice-ios',
            identityKeyId: 'alice-key-1',
            signingKey,
            // Public-key-shaped framing fixtures, not provider session material.
            curveKey: Buffer.alloc(32, 7).toString('base64').replace(/=+$/, ''),
            prekeyId: 'prekey-1',
            prekey: Buffer.alloc(32, 9).toString('base64').replace(/=+$/, ''),
            expiresAt,
        };
        const signature = Buffer.from(
            await webcrypto.subtle.sign('Ed25519', pair.privateKey, deviceBundleSigningBytes(unsigned)),
        )
            .toString('base64')
            .replace(/=+$/, '');
        return encodeDeviceBundle({ ...unsigned, signature });
    }
    registration = await signed(OWNER, NOW + 3600);
    otherRegistration = await signed('mallory', NOW + 3600);
    expiredRegistration = await signed(OWNER, NOW);
});

function harness() {
    const authenticate = vi.fn<ResearchGatewayDependencies['authenticate']>(async () => ({ userId: OWNER }));
    const rpc = vi.fn<ResearchGatewayDependencies['rpc']>(async (name, args) =>
        name === 'send_message' ? { ...(args[1] as EncryptedDmOutboxRecord), accepted: true } : { mockRpc: name },
    );
    const nowSeconds = vi.fn(() => NOW);
    return { authenticate, rpc, nowSeconds, gateway: createResearchGateway({ authenticate, rpc, nowSeconds }) };
}

type Gateway = ReturnType<typeof createResearchGateway>;
const operations: [string, (gateway: Gateway, credential: string) => Promise<unknown>][] = [
    ['register', (g, c) => g.register(c, registration)],
    ['revoke', (g, c) => g.revoke(c, 'alice-ios')],
    ['block', (g, c) => g.block(c, 'bob', true)],
    ['claim', (g, c) => g.claim(c, 'alice-ios', 'bob', 'bob-ios', 'claim-1')],
    ['send', (g, c) => g.send(c, wire)],
    ['list', (g, c) => g.list(c, 'alice-ios')],
];

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

describe('research gateway wiring with mocked Auth and SQL adapters', () => {
    it('binds every SQL actor to the authenticated principal and forwards only explicit arguments', async () => {
        const h = harness();
        for (const [, operation] of operations) await operation(h.gateway, CREDENTIAL);
        expect(h.authenticate).toHaveBeenCalledTimes(6);
        for (const args of h.authenticate.mock.calls) expect(args).toEqual([CREDENTIAL]);
        expect(h.rpc.mock.calls).toEqual([
            ['register_device', [OWNER, registration]],
            ['revoke_device', [OWNER, 'alice-ios']],
            ['set_block', [OWNER, 'bob', true]],
            ['claim_prekey', [OWNER, 'alice-ios', 'bob', 'bob-ios', 'claim-1']],
            ['send_message', [OWNER, outbox]],
            ['list_messages', [OWNER, 'alice-ios', 0, 16]],
        ]);
    });

    it.each(operations)(
        '%s rejects malformed credentials without calling the auth or SQL adapter',
        async (_name, invoke) => {
            for (const credential of ['', 'x'.repeat(8193), null, undefined, 42]) {
                const h = harness();
                await expect(invoke(h.gateway, credential as string)).rejects.toThrow(new ResearchGatewayError());
                expect(h.authenticate).not.toHaveBeenCalled();
                expect(h.rpc).not.toHaveBeenCalled();
            }
        },
    );

    it.each(operations)('%s fails closed on a rejected credential or auth exception', async (_name, invoke) => {
        for (const result of ['unauthenticated', 'error']) {
            const h = harness();
            if (result === 'unauthenticated') h.authenticate.mockResolvedValue(null);
            else h.authenticate.mockRejectedValue(new Error(SECRET));
            await expect(invoke(h.gateway, CREDENTIAL)).rejects.toThrow(new ResearchGatewayError());
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it.each(operations)(
        '%s propagates no terminal receipt or private error details on SQL failure',
        async (_name, invoke) => {
            const h = harness();
            h.rpc.mockRejectedValue(new Error(SECRET));
            await expect(invoke(h.gateway, CREDENTIAL)).rejects.toThrow(new ResearchGatewayError());
            expect(h.rpc).toHaveBeenCalledTimes(1);
        },
    );

    it('rejects malformed authenticated principal objects without executing accessors', async () => {
        const getter = vi.fn(() => OWNER);
        for (const principal of [
            {},
            [],
            { userId: '' },
            { userId: 'alice\n' },
            { userId: 'x'.repeat(129) },
            { userId: OWNER, role: 'admin' },
            { userId: OWNER, [Symbol('actor')]: 'mallory' },
            Object.assign(Object.create({ inherited: true }), { userId: OWNER }),
            Object.defineProperty({}, 'userId', { enumerable: true, get: getter }),
        ]) {
            const h = harness();
            h.authenticate.mockResolvedValue(principal as { userId: string });
            await expect(h.gateway.list(CREDENTIAL, 'alice-ios')).rejects.toThrow(new ResearchGatewayError());
            expect(h.rpc).not.toHaveBeenCalled();
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('accepts the credential length boundary and authenticates every request afresh', async () => {
        const h = harness();
        await h.gateway.send('x'.repeat(8192), wire);
        h.authenticate.mockResolvedValue({ userId: 'mallory' });
        await expect(h.gateway.send(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        expect(h.authenticate).toHaveBeenCalledTimes(2);
        expect(h.rpc).toHaveBeenCalledTimes(1);
    });

    it('rejects a body owner or signed registration belonging to another account', async () => {
        const h = harness();
        await expect(h.gateway.send(CREDENTIAL, JSON.stringify({ ...outbox, ownerUserId: 'mallory' }))).rejects.toThrow(
            ResearchGatewayError,
        );
        await expect(h.gateway.register(CREDENTIAL, otherRegistration)).rejects.toThrow(ResearchGatewayError);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('verifies a registration before dispatch and refuses malformed, expired, or tampered bundles', async () => {
        for (const invalid of [
            '{',
            ` ${registration}`,
            expiredRegistration,
            registration.replace('"prekeyId":"prekey-1"', '"prekeyId":"prekey-2"'),
            JSON.stringify({ ...JSON.parse(registration), actor: 'mallory' }),
        ]) {
            const h = harness();
            await expect(h.gateway.register(CREDENTIAL, invalid)).rejects.toThrow(new ResearchGatewayError());
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it('passes the trusted clock to bundle expiry validation', async () => {
        const h = harness();
        h.nowSeconds.mockReturnValue(NOW + 3600);
        await expect(h.gateway.register(CREDENTIAL, registration)).rejects.toThrow(ResearchGatewayError);
        expect(h.nowSeconds).toHaveBeenCalledTimes(1);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('rejects malformed, noncanonical, oversized, and extra-field outbox wire input before authentication', async () => {
        const badWires = [
            '',
            '{',
            'null',
            '[]',
            '{}',
            'PRIVATE TEXT',
            'x'.repeat(100_001),
            ` ${wire}`,
            `${wire}\n`,
            JSON.stringify(outbox, null, 2),
            JSON.stringify(Object.fromEntries(Object.entries(outbox).reverse())),
            wire.replace('"ownerUserId":"alice"', '"ownerUserId":"mallory","ownerUserId":"alice"'),
            wire.replace('alice', '\\u0061lice'),
            wire.replace('"ownerSessionGeneration":7', '"ownerSessionGeneration":7.0'),
            JSON.stringify({ ...outbox, actor: 'mallory' }),
            JSON.stringify({ ...outbox, userId: 'mallory' }),
            JSON.stringify({ ...outbox, plaintext: SECRET }),
            JSON.stringify({ ...outbox, recipientUserId: 'bób' }),
        ];
        for (const invalid of badWires) {
            const h = harness();
            await expect(h.gateway.send(CREDENTIAL, invalid)).rejects.toThrow(new ResearchGatewayError());
            expect(h.authenticate).not.toHaveBeenCalled();
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it('requires each outbox field and bounded IDs and generations', async () => {
        const malformed: unknown[] = [];
        for (const field of Object.keys(outbox)) {
            const value: Record<string, unknown> = { ...outbox };
            delete value[field];
            malformed.push(value);
        }
        for (const field of ['ownerUserId', 'recipientUserId', 'recipientIdentityKeyId']) {
            for (const value of ['', 'x'.repeat(129), 'slash/id', 'id\n', null, 5])
                malformed.push({ ...outbox, [field]: value });
        }
        for (const field of ['ownerSessionGeneration', 'recipientIdentityGeneration']) {
            for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '7'])
                malformed.push({ ...outbox, [field]: value });
        }
        malformed.push({ ...outbox, recipientUserId: OWNER });
        for (const value of malformed) {
            const h = harness();
            await expect(h.gateway.send(CREDENTIAL, JSON.stringify(value))).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it('rejects legacy, noncanonical, extra-field, or invalid nested envelopes', async () => {
        const invalidEnvelopes = [
            'PRIVATE TEXT',
            JSON.stringify({ ...frame, version: 1, protocol: 'signal-triple-ratchet' }),
            JSON.stringify({ ...frame, version: 1 }),
            JSON.stringify({ ...frame, plaintext: SECRET }),
            JSON.stringify({ ...frame, ciphertext: 'AR==' }),
            JSON.stringify({ ...frame, recipientDeviceId: frame.senderDeviceId }),
            ` ${outbox.serializedEnvelope}`,
            JSON.stringify(Object.fromEntries(Object.entries(frame).reverse())),
            outbox.serializedEnvelope.replace('"version":2', '"version":1,"version":2'),
            ...['clientMessageId', 'senderDeviceId', 'recipientDeviceId'].map((field) =>
                JSON.stringify({ ...frame, [field]: 'device\n' }),
            ),
        ];
        for (const serializedEnvelope of invalidEnvelopes) {
            const h = harness();
            await expect(h.gateway.send(CREDENTIAL, JSON.stringify({ ...outbox, serializedEnvelope }))).rejects.toThrow(
                ResearchGatewayError,
            );
            expect(h.authenticate).not.toHaveBeenCalled();
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it('encodes only exact data fields and never invokes caller getters', () => {
        expect(encodeResearchOutbox(outbox)).toBe(wire);
        expect(
            encodeResearchOutbox(
                Object.fromEntries(Object.entries(outbox).reverse()) as unknown as EncryptedDmOutboxRecord,
            ),
        ).toBe(wire);
        const getter = vi.fn(() => OWNER);
        for (const value of [
            { ...outbox, plaintext: SECRET },
            { ...outbox, [Symbol('secret')]: SECRET },
            Object.defineProperty({ ...outbox }, 'secret', { value: SECRET }),
            Object.defineProperty({ ...outbox }, 'ownerUserId', { get: getter, enumerable: true }),
            Object.assign(Object.create({ actor: 'mallory' }), outbox),
        ])
            expect(() => encodeResearchOutbox(value)).toThrow(ResearchGatewayError);
        expect(getter).not.toHaveBeenCalled();
    });

    it('returns an immutable exact acceptance or supported rejection echo', async () => {
        for (const decision of [
            { accepted: true },
            { accepted: false, reason: 'blocked' },
            { accepted: false, reason: 'device-revoked' },
            { accepted: false, reason: 'record-conflict' },
        ]) {
            const h = harness();
            h.rpc.mockResolvedValue({ ...outbox, ...decision });
            const receipt = await h.gateway.send(CREDENTIAL, wire);
            expect(receipt).toEqual({ ...outbox, ...decision });
            expect(Object.isFrozen(receipt)).toBe(true);
        }
    });

    it('rejects receipts that differ in any echoed field, for both acceptance and rejection', async () => {
        for (const field of Object.keys(outbox) as (keyof EncryptedDmOutboxRecord)[]) {
            const changed = typeof outbox[field] === 'number' ? 99 : 'changed-field';
            for (const decision of [{ accepted: true }, { accepted: false, reason: 'blocked' }]) {
                const h = harness();
                h.rpc.mockResolvedValue({ ...outbox, ...decision, [field]: changed });
                await expect(h.gateway.send(CREDENTIAL, wire)).rejects.toThrow(new ResearchGatewayError());
            }
        }
    });

    it('rejects malformed or overbroad server receipts without executing accessors', async () => {
        const getter = vi.fn(() => true);
        const valid = { ...outbox, accepted: true };
        for (const receipt of [
            undefined,
            null,
            true,
            1,
            [],
            JSON.stringify(valid),
            { accepted: true },
            { ...valid, extra: SECRET },
            { ...valid, reason: 'blocked' },
            { ...valid, accepted: 'true' },
            { ...valid, accepted: false },
            { ...valid, accepted: false, reason: 'temporary-error' },
            { ...valid, [Symbol('extra')]: SECRET },
            Object.assign(Object.create({ inherited: true }), valid),
            Object.defineProperty({ ...valid }, 'accepted', { get: getter, enumerable: true }),
            Object.defineProperty({ ...valid }, 'ownerUserId', { get: getter, enumerable: true }),
            Object.defineProperty({ ...valid, accepted: false }, 'reason', { get: getter, enumerable: true }),
        ]) {
            const h = harness();
            h.rpc.mockResolvedValue(receipt);
            await expect(h.gateway.send(CREDENTIAL, wire)).rejects.toThrow(new ResearchGatewayError());
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('uses a frozen serialized snapshot while authentication is pending', async () => {
        const h = harness();
        const authentication = deferred<{ userId: string }>();
        h.authenticate.mockReturnValue(authentication.promise);
        const callerRecord = { ...outbox };
        const pending = h.gateway.send(CREDENTIAL, encodeResearchOutbox(callerRecord));
        callerRecord.ownerUserId = 'mallory';
        callerRecord.recipientUserId = 'eve';
        callerRecord.serializedEnvelope = SECRET;
        expect(h.rpc).not.toHaveBeenCalled();
        authentication.resolve({ userId: OWNER });
        expect(await pending).toEqual({ ...outbox, accepted: true });
        const passed = h.rpc.mock.calls[0][1][1];
        expect(passed).toEqual(outbox);
        expect(passed).not.toBe(callerRecord);
        expect(Object.isFrozen(passed)).toBe(true);
    });

    it('waits for the mocked SQL adapter to resolve before returning a receipt', async () => {
        const h = harness();
        const started = deferred<void>();
        const committed = deferred<unknown>();
        h.rpc.mockImplementation(async () => {
            started.resolve();
            return committed.promise;
        });
        let resolved = false;
        const pending = h.gateway.send(CREDENTIAL, wire).then((receipt) => {
            resolved = true;
            return receipt;
        });
        await started.promise;
        expect(resolved).toBe(false);
        committed.resolve({ ...outbox, accepted: true });
        expect(await pending).toEqual({ ...outbox, accepted: true });
        // This asserts adapter ordering, not that a real transaction committed.
    });

    it('validates revoke and block targets and booleans before dispatch', async () => {
        for (const target of ['', 'x'.repeat(129), 'target\n', 'two words', null]) {
            const h = harness();
            await expect(h.gateway.revoke(CREDENTIAL, target as string)).rejects.toThrow(ResearchGatewayError);
            await expect(h.gateway.block(CREDENTIAL, target as string, true)).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        }
        for (const blocked of [null, undefined, 1, 'true']) {
            const h = harness();
            await expect(h.gateway.block(CREDENTIAL, 'bob', blocked as unknown as boolean)).rejects.toThrow(
                ResearchGatewayError,
            );
            expect(h.rpc).not.toHaveBeenCalled();
        }
        const h = harness();
        await expect(h.gateway.block(CREDENTIAL, OWNER, true)).rejects.toThrow(ResearchGatewayError);
        expect(h.rpc).not.toHaveBeenCalled();
        await h.gateway.block(CREDENTIAL, 'bob', false);
        expect(h.rpc).toHaveBeenCalledExactlyOnceWith('set_block', [OWNER, 'bob', false]);
    });

    it('validates every claim ID and refuses self-account or same-device claims', async () => {
        const valid = ['alice-ios', 'bob', 'bob-ios', 'request-1'] as const;
        for (let index = 0; index < valid.length; index++) {
            for (const invalid of ['', 'x'.repeat(129), 'id\n', 'two words']) {
                const h = harness();
                const args: [string, string, string, string] = [...valid];
                args[index] = invalid;
                await expect(h.gateway.claim(CREDENTIAL, ...args)).rejects.toThrow(ResearchGatewayError);
                expect(h.rpc).not.toHaveBeenCalled();
            }
        }
        const h = harness();
        await expect(h.gateway.claim(CREDENTIAL, 'alice-ios', OWNER, 'alice-other', 'request-1')).rejects.toThrow(
            ResearchGatewayError,
        );
        await expect(h.gateway.claim(CREDENTIAL, 'alice-ios', 'bob', 'alice-ios', 'request-1')).rejects.toThrow(
            ResearchGatewayError,
        );
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('bounds list device, cursor, and batch inputs and preserves default pagination', async () => {
        const h = harness();
        await h.gateway.list(CREDENTIAL, 'alice-ios');
        expect(h.rpc).toHaveBeenLastCalledWith('list_messages', [OWNER, 'alice-ios', 0, 16]);
        await h.gateway.list(CREDENTIAL, 'x'.repeat(128), Number.MAX_SAFE_INTEGER, 1);
        expect(h.rpc).toHaveBeenLastCalledWith('list_messages', [OWNER, 'x'.repeat(128), Number.MAX_SAFE_INTEGER, 1]);
        h.rpc.mockClear();
        for (const device of ['', 'x'.repeat(129), 'alice-ios\n']) {
            await expect(h.gateway.list(CREDENTIAL, device)).rejects.toThrow(ResearchGatewayError);
        }
        for (const afterId of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
            await expect(h.gateway.list(CREDENTIAL, 'alice-ios', afterId as number)).rejects.toThrow(
                ResearchGatewayError,
            );
        }
        for (const batch of [0, 17, 1.5, NaN, Infinity, '2', null]) {
            await expect(h.gateway.list(CREDENTIAL, 'alice-ios', 0, batch as number)).rejects.toThrow(
                ResearchGatewayError,
            );
        }
        expect(h.rpc).not.toHaveBeenCalled();
    });
});

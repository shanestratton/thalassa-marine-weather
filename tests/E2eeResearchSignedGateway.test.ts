// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeDirectMessageEnvelope } from '../services/chat/e2ee/directMessageEnvelope';
import type { EncryptedDmOutboxRecord } from '../services/chat/e2ee/encryptedDmDelivery';
import {
    deviceBundleSigningBytes,
    encodeDeviceBundle,
    type UnsignedDeviceBundle,
} from '../experiments/scuttlebutt-e2ee/relay/deviceBundle';
import { encodeResearchOutbox, ResearchGatewayError } from '../experiments/scuttlebutt-e2ee/relay/gateway';
import {
    createResearchSignedGateway,
    type ResearchSignedGatewayDependencies,
} from '../experiments/scuttlebutt-e2ee/relay/signedGateway';
import {
    MAX_RESEARCH_REQUEST_AGE_SECONDS,
    MAX_RESEARCH_REQUEST_BYTES,
    encodeSignedResearchRequest,
    encodeUnsignedResearchRequest,
    parseResearchSignedRequest,
    researchRequestSigningBytes,
    verifyResearchRequestSignature,
    type ResearchSignedRequest,
    type UnsignedResearchRequest,
} from '../experiments/scuttlebutt-e2ee/relay/signedRequest';

// Real Ed25519 signatures; Auth and SQL adapters are mocked. These checks do not
// prove JWT validation, database transactions, provider encryption or deployment.
const NOW = 1_800_000_000;
const USER = 'alice';
const DEVICE = 'alice-ios';
const CREDENTIAL = 'synthetic-credential-not-a-jwt';
const PRIVATE_ERROR = 'PRIVATE synthetic credential/database/crypto contents';
const envelope = {
    version: 2 as const,
    protocol: 'olm-v1' as const,
    messageType: 'prekey' as const,
    clientMessageId: 'message-1',
    senderDeviceId: DEVICE,
    recipientDeviceId: 'bob-ios',
    // Frame-shaped bytes only; not produced by the encryption provider.
    ciphertext: 'AQIDBA==',
};
const outbox: EncryptedDmOutboxRecord = {
    ownerUserId: USER,
    ownerSessionGeneration: 7,
    recipientUserId: 'bob',
    recipientIdentityKeyId: 'bob-key-1',
    recipientIdentityGeneration: 2,
    serializedEnvelope: encodeDirectMessageEnvelope(envelope),
};
const unsigned: UnsignedResearchRequest = {
    version: 1,
    protocol: 'olm-v1',
    userId: USER,
    deviceId: DEVICE,
    action: 'list',
    requestId: 'request-1',
    expiresAt: NOW + 60,
    payload: '[0,16]',
};
let signer: webcrypto.CryptoKeyPair;
let otherSigner: webcrypto.CryptoKeyPair;
let signingKey: string;
let otherSigningKey: string;
let request: ResearchSignedRequest;
let registration: string;

function base64(bytes: ArrayBuffer): string {
    return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}
// Independent fixture contract: an encoder and its own verifier agreeing would
// not catch a shared mistake in the domain, field order, or payload representation.
function expectedSigningBytes(value: UnsignedResearchRequest): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        JSON.stringify([
            'thalassa-relay-request',
            1,
            'olm-v1',
            value.userId,
            value.deviceId,
            value.action,
            value.requestId,
            value.expiresAt,
            value.payload,
        ]),
    );
}
async function signRequest(
    patch: Partial<UnsignedResearchRequest> = {},
    privateKey = signer.privateKey,
): Promise<ResearchSignedRequest> {
    const value = { ...unsigned, ...patch };
    const signature = base64(await webcrypto.subtle.sign('Ed25519', privateKey, expectedSigningBytes(value)));
    return { ...value, signature };
}
beforeAll(async () => {
    [signer, otherSigner] = (await Promise.all([
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
    ])) as webcrypto.CryptoKeyPair[];
    signingKey = base64(await webcrypto.subtle.exportKey('raw', signer.publicKey));
    otherSigningKey = base64(await webcrypto.subtle.exportKey('raw', otherSigner.publicKey));
    request = await signRequest();
    const bundle: UnsignedDeviceBundle = {
        version: 1,
        protocol: 'olm-v1',
        userId: USER,
        deviceId: DEVICE,
        identityKeyId: 'alice-key-1',
        signingKey,
        curveKey: Buffer.alloc(32, 7).toString('base64').replace(/=+$/, ''),
        prekeyId: 'prekey-1',
        prekey: Buffer.alloc(32, 9).toString('base64').replace(/=+$/, ''),
        expiresAt: NOW + 3600,
    };
    registration = encodeDeviceBundle({
        ...bundle,
        signature: base64(await webcrypto.subtle.sign('Ed25519', signer.privateKey, deviceBundleSigningBytes(bundle))),
    });
});
afterEach(() => vi.unstubAllGlobals());

function harness(userId = USER, trustedKey = signingKey) {
    const authenticate = vi.fn<ResearchSignedGatewayDependencies['authenticate']>(async () => ({ userId }));
    const rpc = vi.fn<ResearchSignedGatewayDependencies['rpc']>(async (name, args) => {
        if (name === 'lookup_request_key') return { signingKey: trustedKey };
        if (name === 'execute_request' && args[3] === 'send')
            return { ...JSON.parse(args[4] as string), accepted: true };
        return { mockRpc: name };
    });
    const nowSeconds = vi.fn(() => NOW);
    return { authenticate, rpc, nowSeconds, gateway: createResearchSignedGateway({ authenticate, rpc, nowSeconds }) };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

describe('research signed request protocol', () => {
    it('fixes independent signing bytes and canonical field order and returns an immutable snapshot', async () => {
        expect(researchRequestSigningBytes(unsigned)).toEqual(expectedSigningBytes(unsigned));
        expect(encodeUnsignedResearchRequest(unsigned)).toBe(JSON.stringify(unsigned));
        const reversed = Object.fromEntries(Object.entries(request).reverse()) as unknown as ResearchSignedRequest;
        expect(encodeSignedResearchRequest(reversed)).toBe(JSON.stringify(request));
        const parsed = parseResearchSignedRequest(JSON.stringify(request), USER, NOW);
        expect(parsed).toEqual(request);
        expect(Object.isFrozen(parsed)).toBe(true);
        await expect(verifyResearchRequestSignature(parsed, signingKey)).resolves.toBeUndefined();
    });

    it.each([
        { field: 'userId', patch: { userId: 'mallory' } },
        { field: 'deviceId', patch: { deviceId: 'alice-other-ios' } },
        { field: 'action', patch: { action: 'revoke', payload: '[]' } },
        { field: 'requestId', patch: { requestId: 'request-2' } },
        { field: 'expiresAt', patch: { expiresAt: NOW + 61 } },
        { field: 'payload', patch: { payload: '[1,16]' } },
    ] as const)('rejects tampering with signed $field even under otherwise valid framing', async ({ patch }) => {
        const changed = { ...request, ...patch };
        const h = harness(changed.userId);
        await expect(h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(changed))).rejects.toThrow(
            new ResearchGatewayError(),
        );
        expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [changed.userId, changed.deviceId]);
    });

    it('rejects a signature under another domain or a different registered-device key', async () => {
        const wrongDomain = new TextEncoder().encode(
            new TextDecoder()
                .decode(expectedSigningBytes(unsigned))
                .replace('thalassa-relay-request', 'other-relay-request'),
        );
        const wrongSignature = base64(await webcrypto.subtle.sign('Ed25519', signer.privateKey, wrongDomain));
        await expect(
            verifyResearchRequestSignature({ ...request, signature: wrongSignature }, signingKey),
        ).rejects.toThrow(ResearchGatewayError);
        await expect(verifyResearchRequestSignature(request, otherSigningKey)).rejects.toThrow(ResearchGatewayError);
        const attacker = await signRequest({}, otherSigner.privateKey);
        await expect(verifyResearchRequestSignature(attacker, signingKey)).rejects.toThrow(ResearchGatewayError);
    });

    it.each([1, MAX_RESEARCH_REQUEST_AGE_SECONDS])('accepts a signed lifetime of %i seconds', async (seconds) => {
        const fresh = await signRequest({ expiresAt: NOW + seconds });
        expect(parseResearchSignedRequest(JSON.stringify(fresh), USER, NOW)).toEqual(fresh);
    });
    it.each([NOW - 1, NOW, NOW + MAX_RESEARCH_REQUEST_AGE_SECONDS + 1])(
        'rejects expiry outside the accepted window: %i',
        async (expiresAt) => {
            const stale = await signRequest({ expiresAt });
            const h = harness();
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(stale))).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        },
    );
    it('rejects an unchanged signed retry after expiry and invalid trusted clocks', () => {
        expect(() => parseResearchSignedRequest(JSON.stringify(request), USER, request.expiresAt)).toThrow(
            ResearchGatewayError,
        );
        for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
            expect(() => parseResearchSignedRequest(JSON.stringify(request), USER, now)).toThrow(ResearchGatewayError);
    });

    it('rejects duplicate fields, whitespace, order changes, escaped aliases and numeric aliases', () => {
        const serialized = JSON.stringify(request);
        for (const alternative of [
            ` ${serialized}`,
            `${serialized}\n`,
            JSON.stringify(request, null, 2),
            JSON.stringify(Object.fromEntries(Object.entries(request).reverse())),
            serialized.replace('"version":1', '"version":1,"version":1'),
            serialized.replace('alice', '\\u0061lice'),
            serialized.replace(String(request.expiresAt), `${request.expiresAt}.0`),
            serialized.replace(String(request.expiresAt), `${request.expiresAt}e0`),
        ])
            expect(() => parseResearchSignedRequest(alternative, USER, NOW)).toThrow(ResearchGatewayError);
    });
    it('requires strict fields and bounded ASCII IDs without executing accessors', () => {
        for (const field of Object.keys(request)) {
            const missing: Record<string, unknown> = { ...request };
            delete missing[field];
            expect(() => encodeSignedResearchRequest(missing as unknown as ResearchSignedRequest)).toThrow(
                ResearchGatewayError,
            );
        }
        for (const field of ['userId', 'deviceId', 'requestId']) {
            for (const invalid of ['', 'x'.repeat(129), 'id\n', 'two words', 'ü', '/', 7, null])
                expect(() =>
                    encodeSignedResearchRequest({ ...request, [field]: invalid } as ResearchSignedRequest),
                ).toThrow(ResearchGatewayError);
        }
        const getter = vi.fn(() => DEVICE);
        for (const unsafe of [
            { ...request, signingKey },
            { ...request, privateKey: PRIVATE_ERROR },
            { ...request, [Symbol('secret')]: PRIVATE_ERROR },
            Object.defineProperty({ ...request }, 'deviceId', { enumerable: true, get: getter }),
            Object.defineProperty({ ...request }, 'deviceId', { enumerable: false }),
            Object.assign(Object.create({ inherited: true }), request),
        ])
            expect(() => encodeSignedResearchRequest(unsafe)).toThrow(ResearchGatewayError);
        expect(getter).not.toHaveBeenCalled();
        expect(() => researchRequestSigningBytes(request)).toThrow(ResearchGatewayError);
        expect(() => researchRequestSigningBytes({ ...unsigned, toJSON: getter } as UnsignedResearchRequest)).toThrow(
            ResearchGatewayError,
        );
        expect(getter).not.toHaveBeenCalled();
    });
    it('accepts permitted identifier punctuation and maximum length', async () => {
        const identifier = `${'a'.repeat(122)}._:-09`;
        const bounded = await signRequest({ userId: identifier, deviceId: identifier, requestId: identifier });
        expect(parseResearchSignedRequest(JSON.stringify(bounded), identifier, NOW)).toEqual(bounded);
    });
    it('rejects malformed fields, noncanonical signature encodings, and oversize wire before parsing', () => {
        for (const patch of [
            { version: 2 },
            { protocol: 'olm-v2' },
            { action: 'register' },
            { payload: [] },
            ...[-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1800000060', null].map((expiresAt) => ({
                expiresAt,
            })),
            ...['', 'A'.repeat(85), 'A'.repeat(87), 'A'.repeat(86) + '==', 'A'.repeat(85) + 'B', '_'.repeat(86)].map(
                (signature) => ({ signature }),
            ),
        ])
            expect(() => parseResearchSignedRequest(JSON.stringify({ ...request, ...patch }), USER, NOW)).toThrow(
                ResearchGatewayError,
            );
        const parse = vi.spyOn(JSON, 'parse');
        try {
            expect(() => parseResearchSignedRequest(' '.repeat(MAX_RESEARCH_REQUEST_BYTES + 1), USER, NOW)).toThrow(
                ResearchGatewayError,
            );
            expect(() => parseResearchSignedRequest('é', USER, NOW)).toThrow(ResearchGatewayError);
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        for (const malformed of ['', '{', 'null', '[]', '{}', '5', '"PRIVATE fixture"'])
            expect(() => parseResearchSignedRequest(malformed, USER, NOW)).toThrow(new ResearchGatewayError());
    });

    it.each([
        ['revoke', ['[1]', 'null', '[ ]', '{}']],
        ['block', ['["alice",true]', '["bob",1]', '["bob"]', '["bob",true,0]', '["bob", true]', '["bob\\n",true]']],
        [
            'claim',
            [
                '["alice","alice-other","claim-1"]',
                '["bob","alice-ios","claim-1"]',
                '["bob","bob-ios"]',
                '["bob","bob-ios",""]',
            ],
        ],
        [
            'list',
            [
                '[-1,16]',
                '[0,0]',
                '[0,17]',
                '[0.5,16]',
                '[9007199254740992,16]',
                '[-0,16]',
                '[0.0,16]',
                '[0,16,0]',
                '[0, 16]',
                '["0",16]',
            ],
        ],
    ] as const)('rejects malformed or noncanonical %s payloads', (action, payloads) => {
        for (const payload of payloads)
            expect(() => encodeSignedResearchRequest({ ...request, action, payload })).toThrow(ResearchGatewayError);
    });
    it('binds the send outbox user and device and rejects self targets and altered canonical record bytes', async () => {
        const reversed = JSON.stringify(Object.fromEntries(Object.entries(outbox).reverse()));
        const badPayloads = [
            reversed,
            JSON.stringify({ ...outbox, ownerUserId: 'mallory' }),
            JSON.stringify({ ...outbox, recipientUserId: USER }),
            JSON.stringify({
                ...outbox,
                serializedEnvelope: encodeDirectMessageEnvelope({ ...envelope, senderDeviceId: 'alice-other' }),
            }),
            JSON.stringify({
                ...outbox,
                serializedEnvelope: encodeDirectMessageEnvelope({ ...envelope, recipientDeviceId: DEVICE }),
            }),
            JSON.stringify({ ...outbox, plaintext: PRIVATE_ERROR }),
        ];
        for (const payload of badPayloads) {
            const h = harness();
            const invalid = await signRequest({ action: 'send', payload });
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(invalid))).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });
});

describe('research signed gateway with mocked Auth and SQL', () => {
    it.each([
        ['revoke', '[]'],
        ['block', '["bob",true]'],
        ['block', '["bob",false]'],
        ['claim', '["bob","bob-ios","claim-1"]'],
        ['send', encodeResearchOutbox(outbox)],
        ['list', '[0,16]'],
    ] as const)(
        'authenticates once and executes canonical signed %s arguments only after key lookup',
        async (action, payload) => {
            const h = harness();
            const signed = await signRequest({ action, payload });
            const serialized = encodeSignedResearchRequest(signed);
            const result = await h.gateway.dispatch(CREDENTIAL, serialized);
            expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
            expect(h.rpc.mock.calls).toEqual([
                ['lookup_request_key', [USER, DEVICE]],
                ['execute_request', [USER, DEVICE, signed.requestId, action, payload, signed.expiresAt, serialized]],
            ]);
            expect(result).toEqual(action === 'send' ? { ...outbox, accepted: true } : { mockRpc: 'execute_request' });
            if (action === 'send') expect(Object.isFrozen(result)).toBe(true);
        },
    );

    it('delegates signed bundle registration to the existing registration boundary', async () => {
        const h = harness();
        await expect(h.gateway.register(CREDENTIAL, registration)).resolves.toEqual({ mockRpc: 'register_device' });
        expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
        expect(h.rpc).toHaveBeenCalledExactlyOnceWith('register_device', [USER, registration]);
        expect(Object.keys(h.gateway)).toEqual(['register', 'dispatch']);
    });
    it('rejects malformed or unverified credentials without SQL calls', async () => {
        for (const credential of ['', 'x'.repeat(8193), null, undefined, 42]) {
            const h = harness();
            await expect(h.gateway.dispatch(credential as string, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.authenticate).not.toHaveBeenCalled();
            expect(h.rpc).not.toHaveBeenCalled();
        }
        for (const invalid of ['null', 'exception']) {
            const h = harness();
            if (invalid === 'null') h.authenticate.mockResolvedValue(null);
            else h.authenticate.mockRejectedValue(new Error(PRIVATE_ERROR));
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });
    it('rejects an authenticated actor mismatch and unsafe principal objects without reading getters', async () => {
        const getter = vi.fn(() => USER);
        for (const principal of [
            { userId: 'mallory' },
            {},
            { userId: 'alice\n' },
            { userId: USER, role: 'admin' },
            Object.defineProperty({}, 'userId', { enumerable: true, get: getter }),
            Object.assign(Object.create({ inherited: true }), { userId: USER }),
        ]) {
            const h = harness();
            h.authenticate.mockResolvedValue(principal as { userId: string });
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).not.toHaveBeenCalled();
        }
        expect(getter).not.toHaveBeenCalled();
    });
    it('requires one canonical stored signing key and never substitutes caller key material', async () => {
        const getter = vi.fn(() => signingKey);
        for (const lookup of [
            null,
            {},
            { signingKey: otherSigningKey },
            { signingKey, active: true },
            { signingKey: 'A'.repeat(42) + 'B' },
            { signingKey: signingKey + '=' },
            Object.defineProperty({}, 'signingKey', { enumerable: true, get: getter }),
        ]) {
            const h = harness();
            h.rpc.mockResolvedValue(lookup);
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
        }
        expect(getter).not.toHaveBeenCalled();
        const h = harness();
        await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify({ ...request, signingKey }))).rejects.toThrow(
            ResearchGatewayError,
        );
        expect(h.rpc).not.toHaveBeenCalled();
    });
    it('waits for authentication, trusted key lookup, signature verification and transaction commit in order', async () => {
        const h = harness();
        const auth = deferred<{ userId: string }>();
        const lookup = deferred<unknown>();
        const commit = deferred<unknown>();
        h.authenticate.mockReturnValue(auth.promise);
        h.rpc.mockImplementation((name) => (name === 'lookup_request_key' ? lookup.promise : commit.promise));
        const finished = vi.fn();
        const pending = h.gateway.dispatch(CREDENTIAL, JSON.stringify(request));
        pending.then(finished, finished);
        expect(h.rpc).not.toHaveBeenCalled();
        auth.resolve({ userId: USER });
        await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]));
        lookup.resolve({ signingKey });
        await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
        expect(h.rpc.mock.calls[1][0]).toBe('execute_request');
        expect(finished).not.toHaveBeenCalled();
        commit.resolve({ committed: true });
        await expect(pending).resolves.toEqual({ committed: true });
    });
    it('emits no outcome or private error details when lookup or execution fails', async () => {
        for (const failing of ['lookup_request_key', 'execute_request']) {
            const h = harness();
            h.rpc.mockImplementation(async (name) => {
                if (name === failing) throw new Error(PRIVATE_ERROR);
                return { signingKey };
            });
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).toHaveBeenCalledTimes(failing === 'lookup_request_key' ? 1 : 2);
        }
    });
    it('does not execute a request that expires during lookup or verification', async () => {
        const h = harness();
        h.nowSeconds.mockReturnValueOnce(NOW).mockReturnValue(request.expiresAt);
        await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(ResearchGatewayError);
        expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
    });
    it('fails closed on unavailable crypto or private provider exceptions', async () => {
        for (const provider of [
            undefined,
            {
                subtle: {
                    importKey: () => {
                        throw new Error(PRIVATE_ERROR);
                    },
                },
            },
        ]) {
            vi.stubGlobal('crypto', provider);
            const h = harness();
            await expect(h.gateway.dispatch(CREDENTIAL, JSON.stringify(request))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
            vi.unstubAllGlobals();
        }
    });
    it.each(['blocked', 'device-revoked', 'record-conflict'])(
        'accepts only an exact immutable terminal %s receipt',
        async (reason) => {
            const h = harness();
            const sent = await signRequest({ action: 'send', payload: encodeResearchOutbox(outbox) });
            h.rpc.mockImplementation(async (name) =>
                name === 'lookup_request_key' ? { signingKey } : { ...outbox, accepted: false, reason },
            );
            const receipt = await h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(sent));
            expect(receipt).toEqual({ ...outbox, accepted: false, reason });
            expect(Object.isFrozen(receipt)).toBe(true);
        },
    );
    it('rejects mismatched or unsafe send receipts even after the SQL adapter resolves', async () => {
        const sent = await signRequest({ action: 'send', payload: encodeResearchOutbox(outbox) });
        const getter = vi.fn(() => true);
        const accepted = { ...outbox, accepted: true };
        for (const receipt of [
            null,
            { accepted: true },
            { ...accepted, debug: PRIVATE_ERROR },
            { ...accepted, ownerUserId: 'mallory' },
            { ...accepted, ownerSessionGeneration: 8 },
            { ...accepted, recipientUserId: 'other' },
            { ...accepted, recipientIdentityKeyId: 'bob-key-2' },
            { ...accepted, recipientIdentityGeneration: 3 },
            { ...accepted, serializedEnvelope: 'different' },
            { ...outbox, accepted: false },
            { ...outbox, accepted: false, reason: 'timeout' },
            { ...accepted, accepted: 'true' },
            Object.defineProperty({ ...accepted }, 'accepted', { get: getter }),
            Object.assign(Object.create({ inherited: true }), accepted),
        ]) {
            const h = harness();
            h.rpc.mockImplementation(async (name) => (name === 'lookup_request_key' ? { signingKey } : receipt));
            await expect(h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(sent))).rejects.toThrow(
                new ResearchGatewayError(),
            );
            expect(h.rpc).toHaveBeenCalledTimes(2);
        }
        expect(getter).not.toHaveBeenCalled();
    });
});

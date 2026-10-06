// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ResearchGatewayError } from '../experiments/scuttlebutt-e2ee/relay/gateway';
import {
    createResearchSignedGateway,
    type ResearchAccountModeStatus,
    type ResearchSignedGatewayDependencies,
} from '../experiments/scuttlebutt-e2ee/relay/signedGateway';
import {
    encodeSignedResearchRequest,
    parseResearchSignedRequest,
    researchRequestSigningBytes,
    type ResearchSignedRequest,
    type UnsignedResearchRequest,
} from '../experiments/scuttlebutt-e2ee/relay/signedRequest';

// Real Ed25519 fixture signatures; typed Auth and SQL mocks. This suite proves
// gateway framing/authority/receipts, not live Auth, durable SQL or encryption.
const NOW = 1_800_000_000;
const USER = 'cutover-owner';
const DEVICE = 'cutover-owner-phone';
const CREDENTIAL = 'synthetic-cutover-credential';
const PRIVATE_ERROR = 'PRIVATE synthetic credential/database contents';
type ModeAction = 'require-protected' | 'account-mode';
const unsigned: UnsignedResearchRequest = {
    version: 1,
    protocol: 'olm-v1',
    userId: USER,
    deviceId: DEVICE,
    action: 'require-protected',
    requestId: 'cutover-request-1',
    expiresAt: NOW + 60,
    payload: '[]',
};
let signer: webcrypto.CryptoKeyPair;
let otherSigner: webcrypto.CryptoKeyPair;
let signingKey: string;

function independentBytes(value: UnsignedResearchRequest): Uint8Array<ArrayBuffer> {
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
async function sign(
    patch: Partial<UnsignedResearchRequest> = {},
    privateKey = signer.privateKey,
): Promise<ResearchSignedRequest> {
    const value = { ...unsigned, ...patch };
    const signature = Buffer.from(await webcrypto.subtle.sign('Ed25519', privateKey, independentBytes(value)))
        .toString('base64')
        .replace(/=+$/, '');
    return { ...value, signature };
}
function receipt(
    request: UnsignedResearchRequest = unsigned,
    mode: ResearchAccountModeStatus['mode'] = 'protected-required',
): ResearchAccountModeStatus {
    return { requestId: request.requestId, ownerUserId: request.userId, ownerDeviceId: request.deviceId, mode };
}
function harness(result: unknown = receipt()) {
    const authenticate = vi.fn<ResearchSignedGatewayDependencies['authenticate']>(async () => ({ userId: USER }));
    const rpc = vi.fn<ResearchSignedGatewayDependencies['rpc']>(async (name) =>
        name === 'lookup_request_key' ? { signingKey } : result,
    );
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
beforeAll(async () => {
    [signer, otherSigner] = (await Promise.all([
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
        webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
    ])) as webcrypto.CryptoKeyPair[];
    signingKey = Buffer.from(await webcrypto.subtle.exportKey('raw', signer.publicKey))
        .toString('base64')
        .replace(/=+$/, '');
});

describe('isolated server cutover signed gateway contract', () => {
    it.each(['require-protected', 'account-mode'] as const)(
        'binds the unchanged request domain, authenticated account and registered device for %s',
        async (action: ModeAction) => {
            const request = await sign({ action });
            const wire = encodeSignedResearchRequest(request);
            expect(parseResearchSignedRequest(wire, USER, NOW)).toEqual(request);
            expect(
                researchRequestSigningBytes({
                    version: request.version,
                    protocol: request.protocol,
                    userId: request.userId,
                    deviceId: request.deviceId,
                    action: request.action,
                    requestId: request.requestId,
                    expiresAt: request.expiresAt,
                    payload: request.payload,
                }),
            ).toEqual(independentBytes(request));
            const h = harness(receipt(request));
            const result = await h.gateway.dispatch(CREDENTIAL, wire);
            expect(result).toEqual(receipt(request));
            expect(Object.isFrozen(result)).toBe(true);
            expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(CREDENTIAL);
            expect(h.rpc.mock.calls).toEqual([
                ['lookup_request_key', [USER, DEVICE]],
                ['execute_request', [USER, DEVICE, request.requestId, action, '[]', request.expiresAt, wire]],
            ]);
        },
    );

    it('accepts legacy-permitted only for a fresh mode diagnostic and does not cache it', async () => {
        const request = await sign({ action: 'account-mode' });
        const wire = encodeSignedResearchRequest(request);
        const h = harness();
        h.rpc
            .mockResolvedValueOnce({ signingKey })
            .mockResolvedValueOnce(receipt(request, 'legacy-permitted'))
            .mockResolvedValueOnce({ signingKey })
            .mockResolvedValueOnce(receipt(request));
        expect(await h.gateway.dispatch(CREDENTIAL, wire)).toEqual(receipt(request, 'legacy-permitted'));
        expect(await h.gateway.dispatch(CREDENTIAL, wire)).toEqual(receipt(request));
        expect(h.authenticate).toHaveBeenCalledTimes(2);
        expect(h.rpc.mock.calls.filter(([name]) => name === 'execute_request')).toHaveLength(2);
        const require = harness(receipt(unsigned, 'legacy-permitted'));
        await expect(require.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(await sign()))).rejects.toThrow(
            ResearchGatewayError,
        );
    });

    it.each(['require-protected', 'account-mode'] as const)(
        'rejects caller-selected modes, peers and noncanonical payloads for %s before key lookup',
        async (action: ModeAction) => {
            for (const payload of [
                '["protected-required"]',
                '["legacy-permitted"]',
                '["other-account"]',
                '[false]',
                '[null]',
                '{}',
                '[ ]',
                ' []',
                '[] ',
            ]) {
                const h = harness();
                await expect(
                    h.gateway.dispatch(CREDENTIAL, JSON.stringify(await sign({ action, payload }))),
                ).rejects.toThrow(ResearchGatewayError);
                expect(h.rpc).not.toHaveBeenCalled();
            }
        },
    );

    it('rejects absent/wrong Auth, an unregistered device and a wrong registered-device signature', async () => {
        const wire = encodeSignedResearchRequest(await sign());
        for (const principal of [null, { userId: 'different-owner' }]) {
            const h = harness();
            h.authenticate.mockResolvedValue(principal);
            await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        }
        const missingDevice = harness();
        missingDevice.rpc.mockRejectedValue(new Error(PRIVATE_ERROR));
        await expect(missingDevice.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        expect(missingDevice.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
        const wrongSigner = harness();
        const wrongWire = encodeSignedResearchRequest(await sign({}, otherSigner.privateKey));
        await expect(wrongSigner.gateway.dispatch(CREDENTIAL, wrongWire)).rejects.toThrow(ResearchGatewayError);
        expect(wrongSigner.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
    });

    it.each(['requestId', 'ownerUserId', 'ownerDeviceId'] as const)(
        'rejects a committed receipt for another %s',
        async (field) => {
            const h = harness({ ...receipt(), [field]: 'different-id' });
            await expect(h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(await sign()))).rejects.toThrow(
                ResearchGatewayError,
            );
        },
    );

    it('requires exactly four own enumerable data fields and a known mode without invoking getters', async () => {
        const wire = encodeSignedResearchRequest(await sign({ action: 'account-mode' }));
        const getter = vi.fn(() => 'protected-required');
        const missing: Record<string, unknown> = { ...receipt() };
        delete missing.mode;
        for (const result of [
            missing,
            { ...receipt(), selectedAt: NOW },
            { ...receipt(), [Symbol('extra')]: false },
            Object.assign(Object.create({ inherited: true }), receipt()),
            Object.defineProperty({ ...receipt() }, 'mode', { enumerable: true, get: getter }),
            Object.defineProperty({ ...receipt() }, 'mode', { enumerable: false }),
            ...['unknown', 'legacy', true, 1, null, undefined].map((mode) => ({ ...receipt(), mode })),
        ]) {
            const h = harness(result);
            await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('does not dispatch a cutover that expires during the trusted key lookup', async () => {
        const h = harness();
        h.nowSeconds.mockReturnValueOnce(NOW).mockReturnValueOnce(unsigned.expiresAt);
        await expect(h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(await sign()))).rejects.toThrow(
            ResearchGatewayError,
        );
        expect(h.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
    });

    it('publishes no cutover receipt before the SQL adapter resolves its commit', async () => {
        const h = harness();
        const commit = deferred<unknown>();
        h.rpc.mockImplementation(async (name) => (name === 'lookup_request_key' ? { signingKey } : commit.promise));
        let published = false;
        const pending = h.gateway.dispatch(CREDENTIAL, encodeSignedResearchRequest(await sign())).then((result) => {
            published = true;
            return result;
        });
        await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
        expect(published).toBe(false);
        commit.resolve(receipt());
        expect(await pending).toEqual(receipt());
    });

    it('leaves backend failures unresolved without exposing their private contents', async () => {
        const h = harness();
        h.rpc.mockImplementation(async (name) => {
            if (name === 'lookup_request_key') return { signingKey };
            throw new Error(PRIVATE_ERROR);
        });
        const wire = encodeSignedResearchRequest(await sign());
        await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(new ResearchGatewayError());
        await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.not.toThrow(PRIVATE_ERROR);
    });
});

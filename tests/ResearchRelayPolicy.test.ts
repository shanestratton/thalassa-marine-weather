// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ResearchGatewayError } from '../experiments/scuttlebutt-e2ee/relay/gateway';
import {
    createResearchSignedGateway,
    type ResearchPolicyStatus,
    type ResearchSignedGatewayDependencies,
} from '../experiments/scuttlebutt-e2ee/relay/signedGateway';
import {
    encodeSignedResearchRequest,
    parseResearchSignedRequest,
    researchRequestSigningBytes,
    type ResearchSignedRequest,
    type UnsignedResearchRequest,
} from '../experiments/scuttlebutt-e2ee/relay/signedRequest';

// Real request signatures; mocked Auth/SQL. Current database flags and ledger
// bypass are separately exercised by the disposable signed SQL proof.
const NOW = 1_800_000_000;
const USER = 'policy-alice';
const DEVICE = 'policy-alice-ios';
const CREDENTIAL = 'synthetic-policy-credential';
const PRIVATE_ERROR = 'PRIVATE synthetic credential/database contents';
const unsigned: UnsignedResearchRequest = {
    version: 1,
    protocol: 'olm-v1',
    userId: USER,
    deviceId: DEVICE,
    action: 'policy',
    requestId: 'policy-read-1',
    expiresAt: NOW + 60,
    payload: '["policy-bob","policy-bob-ios","policy-bob-key"]',
};
const status: ResearchPolicyStatus = {
    requestId: unsigned.requestId,
    ownerUserId: USER,
    ownerDeviceId: DEVICE,
    peerUserId: 'policy-bob',
    peerDeviceId: 'policy-bob-ios',
    peerIdentityKeyId: 'policy-bob-key',
    ownerRevoked: false,
    peerRevoked: false,
    blockedByMe: false,
    blockedByPeer: false,
};
let signer: webcrypto.CryptoKeyPair;
let signingKey: string;
let request: ResearchSignedRequest;
let wire: string;

async function sign(patch: Partial<UnsignedResearchRequest> = {}): Promise<ResearchSignedRequest> {
    const value = { ...unsigned, ...patch };
    // Independent wire domain/order; not an encoder-verifier self-agreement.
    const bytes = new TextEncoder().encode(
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
    const signature = Buffer.from(await webcrypto.subtle.sign('Ed25519', signer.privateKey, bytes))
        .toString('base64')
        .replace(/=+$/, '');
    return { ...value, signature };
}
beforeAll(async () => {
    signer = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    signingKey = Buffer.from(await webcrypto.subtle.exportKey('raw', signer.publicKey))
        .toString('base64')
        .replace(/=+$/, '');
    request = await sign();
    wire = encodeSignedResearchRequest(request);
});
function harness(result: unknown = { ...status }) {
    const authenticate = vi.fn<ResearchSignedGatewayDependencies['authenticate']>(async () => ({ userId: USER }));
    const rpc = vi.fn<ResearchSignedGatewayDependencies['rpc']>(async (name) =>
        name === 'lookup_request_key' ? { signingKey } : result,
    );
    const nowSeconds = vi.fn(() => NOW);
    return { authenticate, rpc, nowSeconds, gateway: createResearchSignedGateway({ authenticate, rpc, nowSeconds }) };
}

describe('research signed bilateral policy action', () => {
    it('uses the exact three-ID canonical payload and device-signed request domain', async () => {
        expect(encodeSignedResearchRequest(request)).toBe(JSON.stringify(request));
        expect(parseResearchSignedRequest(wire, USER, NOW)).toEqual(request);
        expect(new TextDecoder().decode(researchRequestSigningBytes(unsigned))).toBe(
            JSON.stringify([
                'thalassa-relay-request',
                1,
                'olm-v1',
                USER,
                DEVICE,
                'policy',
                unsigned.requestId,
                unsigned.expiresAt,
                unsigned.payload,
            ]),
        );
        const h = harness();
        const result = await h.gateway.dispatch(CREDENTIAL, wire);
        expect(result).toEqual(status);
        expect(Object.isFrozen(result)).toBe(true);
        expect(h.rpc).toHaveBeenNthCalledWith(1, 'lookup_request_key', [USER, DEVICE]);
        expect(h.rpc).toHaveBeenNthCalledWith(2, 'execute_request', [
            USER,
            DEVICE,
            unsigned.requestId,
            'policy',
            unsigned.payload,
            unsigned.expiresAt,
            wire,
        ]);
    });

    it('reverifies and reexecutes an exact nonce replay instead of caching false flags', async () => {
        const h = harness();
        h.rpc
            .mockResolvedValueOnce({ signingKey })
            .mockResolvedValueOnce({ ...status })
            .mockResolvedValueOnce({ signingKey })
            .mockResolvedValueOnce({ ...status, ownerRevoked: true, peerRevoked: true, blockedByPeer: true });
        expect(await h.gateway.dispatch(CREDENTIAL, wire)).toEqual(status);
        expect(await h.gateway.dispatch(CREDENTIAL, wire)).toEqual({
            ...status,
            ownerRevoked: true,
            peerRevoked: true,
            blockedByPeer: true,
        });
        expect(h.authenticate).toHaveBeenCalledTimes(2);
        expect(h.rpc.mock.calls.filter(([name]) => name === 'execute_request')).toHaveLength(2);
    });

    it.each([
        '[]',
        '["policy-bob","policy-bob-ios"]',
        '["policy-bob","policy-bob-ios","policy-bob-key","extra"]',
        '{"peerUserId":"policy-bob","peerDeviceId":"policy-bob-ios","peerIdentityKeyId":"policy-bob-key"}',
        '["policy-bob","policy-bob-ios",null]',
        '["policy-bob","policy-bob-ios",true]',
        '["policy-bob","policy-bob-ios",""]',
        '["policy-bob","policy-bob-ios","bad key"]',
        '["policy-alice","policy-bob-ios","policy-bob-key"]',
        '["policy-bob","policy-alice-ios","policy-bob-key"]',
        ' ["policy-bob","policy-bob-ios","policy-bob-key"]',
        '["policy-bob", "policy-bob-ios","policy-bob-key"]',
        '["\\u0070olicy-bob","policy-bob-ios","policy-bob-key"]',
    ])('rejects a malformed or aliased policy payload before key lookup: %s', async (payload) => {
        const malformed = JSON.stringify(await sign({ payload }));
        const h = harness();
        await expect(h.gateway.dispatch(CREDENTIAL, malformed)).rejects.toThrow(ResearchGatewayError);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('rejects unknown actions, extra or duplicate fields and noncanonical frames', async () => {
        for (const alternative of [
            JSON.stringify({ ...request, action: 'policy-unknown' }),
            JSON.stringify({ ...request, peerIdentityKeyId: status.peerIdentityKeyId }),
            wire.replace('"action":"policy"', '"action":"policy","action":"policy"'),
            wire.replace('"payload":', `"payload":${JSON.stringify(unsigned.payload)},"payload":`),
            JSON.stringify(Object.fromEntries(Object.entries(request).reverse())),
            `${wire} `,
        ]) {
            const h = harness();
            await expect(h.gateway.dispatch(CREDENTIAL, alternative)).rejects.toThrow(ResearchGatewayError);
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it.each(['requestId', 'ownerUserId', 'ownerDeviceId', 'peerUserId', 'peerDeviceId', 'peerIdentityKeyId'] as const)(
        'rejects a policy result for another %s',
        async (field) => {
            const h = harness({ ...status, [field]: 'different-id' });
            await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        },
    );

    it('requires exactly ten own enumerable result fields and four booleans without invoking getters', async () => {
        const getter = vi.fn(() => false);
        const missing: Record<string, unknown> = { ...status };
        delete missing.blockedByPeer;
        for (const result of [
            missing,
            { ...status, extra: false },
            { ...status, [Symbol('extra')]: false },
            Object.assign(Object.create({ inherited: true }), status),
            Object.defineProperty({ ...status }, 'blockedByPeer', { enumerable: true, get: getter }),
            Object.defineProperty({ ...status }, 'blockedByPeer', { enumerable: false }),
            ...(['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'] as const).flatMap((field) =>
                [0, 1, 'false', null, undefined].map((value) => ({ ...status, [field]: value })),
            ),
        ]) {
            const h = harness(result);
            await expect(h.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects expiry during key verification and sanitizes backend failures', async () => {
        const expired = harness();
        expired.nowSeconds.mockReturnValueOnce(NOW).mockReturnValueOnce(unsigned.expiresAt);
        await expect(expired.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(ResearchGatewayError);
        expect(expired.rpc).toHaveBeenCalledExactlyOnceWith('lookup_request_key', [USER, DEVICE]);
        const failed = harness();
        failed.rpc.mockImplementation(async (name) => {
            if (name === 'lookup_request_key') return { signingKey };
            throw new Error(PRIVATE_ERROR);
        });
        await expect(failed.gateway.dispatch(CREDENTIAL, wire)).rejects.toThrow(new ResearchGatewayError());
        await expect(failed.gateway.dispatch(CREDENTIAL, wire)).rejects.not.toThrow(PRIVATE_ERROR);
    });
});

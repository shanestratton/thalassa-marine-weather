import { describe, expect, it, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createHash, type KeyObject } from 'node:crypto';

/**
 * Pairing crypto and the no-downgrade rule.
 *
 * The signatures are produced HERE with Node's crypto (the Pi's exact
 * signing path: ECDSA P-256, ieee-p1363, fields joined by '|') and verified
 * by the app's WebCrypto code. A green test is therefore proof the two halves
 * interoperate, not just that each is internally consistent — the thing an
 * in-process mock could never show.
 */

// Sign the way identity.ts does, with a key generated per-test.
function makeSigner() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const fingerprint = createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex')
        .toUpperCase()
        .slice(0, 16)
        .replace(/(..)(?=.)/g, '$1:');
    const signFields = (fields: string[]): string =>
        nodeSign('sha256', Buffer.from(fields.join('|'), 'utf8'), {
            key: privateKey as KeyObject,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64');
    return { spkiB64, fingerprint, signFields };
}

const DEVICE_ID = 'test-device-1';

// The pinned transport is mocked per-test to serve the pair endpoints.
// `peerSpki` is the key that terminated TLS — the channel binding under test.
const tls = vi.hoisted(() => ({ pairingFetch: vi.fn(), request: vi.fn() }));
vi.mock('../services/piTls', () => ({
    piPairingFetch: tls.pairingFetch,
    piRequest: tls.request,
    isPinnedTransportAvailable: () => true,
}));

import {
    getPairing,
    savePairing,
    forgetPairing,
    isLegacyPlainConnectionAllowed,
    markHostPairable,
    verifyPairedPi,
    verifySignedResponse,
    pairWithPi,
    type PiPairingRecord,
} from '../services/PiPairingService';

function record(over: Partial<PiPairingRecord> & { publicKeySpki: string }): PiPairingRecord {
    return {
        deviceId: DEVICE_ID,
        boatName: 'Serene Summer',
        fingerprint: 'AA:BB',
        host: 'calypso.local',
        pairedAt: '2026-08-04T00:00:00Z',
        ...over,
    };
}

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

describe('PiPairingService — signed response verification', () => {
    it('accepts a payload signature the Pi would produce', async () => {
        const pi = makeSigner();
        const body = JSON.stringify({ cells: [{ cellId: 'FR466870' }] });
        const path = '/api/enc/installed';
        const time = '1785800000000';
        const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
        const sig = pi.signFields(['payload', bodyHash, path, time]);

        const check = await verifySignedResponse(record({ publicKeySpki: pi.spkiB64 }), body, path, {
            'X-Pi-Signature': sig,
            'X-Pi-Signature-Time': time,
        });
        expect(check.ok).toBe(true);
    });

    it('rejects a tampered body (hash no longer matches)', async () => {
        const pi = makeSigner();
        const body = JSON.stringify({ cells: [{ cellId: 'FR466870', depth: 10 }] });
        const path = '/api/enc/installed';
        const time = '1785800000000';
        const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
        const sig = pi.signFields(['payload', bodyHash, path, time]);

        const tampered = body.replace('10', '99'); // attacker rewrites a depth
        const check = await verifySignedResponse(record({ publicKeySpki: pi.spkiB64 }), tampered, path, {
            'X-Pi-Signature': sig,
            'X-Pi-Signature-Time': time,
        });
        expect(check.ok).toBe(false);
    });

    it('rejects a signature replayed under a different path', async () => {
        const pi = makeSigner();
        const body = JSON.stringify({ cells: [] });
        const time = '1785800000000';
        const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
        const sig = pi.signFields(['payload', bodyHash, '/api/enc/installed', time]);

        const check = await verifySignedResponse(
            record({ publicKeySpki: pi.spkiB64 }),
            body,
            '/api/enc/installed/X/data',
            {
                'X-Pi-Signature': sig,
                'X-Pi-Signature-Time': time,
            },
        );
        expect(check.ok).toBe(false);
    });

    it('rejects a signature from a different key (impostor)', async () => {
        const realPi = makeSigner();
        const impostor = makeSigner();
        const body = JSON.stringify({ cells: [] });
        const path = '/api/enc/installed';
        const time = '1785800000000';
        const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
        const impostorSig = impostor.signFields(['payload', bodyHash, path, time]);

        const check = await verifySignedResponse(record({ publicKeySpki: realPi.spkiB64 }), body, path, {
            'X-Pi-Signature': impostorSig,
            'X-Pi-Signature-Time': time,
        });
        expect(check.ok).toBe(false);
    });

    it('reports missing signature headers rather than throwing', async () => {
        const pi = makeSigner();
        const check = await verifySignedResponse(record({ publicKeySpki: pi.spkiB64 }), '{}', '/api/enc/installed', {});
        expect(check.ok).toBe(false);
        expect(check.reason).toMatch(/not signed/);
    });
});

describe('PiPairingService — challenge/response', () => {
    it('accepts a Pi that signs the exact nonce it was sent', async () => {
        const pi = makeSigner();
        const rec = record({ publicKeySpki: pi.spkiB64 });
        tls.request.mockImplementation(async ({ data }: { data: { nonce: string } }) => {
            const timestamp = 1785800000000;
            return {
                status: 200,
                peerSpki: pi.spkiB64,
                data: JSON.stringify({
                    deviceId: DEVICE_ID,
                    timestamp,
                    signature: pi.signFields(['challenge', data.nonce, String(timestamp), DEVICE_ID]),
                }),
            };
        });
        expect(await verifyPairedPi('https://calypso.local:3001', rec)).toBe(true);
        // The challenge must ride a pinned channel, not an open one.
        expect(tls.request.mock.calls[0][0].pinnedSpki).toBe(pi.spkiB64);
    });

    it('rejects a Pi that signs a DIFFERENT nonce (replay of an old challenge)', async () => {
        const pi = makeSigner();
        const rec = record({ publicKeySpki: pi.spkiB64 });
        tls.request.mockImplementation(async () => {
            const timestamp = 1785800000000;
            return {
                status: 200,
                peerSpki: pi.spkiB64,
                data: JSON.stringify({
                    deviceId: DEVICE_ID,
                    timestamp,
                    signature: pi.signFields(['challenge', 'stale-nonce', String(timestamp), DEVICE_ID]),
                }),
            };
        });
        expect(await verifyPairedPi('https://calypso.local:3001', rec)).toBe(false);
    });

    it('rejects a wrong deviceId even with a valid-looking signature', async () => {
        const pi = makeSigner();
        const rec = record({ publicKeySpki: pi.spkiB64 });
        tls.request.mockImplementation(async ({ data }: { data: { nonce: string } }) => {
            const timestamp = 1785800000000;
            return {
                status: 200,
                peerSpki: pi.spkiB64,
                data: JSON.stringify({
                    deviceId: 'someone-else',
                    timestamp,
                    signature: pi.signFields(['challenge', data.nonce, String(timestamp), 'someone-else']),
                }),
            };
        });
        expect(await verifyPairedPi('https://calypso.local:3001', rec)).toBe(false);
    });
});

describe('PiPairingService — pairWithPi challenges before trusting', () => {
    it('refuses to pair when the responder cannot sign for the key it advertises', async () => {
        const real = makeSigner();
        const impostor = makeSigner();
        // info advertises the REAL key…
        tls.pairingFetch.mockResolvedValue({
            status: 200,
            // TLS was terminated by the real key, so the binding check passes
            // and the challenge is what has to catch this.
            peerSpki: real.spkiB64,
            data: JSON.stringify({
                service: 'thalassa-pi-cache',
                deviceId: DEVICE_ID,
                boatName: 'Serene Summer',
                publicKeySpki: real.spkiB64,
                fingerprint: real.fingerprint,
            }),
        });
        // …but the challenge is answered by the IMPOSTOR's private key.
        tls.request.mockImplementation(async ({ data }: { data: { nonce: string } }) => {
            const timestamp = 1785800000000;
            return {
                status: 200,
                peerSpki: real.spkiB64,
                data: JSON.stringify({
                    deviceId: DEVICE_ID,
                    timestamp,
                    signature: impostor.signFields(['challenge', data.nonce, String(timestamp), DEVICE_ID]),
                }),
            };
        });
        expect(await pairWithPi('https://calypso.local:3001', 'calypso.local')).toBeNull();
        expect(getPairing()).toBeNull();
    });

    it('refuses to pair when the advertised key did not terminate the TLS session', async () => {
        const real = makeSigner();
        const relay = makeSigner();
        // A relay fronting for the real Pi: it can forward the genuine pairing
        // card, but it holds the connection with its OWN certificate. Before
        // TLS this was invisible; the binding is what exposes it, BEFORE any
        // challenge is even attempted.
        tls.pairingFetch.mockResolvedValue({
            status: 200,
            peerSpki: relay.spkiB64,
            data: JSON.stringify({
                service: 'thalassa-pi-cache',
                deviceId: DEVICE_ID,
                boatName: 'Serene Summer',
                publicKeySpki: real.spkiB64,
                fingerprint: real.fingerprint,
            }),
        });
        expect(await pairWithPi('https://calypso.local:3001', 'calypso.local')).toBeNull();
        expect(getPairing()).toBeNull();
        expect(tls.request).not.toHaveBeenCalled();
    });

    it('refuses to pair over a channel whose peer key cannot be observed', async () => {
        const real = makeSigner();
        // The browser lane: script cannot see the peer certificate, so the
        // pairing cannot be bound to it. Pinning a key nobody proved they hold
        // on THIS connection is worse than not pairing.
        tls.pairingFetch.mockResolvedValue({
            status: 200,
            peerSpki: '',
            data: JSON.stringify({
                service: 'thalassa-pi-cache',
                deviceId: DEVICE_ID,
                boatName: 'Serene Summer',
                publicKeySpki: real.spkiB64,
                fingerprint: real.fingerprint,
            }),
        });
        expect(await pairWithPi('https://calypso.local:3001', 'calypso.local')).toBeNull();
        expect(getPairing()).toBeNull();
    });
});

describe('PiPairingService — no-downgrade rule', () => {
    it('allows plain connection only before anything is paired or seen pairable', () => {
        expect(isLegacyPlainConnectionAllowed('calypso.local')).toBe(true);
    });

    it('closes the legacy window for a host once it has offered pairing', () => {
        markHostPairable('calypso.local');
        expect(isLegacyPlainConnectionAllowed('calypso.local')).toBe(false);
        // A different, never-seen host stays in the grace window.
        expect(isLegacyPlainConnectionAllowed('other.local')).toBe(true);
    });

    it('closes the legacy window everywhere once any Pi is paired', () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64 }));
        expect(isLegacyPlainConnectionAllowed('never-seen.local')).toBe(false);
    });

    it('round-trips and forgets a pairing record', () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64 }));
        expect(getPairing()?.deviceId).toBe(DEVICE_ID);
        forgetPairing();
        expect(getPairing()).toBeNull();
    });
});

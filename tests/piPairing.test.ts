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
    fetchVerifiedFromPi,
    pinnedPiRequest,
    PiHttpError,
    saveChartDevice,
    dropChartDevice,
    type PiPairingRecord,
} from '../services/PiPairingService';
import { CHART_ACCESS_CODES, chartAccessWords } from '../services/enc/piChartAccessWords';

function record(over: Partial<PiPairingRecord> & { publicKeySpki: string }): PiPairingRecord {
    return {
        deviceId: DEVICE_ID,
        boatName: 'Kestrel',
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
    it('binds chart JSON to the exact signed-index revision, including wire formatting', async () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64 }));
        const body = '{ "cells": [] }';
        const path = '/api/enc/installed/FR466870/data';
        const hash = createHash('sha256').update(body).digest('hex');
        const time = String(Date.now());
        tls.request.mockResolvedValue({
            status: 200,
            data: body,
            headers: {
                'X-Pi-Signature': pi.signFields(['payload', hash, path, time]),
                'X-Pi-Signature-Time': time,
            },
        });
        await expect(
            fetchVerifiedFromPi({ url: `https://calypso.local${path}`, expectedSha256: hash }),
        ).resolves.toEqual({ cells: [] });
        const reformattedHash = createHash('sha256')
            .update(JSON.stringify(JSON.parse(body)))
            .digest('hex');
        await expect(
            fetchVerifiedFromPi({ url: `https://calypso.local${path}`, expectedSha256: reformattedHash }),
        ).rejects.toThrow(/changed since its index/);
    });

    it('does not accept matching content hashes in place of a valid signature', async () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64 }));
        const body = '{"cells":[]}';
        tls.request.mockResolvedValue({ status: 200, data: body, headers: {} });
        await expect(
            fetchVerifiedFromPi({
                url: 'https://calypso.local/api/enc/installed/FR466870/data',
                expectedSha256: createHash('sha256').update(body).digest('hex'),
            }),
        ).rejects.toThrow(/signature check/);
    });

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
                boatName: 'Kestrel',
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
                boatName: 'Kestrel',
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
                boatName: 'Kestrel',
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

describe('PiPairingService — the chart device header (127-C-d)', () => {
    const TOKEN = 'kestrelSolentChartToken_' + 'y'.repeat(19);
    const BASE = 'https://192.168.4.20:3001';
    const sentHeader = (call: number) =>
        (tls.request.mock.calls[call][0] as { headers?: Record<string, string> }).headers?.['X-Thalassa-Chart-Device'];

    beforeEach(() => dropChartDevice());

    it('pinnedPiRequest and fetchVerifiedFromPi add it to /api/enc/* URLs only', async () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64, host: '192.168.4.20' }));
        await saveChartDevice({ chartDeviceId: 'dev-iphone-1', token: TOKEN });
        const body = '{"cells":[]}';
        const time = String(Date.now());
        tls.request.mockImplementation(async ({ url }: { url: string }) => {
            const path = new URL(url).pathname;
            const hash = createHash('sha256').update(body).digest('hex');
            return {
                status: 200,
                data: body,
                headers: {
                    'X-Pi-Signature': pi.signFields(['payload', hash, path, time]),
                    'X-Pi-Signature-Time': time,
                },
            };
        });

        await pinnedPiRequest({ url: `${BASE}/api/enc/health` });
        await fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` });
        await fetchVerifiedFromPi({ url: `${BASE}/api/enc/route-prepped`, method: 'POST', data: {} });
        await pinnedPiRequest({ url: `${BASE}/api/admin/status` });
        await pinnedPiRequest({ url: `${BASE}/api/pair/challenge`, method: 'POST', data: {} });
        await fetchVerifiedFromPi({ url: `${BASE}/api/osm/overlay` });

        expect([0, 1, 2, 3, 4, 5].map(sentHeader)).toEqual([TOKEN, TOKEN, TOKEN, undefined, undefined, undefined]);
        // A POST keeps its JSON content type beside the header.
        expect(tls.request.mock.calls[2][0].headers['Content-Type']).toBe('application/json');
    });

    it('piPairingFetch (/api/pair/info) never carries it: its transport takes a base URL and nothing else', async () => {
        const pi = makeSigner();
        savePairing(record({ publicKeySpki: pi.spkiB64 }));
        await saveChartDevice({ chartDeviceId: 'dev-iphone-1', token: TOKEN });
        tls.pairingFetch.mockResolvedValue({ status: 404, data: '', headers: {}, peerSpki: '' });
        await pairWithPi(BASE, '192.168.4.20');
        expect(tls.pairingFetch.mock.calls).toEqual([[BASE]]);
    });

    it.each([
        [401, 'chart-device-not-enrolled'],
        [403, 'charts-boat-wifi-only'],
        [503, 'vault-decoder-down'],
    ])(
        'a %i with the JSON code %s throws PiHttpError {status, code}, not a bare "HTTP <status>"',
        async (status, code) => {
            savePairing(record({ publicKeySpki: makeSigner().spkiB64 }));
            tls.request.mockResolvedValue({ status, data: JSON.stringify({ code, error: 'refused' }), headers: {} });
            const error = await fetchVerifiedFromPi({ url: `${BASE}/api/enc/installed` }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(PiHttpError);
            expect(error).toMatchObject({ status, code });
            // The message stays "HTTP <status>": EncImportService still reads
            // 'HTTP 404' off it for a job the Pi has no receipt for.
            expect((error as Error).message).toBe(`HTTP ${status}`);
        },
    );

    it("a status with no JSON code is still a PiHttpError, with no code (today's Pi's own 404 page)", async () => {
        savePairing(record({ publicKeySpki: makeSigner().spkiB64 }));
        tls.request.mockResolvedValue({ status: 404, data: '<pre>Cannot GET /api/enc/jobs/x</pre>', headers: {} });
        const error = await fetchVerifiedFromPi({ url: `${BASE}/api/enc/jobs/x` }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PiHttpError);
        expect(error).toMatchObject({ status: 404, code: undefined, message: 'HTTP 404' });
    });
});

describe('the words for each refusal (services/enc/piChartAccessWords.ts)', () => {
    it('says each code in a plain sentence, naming the boat from the pairing', () => {
        const said = Object.fromEntries(
            CHART_ACCESS_CODES.map((code) => [code, chartAccessWords(code, 'Kestrel').text]),
        );
        expect(said['charts-boat-wifi-only']).toBe("Charts come over Kestrel's own Wi-Fi. Join it to get charts.");
        expect(said['vault-decoder-down']).toBe(
            "Kestrel can't open her charts. Check the o-charts dongle is plugged into the Pi.",
        );
        expect(said['chart-device-limit']).toBe(
            "Five phones and tablets already get Kestrel's charts. Remove one to add this one.",
        );
        for (const [code, text] of Object.entries(said)) {
            expect(text, code).toMatch(/^[A-Z].*[.]$/);
            expect(text, code).not.toMatch(/Serene Summer|HTTP|\b[45]\d\d\b|undefined/);
            expect(text, code).not.toContain(code);
        }
        // Every code has its own sentence, never the fallback.
        const fallback = chartAccessWords('something-new', 'Kestrel').text;
        expect(Object.values(said)).not.toContain(fallback);
        expect(new Set(Object.values(said)).size).toBe(CHART_ACCESS_CODES.length);
    });

    it('marks the quiet codes as not-an-error, for the status line', () => {
        // Off the boat's Wi-Fi (the tailnet from home) is the normal answer
        // there, not a fault: 127-C-c's status line shows it muted.
        expect(chartAccessWords('charts-boat-wifi-only', 'Kestrel').quiet).toBe(true);
        expect(chartAccessWords('pi-needs-update', 'Kestrel').quiet).toBe(true);
        expect(chartAccessWords('vault-starting', 'Kestrel').quiet).toBe(true);
        expect(chartAccessWords('vault-decoder-down', 'Kestrel').quiet).toBe(false);
        expect(chartAccessWords('chart-device-limit', 'Kestrel').quiet).toBe(false);
        expect(chartAccessWords('chart-device-removed', 'Kestrel').quiet).toBe(false);
        expect(chartAccessWords(undefined, 'Kestrel').quiet).toBe(false);
    });

    it('works for any boat name, and without one', () => {
        expect(chartAccessWords('charts-boat-wifi-only', 'Étoile du Nord').text).toBe(
            "Charts come over Étoile du Nord's own Wi-Fi. Join it to get charts.",
        );
        expect(chartAccessWords('charts-boat-wifi-only', '').text).toBe(
            "Charts come over your boat's own Wi-Fi. Join it to get charts.",
        );
    });
});

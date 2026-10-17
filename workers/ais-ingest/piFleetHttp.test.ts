import { it, expect } from 'vitest';
import http from 'node:http';
import { createPublicKey, generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { createPiFleetHttp, type PiFleetHttpDeps } from './piFleetHttp.js';
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetForwardBatchBytes,
    fleetConsentProposalBytes,
    type FleetForwardBatch,
} from './fleetForwardingWire.js';
import { fleetRelayTokenHash } from './fleetCrypto.js';

async function fixture() {
    const at = Date.now(),
        token = 'e'.repeat(64),
        pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = createPublicKey(pair.privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    const binding = {
        ownerId: '10000000-0000-4000-8000-000000000001',
        boatId: '20000000-0000-4000-8000-000000000001',
        piDeviceId: '30000000-0000-4000-8000-000000000001',
        relayId: 'fixture-http-relay140',
        pairingId: 'a'.repeat(64),
        controllerId: '40000000-0000-4000-8000-000000000001',
        enrollmentRevision: 'b'.repeat(64),
        sourceKey: 'c'.repeat(64),
    };
    const grant = { binding, revision: randomUUID(), spki, enabled: true, expiresAt: at + 3600000 };
    const events: string[] = [];
    const deps: PiFleetHttpDeps = {
        operatorEnabled: true,
        authenticateOwner: async () => binding.ownerId,
        store: {
            relay: async () => ({
                ownerId: binding.ownerId,
                boatId: binding.boatId,
                relayId: binding.relayId,
                tokenHash: fleetRelayTokenHash(token),
            }),
            grant: async () => grant,
            currentGrant: async () => grant,
            admit: async () => {
                events.push('admit');
                return true;
            },
            configure: async (p) => ({
                schema: 1,
                binding: p.binding,
                revision: randomUUID(),
                enabled: p.enabled,
                consentVersion: LIMIT.consentVersion,
                issuedAt: Date.now(),
                expiresAt: p.expiresAt ?? at + 3600000,
            }),
        },
        enqueue: () => events.push('enqueue'),
        scheduleForward: () => events.push('forward'),
    };
    const handler = createPiFleetHttp(deps),
        server = http.createServer((req, res) => {
            void handler(req, res).then((used) => {
                if (!used) {
                    res.writeHead(404);
                    res.end();
                }
            });
        });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const signature = (body: string, path: string, time = at) =>
        sign('sha256', Buffer.from(`payload|${createHash('sha256').update(body).digest('hex')}|${path}|${time}`), {
            key: pair.privateKey,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64');
    const batch: FleetForwardBatch = {
        schema: 1,
        binding,
        consentRevision: grant.revision,
        bootId: randomUUID(),
        sequence: 1,
        sentAt: at,
        cell: { id: 'v1:31:166', measuredAt: at - 1000 },
        observations: [{ sentence: '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D', receivedAt: at - 500 }],
    };
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
        fetch(base + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'X-Thalassa-Relay': binding.relayId,
                'X-Thalassa-Pi-Signature': signature(body, path),
                ...headers,
            },
            body,
        });
    const close = () => {
        server.closeAllConnections();
        server.close();
    };
    return { deps, events, binding, grant, spki, at, batch, signature, base, post, close };
}
it('actual HTTP front door admits only the exact signed Pi batch before shared enqueue/forward', async () => {
    const f = await fixture();
    try {
        const response = await f.post(LIMIT.batchPath, fleetForwardBatchBytes(f.batch));
        expect(response.status).toBe(200);
        expect((await response.json()).deliveryConfirmed).toBe(false);
        expect(f.events).toEqual(['admit', 'enqueue', 'forward']);
    } finally {
        f.close();
    }
});
it('preflight is bounded/config-independent; missing setup, auth, encoding and large bodies never touch stores', async () => {
    const f = await fixture();
    try {
        expect((await fetch(f.base + LIMIT.batchPath, { method: 'OPTIONS' })).status).toBe(204);
        const body = fleetForwardBatchBytes(f.batch);
        f.deps.operatorEnabled = false;
        expect((await f.post(LIMIT.batchPath, body)).status).toBe(503);
        f.deps.operatorEnabled = true;
        expect((await f.post(LIMIT.batchPath, body, { Authorization: '' })).status).toBe(401);
        expect((await f.post(LIMIT.batchPath, body, { 'Content-Encoding': 'gzip' })).status).toBe(415);
        expect((await f.post(LIMIT.batchPath, ' '.repeat(LIMIT.batchBytes + 1))).status).toBe(413);
        expect(f.events).toEqual([]);
    } finally {
        f.close();
    }
});
it('actual owner read can review current source/revision after local receipt loss without exposing a relay secret or key', async () => {
    const f = await fixture();
    try {
        const body = JSON.stringify({ schema: 1, binding: f.binding });
        const response = await f.post('/pi-fleet-consent/status/v1', body);
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.grant.revision).toBe(f.grant.revision);
        expect(Object.keys(payload.grant).sort()).toEqual(['binding', 'enabled', 'expiresAt', 'revision']);
        f.deps.authenticateOwner = async () => f.binding.boatId;
        expect((await f.post('/pi-fleet-consent/status/v1', body)).status).toBe(401);
        expect(f.events).toEqual([]);
    } finally {
        f.close();
    }
});
it('held operator still permits owner withdrawal but cannot accept a new Pi grant', async () => {
    const f = await fixture();
    try {
        f.deps.operatorEnabled = false;
        const proposal = {
            schema: 1,
            binding: f.binding,
            expectedRevision: f.grant.revision,
            enabled: false,
            consentVersion: LIMIT.consentVersion,
            at: f.at,
            expiresAt: null,
            nonce: randomUUID(),
            publicKeySpki: null,
        };
        expect((await f.post(LIMIT.consentPath, fleetConsentProposalBytes(proposal))).status).toBe(200);
        const enabled = { ...proposal, enabled: true, expiresAt: f.at + 3600000, publicKeySpki: f.spki };
        expect((await f.post(LIMIT.consentPath, fleetConsentProposalBytes(enabled))).status).toBe(503);
    } finally {
        f.close();
    }
});

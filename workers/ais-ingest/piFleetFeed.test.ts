import { expect, it } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { processPiFleetBatch, processPiFleetConsent, type PiFleetDataDeps } from './piFleetFeed.js';
import { fleetRelayTokenHash, verifyFleetConsentReceipt } from './fleetCrypto.js';
import {
    AIS_FLEET_FORWARDING as LIMIT,
    fleetForwardBatchBytes,
    fleetConsentProposalBytes,
    type FleetConsentProposal,
    type FleetForwardBatch,
    type FleetForwardConsent,
} from './fleetForwardingWire.js';
import type { PiFleetStore } from './piFleetStore.js';

const now = 1_800_000_000_000,
    token = 'd'.repeat(64);
const sentence = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';
const own = '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F';
function fixture() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    const binding = {
        ownerId: '10000000-0000-4000-8000-000000000001',
        boatId: '20000000-0000-4000-8000-000000000001',
        piDeviceId: '30000000-0000-4000-8000-000000000001',
        relayId: 'fictional-relay-14005',
        pairingId: 'a'.repeat(64),
        controllerId: '40000000-0000-4000-8000-000000000001',
        enrollmentRevision: 'b'.repeat(64),
        sourceKey: 'c'.repeat(64),
    };
    const consent: FleetForwardConsent = {
        schema: 1,
        binding,
        revision: '50000000-0000-4000-8000-000000000001',
        enabled: true,
        consentVersion: LIMIT.consentVersion,
        issuedAt: now - 1000,
        expiresAt: now + 100_000,
    };
    const batch: FleetForwardBatch = {
        schema: 1,
        binding,
        consentRevision: consent.revision,
        bootId: '60000000-0000-4000-8000-000000000001',
        sequence: 1,
        sentAt: now,
        cell: { id: 'v1:31:166', measuredAt: now - 1000 },
        observations: [{ sentence, receivedAt: now - 500 }],
    };
    const events: string[] = [],
        admissions: unknown[][] = [];
    let current = true;
    const store: PiFleetStore = {
        async currentGrant() {
            return store.grant(binding);
        },
        async relay() {
            events.push('relay');
            return current
                ? {
                      ownerId: binding.ownerId,
                      boatId: binding.boatId,
                      relayId: binding.relayId,
                      tokenHash: fleetRelayTokenHash(token),
                  }
                : null;
        },
        async grant() {
            events.push('grant');
            return { binding, revision: consent.revision, spki, enabled: true, expiresAt: consent.expiresAt };
        },
        async configure(proposal) {
            events.push('configure');
            return { ...consent, enabled: proposal.enabled };
        },
        async admit(...args) {
            events.push('admit');
            admissions.push(args);
            return current;
        },
    };
    const deps: PiFleetDataDeps = {
        store,
        operatorEnabled: true,
        enqueue: () => {
            events.push('enqueue');
        },
        scheduleForward: () => {
            events.push('forward');
        },
        now: () => now,
    };
    const signature = (body: string, path: string, at = now) =>
        sign('sha256', Buffer.from(`payload|${createHash('sha256').update(body).digest('hex')}|${path}|${at}`), {
            key: privateKey,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64');
    const run = () =>
        processPiFleetBatch(
            JSON.stringify(batch),
            signature(fleetForwardBatchBytes(batch), LIMIT.batchPath),
            binding.relayId,
            token,
            deps,
        );
    const proposal: FleetConsentProposal = {
        schema: 1,
        binding,
        expectedRevision: null,
        enabled: true,
        consentVersion: LIMIT.consentVersion,
        at: now,
        expiresAt: consent.expiresAt,
        nonce: '70000000-0000-4000-8000-000000000001',
        publicKeySpki: spki,
    };
    return {
        batch,
        binding,
        consent,
        proposal,
        store,
        deps,
        events,
        admissions,
        signature,
        run,
        retire: () => {
            current = false;
        },
    };
}
it('actual signed receiver source reaches the shared writer and schedules forwarding only after true admission', async () => {
    const f = fixture(),
        result = await f.run();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: 1, decoded: 1, forwardScheduled: 1, deliveryConfirmed: false });
    expect(f.events).toEqual(['relay', 'grant', 'admit', 'enqueue', 'forward']);
    expect(f.admissions[0][3]).toBe(now - 500);
});
it('operator OFF, malformed packets, tokens and signatures never enqueue or schedule UDP', async () => {
    const f = fixture();
    f.deps.operatorEnabled = false;
    expect((await f.run()).status).toBe(503);
    expect(f.events).toEqual([]);
    f.deps.operatorEnabled = true;
    for (const [raw, signature, relay, credential] of [
        ['{}', 'bad', f.binding.relayId, token],
        [JSON.stringify(f.batch), 'bad', f.binding.relayId, token],
        [JSON.stringify(f.batch), 'bad', 'another-relay-14005', token],
        [JSON.stringify(f.batch), 'bad', f.binding.relayId, 'not-a-token'],
    ]) {
        const result = await processPiFleetBatch(raw, signature, relay, credential, f.deps);
        expect(result.status).not.toBe(200);
    }
    expect(f.events).not.toContain('admit');
    expect(f.events).not.toContain('enqueue');
    expect(f.events).not.toContain('forward');
});
it('private read/admission errors and explicit refusals never fall back to a legacy writer', async () => {
    for (const where of ['relay', 'grant', 'admit'] as const) {
        const f = fixture();
        f.store[where] = async () => {
            throw Error('private unavailable');
        };
        expect((await f.run()).status).toBe(503);
        expect(f.events).not.toContain('enqueue');
        expect(f.events).not.toContain('forward');
    }
    const f = fixture();
    f.retire();
    expect((await f.run()).status).toBe(401);
});
it('current consent retirement or expiry across an awaited key read cannot be adopted', async () => {
    const f = fixture(),
        old = await f.store.grant(f.binding);
    f.store.grant = async () => {
        f.retire();
        return old;
    };
    expect((await f.run()).status).toBe(409);
    expect(f.events).not.toContain('enqueue');
    expect(f.events).not.toContain('forward');
    const expired = fixture();
    expired.store.grant = async () => ({ ...old!, binding: expired.binding, expiresAt: now });
    expect((await expired.run()).status).toBe(403);
});
it('abort during lookup or admitted return cannot publish any queued traffic', async () => {
    for (const where of ['relay', 'admit'] as const) {
        const f = fixture(),
            controller = new AbortController(),
            original = f.store[where];
        f.deps.signal = controller.signal;
        // Keep the production await boundary; abort after the actual async result resolves.
        if (where === 'relay')
            f.store.relay = async (...args) => {
                const result = await (original as PiFleetStore['relay'])(...args);
                controller.abort();
                return result;
            };
        else
            f.store.admit = async (...args) => {
                const result = await (original as PiFleetStore['admit'])(...args);
                controller.abort();
                return result;
            };
        expect((await f.run()).status).toBe(499);
        expect(f.events).not.toContain('enqueue');
        expect(f.events).not.toContain('forward');
    }
});
it('raw ownship messages may forward only under separate Pi consent and never qualify receiver coverage alone', async () => {
    const f = fixture();
    f.batch.observations = [{ sentence: own, receivedAt: now - 500 }];
    expect((await f.run()).status).toBe(400);
    f.batch.cell = null;
    expect((await f.run()).status).toBe(200);
    expect(f.admissions[0][3]).toBeNull();
});
it('a delayed body cannot be dated as fresh by a new RPC receipt', async () => {
    const f = fixture();
    let clock = now;
    f.deps.now = () => clock;
    f.store.admit = async () => {
        clock += LIMIT.requestAgeMs + 1;
        return true;
    };
    expect((await f.run()).status).toBe(409);
    expect(f.events).not.toContain('enqueue');
    expect(f.events).not.toContain('forward');
});
it('owner JWT plus fresh paired Pi proof creates an authenticated scoped receipt, never a naked boolean', async () => {
    const f = fixture();
    const result = await processPiFleetConsent(
        JSON.stringify(f.proposal),
        f.signature(fleetConsentProposalBytes(f.proposal), LIMIT.consentPath),
        { store: f.store, operatorEnabled: true, authenticateOwner: async () => f.binding.ownerId, now: () => now },
    );
    expect(result.status).toBe(200);
    expect(verifyFleetConsentReceipt(result.body.receipt, token, now)).toEqual(f.consent);
    expect(f.events).toEqual(['relay', 'configure']);
});
it('wrong account, absent/changed Pi proof and held enabling never configure a grant', async () => {
    for (const kind of ['owner', 'signature', 'held'] as const) {
        const f = fixture();
        const result = await processPiFleetConsent(
            JSON.stringify(f.proposal),
            kind === 'signature' ? null : f.signature(fleetConsentProposalBytes(f.proposal), LIMIT.consentPath),
            {
                store: f.store,
                operatorEnabled: kind !== 'held',
                authenticateOwner: async () => (kind === 'owner' ? f.binding.boatId : f.binding.ownerId),
                now: () => now,
            },
        );
        expect(result.status).not.toBe(200);
        expect(f.events).not.toContain('configure');
    }
});
it('withdrawal needs owner/CAS but no signature or active transport right', async () => {
    const f = fixture();
    f.proposal = {
        ...f.proposal,
        enabled: false,
        expectedRevision: f.consent.revision,
        publicKeySpki: null,
        expiresAt: null,
    };
    const result = await processPiFleetConsent(JSON.stringify(f.proposal), null, {
        store: f.store,
        operatorEnabled: false,
        authenticateOwner: async () => f.binding.ownerId,
        now: () => now,
    });
    expect(result.status).toBe(200);
    expect(verifyFleetConsentReceipt(result.body.receipt, token, now)?.enabled).toBe(false);
});

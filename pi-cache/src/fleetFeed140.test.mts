import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { FleetConsentStore } from './fleetFeed/store.js';
import { FleetFeedKeeper, type FleetKeeperDeps } from './fleetFeed/keeper.js';
import { FleetForwarder, type FleetForwardDeps } from './fleetFeed/forwarder.js';
import { FleetAisInput, currentFleetContext, localFleetSource } from './fleetFeed/source.js';
import { fleetWorkerEndpoint } from './fleetFeed/transport.js';
import { verifyFleetReceipt, type FleetPiContext } from './fleetFeed/contract.js';
import { loadOrCreateIdentity } from './identity.js';
import { AIS_FLEET_FORWARDING as LIMIT, type FleetForwardConsent } from './fleetFeedWire.js';
import {
    fleetConsentReceipt,
    fleetRelayTokenHash,
    verifyFleetPiPayload,
} from '../../workers/ais-ingest/fleetCrypto.js';
import { fleetConsentProposalBytes } from './fleetFeedWire.js';
import express from 'express';
import { createFleetFeedRoutes } from './routes/fleetFeed.js';
import { createAppJsonParser } from './appJson.js';
import type { BoatLanView } from './encDevices.js';

const lan: BoatLanView = {
    gateways: ['192.168.44.1'],
    interfaces: {
        wlan0: [
            {
                address: '192.168.44.2',
                netmask: '255.255.255.0',
                family: 'IPv4',
                internal: false,
                mac: '00:00:00:00:00:00',
                cidr: '192.168.44.2/24',
            },
        ],
    },
};
test('actual borrowed relay A/B/A transition persists off before any next authority poll', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    const a = { ownerId, relayId: f.consent.binding.relayId, token },
        b = { ...a, ownerId: boatId };
    f.keeper.relayChanged(a, b);
    f.keeper.relayChanged(b, a);
    await f.forwarder.tick();
    assert.equal(f.store.read(now).receipt, null);
    assert.equal(f.store.read(now).blockedRevision, f.consent.revision);
    assert.equal(f.sent.length, 0);
});
for (const mode of ['boat-lan', 'tailnet', 'loopback', 'unenrolled', 'preparsed'] as const)
    test('actual mounted Pi fleet route admission: ' + mode, { timeout: 5000 }, async (t) => {
        const f = fixture(t),
            app = express();
        app.use(mode === 'preparsed' ? express.json() : createAppJsonParser(false));
        const peer = mode === 'tailnet' ? '100.76.191.119' : mode === 'loopback' ? '127.0.0.1' : '192.168.44.10';
        app.use(
            '/api/fleet-sharing',
            createFleetFeedRoutes({
                keeper: f.keeper,
                lanView: () => lan,
                peerOf: () => peer,
                devices: {
                    verify: async () => (mode === 'unenrolled' ? { state: 'unknown' } : { state: 'enrolled', device }),
                },
            }),
        );
        const server = app.listen(0, '127.0.0.1');
        await new Promise<void>((resolve) => server.once('listening', resolve));
        t.after(() => {
            server.closeAllConnections();
            server.close();
        });
        const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/fleet-sharing`;
        const post = (suffix: string, value: unknown) =>
            fetch(base + suffix, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(value),
            });
        if (mode === 'tailnet' || mode === 'loopback') {
            assert.equal((await post('/off', { schema: 1 })).status, 403);
            return;
        }
        if (mode === 'unenrolled') {
            assert.equal((await post('/off', { schema: 1 })).status, 401);
            return;
        }
        if (mode === 'preparsed') {
            assert.equal((await post('/off', { schema: 1 })).status, 409);
            return;
        }
        assert.equal((await fetch(base + '/status')).status, 200);
        assert.equal((await fetch(base + '/status?unexpected=1')).status, 409);
        assert.equal((await post('/prepare', { enabled: true })).status, 409);
        assert.equal((await post('/prepare', { schema: 1, note: 'é'.repeat(7000) })).status, 413);
        const response = await post('/prepare', {
            schema: 1,
            boatId,
            expectedRevision: null,
            expiresAt: f.consent.expiresAt,
            nonce: randomUUID(),
        });
        assert.equal(response.status, 200);
        const prepared = await response.json();
        assert.equal(prepared.proposal.binding.controllerId, device.id);
        assert.equal((await post('/confirm', { enabled: true })).status, 409);
        assert.equal((await post('/off', { schema: 1 })).status, 200);
        assert.equal(f.store.read(now).receipt, null);
    });

const sentence = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';
const own = '!AIVDO,1,1,,B,B7Ojo>00=:g<MbL6qQAu1Sv00000,0*1F';
const now = 1800000000000,
    token = 'd'.repeat(64);
const ownerId = '10000000-0000-4000-8000-000000000001',
    boatId = '20000000-0000-4000-8000-000000000001';
const device = {
    id: '40000000-0000-4000-8000-000000000001',
    label: 'Fixture phone',
    enrolledAt: new Date(now - 100000).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
};
function fixture(t: TestContext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-fleet140-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let clock = now;
    const identity = loadOrCreateIdentity(path.join(dir, 'identity'), 'Fixture only'),
        store = new FleetConsentStore(path.join(dir, 'consent.json'));
    const doc = {
        uuid: 'urn:mrn:signalk:uuid:fixture1',
        navigation: {
            position: {
                $source: 'serial.receiver',
                timestamp: new Date(now - 1000).toISOString(),
                value: { latitude: -27, longitude: 153 },
            },
        },
    };
    const source = localFleetSource({ port: 10110, reference: 'FICTIONAL receiver-only rebroadcast' });
    let context = currentFleetContext({
        source,
        document: doc,
        now: clock,
        ownerId,
        relayId: 'fixture-fleet-relay140',
        token,
        piDeviceId: identity.deviceId,
        boatId,
        device,
        allowInternet: true,
    })!;
    const contexts: (string | null)[] = [],
        sent: { body: string; signature: string; signal: AbortSignal }[] = [];
    const deps: FleetForwardDeps = {
        store,
        identity,
        operatorEnabled: true,
        now: () => clock,
        input: { setContext: (key) => contexts.push(key) },
        readContext: async () => context,
        send: async (body, signature, _relay, _token, signal) => {
            sent.push({ body, signature, signal });
            return { status: 200 };
        },
    };
    const forwarder = new FleetForwarder(deps);
    t.after(() => forwarder.close());
    const keeperDeps: FleetKeeperDeps = {
        store,
        identity,
        operatorEnabled: true,
        context: async () => context,
        forwarder,
        now: () => clock,
    };
    const keeper = new FleetFeedKeeper(keeperDeps);
    const consent: FleetForwardConsent = {
        schema: 1,
        binding: context.binding,
        revision: randomUUID(),
        enabled: true,
        consentVersion: LIMIT.consentVersion,
        issuedAt: now,
        expiresAt: now + 100000,
    };
    const receipt = fleetConsentReceipt(consent, fleetRelayTokenHash(token), randomUUID());
    return {
        store,
        identity,
        dir,
        doc,
        source,
        deps,
        forwarder,
        keeper,
        keeperDeps,
        consent,
        receipt,
        contexts,
        sent,
        context: () => context,
        setContext: (v: FleetPiContext) => {
            context = v;
        },
        clock: () => clock,
        advance: (ms: number) => {
            clock += ms;
        },
        enable: () => store.save(receipt, null),
    };
}
test('durable receipt remains private, bounded and cannot be replaced by a boolean or corrupt file', (t) => {
    const f = fixture(t);
    assert.equal(f.store.read(now).receipt, null);
    f.enable();
    assert.equal(f.store.read(now).receipt?.consent.revision, f.consent.revision);
    assert.equal(verifyFleetReceipt(f.receipt, token, now)?.consent.revision, f.consent.revision);
    assert.equal(verifyFleetReceipt({ ...f.receipt, nonce: randomUUID() }, token, now), null);
    assert.equal(verifyFleetReceipt(f.receipt, 'e'.repeat(64), now), null);
    assert.equal(verifyFleetReceipt({ enabled: true }, token, now), null);
    const file = path.join(f.dir, 'consent.json');
    fs.writeFileSync(file, 'x'.repeat(13000));
    assert.throws(() => f.store.read(now));
    f.store.off(now);
    assert.equal(f.store.read(now).receipt, null);
});
test('proposal uses actual Pi identity/enrollment/source and only matching one-use server receipt can enable', async (t) => {
    const f = fixture(t),
        nonce = randomUUID();
    const reviewed = await f.keeper.prepare(
        { schema: 1, boatId, expectedRevision: null, expiresAt: f.consent.expiresAt, nonce },
        device,
    );
    assert.equal(
        verifyFleetPiPayload(
            f.identity.publicKeySpki,
            fleetConsentProposalBytes(reviewed.proposal),
            LIMIT.consentPath,
            now,
            reviewed.signature,
        ),
        true,
    );
    const receipt = fleetConsentReceipt(
        { ...f.consent, binding: reviewed.proposal.binding },
        fleetRelayTokenHash(token),
        nonce,
    );
    await f.keeper.install(receipt, device);
    assert.equal(f.store.read(now).receipt?.nonce, nonce);
    await assert.rejects(() => f.keeper.install(receipt, device));
});
for (const kind of [
    'nonce',
    'binding',
    'token',
    'expiry',
    'off-during-await',
    'enrollment',
    'expired-proposal',
    'held',
] as const)
    test('reviewed consent refuses ' + kind, async (t) => {
        const f = fixture(t),
            nonce = randomUUID();
        if (kind === 'held') {
            f.keeperDeps.operatorEnabled = false;
            await assert.rejects(() =>
                f.keeper.prepare(
                    { schema: 1, boatId, expectedRevision: null, expiresAt: f.consent.expiresAt, nonce },
                    device,
                ),
            );
            return;
        }
        const proposal = await f.keeper.prepare(
            { schema: 1, boatId, expectedRevision: null, expiresAt: f.consent.expiresAt, nonce },
            device,
        );
        let consent = { ...f.consent, binding: proposal.proposal.binding };
        if (kind === 'binding') consent = { ...consent, binding: { ...consent.binding, boatId: ownerId } };
        if (kind === 'expiry') consent = { ...consent, expiresAt: consent.expiresAt + 1 };
        const receipt = fleetConsentReceipt(
            consent,
            fleetRelayTokenHash(kind === 'token' ? 'e'.repeat(64) : token),
            kind === 'nonce' ? randomUUID() : nonce,
        );
        if (kind === 'off-during-await')
            f.keeperDeps.context = async () => {
                f.keeper.off();
                return f.context();
            };
        if (kind === 'expired-proposal') f.advance(LIMIT.requestAgeMs + 1);
        await assert.rejects(() =>
            f.keeper.install(
                receipt,
                kind === 'enrollment' ? { ...device, enrolledAt: new Date(now + 1).toISOString() } : device,
            ),
        );
        assert.equal(f.store.read(f.clock()).receipt, null);
    });
test('default OFF neither opens raw input nor sends a batch', async (t) => {
    const f = fixture(t);
    f.deps.operatorEnabled = false;
    f.enable();
    await f.forwarder.tick();
    assert.equal(f.sent.length, 0);
    assert.equal(f.contexts.includes(null), true);
    assert.equal(f.forwarder.status().operatorConfigured, false);
});
test('actual received lines use exact signed batch, coarse-only fix and bounded loss-only queue', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    const key = f.contexts.at(-1)!;
    for (let n = 0; n < 700; n++) f.forwarder.ingest(sentence, now - 1000, key);
    f.forwarder.ingest(sentence, now - 1000, 'old-context');
    f.forwarder.ingest('$GPGGA,not-ais', now, key);
    assert.equal(f.forwarder.status().queued, 600);
    await f.forwarder.tick();
    assert.equal(f.sent.length, 1);
    const batch = JSON.parse(f.sent[0].body);
    assert.equal(batch.observations.length, 600);
    assert.deepEqual(batch.cell, { id: 'v1:31:166', measuredAt: now - 1000 });
    assert.doesNotMatch(f.sent[0].body, /latitude|longitude|"lat"|"lon"/);
    assert.equal(
        verifyFleetPiPayload(f.identity.publicKeySpki, f.sent[0].body, LIMIT.batchPath, now, f.sent[0].signature),
        true,
    );
    assert.equal(f.forwarder.status().deliveryConfirmed, false);
    assert.equal(f.forwarder.status().queued, 0);
});
test('ownship raw AIS may share under explicit grant but never creates receiver coverage alone', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    f.forwarder.ingest(own, now, f.contexts.at(-1)!);
    await f.forwarder.tick();
    assert.equal(JSON.parse(f.sent[0].body).cell, null);
    assert.equal(JSON.parse(f.sent[0].body).observations[0].sentence, own);
});
for (const field of [
    'ownerId',
    'boatId',
    'piDeviceId',
    'relayId',
    'pairingId',
    'controllerId',
    'enrollmentRevision',
    'sourceKey',
] as const)
    test('forwarding retires the saved grant when current ' + field + ' changes', async (t) => {
        const f = fixture(t);
        f.enable();
        await f.forwarder.tick();
        f.forwarder.ingest(sentence, now, f.contexts.at(-1)!);
        f.setContext({
            ...f.context(),
            binding: { ...f.context().binding, [field]: field.endsWith('Id') ? randomUUID() : 'e'.repeat(64) },
        });
        await f.forwarder.tick();
        assert.equal(f.sent.length, 0);
        assert.equal(f.store.read(now).receipt, null);
        assert.equal(f.forwarder.status().queued, 0);
        f.setContext({ ...f.context(), binding: f.consent.binding });
        await f.forwarder.tick();
        assert.equal(f.sent.length, 0);
    });
test('local withdrawal cancels in-flight request and ignores late successful acknowledgement', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    f.forwarder.ingest(sentence, now, f.contexts.at(-1)!);
    let finish!: (value: { status: number }) => void;
    f.deps.send = async (body, signature, _r, _t, signal) => {
        f.sent.push({ body, signature, signal });
        return new Promise((resolve) => {
            finish = resolve;
        });
    };
    const pending = f.forwarder.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.sent.length, 1);
    f.keeper.off();
    assert.equal(f.sent[0].signal.aborted, true);
    finish({ status: 200 });
    await pending;
    assert.equal(f.forwarder.status().lastAcknowledgedAt, null);
    assert.equal(f.store.read(now).blockedRevision, f.consent.revision);
});
test('unavailable network drops the sent buffer and internet hold discards new observations', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    f.forwarder.ingest(sentence, now, f.contexts.at(-1)!);
    f.deps.send = async () => {
        throw Error('fixture outage');
    };
    await f.forwarder.tick();
    assert.equal(f.forwarder.status().queued, 0);
    f.setContext({ ...f.context(), allowInternet: false });
    await f.forwarder.tick();
    assert.equal(f.forwarder.status().state, 'internet-paused');
});
test('stale raw sentences are discarded and request cadence cannot extend observation age', async (t) => {
    const f = fixture(t);
    f.enable();
    await f.forwarder.tick();
    const key = f.contexts.at(-1)!;
    f.forwarder.ingest(sentence, now, key);
    f.advance(30001);
    await f.forwarder.tick();
    assert.equal(f.sent.length, 0);
});
test('source context needs explicit local declaration and original GPS leaf clock; provider/parent times do not qualify', (t) => {
    const f = fixture(t);
    assert.equal(localFleetSource({ port: 10110 }), null);
    assert.equal(localFleetSource({ port: 0, reference: 'fixture' }), null);
    const value = {
        ...f.doc,
        navigation: { position: { value: { latitude: -27, longitude: 153 }, timestamp: new Date(now).toISOString() } },
    };
    const context = currentFleetContext({
        source: f.source,
        document: value,
        now,
        ownerId,
        relayId: f.consent.binding.relayId,
        token,
        piDeviceId: f.identity.deviceId,
        boatId,
        device,
        allowInternet: true,
    });
    assert.equal(context?.cell, null);
    assert.equal(fleetWorkerEndpoint('http://example.com/pi-fleet-feed/v1'), null);
    assert.equal(fleetWorkerEndpoint('https://example.com/pi-fleet-feed/v1?token=bad'), null);
    assert.equal(fleetWorkerEndpoint('https://example.com/fleet-feed'), null);
    assert.equal(fleetWorkerEndpoint('https://example.com/pi-fleet-feed/v1'), 'https://example.com/pi-fleet-feed/v1');
});
test(
    'raw input is inert until consent context, loopback-only and bounded across split/hostile lines',
    { timeout: 4000 },
    async (t) => {
        const accepted: string[] = [],
            connections: net.Socket[] = [];
        const server = net.createServer((socket) => {
            connections.push(socket);
            socket.write('noise\n' + sentence.slice(0, 20));
            socket.write(sentence.slice(20) + '\r\n' + 'x'.repeat(500) + '\n' + own + '\n');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const input = new FleetAisInput((server.address() as net.AddressInfo).port, (line) => accepted.push(line));
        t.after(async () => {
            input.setContext(null);
            for (const socket of connections) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        assert.equal(connections.length, 0);
        input.setContext('fixture-admitted-context');
        const deadline = Date.now() + 2000;
        while (accepted.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(accepted, [sentence, own]);
        input.setContext(null);
    },
);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorZonePosition } from './anchorSafeZone.js';
import { normalizeAnchorAssignment, assignmentSafeArea } from './anchorZoneContract.js';
import { broadcastOnce, AnchorWatchRunner, type AnchorWatchAssignment } from './anchorBroadcaster.js';
import { fileAnchorWatchStore } from './anchorWatchStore.js';
import { reviewAnchorAreaChange, type AreaReviewDeps } from './anchorAreaAdmission.js';
import { findPiRoute } from './piCommandLock.js';

const anchor = { latitude: -27, longitude: 179.99999 };
const zone = {
    version: 1 as const,
    kind: 'polygon' as const,
    anchor,
    vertices: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
    ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
};
const assignment: AnchorWatchAssignment = {
    sessionCode: 'ABC123DEF456',
    anchorLat: anchor.latitude,
    anchorLon: anchor.longitude,
    swingRadius: 60,
    safeZone: zone,
    safeAreaRevision: '11111111-1111-4111-8111-111111111111',
    safeAreaVesselId: 'boat-a',
};
const credential = {
    url: 'https://example.invalid/anchor-relay',
    relayId: 'r'.repeat(20),
    token: 'fictional',
    anonKey: 'fictional-public',
};
const now = 1_800_000_000_000;
const fix = { ...anchor, timestamp: now };
const doc = (at: number, p = anchor) => ({
    navigation: { position: { value: p, timestamp: new Date(at).toISOString() } },
});
function reviewDeps(patch: Partial<AreaReviewDeps> = {}): AreaReviewDeps {
    return {
        now: () => now,
        revision: () => 'boot:1',
        dragging: () => false,
        paired: () => true,
        enrolled: async () => true,
        readFix: async () => fix,
        ...patch,
    };
}

test('custom assignment admission is immutable, frame-bound and explicit about returning to the circle', () => {
    const input = structuredClone(assignment);
    const normalized = normalizeAnchorAssignment(input)!;
    assert.ok(normalized);
    assert.equal(Object.isFrozen(normalized.safeZone), true);
    (input.safeZone as typeof zone).vertices[0].latitude = 0;
    assert.notDeepEqual(normalized.safeZone, input.safeZone);
    assert.equal(normalizeAnchorAssignment({ ...assignment, safeZone: undefined }, assignment), null);
    assert.equal(normalizeAnchorAssignment({ ...assignment, anchorLon: 0 }), null);
    assert.equal(normalizeAnchorAssignment({ ...assignment, safeAreaRevision: undefined }), null);
    assert.equal(normalizeAnchorAssignment({ ...assignment, safeAreaVesselId: undefined }), null);
    assert.ok(normalizeAnchorAssignment({ ...assignment, safeAreaVesselId: null }));
    assert.ok(normalizeAnchorAssignment({ ...assignment, safeZone: null }));
    assert.equal(assignmentSafeArea(assignment)?.frame.radiusM, 60);
});

test('three distinct original fixes outside the polygon confirm drag while frozen replays cannot', async () => {
    const outside = anchorZonePosition(anchor, 25, 0)!;
    let at = now - 10_000;
    const payloads: Record<string, unknown>[] = [];
    const drag = { outsideCount: 0, lastTimestamp: undefined as number | undefined };
    const deps = {
        now: () => now,
        signalkOrigin: 'http://example.invalid',
        selfDocument: async () => doc(at, outside),
        fetchImpl: async (_url: string, init?: Record<string, unknown>) => {
            payloads.push(JSON.parse(String(init?.body)).payload);
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        },
    };
    for (let i = 0; i < 5; i++) await broadcastOnce(assignment, credential, deps, drag);
    assert.equal(drag.outsideCount, 1);
    assert.equal(payloads.at(-1)!.isAlarm, false);
    at += 5_000;
    await broadcastOnce(assignment, credential, deps, drag);
    assert.equal(drag.outsideCount, 2);
    at += 5_000;
    await broadcastOnce(assignment, credential, deps, drag);
    assert.equal(payloads.at(-1)!.isAlarm, true);
    assert.equal(payloads.at(-1)!.safeAreaRevision, assignment.safeAreaRevision);
    assert.equal(payloads.at(-1)!.safeZoneWatch, 'pi');
    assert.ok(Number(payloads.at(-1)!.distance) < 60);
    await broadcastOnce(assignment, credential, { ...deps, selfDocument: async () => null }, drag);
    assert.equal(drag.outsideCount, 0);
    assert.equal(payloads.at(-1)!.type, 'status');
    assert.equal(payloads.at(-1)!.safeAreaRevision, assignment.safeAreaRevision);
    assert.equal(payloads.at(-1)!.vessel, undefined);
});

test('private assignment recovery revalidates the whole custom area', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-zone139-'));
    try {
        const store = fileAnchorWatchStore(dir);
        store.save({ assignment, relayId: credential.relayId, expiresAt: now + 1000, sessionExpiresAt: now + 2000 });
        assert.deepEqual(store.read()?.assignment.safeZone, zone);
        const file = path.join(dir, 'anchor-watch.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.assignment.safeZone.anchor.longitude = 0;
        fs.writeFileSync(file, JSON.stringify(raw));
        assert.equal(store.read(), null);
    } finally {
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('anchor-zone139-'));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runtime revision changes across stop/restart and a new process, preserving immutable assigned geometry', () => {
    const deps = {
        now: () => now,
        signalkOrigin: 'http://example.invalid',
        selfDocument: async () => null,
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    };
    const runner = new AnchorWatchRunner(deps),
        other = new AnchorWatchRunner(deps);
    const first = runner.watchRevision();
    assert.notEqual(first, other.watchRevision());
    try {
        runner.start(assignment, credential);
        const second = runner.watchRevision();
        assert.notEqual(second, first);
        runner.stop();
        runner.start(assignment, credential);
        assert.notEqual(runner.watchRevision(), second);
        assert.deepEqual(runner.current()?.safeZone, zone);
    } finally {
        runner.close();
        other.close();
    }
});

test('only an exact unchanged zone and UUID is a raise; changing or dropping either remains a command', () => {
    const rule = findPiRoute('POST', '/api/anchor/watch')!;
    assert.equal(typeof rule.class, 'function');
    const classify = rule.class as (body: unknown, facts: { anchorWatch: () => AnchorWatchAssignment }) => string;
    const facts = { anchorWatch: () => assignment };
    assert.equal(classify(assignment, facts), 'raise');
    assert.equal(classify({ ...assignment, safeZone: null }, facts), 'command');
    assert.equal(classify({ ...assignment, safeZone: undefined }, facts), 'command');
    assert.equal(
        classify({ ...assignment, safeAreaRevision: '22222222-2222-4222-8222-222222222222' }, facts),
        'command',
    );
});

test('area admission requires a fresh inside fix, expected revision, enrolled device and a stable paired watch', async () => {
    assert.deepEqual(await reviewAnchorAreaChange(assignment, null, 'boot:1', reviewDeps()), {
        ok: true,
        unchanged: false,
        revision: 'boot:1',
    });
    for (const patch of [
        { enrolled: async () => false },
        { paired: () => false },
        { dragging: () => true },
        { readFix: async () => null },
        { readFix: async () => ({ ...fix, timestamp: now - 31_000 }) },
        { readFix: async () => ({ ...anchorZonePosition(anchor, 25, 0)!, timestamp: now }) },
    ])
        assert.equal((await reviewAnchorAreaChange(assignment, null, 'boot:1', reviewDeps(patch))).ok, false);
    assert.equal((await reviewAnchorAreaChange(assignment, null, 'old', reviewDeps())).ok, false);
});

test('late A/B/A watch, pairing and enrollment changes cannot adopt an area after its GPS read', async () => {
    for (const kind of ['watch', 'pair', 'enrollment']) {
        let revision = 'boot:1',
            paired = true,
            enrolled = true;
        const deps = reviewDeps({
            revision: () => revision,
            paired: () => paired,
            enrolled: async () => enrolled,
            readFix: async () => {
                if (kind === 'watch') revision = 'boot:3';
                if (kind === 'pair') paired = false;
                if (kind === 'enrollment') enrolled = false;
                return fix;
            },
        });
        assert.equal((await reviewAnchorAreaChange(assignment, null, 'boot:1', deps)).ok, false);
    }
});

test('an identical renewal preserves a confirmed alarm without re-reading GPS; a clear cannot silence it', async () => {
    let reads = 0;
    const deps = reviewDeps({
        dragging: () => true,
        readFix: async () => {
            reads++;
            return fix;
        },
    });
    assert.deepEqual(await reviewAnchorAreaChange(assignment, assignment, undefined, deps), {
        ok: true,
        unchanged: true,
        revision: 'boot:1',
    });
    assert.equal(reads, 0);
    assert.equal(
        (
            await reviewAnchorAreaChange(
                { ...assignment, safeZone: null, safeAreaRevision: '22222222-2222-4222-8222-222222222222' },
                assignment,
                'boot:1',
                deps,
            )
        ).ok,
        false,
    );
});

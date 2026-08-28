/**
 * The Pi keeping the shore watch — so a skipper needs a Pi OR a tablet aboard,
 * not both (Shane 2026-08-29).
 *
 * The rules that matter here are all about NOT transmitting something false. A
 * shore watcher looking at a boat sitting calmly inside its swing circle, when
 * that position is four minutes old and the boat has been dragging since, is
 * worse off than one seeing nothing at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    BROADCAST_INTERVAL_MS,
    POSITION_MAX_AGE_MS,
    broadcastOnce,
    buildPositionPayload,
    currentFix,
    distanceMetres,
    fixIsCurrent,
    readFix,
    relayFingerprint,
    AnchorWatchRunner,
} from './anchorBroadcaster.js';

const ASSIGNMENT = { sessionCode: 'ABC123DEF456', anchorLat: -27.19508, anchorLon: 153.10555, swingRadius: 40 };
const CREDENTIAL = {
    url: 'https://x.supabase.co/functions/v1/anchor-relay',
    relayId: 'r'.repeat(20),
    token: 'sk-relay-9f3c2e7a1b',
    anonKey: 'anon',
};

const skDoc = (lat: number, lon: number, timestamp?: string) => ({
    navigation: { position: { value: { latitude: lat, longitude: lon }, ...(timestamp ? { timestamp } : {}) } },
});

const fetcherFor = (self: unknown, selfOk = true, post?: { ok: boolean; status: number }) => {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const impl = async (url: string, init?: Record<string, unknown>) => {
        calls.push({ url, init });
        if (url.endsWith('/signalk')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ endpoints: { v1: { 'signalk-http': 'http://127.0.0.1:3000/signalk/v1/api/' } } }),
                text: async () => '',
            };
        }
        if (url.endsWith('vessels/self')) {
            return { ok: selfOk, status: selfOk ? 200 : 404, json: async () => self, text: async () => '' };
        }
        return { ok: post?.ok ?? true, status: post?.status ?? 200, json: async () => ({}), text: async () => '' };
    };
    return { impl, calls };
};

test('distance is great-circle, not flat-earth — a swing circle is tens of metres', () => {
    // One minute of latitude is a nautical mile, near enough, anywhere.
    const d = distanceMetres(-27.0, 153.0, -27.0 - 1 / 60, 153.0);
    assert.ok(Math.abs(d - 1852) < 5, `expected ~1852 m, got ${d}`);
    // A degree of longitude at 55S is far shorter than at the equator; a flat
    // approximation would report these as equal.
    const equator = distanceMetres(0, 0, 0, 1);
    const high = distanceMetres(-55, 0, -55, 1);
    assert.ok(high < equator * 0.6, 'longitude must shrink with latitude');
});

test('a Signal K document with no vessel branch is no fix, not an error', () => {
    // The ordinary ashore state: server up, nothing feeding the bus.
    assert.equal(readFix(undefined), null);
    assert.equal(readFix({}), null);
    assert.equal(readFix({ navigation: {} }), null);
    assert.equal(readFix({ navigation: { position: {} } }), null);
});

test('rejects positions that are not positions', () => {
    assert.equal(readFix({ navigation: { position: { value: { latitude: null, longitude: 153 } } } }), null);
    assert.equal(readFix({ navigation: { position: { value: { latitude: 91, longitude: 153 } } } }), null);
    assert.equal(readFix({ navigation: { position: { value: { latitude: -27, longitude: 181 } } } }), null);
    assert.equal(readFix({ navigation: { position: { value: { latitude: NaN, longitude: 153 } } } }), null);
});

test('reads a real fix and keeps Signal K own timestamp', () => {
    const fix = readFix(skDoc(-27.5, 153.5, '2026-08-29T01:00:00.000Z'));
    assert.ok(fix);
    assert.equal(fix.latitude, -27.5);
    assert.equal(fix.longitude, 153.5);
    assert.equal(fix.timestamp, Date.parse('2026-08-29T01:00:00.000Z'));
});

test('a stale fix is never transmitted as the boat position', () => {
    const now = 1_800_000_000_000;
    assert.equal(fixIsCurrent({ latitude: 0, longitude: 0, timestamp: now - 1_000 }, now), true);
    assert.equal(fixIsCurrent({ latitude: 0, longitude: 0, timestamp: now - POSITION_MAX_AGE_MS - 1 }, now), false);
    // A fix from the future is a clock fault, not a position.
    assert.equal(fixIsCurrent({ latitude: 0, longitude: 0, timestamp: now + 60_000 }, now), false);
});

test('the age gate is wider than the report interval, or every report would be stale', () => {
    assert.ok(POSITION_MAX_AGE_MS > BROADCAST_INTERVAL_MS * 2);
});

test('the payload is what a vessel PHONE sends, so shore cannot tell the difference', () => {
    const payload = buildPositionPayload(ASSIGNMENT, { latitude: -27.19508, longitude: 153.10555, timestamp: 1 });
    assert.deepEqual(Object.keys(payload).sort(), ['anchor', 'distance', 'isAlarm', 'source', 'swingRadius', 'vessel']);
    assert.equal(payload.distance, 0);
    assert.equal(payload.isAlarm, false);
});

test('raises the alarm exactly when the boat is outside its swing circle', () => {
    const outside = buildPositionPayload(ASSIGNMENT, {
        latitude: -27.19508 - 0.001,
        longitude: 153.10555,
        timestamp: 1,
    });
    assert.ok(outside.distance > 40, `expected >40 m, got ${outside.distance}`);
    assert.equal(outside.isAlarm, true);
});

test('no fix means no broadcast — silence beats a wrong position', async () => {
    const { impl, calls } = fetcherFor({}, true);
    const outcome = await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
        fetchImpl: impl,
        signalkOrigin: 'http://127.0.0.1:3000',
    });
    assert.equal(outcome, 'no-fix');
    assert.equal(calls.filter((c) => c.url === CREDENTIAL.url).length, 0);
});

test('a 404 self document is the ashore state, handled as no-fix', async () => {
    const { impl } = fetcherFor(null, false);
    const outcome = await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
        fetchImpl: impl,
        signalkOrigin: 'http://127.0.0.1:3000',
    });
    assert.equal(outcome, 'no-fix');
});

test('sends the relay credential in the body and only the anon key at the gateway', async () => {
    const now = Date.parse('2026-08-29T02:00:00.000Z');
    const { impl, calls } = fetcherFor(skDoc(-27.19, 153.1, '2026-08-29T02:00:00.000Z'));
    const outcome = await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
        fetchImpl: impl,
        signalkOrigin: 'http://127.0.0.1:3000',
        now: () => now,
    });
    assert.equal(outcome, 'sent');
    const post = calls.find((c) => c.url === CREDENTIAL.url);
    assert.ok(post);
    const headers = post.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer anon');
    // The relay token belongs in the body, never in a header where a proxy
    // log or an error report would carry it.
    assert.ok(!JSON.stringify(headers).includes(CREDENTIAL.token), 'token must not travel in a header');
    const body = JSON.parse(String(post.init?.body));
    assert.equal(body.relay_id, CREDENTIAL.relayId);
    assert.equal(body.session_code, ASSIGNMENT.sessionCode);
});

test('tells a lapsed authorisation apart from a bad credential', async () => {
    const doc = skDoc(-27.19, 153.1, '2026-08-29T02:00:00.000Z');
    const now = Date.parse('2026-08-29T02:00:00.000Z');
    for (const [status, expected] of [
        [403, 'not-authorised'],
        [401, 'unauthorised'],
        [500, 'unreachable'],
    ] as const) {
        const { impl } = fetcherFor(doc, true, { ok: false, status });
        const outcome = await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
            fetchImpl: impl,
            signalkOrigin: 'http://127.0.0.1:3000',
            now: () => now,
        });
        assert.equal(outcome, expected, `status ${status}`);
    }
});

test('uses Signal K own discovery document rather than a hardcoded path', async () => {
    const { impl, calls } = fetcherFor(skDoc(-27.19, 153.1, '2026-08-29T02:00:00.000Z'));
    await currentFix({ fetchImpl: impl, signalkOrigin: 'http://127.0.0.1:3000' });
    assert.ok(calls.some((c) => c.url === 'http://127.0.0.1:3000/signalk'));
    assert.ok(calls.some((c) => c.url.endsWith('/signalk/v1/api/vessels/self')));
});

test('a relay fingerprint identifies a Pi in logs without leaking its id', () => {
    const fp = relayFingerprint(CREDENTIAL.relayId);
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.ok(!CREDENTIAL.relayId.includes(fp));
});

/* ── the running watch ─────────────────────────────────────────────────── */

const runnerDeps = (post: { ok: boolean; status: number }, fixDoc: unknown = skDoc(-27.19, 153.1)) => {
    const timers: Array<() => void> = [];
    const outcomes: string[] = [];
    const { impl } = fetcherFor(fixDoc, true, post);
    return {
        outcomes,
        tick: async () => {
            timers.forEach((fn) => fn());
            await new Promise((r) => setTimeout(r, 0));
        },
        deps: {
            fetchImpl: impl,
            signalkOrigin: 'http://127.0.0.1:3000',
            now: () => Date.now(),
            setIntervalImpl: ((fn: () => void) => {
                timers.push(fn);
                return 1 as unknown as ReturnType<typeof setInterval>;
            }) as unknown as typeof setInterval,
            clearIntervalImpl: (() => {
                timers.length = 0;
            }) as unknown as typeof clearInterval,
            onOutcome: (o: string) => outcomes.push(o),
        },
    };
};

test('a second assignment replaces the first — a boat has one anchor down', async () => {
    const { deps } = runnerDeps({ ok: true, status: 200 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    runner.start({ ...ASSIGNMENT, sessionCode: 'ZZZ999YYY888' }, CREDENTIAL);
    assert.equal(runner.describe().sessionCode, 'ZZZ999YYY888');
    assert.equal(runner.isRunning(), true);
    runner.stop();
});

test('stops itself on a credential the relay rejects outright', async () => {
    // Retrying a bad credential every ten seconds is a stream of failed auth
    // attempts against the skipper's own account, and it will never start
    // working.
    const { deps, tick } = runnerDeps({ ok: false, status: 401 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    await tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runner.isRunning(), false);
});

test('keeps going when the authorisation has merely lapsed', async () => {
    // The app renews it; this is not a permanent failure.
    const { deps, tick } = runnerDeps({ ok: false, status: 403 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    await tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runner.isRunning(), true);
    runner.stop();
});

test('describe() is safe to put in a status response', () => {
    const { deps } = runnerDeps({ ok: true, status: 200 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    const described = JSON.stringify(runner.describe());
    assert.ok(!described.includes(CREDENTIAL.token), 'must never carry the relay token');
    assert.ok(!described.includes(CREDENTIAL.relayId), 'must never carry the relay id');
    runner.stop();
});

test('stopping clears the assignment, so nothing lingers after the watch ends', () => {
    const { deps } = runnerDeps({ ok: true, status: 200 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    runner.stop();
    assert.equal(runner.describe().sessionCode, null);
    assert.equal(runner.isRunning(), false);
});

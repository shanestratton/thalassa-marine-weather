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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileAnchorWatchStore, type SavedAnchorWatch } from './anchorWatchStore.js';
import {
    AnchorWatchRunner,
    BROADCAST_INTERVAL_MS,
    POSITION_MAX_AGE_MS,
    ALARM_CONFIRM_COUNT,
    broadcastOnce,
    buildPositionPayload,
    nextDragState,
    currentFix,
    distanceMetres,
    fixIsCurrent,
    rankSource,
    readFix,
    relayFingerprint,
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
    // `config` joined the shape on 2026-09-03. The shore view reads
    // config.rodeLength and config.waterDepth, and a payload without the key
    // crashed it on the Pi's first broadcast — this very assertion is what
    // proves the two shapes now agree, and it caught the change when it landed.
    assert.deepEqual(Object.keys(payload).sort(), [
        'anchor',
        'config',
        'distance',
        'gpsAvailable',
        'gpsTimestamp',
        'isAlarm',
        'source',
        'swingRadius',
        'vessel',
    ]);
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

test('no fix sends an explicit blind-watch status, never a false position', async () => {
    const { impl, calls } = fetcherFor({}, true);
    const outcome = await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
        fetchImpl: impl,
        signalkOrigin: 'http://127.0.0.1:3000',
    });
    assert.equal(outcome, 'no-fix');
    const post = calls.find((c) => c.url === CREDENTIAL.url);
    assert.ok(post);
    const { payload } = JSON.parse(String(post.init?.body));
    assert.equal(payload.gpsAvailable, false);
    assert.equal(payload.type, 'status');
    assert.equal(payload.gpsTimestamp, null);
    assert.equal(payload.vessel, undefined);
    assert.equal(payload.isAlarm, undefined);
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

const runnerDeps = (
    post: { ok: boolean; status: number },
    fixDoc: unknown = skDoc(-27.19, 153.1, new Date().toISOString()),
) => {
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

test('an expired or revoked authorisation requires an explicit new assignment', async () => {
    const { deps, tick } = runnerDeps({ ok: false, status: 403 });
    const runner = new AnchorWatchRunner(deps);
    runner.start(ASSIGNMENT, CREDENTIAL);
    await tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runner.isRunning(), false);
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

/* ── Which GPS wins ──────────────────────────────────────────────────────
 *
 * Calypso carries two receivers. Signal K picks per PATH by whoever wrote
 * last: measured 2026-09-03, navigation.position was won by the bus while
 * navigation.gnss.methodQuality was won by the USB stick at the same instant.
 * The boat's position was therefore right by luck. These pin the rule.
 */
test('prefers the instrument bus over the USB stick, whatever wrote last', () => {
    const doc = {
        navigation: {
            position: {
                // Signal K's last-writer answer is the USB stick…
                $source: 'ublox-gps.GP',
                value: { latitude: -27.2, longitude: 153.2 },
                timestamp: '2026-09-02T23:20:00.000Z',
                values: {
                    'ublox-gps.GP': {
                        value: { latitude: -27.2, longitude: 153.2 },
                        timestamp: '2026-09-02T23:20:00.000Z',
                    },
                    'ydwg-tcp.YD': {
                        value: { latitude: -27.195095, longitude: 153.10556 },
                        timestamp: '2026-09-02T23:19:58.000Z',
                    },
                },
            },
        },
    };
    const fix = readFix(doc, Date.parse('2026-09-02T23:20:01.000Z'));
    // …and we take the bus anyway, even though it is two seconds older.
    assert.equal(fix?.source, 'ydwg-tcp.YD');
    assert.equal(fix?.latitude, -27.195095);
});

test('falls back to the USB stick when the bus is not writing', () => {
    const doc = {
        navigation: {
            position: {
                $source: 'ublox-gps.GP',
                value: { latitude: -27.2, longitude: 153.2 },
                timestamp: '2026-09-02T23:20:00.000Z',
                values: {
                    'ublox-gps.GP': {
                        value: { latitude: -27.2, longitude: 153.2 },
                        timestamp: '2026-09-02T23:20:00.000Z',
                    },
                },
            },
        },
    };
    const fix = readFix(doc, Date.parse('2026-09-02T23:20:01.000Z'));
    assert.equal(fix?.source, 'ublox-gps.GP');
    assert.equal(fix?.latitude, -27.2);
});

test("reads Calypso's real single-source shape, and says which receiver it was", () => {
    // Exactly what the boat served on 2026-09-03: one writer, no values map.
    const doc = {
        navigation: {
            position: {
                meta: { description: 'The position of the vessel' },
                value: { latitude: -27.195095, longitude: 153.10556 },
                $source: 'ydwg-tcp.YD',
                timestamp: '2026-09-02T23:19:38.000Z',
                sentence: 'GGA',
            },
        },
    };
    const fix = readFix(doc, Date.parse('2026-09-02T23:19:40.000Z'));
    assert.equal(fix?.source, 'ydwg-tcp.YD');
    assert.equal(fix?.latitude, -27.195095);
});

test('ranks the bus above the stick above anything unrecognised', () => {
    assert.ok(rankSource('ydwg-tcp.YD') < rankSource('ublox-gps.GP'));
    assert.ok(rankSource('ublox-gps.GP') < rankSource('some-plugin.XX'));
    assert.equal(rankSource(null), Number.MAX_SAFE_INTEGER);
});

test('carries the skipper rode and depth when the app supplied them', () => {
    const payload = buildPositionPayload(
        { ...ASSIGNMENT, rodeLength: 30, waterDepth: 5 },
        { latitude: -27.19508, longitude: 153.10555, timestamp: 1 },
    );
    assert.deepEqual(payload.config, { rodeLength: 30, waterDepth: 5 });
});

test('sends config undefined rather than half a config when the app sent neither', () => {
    // An older app build assigns without them. The shore view shows "--";
    // it must never be handed { rodeLength: undefined } and format NaN.
    const payload = buildPositionPayload(ASSIGNMENT, { latitude: -27.19508, longitude: 153.10555, timestamp: 1 });
    assert.equal(payload.config, undefined);
});

// ── A drag must be CONFIRMED, not guessed from one fix ────────────────────
//
// The Pi used to send `isAlarm: distance > swingRadius` — one sample, no
// confirmation. Handing the watch to the Pi therefore made the alarm MORE
// trigger-happy than the phone it replaced, which requires three consecutive
// breaches and decays on any fix back inside. The Pi sees the boat's own GPS;
// it should be the steadier watcher, not the twitchier one.

test('does not cry drag on a single fix outside the circle', () => {
    const drag = { outsideCount: 0 };
    const step = () => {
        const next = nextDragState(drag.outsideCount, 40, 35.14);
        drag.outsideCount = next.outsideCount;
        return next.alarm;
    };
    assert.equal(step(), false, 'one breach is a GPS outlier, not a drag');
    assert.equal(step(), false, 'two is still not enough');
    assert.equal(step(), true, `fires on breach ${ALARM_CONFIRM_COUNT}`);
});

test('a fix back inside decays the count, so jitter cannot accumulate overnight', () => {
    let drag = { outsideCount: 0 };
    const feed = (distance: number) => {
        const next = nextDragState(drag.outsideCount, distance, 35.14);
        drag = { outsideCount: next.outsideCount };
        return next.alarm;
    };
    assert.equal(feed(40), false);
    assert.equal(feed(40), false);
    assert.equal(feed(10), false, 'back inside');
    assert.equal(drag.outsideCount, 1, 'decayed by one, not reset to zero');
    assert.equal(feed(40), false, 'so the next breach is only the second');
    assert.equal(feed(40), true);
});

test('the payload carries the CONFIRMED alarm, not the bare comparison', () => {
    // 0.001 deg of latitude is ~111 m — comfortably outside the 40 m circle,
    // unlike the anchor's own coordinates, which are 0 m from it.
    const fix = { latitude: ASSIGNMENT.anchorLat + 0.001, longitude: ASSIGNMENT.anchorLon, timestamp: 1 };
    // Well outside the circle, but unconfirmed: the wire must say no alarm.
    const unconfirmed = buildPositionPayload(ASSIGNMENT, fix, false);
    assert.equal(unconfirmed.isAlarm, false);
    assert.ok(unconfirmed.distance > ASSIGNMENT.swingRadius, 'and it really is outside');
    assert.equal(buildPositionPayload(ASSIGNMENT, fix, true).isAlarm, true);
});

test('missing or invalid source timestamps cannot become fresh GPS fixes', () => {
    assert.equal(readFix(skDoc(-27, 153)), null);
    assert.equal(readFix(skDoc(-27, 153, 'not-a-time')), null);
});

test('a fresh backup is selected ahead of a stale preferred receiver', () => {
    const now = Date.now();
    const doc = {
        navigation: {
            position: {
                values: {
                    'ydwg-tcp.YD': {
                        value: { latitude: -27, longitude: 153 },
                        timestamp: new Date(now - 120_000).toISOString(),
                    },
                    'usb.GP': { value: { latitude: -27.1, longitude: 153 }, timestamp: new Date(now).toISOString() },
                },
            },
        },
    };
    assert.equal(readFix(doc, now)?.source, 'usb.GP');
});

test('a frozen outside fix does not accumulate three confirmations', async () => {
    const now = Date.now();
    const { impl, calls } = fetcherFor(
        skDoc(ASSIGNMENT.anchorLat + 0.001, ASSIGNMENT.anchorLon, new Date(now).toISOString()),
    );
    const drag = { outsideCount: 0 };
    for (let i = 0; i < 4; i++)
        await broadcastOnce(
            ASSIGNMENT,
            CREDENTIAL,
            { fetchImpl: impl, signalkOrigin: 'http://localhost', now: () => now },
            drag,
        );
    const posts = calls.filter((c) => c.url === CREDENTIAL.url).map((c) => JSON.parse(String(c.init?.body)));
    assert.equal(drag.outsideCount, 1);
    assert.ok(posts.every((p) => p.payload.isAlarm === false));
});

test('a stale GPS report is explicit and omits stale coordinates', async () => {
    const now = Date.now();
    const timestamp = now - 120_000;
    const { impl, calls } = fetcherFor(skDoc(-27, 153, new Date(timestamp).toISOString()));
    assert.equal(
        await broadcastOnce(ASSIGNMENT, CREDENTIAL, {
            fetchImpl: impl,
            signalkOrigin: 'http://localhost',
            now: () => now,
        }),
        'stale-fix',
    );
    const { payload } = JSON.parse(String(calls.find((c) => c.url === CREDENTIAL.url)?.init?.body));
    assert.equal(payload.gpsAvailable, false);
    assert.equal(payload.gpsTimestamp, timestamp);
    assert.equal(payload.vessel, undefined);
    assert.equal(payload.distance, undefined);
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('confirmed assignment survives process shutdown, not explicit stop', async () => {
    const now = Date.now();
    let saved: SavedAnchorWatch | null = null;
    const store = {
        read: () => saved,
        save: (v: SavedAnchorWatch) => {
            saved = v;
        },
        clear: () => {
            saved = null;
        },
    };
    const { deps } = runnerDeps({ ok: true, status: 200 });
    const original = deps.fetchImpl;
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = async (url: string, init?: Record<string, unknown>) => {
        if (url === CREDENTIAL.url) {
            requests.push(JSON.parse(String(init?.body)));
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    expires_at: new Date(now + 6 * 3_600_000).toISOString(),
                    session_expires_at: new Date(now + 24 * 3_600_000).toISOString(),
                }),
                text: async () => '',
            };
        }
        return original(url, init);
    };
    const runner = new AnchorWatchRunner({ ...deps, now: () => now, store, fetchImpl });
    runner.start(ASSIGNMENT, CREDENTIAL);
    await flush();
    assert.ok(saved);
    assert.ok(!JSON.stringify(saved).includes(CREDENTIAL.token));
    assert.equal(runner.describe().sessionExpiresAt, now + 24 * 3_600_000);
    runner.close();
    assert.ok(saved, 'shutdown retains only the confirmed assignment');
    assert.equal(
        requests.some((r) => r.action === 'stop'),
        false,
    );
    assert.equal(runner.restore(CREDENTIAL), true);
    assert.equal(runner.describe().lastOutcome, null, 'restart does not replay a safe state');
    await flush();
    runner.stop();
    assert.equal(saved, null);
    assert.equal(requests.at(-1)?.action, 'stop');
    assert.equal(requests.at(-1)?.session_code, ASSIGNMENT.sessionCode);
});

test('recovery refuses expired or another relay assignment', () => {
    const now = Date.now();
    const { deps } = runnerDeps({ ok: true, status: 200 });
    for (const bad of [
        { relayId: CREDENTIAL.relayId, expiresAt: now - 1 },
        { relayId: 'different-relay-1234', expiresAt: now + 1_000 },
    ]) {
        let saved: SavedAnchorWatch | null = { assignment: ASSIGNMENT, sessionExpiresAt: now + 10_000, ...bad };
        const runner = new AnchorWatchRunner({
            ...deps,
            now: () => now,
            store: {
                read: () => saved,
                save: () => {},
                clear: () => {
                    saved = null;
                },
            },
        });
        assert.equal(runner.restore(CREDENTIAL), false);
        assert.equal(runner.isRunning(), false);
        assert.equal(saved, null);
    }
});

test('stop during GPS read cannot send a late position or overwrite stopped state', async () => {
    let resolveGps!: (doc: unknown) => void;
    const gps = new Promise((resolve) => {
        resolveGps = resolve;
    });
    const { deps } = runnerDeps({ ok: true, status: 200 });
    const original = deps.fetchImpl;
    const posts: Record<string, unknown>[] = [];
    const runner = new AnchorWatchRunner({
        ...deps,
        fetchImpl: async (url, init) => {
            if (url.endsWith('vessels/self')) return { ok: true, status: 200, json: () => gps, text: async () => '' };
            if (url === CREDENTIAL.url) posts.push(JSON.parse(String(init?.body)));
            return original(url, init);
        },
    });
    runner.start(ASSIGNMENT, CREDENTIAL);
    await flush();
    runner.stop();
    resolveGps(skDoc(-27, 153, new Date().toISOString()));
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, 'stop');
    assert.equal(runner.describe().sessionCode, null);
    assert.equal(runner.describe().lastOutcome, null);
});

test('assignment file is private, atomic and validates malformed recovery data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thalassa-anchor-watch-'));
    try {
        const store = fileAnchorWatchStore(dir);
        const saved = {
            assignment: ASSIGNMENT,
            relayId: CREDENTIAL.relayId,
            expiresAt: Date.now() + 1000,
            sessionExpiresAt: Date.now() + 2000,
        };
        store.save(saved);
        assert.deepEqual(store.read(), saved);
        assert.equal(fs.statSync(path.join(dir, 'anchor-watch.json')).mode & 0o777, 0o600);
        fs.writeFileSync(path.join(dir, 'anchor-watch.json'), '{');
        assert.equal(store.read(), null);
        store.clear();
        assert.equal(store.read(), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

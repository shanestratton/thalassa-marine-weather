import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { RadarFeed } from './radar/radarFeed.js';
import {
    RadarWatch,
    RadarWatchError,
    type RadarServerContext,
    type RadarWatchEvent,
    type RadarWatchRelayPass,
} from './radar/watch.js';
import { DEFAULT_COLLISION_PREFS } from './collisionRule/collisionRule.js';
import type { RadarRawSnapshot } from './radar/rawReader.js';
import { createRadarWatchRoutes } from './routes/radarWatch.js';
import { createAppJsonParser } from './appJson.js';
import { gzipSync } from 'node:zlib';
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/radar-relay137.json', import.meta.url), 'utf8'));
const T = Date.UTC(2026, 0, 2, 12);
const controller = {
    deviceId: fixture.context.binding.deviceId,
    enrollmentRevision: fixture.context.binding.enrollmentRevision,
};
const other = { deviceId: '22222222-2222-4222-8222-222222222222', enrollmentRevision: 'e'.repeat(64) };
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function picture(at = T, range = 1, navigationAt = at): RadarRawSnapshot {
    const feed = new RadarFeed('pi:' + 'a'.repeat(32)),
        time = (clock: number) => new Date(clock).toISOString().slice(11, 23).replaceAll(':', '');
    feed.ingest(
        frame(`GPRMC,${time(navigationAt)},A,0000.000,N,00000.000,E,5,0,020126,,,A`),
        navigationAt,
        navigationAt,
    );
    feed.ingest(frame('HEHDT,0,T'), navigationAt, navigationAt);
    feed.ingest(frame(`RATTM,1,${range},0,R,10,180,R,0,6,N,Generated,T,,${time(at)},A`), at, at);
    return {
        schema: 1,
        source: 'radar',
        configured: true,
        connected: true,
        overloaded: false,
        feedId: feed.feedId,
        servedAt: at,
        lastFrameAt: at,
        lastTargetAt: at,
        ownship: feed.ownshipSnapshot(),
        observations: feed.evidence(at),
    };
}
function setup() {
    let now = T,
        raw = picture(),
        context: RadarServerContext | null = {
            ownerId: fixture.context.binding.ownerId,
            piDeviceId: fixture.context.binding.piDeviceId,
            pairingId: fixture.context.binding.pairingId,
            feedId: fixture.context.binding.feedId,
            contextToken: 'a'.repeat(64),
        },
        ais = true;
    let enrolled: () => boolean | Promise<boolean> = () => true;
    const events: RadarWatchEvent[] = [];
    const passes: { pass: RadarWatchRelayPass; current: () => boolean }[] = [];
    const watch = new RadarWatch({
        readSnapshot: () => structuredClone(raw),
        currentContext: () => context,
        aisArmed: () => ais,
        atAnchor: () => false,
        controllerCurrent: () => enrolled(),
        now: () => now,
        onEvent: (e) => events.push(e),
        onPass: (pass, current) => passes.push({ pass, current }),
    });
    return {
        watch,
        events,
        passes,
        arm: () => watch.command(controller, { armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS }),
        time: (t: number) => {
            now = t;
        },
        raw: (r: RadarRawSnapshot) => {
            raw = r;
        },
        context: (c: RadarServerContext | null) => {
            context = c;
        },
        getContext: () => context!,
        enrolled: (fn: typeof enrolled) => {
            enrolled = fn;
        },
        ais: (v: boolean) => {
            ais = v;
        },
    };
}
const error = (status: number, code?: string) => (e: unknown) =>
    e instanceof RadarWatchError && e.status === status && (!code || e.code === code);
test('status/default AIS state cannot arm radar; explicit source and checked collision watch are required', async () => {
    const s = setup();
    assert.equal((await s.watch.describe()).context, null);
    assert.equal(s.events.length, 0);
    s.ais(false);
    await assert.rejects(s.arm(), error(409, 'radar_collision_watch_required'));
    s.ais(true);
    s.raw({ ...picture(), configured: false });
    await assert.rejects(s.arm(), error(503, 'radar_passthrough_unavailable'));
    s.raw(picture());
    const view = await s.arm();
    assert.equal(view.running, true);
    assert.equal(view.state, 'armed');
    assert.equal(view.alarms.length, 1);
    assert.equal(view.alarms[0].sourceAt, T);
    assert.match(view.alarms[0].key, /^radar-collision:[0-9a-f]{12}:/);
    assert.equal(view.push.state, 'unavailable');
    s.ais(false);
    await s.watch.tick();
    assert.equal((await s.watch.describe()).context, null);
});
test('earliest original dependency ages independently of a fresh TTM/poll; unknown cannot clear', async () => {
    const s = setup();
    s.raw(picture(T, 1, T - 5000));
    const first = await s.arm();
    assert.equal(first.alarms[0].sourceAt, T - 5000);
    s.time(T + 11000);
    await s.watch.tick();
    const view = await s.watch.describe();
    assert.equal(view.alarms[0].sourceAt, T - 5000);
    assert.equal(view.alarms[0].cleared, undefined);
    assert.ok(view.alarms[0].lost);
    assert.equal(view.alarms[0].reportAt, T);
});
test('any current owned enrollment can exact-ACK, but stale danger key cannot ACK escalation', async () => {
    const s = setup(),
        view = await s.arm(),
        first = view.alarms[0];
    await s.watch.acknowledge(other, { context: view.context, key: first.key });
    await s.watch.acknowledge(other, { context: view.context, key: first.key });
    assert.equal(s.events.filter((e) => e.action === 'ack').length, 1);
    s.time(T + 1000);
    s.raw(picture(T + 1000, 0.04));
    await s.watch.tick();
    const close = await s.watch.describe();
    assert.equal(close.alarms[0].closeQuarters, true);
    await assert.rejects(s.watch.acknowledge(other, { context: close.context, key: first.key }), error(409));
    await s.watch.acknowledge(other, { context: close.context, key: close.alarms[0].key });
    assert.equal((await s.watch.describe()).alarms.length, 0);
});
test('controller/policy takeover requires explicit review and exact context CAS', async () => {
    const s = setup(),
        first = await s.arm();
    await assert.rejects(
        s.watch.command(other, { armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS }),
        error(409),
    );
    await assert.rejects(
        s.watch.command(other, { armed: true, expected: first.context, prefs: DEFAULT_COLLISION_PREFS }),
        error(409, 'radar_controller_review_required'),
    );
    const replacement = await s.watch.command(other, {
        armed: true,
        expected: first.context,
        prefs: DEFAULT_COLLISION_PREFS,
        replaceController: true,
    });
    assert.notEqual(replacement.context!.watchEpoch, first.context!.watchEpoch);
    await assert.rejects(
        s.watch.command(controller, { armed: false, expected: replacement.context }),
        error(409, 'radar_controller_conflict'),
    );
    await assert.rejects(s.watch.acknowledge(other, { context: first.context, key: first.alarms[0].key }), error(409));
    const stopped = await s.watch.command(other, { armed: false, expected: replacement.context });
    assert.equal(stopped.running, false);
    assert.equal(stopped.alarms.length, 0);
});
test('pair/source change during async enrollment cannot arm or expose the former context', async () => {
    const s = setup();
    let finish!: (ok: boolean) => void;
    s.enrolled(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const arm = s.arm();
    s.context({ ...s.getContext(), contextToken: 'b'.repeat(64) });
    finish(true);
    await assert.rejects(arm, error(409, 'radar_context_changed'));
    s.enrolled(() => true);
    const first = await s.arm();
    s.enrolled(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const pending = s.watch.describe();
    s.context(null);
    finish(true);
    const view = await pending;
    assert.equal(view.context, null);
    assert.equal(view.alarms.length, 0);
    assert.equal(view.running, false);
    assert.notEqual(first.context, null);
});
test('unknown enrollment withholds proof without erasing held danger; revoked enrollment retires it', async () => {
    const s = setup(),
        first = await s.arm();
    s.enrolled(() => {
        throw Error('temporary device-store failure');
    });
    assert.equal((await s.watch.describe()).running, false);
    s.enrolled(() => true);
    s.time(T + 16000);
    await s.watch.tick();
    const recovered = await s.watch.describe();
    assert.equal(recovered.context!.watchEpoch, first.context!.watchEpoch);
    assert.ok(recovered.alarms[0].lost);
    assert.equal(recovered.alarms[0].cleared, undefined);
    s.enrolled(() => false);
    assert.equal((await s.watch.describe()).context, null);
});
test('malformed prefs/body cannot turn default-normalization into an accepted configuration', async () => {
    const s = setup();
    for (const prefs of [
        null,
        {},
        { offshore: { cpaNm: 0, tcpaMin: 0 }, inshore: DEFAULT_COLLISION_PREFS.inshore },
        { ...DEFAULT_COLLISION_PREFS, extra: true },
    ])
        await assert.rejects(s.watch.command(controller, { armed: true, expected: null, prefs }), error(400));
    await assert.rejects(
        s.watch.command(controller, {
            armed: true,
            expected: null,
            prefs: DEFAULT_COLLISION_PREFS,
            ownerId: fixture.context.binding.ownerId,
        }),
        error(400),
    );
});
test('real HTTP routes stay read-only on GET, require enrollment, reject queries and use no-store', async (t) => {
    const s = setup(),
        app = express();
    app.use(
        '/api/radar',
        createRadarWatchRoutes({
            watch: s.watch,
            enrolled: (req) => (req.header('x-generated-device') === 'yes' ? controller : null),
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/radar/watch`,
        headers = { 'x-generated-device': 'yes', 'content-type': 'application/json' };
    assert.equal((await fetch(base)).status, 403);
    const get = await fetch(base, { headers });
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(((await get.json()) as { running: boolean }).running, false);
    assert.equal(s.events.length, 0);
    assert.equal((await fetch(base + '?arm=true', { headers })).status, 400);
    const arm = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS }),
    });
    assert.equal(arm.status, 200);
    const status = (await arm.json()) as Awaited<ReturnType<RadarWatch['describe']>>;
    const ack = await fetch(base + '/ack', {
        method: 'POST',
        headers,
        body: JSON.stringify({ context: status.context, key: status.alarms[0].key }),
    });
    assert.equal(ack.status, 200);
    assert.equal(((await ack.json()) as { alarms: unknown[] }).alarms.length, 0);
});

test('relay facts contain only fixed scalar original evidence and lose eligibility on context retirement', async () => {
    const s = setup();
    s.raw(picture(T, 1, T - 5000));
    await s.arm();
    const last = s.passes.at(-1)!;
    assert.equal(last.pass.upserts[0].sourceAt, T - 5000);
    assert.equal(last.pass.upserts[0].reportAt, T);
    assert.equal(last.current(), true);
    assert.ok(!/Generated|RATTM|latitude|longitude|sentence|ownship/.test(JSON.stringify(last.pass)));
    s.time(T + 11000);
    await s.watch.tick();
    assert.equal(s.passes.at(-1)!.pass.upserts.length, 0);
    s.watch.stop();
    assert.equal(last.current(), false);
});
test('root parser assembly enforces the smaller raw radar body cap before a command can arm', async (t) => {
    const s = setup(),
        app = express();
    app.use(createAppJsonParser(false));
    app.use('/api/radar', createRadarWatchRoutes({ watch: s.watch, enrolled: () => controller }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/radar/watch`;
    const body = JSON.stringify({ armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS });
    assert.equal(
        (
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: ' '.repeat(9000) + body,
            })
        ).status,
        413,
    );
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status, 400);
    assert.equal(
        (
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
                body: new Uint8Array(gzipSync(body)),
            })
        ).status,
        400,
    );
    assert.equal(s.events.length, 0);
    assert.equal((await s.watch.describe()).context, null);
    assert.equal(
        (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
        200,
    );
    assert.equal(s.events.filter((e) => e.action === 'bind').length, 1);
});
test('an accidentally preconsumed radar body is refused instead of claiming raw-byte admission', async (t) => {
    const s = setup(),
        app = express();
    app.use(express.json());
    app.use('/api/radar', createRadarWatchRoutes({ watch: s.watch, enrolled: () => controller }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/radar/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS }),
    });
    assert.equal(response.status, 400);
    assert.equal(s.events.length, 0);
});
test('an unreadable current controller cannot be silently treated as an empty CAS slot', async () => {
    const s = setup(),
        first = await s.arm();
    let calls = 0;
    s.enrolled(() => {
        if (++calls === 1) return true;
        throw Error('temporary controller store failure');
    });
    await assert.rejects(
        s.watch.command(other, { armed: true, expected: null, prefs: DEFAULT_COLLISION_PREFS }),
        error(503, 'radar_enrollment_unavailable'),
    );
    s.enrolled(() => true);
    assert.equal((await s.watch.describe()).context!.watchEpoch, first.context!.watchEpoch);
});

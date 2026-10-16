import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RadarRelay } from './radar/relay.js';
import { radarRelayKeyCanonical, type RadarRelayUpsert, type RadarRelayRequest } from './radar/radarRelayContract.js';
const f = JSON.parse(readFileSync(new URL('../../tests/fixtures/radar-relay137.json', import.meta.url), 'utf8'));
const T = f.alarm.raisedAt as number;
const R = '77777777-7777-4777-8777-777777777777',
    R2 = '88888888-8888-4888-8888-888888888888';
const cap = { v: 1, enabled: true };
function alarm(number = 1, at = T): RadarRelayUpsert {
    const a = {
        ...f.alarm,
        contactKey: f.alarm.contactKey.replace(/:1$/, ':' + number),
        episodeId: f.context.watchEpoch + ':' + number,
        sourceAt: at,
        reportAt: at,
    } as RadarRelayUpsert;
    a.key = `${a.kind}:${createHash('sha256').update(radarRelayKeyCanonical(f.context, a)).digest('hex').slice(0, 12)}:${a.raisedAt}`;
    return a;
}
function setup() {
    let now = T,
        current = true,
        internet = true,
        token = 'generated-secret',
        owner = f.context.binding.ownerId;
    const requests: { url: string; body: RadarRelayRequest; init: RequestInit }[] = [],
        applied: unknown[] = [];
    let respond = async (body: RadarRelayRequest): Promise<Response> =>
        new Response(
            JSON.stringify(
                body.action === 'probe'
                    ? { ok: true, radar: cap, devices: 1, contextRevision: null, context: null, retired: false }
                    : {
                          ok: true,
                          radar: cap,
                          contextRevision: body.action === 'retire' ? R2 : R,
                          queued: body.action === 'sync' ? body.upserts.length : 0,
                          acked: [],
                          acknowledgements: [],
                          ...(body.action === 'retire' ? { retired: true } : {}),
                      },
            ),
        );
    const relay = new RadarRelay({
        endpoint: 'https://generated.supabase.co/functions/v1/pi-alarm-relay',
        fetchImpl: async (url, init) => {
            const body = JSON.parse(init!.body as string);
            requests.push({ url: String(url), body, init: init! });
            return respond(body);
        },
        anonKey: () => 'generated-public-key',
        credentials: () => ({ relayId: 'generated-id', token }),
        ownerId: () => owner,
        internetAllowed: () => internet,
        now: () => now,
    });
    const update = (upserts = [alarm(1, now)]) =>
        relay.update(
            { context: f.context, evaluatedAt: now, upserts },
            () => current,
            (context, acks) => {
                applied.push({ context, acks });
            },
        );
    return {
        relay,
        requests,
        applied,
        update,
        respond: (fn: typeof respond) => {
            respond = fn;
        },
        time: (t: number) => {
            now = t;
        },
        current: (v: boolean) => {
            current = v;
        },
        internet: (v: boolean) => {
            internet = v;
        },
        token: (v: string) => {
            token = v;
        },
        owner: (v: string) => {
            owner = v;
        },
    };
}
test('fixed bounded family probe/bind/sync contains no raw target facts and readiness ages', async () => {
    const s = setup();
    s.update();
    await s.relay.settled();
    assert.deepEqual(
        s.requests.map((r) => r.body.action),
        ['probe', 'bind', 'sync'],
    );
    assert.equal(s.relay.status().state, 'ready');
    for (const r of s.requests) {
        assert.equal(r.url, 'https://generated.supabase.co/functions/v1/pi-alarm-relay');
        assert.equal(r.init.redirect, 'error');
        assert.ok(Buffer.byteLength(JSON.stringify(r.body)) <= 8192);
        assert.ok(!/RATTM|Generated|latitude|longitude|sentence|ownship/.test(JSON.stringify(r.body)));
    }
    s.time(T + 30001);
    assert.equal(s.relay.status().state, 'unavailable');
    assert.throws(
        () =>
            new RadarRelay({
                endpoint: 'https://generated.supabase.co/other',
                fetchImpl: fetch,
                anonKey: () => '',
                credentials: () => null,
                ownerId: () => null,
                internetAllowed: () => false,
            }),
    );
});
test('batch8 continuation rotates through targets and never turns absence into resolution', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
        s.time(T + i * 5000);
        s.update(Array.from({ length: 20 }, (_, n) => alarm(n + 1, T + i * 5000)));
        await s.relay.settled();
    }
    const sync = s.requests.map((r) => r.body).filter((b) => b.action === 'sync');
    assert.equal(new Set(sync.flatMap((b) => b.upserts.map((u) => u.contactKey))).size, 20);
    for (const b of sync) {
        assert.ok(b.upserts.length + b.acks.length + b.resolved.length <= 8);
        assert.equal(b.more, true);
        assert.equal(b.resolved.length, 0);
    }
});
test('unknown existing cloud controller conflicts until exact explicit revision review', async () => {
    const s = setup();
    s.respond(
        async (body) =>
            new Response(
                JSON.stringify(
                    body.action === 'probe'
                        ? {
                              ok: true,
                              radar: cap,
                              devices: 1,
                              contextRevision: R,
                              context: { ...f.context, configurationRevision: R2 },
                              retired: false,
                          }
                        : { ok: true, radar: cap, contextRevision: R2, queued: 0, acked: [], acknowledgements: [] },
                ),
            ),
    );
    s.update();
    await s.relay.settled();
    assert.equal(s.relay.status().state, 'conflict');
    assert.equal(
        s.requests.some((r) => r.body.action === 'bind'),
        false,
    );
    assert.equal(s.relay.review(R2, f.context), false);
    assert.equal(s.relay.review(R, f.context), true);
    s.update();
    await s.relay.settled();
    assert.equal(s.requests.find((r) => r.body.action === 'bind')!.body.action, 'bind');
});
test('original acknowledgement times survive repeated replies; missing or foreign ACK clocks fail closed', async () => {
    const s = setup();
    s.respond(
        async (body) =>
            new Response(
                JSON.stringify(
                    body.action === 'probe'
                        ? { ok: true, radar: cap, devices: 1, contextRevision: null, context: null, retired: false }
                        : body.action === 'bind'
                          ? { ok: true, radar: cap, contextRevision: R, queued: 0, acked: [], acknowledgements: [] }
                          : {
                                ok: true,
                                radar: cap,
                                contextRevision: R,
                                queued: 0,
                                acked: [alarm().key],
                                acknowledgements: [{ key: alarm().key, ackedAt: T + 500 }],
                            },
                ),
            ),
    );
    s.time(T + 60000);
    s.update();
    await s.relay.settled();
    s.time(T + 65000);
    s.update();
    await s.relay.settled();
    assert.equal((s.applied[0] as { acks: { ackedAt: number }[] }).acks[0].ackedAt, T + 500);
    assert.equal((s.applied[1] as { acks: { ackedAt: number }[] }).acks[0].ackedAt, T + 500);
    s.respond(
        async () =>
            new Response(JSON.stringify({ ok: true, radar: cap, contextRevision: R, queued: 0, acked: [alarm().key] })),
    );
    s.time(T + 70000);
    s.update();
    await s.relay.settled();
    assert.equal(s.applied.length, 2);
    assert.equal(s.relay.status().state, 'unavailable');
});
test('credential/context retirement during fetch cannot install an old ready result', async () => {
    const s = setup();
    let finish!: (r: Response) => void;
    s.respond(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    s.update();
    s.token('replacement-secret');
    finish(
        new Response(
            JSON.stringify({ ok: true, radar: cap, devices: 1, contextRevision: null, context: null, retired: false }),
        ),
    );
    await s.relay.settled();
    assert.equal(s.relay.status().state, 'unavailable');
    assert.equal(s.requests.length, 1);
    assert.equal(s.applied.length, 0);
});
test('stand-down sends only the confirmed old context retirement, even without a new source pass', async () => {
    const s = setup();
    s.update();
    await s.relay.settled();
    s.relay.event({ action: 'retire', context: f.context });
    await s.relay.settled();
    assert.equal(s.requests.at(-1)!.body.action, 'retire');
    assert.equal(s.relay.status().state, 'unavailable');
    const count = s.requests.length;
    s.relay.pump();
    await s.relay.settled();
    assert.equal(s.requests.length, count);
});
test('Satellite/internet policy and changed owner credentials never send old-context work', async () => {
    const s = setup();
    s.internet(false);
    s.update();
    await s.relay.settled();
    assert.equal(s.requests.length, 0);
    assert.equal(s.relay.status().state, 'internet-off');
    s.internet(true);
    s.time(T + 5000);
    s.update();
    await s.relay.settled();
    const count = s.requests.length;
    s.internet(false);
    s.relay.event({ action: 'retire', context: f.context });
    await s.relay.settled();
    s.owner('99999999-9999-4999-8999-999999999999');
    s.token('other-owner');
    s.internet(true);
    s.time(T + 10000);
    s.relay.pump();
    await s.relay.settled();
    assert.equal(s.requests.length, count);
});
test('an oversized actual response stream is cancelled and cannot claim readiness', async () => {
    const s = setup();
    let cancelled = false;
    s.respond(
        async () =>
            new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array(16385));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
            ),
    );
    s.update();
    await s.relay.settled();
    assert.equal(cancelled, true);
    assert.equal(s.relay.status().state, 'unavailable');
});

test('an explicit ACK during an in-flight upsert is sent once with its original action clock', async () => {
    const s = setup();
    let finish!: (r: Response) => void;
    s.respond(async (body) => {
        if (body.action === 'probe')
            return new Response(
                JSON.stringify({
                    ok: true,
                    radar: cap,
                    devices: 1,
                    contextRevision: null,
                    context: null,
                    retired: false,
                }),
            );
        if (body.action === 'bind')
            return new Response(
                JSON.stringify({
                    ok: true,
                    radar: cap,
                    contextRevision: R,
                    queued: 0,
                    acked: [],
                    acknowledgements: [],
                }),
            );
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    s.update();
    while (!finish) await new Promise((r) => setImmediate(r));
    const a = alarm();
    s.relay.event({
        action: 'ack',
        context: f.context,
        ack: { key: a.key, contactKey: a.contactKey, episodeId: a.episodeId, kind: a.kind, ackedAt: T + 1000 },
    });
    s.time(T + 1000);
    s.update([]);
    finish(
        new Response(
            JSON.stringify({ ok: true, radar: cap, contextRevision: R, queued: 1, acked: [], acknowledgements: [] }),
        ),
    );
    await s.relay.settled();
    s.respond(
        async () =>
            new Response(
                JSON.stringify({
                    ok: true,
                    radar: cap,
                    contextRevision: R,
                    queued: 0,
                    acked: [a.key],
                    acknowledgements: [{ key: a.key, ackedAt: T + 1000 }],
                }),
            ),
    );
    s.time(T + 5000);
    s.update([]);
    await s.relay.settled();
    const ackRequest = s.requests.at(-1)!.body;
    assert.equal(ackRequest.action, 'sync');
    if (ackRequest.action === 'sync') assert.equal(ackRequest.acks[0].ackedAt, T + 1000);
    s.time(T + 10000);
    s.update([]);
    await s.relay.settled();
    const after = s.requests.at(-1)!.body;
    if (after.action === 'sync') assert.equal(after.acks.length, 0);
});

test('a stalled actual response stream is cancelled at the whole 8-second deadline', async () => {
    const s = setup();
    let cancelled = false;
    s.respond(
        async () =>
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled = true;
                    },
                }),
            ),
    );
    const keepAlive = setTimeout(() => {}, 10000),
        start = performance.now();
    try {
        s.update();
        await s.relay.settled();
        assert.equal(cancelled, true);
        assert.equal(s.relay.status().state, 'unavailable');
        assert.ok(performance.now() - start >= 7900 && performance.now() - start < 9500);
    } finally {
        clearTimeout(keepAlive);
    }
});

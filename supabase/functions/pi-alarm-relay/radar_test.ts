import fixture from '../../../tests/fixtures/radar-relay137.json' with { type: 'json' };
import { type PiRelayIdentity, sha256Hex } from '../_shared/pi-relay-auth.ts';
import {
    type RadarRelayContext,
    radarRelayKeyCanonical,
    type RadarRelayUpsert,
} from '../../../utils/radarRelayContract.ts';
import { parseRadarRelayRequest, radarRelayAlarmKey } from './radar-contract.ts';
import { handleRadarRelay, radarCapabilityReady, type RadarRelayDeps } from './radar-relay.ts';
import { handlePiAlarmRelay, type PiAlarmStore } from './relay.ts';

const assert = (value: unknown, message = 'Assertion failed') => {
    if (!value) throw new Error(message);
};
const normalized = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(normalized) : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalized(v)]),
        )
        : value;
const equal = (actual: unknown, expected: unknown) =>
    assert(
        JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected)),
        `Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
    );
const now = fixture.alarm.raisedAt;
const identity: PiRelayIdentity = { ownerId: fixture.context.binding.ownerId, relayId: 'fictional-radar-relay-137' };
async function input() {
    const context: RadarRelayContext = structuredClone(fixture.context);
    context.binding.pairingId = await sha256Hex(
        JSON.stringify([identity.ownerId, context.binding.piDeviceId, identity.relayId]),
    );
    const alarm = structuredClone(fixture.alarm) as RadarRelayUpsert;
    alarm.key = await radarRelayAlarmKey(context, alarm);
    return {
        family: 'radar' as const,
        action: 'sync' as const,
        context,
        contextRevision: '66666666-6666-4666-8666-666666666666',
        evaluatedAt: now,
        upserts: [alarm],
        acks: [] as unknown[],
        resolved: [] as unknown[],
        more: false,
    };
}
const parse = (body: Record<string, unknown>, at = now) => parseRadarRelayRequest(body, identity, at);

Deno.test('portable fixed radar fixture has exactly the same canonical bytes and event key at the Edge', async () => {
    equal(radarRelayKeyCanonical(fixture.context, fixture.alarm as RadarRelayUpsert), fixture.canonical);
    equal(await sha256Hex(fixture.canonical), fixture.sha256);
    equal(await radarRelayAlarmKey(fixture.context, fixture.alarm as RadarRelayUpsert), fixture.alarm.key);
    const body = await input(), result = await parse(body);
    assert(result?.action === 'sync');
    if (result?.action !== 'sync') return;
    equal(result.upserts, body.upserts);
    equal(result.upserts[0].sourceAt, fixture.alarm.sourceAt);
});
Deno.test('probe and explicit context CAS operations accept only their fixed fields', async () => {
    equal(await parse({ family: 'radar', action: 'probe' }), { family: 'radar', action: 'probe' });
    const { context, contextRevision } = await input();
    const bind = { family: 'radar', action: 'bind', context, expectedContextRevision: null };
    equal(await parse(bind), bind);
    equal(await parse({ ...bind, expectedContextRevision: contextRevision }), {
        ...bind,
        expectedContextRevision: contextRevision,
    });
    const retire = { family: 'radar', action: 'retire', context, contextRevision };
    equal(await parse(retire), retire);
    for (
        const body of [{ family: 'radar', action: 'probe', context }, { ...bind, expectedContextRevision: undefined }, {
            ...retire,
            contextRevision: null,
        }, { ...bind, url: 'https://example.test' }]
    ) equal(await parse(body), null);
});
Deno.test('owner, relay pairing, enrollment, phone and verified Pi feed cannot be substituted', async () => {
    for (
        const mutate of [
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.ownerId = '77777777-7777-4777-8777-777777777777';
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.pairingId = 'a'.repeat(64);
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.piDeviceId = '77777777-7777-4777-8777-777777777777';
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.deviceId = 'not-a-phone';
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.enrollmentRevision = 'b'.repeat(63);
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.binding.feedId = 'gateway:unverified';
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.context.watchEpoch = 'z'.repeat(32);
            },
        ]
    ) {
        const r = await input();
        mutate(r);
        equal(await parse(r), null);
    }
    const r = await input();
    equal(await parseRadarRelayRequest(r, { ...identity, relayId: 'another-valid-relay-identity' }, now), null);
});
Deno.test('no positions, names, raw frames, arbitrary paths or extra command fields cross the relay', async () => {
    for (const target of ['root', 'context', 'binding', 'alarm']) {
        for (
            const [key, value] of [['position', { lat: 10, lon: 20 }], ['name', 'echo'], ['nmea', '$RATTM,...'], [
                'path',
                'navigation.position',
            ], ['url', 'https://example.test']] as const
        ) {
            const r = await input();
            Object.assign(
                target === 'root'
                    ? r
                    : target === 'context'
                    ? r.context
                    : target === 'binding'
                    ? r.context.binding
                    : r.upserts[0],
                { [key]: value },
            );
            equal(await parse(r), null);
        }
    }
});
Deno.test('contact, watch episode, severity and raised clock are bound into the exact hash key', async () => {
    for (
        const mutate of [
            (a: RadarRelayUpsert) => {
                a.contactKey = 'radar:pi:' + 'e'.repeat(32) + ':RA:2';
            },
            (a: RadarRelayUpsert) => {
                a.contactKey = 'ais:123456789';
            },
            (a: RadarRelayUpsert) => {
                a.episodeId = 'f'.repeat(32) + ':1';
            },
            (a: RadarRelayUpsert) => {
                a.episodeId = fixture.context.watchEpoch + ':0';
            },
            (a: RadarRelayUpsert) => {
                a.kind = 'radar-close-quarters';
            },
            (a: RadarRelayUpsert) => {
                a.raisedAt -= 1;
            },
            (a: RadarRelayUpsert) => {
                a.key = a.key.replace(/:[0-9a-f]{12}:/, ':000000000000:');
            },
        ]
    ) {
        const r = await input();
        mutate(r.upserts[0]);
        equal(await parse(r), null);
    }
    const r = await input();
    r.upserts[0].kind = 'radar-close-quarters';
    r.upserts[0].key = await radarRelayAlarmKey(r.context, r.upserts[0]);
    assert(await parse(r));
});
Deno.test('fresh report arrival cannot renew a stale leaf dependency or fabricate a future clock', async () => {
    for (
        const mutate of [
            (r: Awaited<ReturnType<typeof input>>) => {
                r.upserts[0].sourceAt = now - 15_001;
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.upserts[0].sourceAt = now + 1;
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.upserts[0].reportAt = now + 1001;
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.evaluatedAt = now + 1001;
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.evaluatedAt = now - 30_001;
            },
            (r: Awaited<ReturnType<typeof input>>) => {
                r.upserts[0].sourceAt = NaN;
            },
        ]
    ) {
        const r = await input();
        mutate(r);
        equal(await parse(r), null);
    }
    const r = await input();
    r.upserts[0].sourceAt = now - 15_000;
    assert(await parse(r));
});
Deno.test('unknown evidence remains unknown with original clock and bounded fixed lost reasons', async () => {
    const r = await input();
    Object.assign(r.upserts[0], {
        sourceAt: now - 20_000,
        cpaNm: null,
        tcpaMin: null,
        rangeNm: null,
        bearingDeg: null,
        lost: 'report-too-old',
    });
    const parsed = await parse(r);
    assert(parsed?.action === 'sync');
    if (parsed?.action === 'sync') equal(parsed.upserts[0], r.upserts[0]);
    for (
        const extra of [{ lost: 'arbitrary text' }, { lost: null }, { cpaNm: 1 }, { sourceAt: now - 31 * 86_400_000 }]
    ) equal(await parse({ ...r, upserts: [{ ...r.upserts[0], ...extra }] }), null);
});
Deno.test('CPA, TCPA, range and bearing reject unknown promotion and non-finite or out-of-range values', async () => {
    for (
        const extra of [
            { cpaNm: -1 },
            { cpaNm: 1001 },
            { cpaNm: Infinity },
            { tcpaMin: 61 },
            { tcpaMin: -61 },
            { tcpaMin: null },
            { cpaNm: null },
            { rangeNm: -1 },
            { rangeNm: null },
            { bearingDeg: 360 },
            { bearingDeg: -1 },
        ]
    ) {
        const r = await input();
        Object.assign(r.upserts[0], extra);
        equal(await parse(r), null);
    }
});
Deno.test('sparse and continuation batches never imply a resolution; duplicate list keys and over-cap batches refuse', async () => {
    const r = await input();
    for (const more of [false, true]) {
        const p = await parse({ ...r, upserts: [], more });
        assert(p?.action === 'sync');
        if (p?.action === 'sync') equal(p.resolved, []);
    }
    equal(await parse({ ...r, upserts: [r.upserts[0], r.upserts[0]] }), null);
    equal(await parse({ ...r, upserts: Array(9).fill(r.upserts[0]) }), null);
    equal(await parse({ ...r, more: 'yes' }), null);
});
Deno.test('ACK and resolution bind exact episode plus severity and allow upsert+ACK in one bounded batch', async () => {
    const r = await input(), { key, contactKey, episodeId, kind } = r.upserts[0];
    const ack = { key, contactKey, episodeId, kind, ackedAt: now },
        resolved = { key, contactKey, episodeId, kind, how: 'passed', endedAt: now };
    assert(await parse({ ...r, acks: [ack] }));
    assert(await parse({ ...r, upserts: [], resolved: [resolved] }));
    for (
        const body of [
            { ...r, acks: [ack, ack] },
            { ...r, acks: [{ ...ack, kind: 'radar-close-quarters' }] },
            { ...r, acks: [{ ...ack, ackedAt: now - 1 }] },
            { ...r, acks: [{ ...ack, ackedAt: now + 1001 }] },
            { ...r, resolved: [{ ...resolved, how: 'gone' }] },
            { ...r, resolved: [{ ...resolved, endedAt: now - 1 }] },
            { ...r, acks: [{ ...ack, position: { lat: 1, lon: 2 } }] },
        ]
    ) equal(await parse(body), null);
});

Deno.test('unavailable capability permits an unarmed probe only; malformed input never reaches storage', async () => {
    let applies = 0;
    const deps: RadarRelayDeps = {
        capability: () => Promise.resolve(false),
        apply: () => {
            applies++;
            throw new Error('must stay unarmed');
        },
        deliver: () => {
            throw new Error('no notification');
        },
    };
    const probe = await handleRadarRelay({ family: 'radar', action: 'probe' }, identity, deps, now);
    equal(probe.status, 200);
    equal((await probe.json()).radar, { v: 1, enabled: false });
    equal((await handleRadarRelay(await input(), identity, deps, now)).status, 503);
    equal(
        (await handleRadarRelay({ family: 'radar', action: 'probe', position: [1, 2] }, identity, deps, now)).status,
        400,
    );
    equal(applies, 0);
});
Deno.test('atomic sync queues only bounded UUIDs and returns acknowledgements only from this exact batch', async () => {
    const r = await input(), queue = '77777777-7777-4777-8777-777777777777', delivered: string[] = [];
    const deps: RadarRelayDeps = {
        capability: () => Promise.resolve(true),
        apply: () =>
            Promise.resolve({
                contextRevision: r.contextRevision,
                queued: [queue, queue],
                acked: [r.upserts[0].key],
                acknowledgements: [{ key: r.upserts[0].key, ackedAt: now }],
            }),
        deliver: (id) => {
            delivered.push(id);
        },
    };
    const response = await handleRadarRelay(r, identity, deps, now);
    equal(response.status, 200);
    equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    equal(value.queued, 2);
    equal(value.acked, [r.upserts[0].key]);
    equal(delivered, [queue]);
    assert(!JSON.stringify(value).includes(queue));
    for (
        const extra of [
            { contextRevision: '88888888-8888-4888-8888-888888888888' },
            { queued: ['not-a-queue'] },
            { queued: Array(9).fill(queue) },
            { acked: ['radar-collision:000000000000:' + now] },
            { acked: Array(9).fill(r.upserts[0].key) },
        ]
    ) {
        const answer = await handleRadarRelay(r, identity, {
            ...deps,
            apply: () =>
                Promise.resolve({
                    contextRevision: r.contextRevision,
                    queued: [],
                    acked: [],
                    acknowledgements: [],
                    ...extra,
                }),
            deliver: () => {
                throw new Error('malformed reply must not deliver');
            },
        }, now);
        equal(answer.status, 503);
    }
});
Deno.test('context conflict never rebinds, and a retire must rotate the revision without pushing', async () => {
    const r = await input(),
        deps: RadarRelayDeps = {
            capability: () => Promise.resolve(true),
            apply: () => Promise.resolve({ conflict: true }),
            deliver: () => {
                throw new Error('no notification');
            },
        };
    const response = await handleRadarRelay(r, identity, deps, now);
    equal(response.status, 409);
    equal(await response.json(), { error: 'radar_context_conflict' });
    const retire = { family: 'radar', action: 'retire', context: r.context, contextRevision: r.contextRevision };
    equal(
        (await handleRadarRelay(retire, identity, {
            ...deps,
            apply: () =>
                Promise.resolve({
                    contextRevision: r.contextRevision,
                    retired: true,
                    queued: [],
                    acked: [],
                    acknowledgements: [],
                }),
        }, now)).status,
        503,
    );
    const accepted = await handleRadarRelay(retire, identity, {
        ...deps,
        apply: () =>
            Promise.resolve({
                contextRevision: '88888888-8888-4888-8888-888888888888',
                retired: true,
                queued: [],
                acked: [],
                acknowledgements: [],
            }),
    }, now);
    equal(accepted.status, 200);
    equal((await accepted.json()).retired, true);
});
Deno.test('probe verifies owner-bound returned context and never invokes a delivery', async () => {
    const r = await input(),
        result = { devices: 1, contextRevision: r.contextRevision, context: r.context, retired: false };
    const deps: RadarRelayDeps = {
        capability: () => Promise.resolve(true),
        apply: () => Promise.resolve(result),
        deliver: () => {
            throw new Error('read must not deliver');
        },
    };
    equal((await handleRadarRelay({ family: 'radar', action: 'probe' }, identity, deps, now)).status, 200);
    for (
        const extra of [{ devices: 1001 }, { devices: -1 }, { context: null }, { retired: 'yes' }, {
            contextRevision: null,
        }, {
            context: {
                ...r.context,
                binding: { ...r.context.binding, ownerId: '77777777-7777-4777-8777-777777777777' },
            },
        }]
    ) {
        equal(
            (await handleRadarRelay({ family: 'radar', action: 'probe' }, identity, {
                ...deps,
                apply: () => Promise.resolve({ ...result, ...extra }),
            }, now)).status,
            503,
        );
    }
});
Deno.test('a delayed remote ACK preserves its original clock rather than renewing the mute at receipt', async () => {
    const r = await input();
    r.upserts[0].raisedAt = now - 29 * 60_000;
    r.upserts[0].key = await radarRelayAlarmKey(r.context, r.upserts[0]);
    const acknowledgement = { key: r.upserts[0].key, ackedAt: now - 28 * 60_000 };
    const result = {
        contextRevision: r.contextRevision,
        queued: [],
        acked: [acknowledgement.key],
        acknowledgements: [acknowledgement],
    };
    const deps: RadarRelayDeps = {
        capability: () => Promise.resolve(true),
        apply: () => Promise.resolve(result),
        deliver: () => {
            throw new Error('ACK is not a push');
        },
    };
    const response = await handleRadarRelay(r, identity, deps, now);
    equal(response.status, 200);
    equal((await response.json()).acknowledgements, [acknowledgement]);
    for (
        const acknowledgements of [
            undefined,
            [],
            [{ ...acknowledgement, ackedAt: now + 1001 }],
            [{ ...acknowledgement, ackedAt: r.upserts[0].raisedAt - 1 }],
            [{ ...acknowledgement, ackedAt: 'now' }],
            [acknowledgement, acknowledgement],
            [{ ...acknowledgement, position: { lat: 1, lon: 2 } }],
        ]
    ) {
        equal(
            (await handleRadarRelay(r, identity, {
                ...deps,
                apply: () => Promise.resolve({ ...result, acknowledgements }),
            }, now)).status,
            503,
        );
    }
});
Deno.test('paired credential and existing 8KiB door precede radar dispatch; legacy tables are untouched', async () => {
    let calls = 0, auths = 0, touches = 0;
    const fail = () => {
        throw new Error('legacy storage was accessed');
    };
    const store: PiAlarmStore = {
        touchRelay: () => {
            touches++;
        },
        countDevices: fail,
        findEvents: fail,
        openEvents: fail,
        insertEvent: fail,
        updateEvent: fail,
        resolveEvents: fail,
        lastPushedAt: fail,
        countPushedSince: fail,
        alarmPushesSince: fail,
        enqueuePush: fail,
        pruneResolved: fail,
    };
    const deps = {
        store,
        authenticate: (credential: unknown) => {
            auths++;
            return Promise.resolve(credential ? identity : { status: 401 as const, error: 'refused' });
        },
        now: () => now,
        radar: () => {
            calls++;
            return Promise.resolve(Response.json({ ok: true }));
        },
    };
    const make = (body: unknown, auth = true) =>
        new Request('https://example.test/pi-alarm-relay', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(auth
                    ? { 'X-Thalassa-Pi-Relay-Id': identity.relayId, 'X-Thalassa-Pi-Relay-Token': 'a'.repeat(64) }
                    : {}),
            },
            body: JSON.stringify(body),
        });
    equal((await handlePiAlarmRelay(make(await input(), false), deps)).status, 401);
    equal(calls, 0);
    equal((await handlePiAlarmRelay(make(await input()), deps)).status, 200);
    equal(calls, 1);
    equal(touches, 1);
    equal((await handlePiAlarmRelay(make({ family: 'radar', padding: 'x'.repeat(9000) }), deps)).status, 413);
    equal(auths, 2);
    equal(calls, 1);
    equal((await handlePiAlarmRelay(make(await input()), { ...deps, radar: undefined })).status, 503);
});
Deno.test('capability requires both exact schema and configured fixed sender; redirects and oversized replies refuse', async () => {
    let calls = 0;
    const fetcher: typeof fetch = (url, init) => {
        calls++;
        equal(String(url), 'https://example.supabase.co/functions/v1/send-push');
        equal(init?.method, 'POST');
        equal(init?.redirect, 'error');
        equal(init?.cache, 'no-store');
        equal(init?.body, JSON.stringify({ action: 'capabilities' }));
        return Promise.resolve(Response.json({ radar_alarm: 1 }));
    };
    equal(
        await radarCapabilityReady(
            () => Promise.resolve(1),
            'https://example.supabase.co',
            'fictional-service',
            fetcher,
        ),
        true,
    );
    for (const schema of [0, true, null]) {
        equal(
            await radarCapabilityReady(
                () => Promise.resolve(schema),
                'https://example.supabase.co',
                'fictional-service',
                fetcher,
            ),
            false,
        );
    }
    equal(calls, 1);
    for (
        const url of [
            'http://example.test',
            'https://user@example.test',
            'https://example.test/path',
            'https://example.test?key=value',
        ]
    ) equal(await radarCapabilityReady(() => Promise.resolve(1), url, 'fictional-service', fetcher), false);
    for (const body of [{ radar_alarm: true }, { wake_alarm: 1 }, { radar_alarm: 1, padding: 'x'.repeat(2000) }]) {
        equal(
            await radarCapabilityReady(
                () => Promise.resolve(1),
                'https://example.supabase.co',
                'fictional-service',
                () => Promise.resolve(Response.json(body)),
            ),
            false,
        );
    }
    equal(
        await radarCapabilityReady(
            () => Promise.resolve(1),
            'https://example.supabase.co',
            'fictional-service',
            () => Promise.resolve(new Response(null, { status: 302 })),
        ),
        false,
    );
});

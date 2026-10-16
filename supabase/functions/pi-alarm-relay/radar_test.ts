import fixture from '../../../tests/fixtures/radar-relay137.json' with { type: 'json' };
import { type PiRelayIdentity, sha256Hex } from '../_shared/pi-relay-auth.ts';
import {
    type RadarRelayContext,
    radarRelayKeyCanonical,
    type RadarRelayUpsert,
} from '../../../utils/radarRelayContract.ts';
import { parseRadarRelayRequest, radarRelayAlarmKey } from './radar-contract.ts';

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

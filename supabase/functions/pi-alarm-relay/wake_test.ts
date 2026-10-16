import { type PiRelayIdentity, sha256Hex } from '../_shared/pi-relay-auth.ts';
import {
    parseWakeRelayRequest,
    WAKE_KINDS,
    wakeRelayAlarmKey,
    type WakeRelayContext,
    type WakeRelayState,
} from './wake-contract.ts';
import { handleWakeRelay, wakeCapabilityReady } from './wake-relay.ts';
import { handlePiAlarmRelay, type PiAlarmStore } from './relay.ts';
const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
    }
};
const assert = (value: unknown) => {
    if (!value) throw new Error('Assertion failed');
};
const now = Date.parse('2026-10-17T00:00:00Z'),
    owner = '00000000-0000-4000-8000-000000000001',
    pi = '00000000-0000-4000-8000-000000000002';
const identity: PiRelayIdentity = { ownerId: owner, relayId: 'fictional-relay-identity' };
async function fixture() {
    const context: WakeRelayContext = {
        binding: {
            ownerId: owner,
            piDeviceId: pi,
            pairingId: await sha256Hex(JSON.stringify([owner, pi, identity.relayId])),
            deviceId: '00000000-0000-4000-8000-000000000003',
            enrollmentRevision: 'a'.repeat(64),
            feedId: `pi:${pi}:` + 'b'.repeat(24),
        },
        rulesDigest: 'c'.repeat(64),
        configurationRevision: '00000000-0000-4000-8000-000000000004',
        instance: '00000000-0000-4000-8000-000000000005',
        rules: [],
    };
    const values = [1, 30, 1, 4, 110, 50, 5000, 10], thresholds = [3, 25, 2, 3, 100, 100, 4000, 12];
    context.rules = (Object.keys(WAKE_KINDS) as (keyof typeof WAKE_KINDS)[]).map((kind, i) => ({
        kind,
        enabled: true,
        sourceKey: 'd'.repeat(64),
        threshold: thresholds[i],
        quietHours: null,
    }));
    const states: WakeRelayState[] = [];
    for (const [i, kind] of (Object.keys(WAKE_KINDS) as (keyof typeof WAKE_KINDS)[]).entries()) {
        states.push({
            kind,
            status: 'active',
            quiet: false,
            alarm: {
                key: await wakeRelayAlarmKey(context, kind, 'd'.repeat(64), now - 1000),
                sourceKey: 'd'.repeat(64),
                sourceAt: now,
                raisedAt: now - 1000,
                value: values[i],
                threshold: thresholds[i],
                depthBasis: i === 0 ? 'below-keel' : null,
                ackedAt: null,
            },
        });
    }
    const request = {
        family: 'wake',
        action: 'sync',
        context,
        contextRevision: '00000000-0000-4000-8000-000000000006',
        evaluatedAt: now,
        higherPriority: 'none',
        states,
    };
    return { context, request };
}
Deno.test('all eight fixed wake presets preserve original clocks, explicit references and context-bound episodes', async () => {
    const f = await fixture(), parsed = await parseWakeRelayRequest(f.request, identity, now);
    assert(parsed?.action === 'sync');
    if (parsed?.action !== 'sync') return;
    equal(parsed.states.map((s) => s.alarm!.sourceAt), Array(8).fill(now));
    equal(parsed.states.map((s) => s.kind), Object.keys(WAKE_KINDS));
    assert(parsed.states.every((s) => s.alarm!.key.length <= 64));
});
Deno.test('no generic text/path/source/URL/coordinate payload or unknown fields cross the wake boundary', async () => {
    const f = await fixture();
    for (
        const mutate of [
            (r: Record<string, unknown>) => {
                r.url = 'https://example.test';
            },
            (r: typeof f.request) => {
                Object.assign(r.states[0].alarm!, { message: 'arbitrary message' });
            },
            (r: typeof f.request) => {
                Object.assign(r.states[0], { lat: 10 });
            },
            (r: typeof f.request) => {
                Object.assign(r.context.binding, { token: 'not-a-field' });
            },
            (r: typeof f.request) => {
                r.states[0].alarm!.sourceKey = 'nmea0183.raw';
            },
            (r: typeof f.request) => {
                Object.assign(r.states[1].alarm!, { unit: 'mph' });
            },
            (r: typeof f.request) => {
                r.states[1].alarm!.value = -1;
            },
            (r: typeof f.request) => {
                r.states[7].alarm!.threshold = 0;
            },
        ]
    ) {
        const request = structuredClone(f.request);
        mutate(request);
        equal(await parseWakeRelayRequest(request, identity, now), null);
    }
});
Deno.test('quiet policy is explicit, bounded and part of the exact saved context', async () => {
    const { request } = await fixture();
    request.context.rules[1].quietHours = { startMinute: 1380, endMinute: 360, utcOffsetMinutes: 600 };
    assert(await parseWakeRelayRequest(request, identity, now));
    for (
        const quiet of [
            undefined,
            {},
            { startMinute: 0, endMinute: 0, utcOffsetMinutes: 0 },
            { startMinute: 0.5, endMinute: 10, utcOffsetMinutes: 0 },
            { startMinute: 0, endMinute: 10, utcOffsetMinutes: 841 },
            { startMinute: 0, endMinute: 10, utcOffsetMinutes: 0, timezone: 'guessed' },
        ]
    ) {
        const candidate = structuredClone(request);
        Object.assign(candidate.context.rules[1], { quietHours: quiet });
        equal(await parseWakeRelayRequest(candidate, identity, now), null);
    }
});
Deno.test('physical source, digest, exact pairing/owner and stream instance cannot borrow another episode', async () => {
    const f = await fixture();
    for (
        const mutate of [
            (r: typeof f.request) => {
                r.context.rulesDigest = 'e'.repeat(64);
            },
            (r: typeof f.request) => {
                r.context.instance = '00000000-0000-4000-8000-000000000007';
            },
            (r: typeof f.request) => {
                r.states[0].alarm!.sourceKey = 'f'.repeat(64);
            },
            (r: typeof f.request) => {
                r.context.binding.ownerId = '00000000-0000-4000-8000-000000000099';
            },
            (r: typeof f.request) => {
                r.context.binding.pairingId = '0'.repeat(64);
            },
        ]
    ) {
        const request = structuredClone(f.request);
        mutate(request);
        equal(await parseWakeRelayRequest(request, identity, now), null);
    }
    equal(await parseWakeRelayRequest(f.request, { ...identity, relayId: 'other-fictional-relay' }, now), null);
});
Deno.test('stale/future/restamped source clocks refuse active alarms; unknown retains no fabricated value', async () => {
    const f = await fixture();
    for (
        const mutate of [
            (r: typeof f.request) => {
                r.evaluatedAt = now - 30001;
            },
            (r: typeof f.request) => {
                r.evaluatedAt = now + 1001;
            },
            (r: typeof f.request) => {
                r.states[1].alarm!.sourceAt = now - 13001;
            },
            (r: typeof f.request) => {
                r.states[1].alarm!.sourceAt = now + 1001;
            },
        ]
    ) {
        const request = structuredClone(f.request);
        mutate(request);
        equal(await parseWakeRelayRequest(request, identity, now), null);
    }
    const unknown = structuredClone(f.request);
    unknown.states[1].status = 'unknown';
    unknown.states[1].alarm!.value = null;
    assert(await parseWakeRelayRequest(unknown, identity, now));
    unknown.states[1].alarm!.value = 30;
    equal(await parseWakeRelayRequest(unknown, identity, now), null);
    unknown.states[1].alarm = null;
    assert(await parseWakeRelayRequest(unknown, identity, now));
});
Deno.test('sync must name every curated preset once; no empty sync can resolve an unobserved cohort', async () => {
    const f = await fixture();
    for (const states of [[], f.request.states.slice(1), [...f.request.states.slice(1), f.request.states[1]]]) {
        equal(await parseWakeRelayRequest({ ...f.request, states }, identity, now), null);
    }
    equal(await parseWakeRelayRequest({ family: 'wake', action: 'test' }, identity, now), null);
});
Deno.test('unavailable deployed halves never write or claim push readiness; CAS conflict never auto-rebinds', async () => {
    const f = await fixture();
    let writes = 0;
    const deps = {
        capability: () => Promise.resolve(false),
        apply: () => {
            writes++;
            return Promise.resolve({});
        },
        deliver: () => {
            throw new Error('unexpected push');
        },
    };
    let response = await handleWakeRelay({ family: 'wake', action: 'probe' }, identity, deps, now);
    equal((await response.json()).wake, { v: 1, enabled: false });
    response = await handleWakeRelay(f.request, identity, deps, now);
    equal(response.status, 503);
    equal(writes, 0);
    response = await handleWakeRelay(f.request, identity, {
        ...deps,
        capability: () => Promise.resolve(true),
        apply: () => Promise.resolve({ conflict: true }),
    }, now);
    equal(response.status, 409);
    equal(writes, 0);
});
Deno.test('handler returns only bounded acks/counts and hands exact committed queue IDs to existing delivery', async () => {
    const f = await fixture(), delivered: string[] = [];
    const queue = '00000000-0000-4000-8000-000000000008';
    const response = await handleWakeRelay(f.request, identity, {
        capability: () => Promise.resolve(true),
        apply: () =>
            Promise.resolve({
                contextRevision: f.request.contextRevision,
                queued: [queue],
                acked: [f.request.states[0].alarm!.key],
            }),
        deliver: (id) => {
            delivered.push(id);
        },
    }, now);
    equal(response.status, 200);
    const result = await response.json();
    equal(result.queued, 1);
    equal(delivered, [queue]);
    assert(!JSON.stringify(result).includes(queue));
    equal(response.headers.get('cache-control'), 'no-store');
});
Deno.test('existing credential and bounded-body door run before new family; legacy storage is not accessed', async () => {
    const f = await fixture();
    let wakeCalls = 0, authCalls = 0;
    const fail = () => {
        throw new Error('legacy storage was accessed');
    };
    const store = {
        touchRelay: () => undefined,
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
    } satisfies PiAlarmStore;
    const deps = {
        store,
        authenticate: (credential: unknown) => {
            authCalls++;
            return Promise.resolve(credential ? identity : { status: 401 as const, error: 'refused' });
        },
        now: () => now,
        wake: () => {
            wakeCalls++;
            return Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
        },
    };
    const make = (body: unknown, token = true) =>
        new Request('https://example.test/pi-alarm-relay', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token
                    ? { 'X-Thalassa-Pi-Relay-Id': identity.relayId, 'X-Thalassa-Pi-Relay-Token': 'a'.repeat(64) }
                    : {}),
            },
            body: JSON.stringify(body),
        });
    equal((await handlePiAlarmRelay(make(f.request, false), deps)).status, 401);
    equal(wakeCalls, 0);
    equal((await handlePiAlarmRelay(make(f.request), deps)).status, 200);
    equal(wakeCalls, 1);
    equal(authCalls, 2);
    equal((await handlePiAlarmRelay(make({ family: 'wake', padding: 'x'.repeat(9000) }), deps)).status, 413);
    equal(wakeCalls, 1);
    equal(authCalls, 2);
});
Deno.test('capability requires exact schema and wake delivery support, fixed HTTPS POST, no redirect or oversized reply', async () => {
    let calls = 0;
    const fetcher: typeof fetch = (_input, init) => {
        calls++;
        equal(init?.redirect, 'error');
        equal(init?.method, 'POST');
        equal(init?.body, JSON.stringify({ action: 'capabilities' }));
        return Promise.resolve(Response.json({ wake_alarm: 1 }));
    };
    equal(
        await wakeCapabilityReady(
            () => Promise.resolve(1),
            'https://example.supabase.co',
            'fictional-service-only',
            fetcher,
        ),
        true,
    );
    equal(
        await wakeCapabilityReady(
            () => Promise.resolve(0),
            'https://example.supabase.co',
            'fictional-service-only',
            fetcher,
        ),
        false,
    );
    equal(calls, 1);
    equal(
        await wakeCapabilityReady(() => Promise.resolve(1), 'http://example.test', 'fictional-service-only', fetcher),
        false,
    );
    equal(
        await wakeCapabilityReady(
            () => Promise.resolve(1),
            'https://example.supabase.co',
            'fictional-service-only',
            () => Promise.resolve(Response.json({ underway_alarm: 1 })),
        ),
        false,
    );
    equal(
        await wakeCapabilityReady(
            () => Promise.resolve(1),
            'https://example.supabase.co',
            'fictional-service-only',
            () =>
                Promise.resolve(
                    new Response(' '.repeat(1100) + '{"wake_alarm":1}', {
                        headers: { 'Content-Type': 'application/json' },
                    }),
                ),
        ),
        false,
    );
});

import { createRadarDeliveryGuard } from './radar-delivery.ts';
import {
    buildAps,
    getAlertSound,
    getApnsExpiration,
    getCollapseId,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
    PI_ALARM_SOUND,
} from './config.ts';
const equal = (a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`Expected ${JSON.stringify(b)}; got ${JSON.stringify(a)}`);
    }
};
const now = Date.parse('2026-10-17T00:00:00Z'), id = '00000000-0000-4000-8000-000000000001';
const data = {
    kind: 'radar-collision',
    alarm_key: `radar-collision:aaaaaaaaaaaa:${now}`,
    contact_key: 'radar:pi:' + 'b'.repeat(32) + ':RA:1',
    episode_id: 'c'.repeat(32) + ':1',
    source_at: now,
};
Deno.test('radar original source age is checked independently of a newly created queue row', () => {
    const created = new Date(now).toISOString();
    equal(isStaleForDelivery('radar_alarm', created, now, data), false);
    equal(isStaleForDelivery('radar_alarm', created, now, { ...data, source_at: now - 15000 }), false);
    equal(isStaleForDelivery('radar_alarm', created, now, { ...data, source_at: now - 15001 }), true);
    equal(isStaleForDelivery('radar_alarm', created, now, { ...data, source_at: now + 1001 }), true);
    equal(isStaleForDelivery('radar_alarm', new Date(now - 15001).toISOString(), now, data), true);
    equal(isStaleForDelivery('radar_alarm', 'invalid', now, data), true);
    equal(isStaleForDelivery('radar_alarm', undefined, now, data), true);
});
Deno.test('unknown, mismatched severity or non-radar identities cannot borrow radar delivery settings', () => {
    for (
        const extra of [
            { source_at: undefined },
            { source_at: 'fresh' },
            { source_at: Infinity },
            { source_at: 0 },
            { kind: 'radar-close-quarters' },
            { alarm_key: 'collision:123456789' },
            { contact_key: 'ais:123456789' },
            { episode_id: 'arbitrary' },
            { episode_id: undefined },
        ]
    ) equal(isStaleForDelivery('radar_alarm', new Date(now).toISOString(), now, { ...data, ...extra }), true);
});
Deno.test('radar has a separate bounded collapse/thread and preserves AIS and anchor grouping', () => {
    equal(getThreadId('radar_alarm'), 'thalassa-radar');
    equal(getCollapseId('radar_alarm', data), 'radar-' + data.contact_key);
    equal(getCollapseId('radar_alarm', { ...data, contact_key: 'ais:123456789' }), null);
    const collapse = getCollapseId('radar_alarm', { ...data, contact_key: 'radar:pi:' + 'b'.repeat(32) + ':ZZ:999' });
    equal(new TextEncoder().encode(collapse!).length < 64, true);
    equal(getThreadId('collision_alarm'), 'thalassa-collision');
    equal(getCollapseId('collision_alarm', { mmsi: 123456789 }), 'collision-123456789');
    equal(getCollapseId('anchor_alarm', {}), 'anchor-alarm');
});
Deno.test('radar uses the existing collision sound and entitlement gate; APNs cannot store a stale echo', () => {
    equal(isCriticalType('radar_alarm'), true);
    equal(getAlertSound('radar_alarm'), PI_ALARM_SOUND);
    equal(getApnsExpiration('radar_alarm', false, now, data), '0');
    equal(getApnsExpiration('radar_alarm', true, now, data), '0');
    const input = {
        title: 'Radar collision risk',
        body: 'Fixed numeric facts',
        type: 'radar_alarm',
        threadId: getThreadId('radar_alarm'),
        isCritical: true,
    };
    const ordinary = buildAps(input, false);
    equal(ordinary['interruption-level'], 'time-sensitive');
    equal(ordinary.sound, PI_ALARM_SOUND);
    const entitled = buildAps(input, true);
    equal(entitled['interruption-level'], 'critical');
    equal(entitled.sound, { critical: 1, name: PI_ALARM_SOUND, volume: 1 });
});
Deno.test('every retry rereads the current radar context; a prior green is never cached', async () => {
    const states: unknown[] = [true, false, null, true, 'true'];
    let reads = 0;
    const guard = createRadarDeliveryGuard(id, (got) => {
        equal(got, id);
        return Promise.resolve(states[reads++]);
    });
    equal(await guard(), 'allow');
    equal(await guard(), 'retire');
    equal(await guard(), 'unavailable');
    equal(await guard(), 'allow');
    equal(await guard(), 'unavailable');
    equal(reads, 5);
    equal(await createRadarDeliveryGuard(id, () => Promise.reject(new Error('fixture')))(), 'unavailable');
    equal(
        await createRadarDeliveryGuard('not-a-queue', () => {
            throw new Error('must not read');
        })(),
        'retire',
    );
});

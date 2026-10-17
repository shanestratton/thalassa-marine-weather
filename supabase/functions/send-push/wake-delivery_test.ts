import { createWakeDeliveryGuard } from './wake-delivery.ts';
import {
    buildAps,
    getApnsExpiration,
    getCollapseId,
    getInterruptionLevel,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
    PI_ALARM_SOUND,
} from './config.ts';
const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
    }
};
const now = Date.parse('2026-10-17T00:00:00Z'), id = '00000000-0000-4000-8000-000000000001';
Deno.test('wake delivery guard distinguishes definitive retirement from unavailable storage and never caches green across attempts', async () => {
    const answers: unknown[] = [true, false, null, 'true', true];
    let reads = 0;
    const guard = createWakeDeliveryGuard(id, (got) => {
        equal(got, id);
        return Promise.resolve(answers[reads++]);
    });
    equal(await guard(), 'allow');
    equal(await guard(), 'retire');
    equal(await guard(), 'unavailable');
    equal(await guard(), 'unavailable');
    equal(await guard(), 'allow');
    equal(reads, 5);
    equal(await createWakeDeliveryGuard(id, () => Promise.reject(new Error('synthetic')))(), 'unavailable');
    equal(
        await createWakeDeliveryGuard('not-a-queue-id', () => Promise.reject(new Error('must not read')))(),
        'retire',
    );
});
Deno.test('wake remains Time Sensitive only, with its own thread/collapse and zero APNs store duration', () => {
    const data = { kind: 'wake-depth', alarm_key: `wake-depth:aaaaaaaaaaaa:${now}`, source_at: now };
    equal(isCriticalType('wake_alarm'), false);
    equal(getInterruptionLevel('wake_alarm', data), 'time-sensitive');
    equal(getThreadId('wake_alarm'), 'thalassa-wake-rules');
    equal(getCollapseId('wake_alarm', data), 'wake-depth');
    equal(getCollapseId('wake_alarm', { ...data, kind: 'collision' }), null);
    equal(getApnsExpiration('wake_alarm', false, now, data), '0');
    const aps = buildAps({
        title: 'Wake rule',
        body: 'Fictional bounded facts',
        type: 'wake_alarm',
        threadId: getThreadId('wake_alarm'),
        isCritical: false,
        level: getInterruptionLevel('wake_alarm', data),
    }, true);
    equal(aps.sound, PI_ALARM_SOUND);
    equal(aps['interruption-level'], 'time-sensitive');
    equal(getThreadId('anchor_alarm'), 'thalassa-anchor');
    equal(getCollapseId('anchor_alarm', {}), 'anchor-alarm');
});
Deno.test('queue time never restamps an old measurement; missing/future/unknown data refuses wake delivery', () => {
    const data = { kind: 'wake-wind', source_at: now };
    equal(isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, data), false);
    equal(
        isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, { ...data, source_at: now - 13001 }),
        true,
    );
    equal(isStaleForDelivery('wake_alarm', new Date(now - 30001).toISOString(), now, data), true);
    equal(isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, { ...data, source_at: now + 1001 }), true);
    equal(
        isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, {
            kind: 'wake-pressure',
            source_at: now - 120001,
        }),
        true,
    );
    equal(
        isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, {
            kind: 'wake-battery',
            source_at: now - 180001,
        }),
        true,
    );
    equal(isStaleForDelivery('wake_alarm', new Date(now).toISOString(), now, {}), true);
});

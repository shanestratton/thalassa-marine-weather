import { createOverdueDeliveryGuards } from './overdue-delivery.ts';
import {
    buildAps,
    getApnsExpiration,
    getCollapseId,
    getInterruptionLevel,
    getThreadId,
    isStaleForDelivery,
} from './config.ts';
const id = '10000000-0000-4000-8000-000000000001';
const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Overdue delivery policy assertion failed');
};
Deno.test('overdue owner policy stays ordinary even with caller priority and critical entitlement', () => {
    const aps = buildAps({
        title: 'Fixture',
        body: 'Fixture',
        type: 'overdue_notice',
        isCritical: true,
        threadId: getThreadId('overdue_notice'),
        level: 'time-sensitive',
    }, true);
    equal(aps['interruption-level'], 'active');
    equal(aps.sound, 'default');
    equal(aps['thread-id'], 'thalassa-overdue');
    equal(getInterruptionLevel('overdue_notice', {}), 'active');
});
Deno.test('overdue owner queue and APNs share the original absolute expiry without a renewed grace window', () => {
    const now = Date.now(),
        data = { overdue_watch: 1, boatId: id, revision: id, overdueAt: now - 60_000, expiresAt: now + 60_000 };
    equal(getCollapseId('overdue_notice', data), `overdue:${id}`);
    equal(getApnsExpiration('overdue_notice', true, now, data), String(Math.floor(data.expiresAt / 1000)));
    equal(isStaleForDelivery('overdue_notice', new Date(now).toISOString(), now, data), false);
    equal(isStaleForDelivery('overdue_notice', new Date(now).toISOString(), data.expiresAt, data), true);
    equal(isStaleForDelivery('overdue_notice', new Date(now + 1).toISOString(), now, data), true);
    equal(getApnsExpiration('overdue_notice', false, now, { ...data, expiresAt: now + 600_001 }), '0');
});
Deno.test('overdue read preflight never initiates an attempt and malformed facts reach neither RPC', async () => {
    const now = Date.now(),
        data = { overdue_watch: 1, boatId: id, revision: id, overdueAt: now - 60_000, expiresAt: now + 60_000 };
    let reads = 0, attempts = 0;
    const read = () => {
        reads++;
        return Promise.resolve(true);
    };
    const attempt = () => {
        attempts++;
        return Promise.resolve(true);
    };
    const guard = createOverdueDeliveryGuards(id, data, read, attempt, () => now);
    equal(await guard.current(), 'allow');
    equal([reads, attempts], [1, 0]);
    const invalid = createOverdueDeliveryGuards(
        id,
        { ...data, arbitraryDestination: 'fixture' },
        read,
        attempt,
        () => now,
    );
    equal(await invalid.current(), 'retire');
    equal(await invalid.beforeHttp(), 'retire');
    equal([reads, attempts], [1, 0]);
});

import { createBuddyDeliveryGuard } from './buddy-delivery.ts';
import {
    buildAps,
    getApnsExpiration,
    getCollapseId,
    getInterruptionLevel,
    getThreadId,
    isStaleForDelivery,
} from './config.ts';

const equal = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Buddy delivery assertion failed');
};
const id = '10000000-0000-4000-8000-000000000001';
const now = Date.UTC(2026, 9, 16, 18);
const facts = { buddy_watch: 1, watch_id: id, revision: id, receipt_id: id, event: 'entered', observed_at: now - 1000 };

Deno.test('buddy consent, owner, source and entitlement are read anew on each delivery attempt', async () => {
    let permission: unknown = true, reads = 0;
    const guard = createBuddyDeliveryGuard(id, facts, () => {
        reads++;
        return Promise.resolve(permission);
    }, () => now);
    equal(await guard(), 'allow');
    permission = false;
    equal(await guard(), 'retire');
    permission = null;
    equal(await guard(), 'unavailable');
    permission = 'true';
    equal(await guard(), 'unavailable');
    equal(reads, 4);
    equal(
        await createBuddyDeliveryGuard(id, facts, () => Promise.reject(new Error('offline')), () => now)(),
        'unavailable',
    );
});

Deno.test('malformed buddy facts cannot reach the delivery database', async () => {
    let reads = 0;
    for (
        const data of [
            {},
            { ...facts, event: 'lost-vessel' },
            { ...facts, observed_at: now + 1 },
            { ...facts, observed_at: String(now) },
            { ...facts, receipt_id: 'other' },
            { ...facts, url: 'https://synthetic.invalid' },
        ]
    ) {
        equal(
            await createBuddyDeliveryGuard(id, data, () => {
                reads++;
                return Promise.resolve(true);
            }, () => now)(),
            'retire',
        );
    }
    equal(
        await createBuddyDeliveryGuard('bad-id', facts, () => {
            reads++;
            return Promise.resolve(true);
        }, () => now)(),
        'retire',
    );
    equal(reads, 0);
});

Deno.test('buddy notices stay passive and silent even with a critical entitlement', () => {
    const aps = buildAps({
        title: 'Buddy boat update',
        body: 'Synthetic notice',
        type: 'buddy_notice',
        isCritical: true,
        threadId: getThreadId('buddy_notice'),
        level: getInterruptionLevel('buddy_notice', facts),
    }, true);
    equal(aps['interruption-level'], 'passive');
    equal(Object.hasOwn(aps, 'sound'), false);
    equal(aps['thread-id'], 'thalassa-buddy');
    equal(getCollapseId('buddy_notice', facts), `buddy-${id}`);
    equal(getApnsExpiration('buddy_notice', false, now, facts), '0');
});

Deno.test('late or invalid buddy queue clocks retire, with no renewed APNs storage window', () => {
    equal(isStaleForDelivery('buddy_notice', new Date(now - 29 * 60_000).toISOString(), now, facts), false);
    equal(isStaleForDelivery('buddy_notice', new Date(now - 30 * 60_000).toISOString(), now, facts), true);
    for (const clock of [null, 'invalid', new Date(now + 1).toISOString()]) {
        equal(isStaleForDelivery('buddy_notice', clock, now, facts), true);
    }
});

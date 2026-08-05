import { describe, expect, it } from 'vitest';

import {
    boundedLocalQuarantine,
    LOCAL_QUARANTINE_MAX_BYTES,
    LOCAL_QUARANTINE_MAX_ENTRIES,
    LOCAL_QUARANTINE_TTL_MS,
    removeLocalValuesOwnedBy,
} from '../utils/localPrivacyRetention';

describe('local privacy retention', () => {
    it('bounds non-replayable quarantine by age, count and bytes', () => {
        const now = Date.UTC(2026, 7, 5);
        const old = {
            quarantined_at: new Date(now - LOCAL_QUARANTINE_TTL_MS - 1).toISOString(),
            value: 'retire-me',
        };
        const recent = Array.from({ length: LOCAL_QUARANTINE_MAX_ENTRIES + 20 }, (_, index) => ({
            quarantinedAt: now - index,
            value: `entry-${index}`,
        }));

        const retained = boundedLocalQuarantine([old, ...recent], [], now);

        expect(retained).toHaveLength(LOCAL_QUARANTINE_MAX_ENTRIES);
        expect(JSON.stringify(retained)).not.toContain('retire-me');
        expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(
            LOCAL_QUARANTINE_MAX_BYTES,
        );
    });

    it('omits an oversize payload while retaining bounded diagnostic metadata', () => {
        const now = Date.UTC(2026, 7, 5);
        const retained = boundedLocalQuarantine(
            [],
            [
                {
                    quarantined_at: new Date(now).toISOString(),
                    reason: 'owner mismatch',
                    owner_user_id: 'account-a',
                    value: 'x'.repeat(LOCAL_QUARANTINE_MAX_BYTES * 2),
                },
            ],
            now,
        );

        expect(retained).toEqual([
            expect.objectContaining({
                owner_user_id: 'account-a',
                payload_omitted: true,
                reason: 'owner mismatch',
            }),
        ]);
        expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(
            LOCAL_QUARANTINE_MAX_BYTES,
        );
    });

    it('removes only unanimous exact-owner nodes from mixed legacy data', () => {
        const accountA = { owner_user_id: 'account-a', secret: 'a' };
        const accountB = { owner_user_id: 'account-b', secret: 'b' };
        const conflicting = { owner_user_id: 'account-a', user_id: 'account-b', secret: 'keep-conflict' };
        const nestedConflict = {
            scoped_key: 'settings::user%3Aaccount-a',
            value: { owner_user_id: 'account-b', secret: 'keep-nested-conflict' },
        };
        const scopedA = { scoped_key: 'queue::user%3Aaccount-a', secret: 'scoped-a' };
        const unowned = { secret: 'unknown' };

        const result = removeLocalValuesOwnedBy(
            { values: [accountA, accountB, conflicting, nestedConflict, scopedA, unowned] },
            'account-a',
        );

        expect(result.changed).toBe(true);
        expect(result.removed).toEqual([accountA, scopedA]);
        expect(result.value).toEqual({ values: [accountB, conflicting, nestedConflict, unowned] });
    });
});

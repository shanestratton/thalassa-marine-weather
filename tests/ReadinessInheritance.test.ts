/**
 * A new voyage inherits the skipper's most recent readiness ticks when they
 * are under a week old (Shane 2026-08-26: "when you have ticked all of your
 * boxes green, they should stay like that for at least one week"). Every
 * re-planned trip mints a new voyage id; the boat's fuel, medical kit and
 * comms plan do not reset because a row id did.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ReadinessCheckService } from '../services/ReadinessCheckService';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const cacheKey = (voyageId: string) => authScopedStorageKey(`thalassa_readiness_${voyageId}`, undefined as never);

const seed = (voyageId: string, checkedAtIso: string) => {
    localStorage.setItem(
        cacheKey(voyageId),
        JSON.stringify({
            vessel_check: {
                engine: { checked: true, checked_at: checkedAtIso, checked_by_name: 'Shane' },
                hull: { checked: true, checked_at: checkedAtIso, checked_by_name: 'Shane' },
            },
            essential_reserves: {
                fuel: { checked: true, checked_at: checkedAtIso, checked_by_name: 'Shane' },
            },
        }),
    );
};

describe('readiness inheritance', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope('skipper-a');
    });
    afterEach(() => {
        setAuthIdentityScope(null);
        localStorage.clear();
    });

    it('a brand-new voyage adopts ticks made in the last week', async () => {
        seed('voyage-old', new Date(Date.now() - 2 * 24 * 3_600_000).toISOString());
        const checks = await ReadinessCheckService.loadChecks('voyage-new');
        expect(checks.vessel_check?.engine?.checked).toBe(true);
        expect(checks.essential_reserves?.fuel?.checked).toBe(true);
        // Adoption sticks: the new voyage now has its own cache.
        expect(localStorage.getItem(cacheKey('voyage-new'))).toContain('engine');
    });

    it('ticks older than a week stay grey — a month-old checklist is not readiness', async () => {
        seed('voyage-ancient', new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
        const checks = await ReadinessCheckService.loadChecks('voyage-new');
        expect(Object.keys(checks)).toHaveLength(0);
    });

    it('never overwrites a voyage that already has its own state', async () => {
        seed('voyage-old', new Date().toISOString());
        localStorage.setItem(
            cacheKey('voyage-new'),
            JSON.stringify({ vessel_check: { engine: { checked: false, checked_at: null, checked_by_name: null } } }),
        );
        const checks = await ReadinessCheckService.loadChecks('voyage-new');
        expect(checks.vessel_check?.engine?.checked).toBe(false);
        expect(checks.essential_reserves).toBeUndefined();
    });

    it('adopts the NEWEST sibling when several qualify', async () => {
        seed('voyage-tuesday', new Date(Date.now() - 3 * 24 * 3_600_000).toISOString());
        localStorage.setItem(
            cacheKey('voyage-yesterday'),
            JSON.stringify({
                vessel_check: {
                    engine: {
                        checked: true,
                        checked_at: new Date(Date.now() - 1 * 24 * 3_600_000).toISOString(),
                        checked_by_name: 'Newer',
                    },
                },
            }),
        );
        const checks = await ReadinessCheckService.loadChecks('voyage-new');
        expect(checks.vessel_check?.engine?.checked_by_name).toBe('Newer');
    });
});

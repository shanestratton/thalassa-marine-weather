/**
 * The Cast Off zombie trap — Shane 2026-08-26.
 *
 * A voyage row cast off 26 Jul sat 'active' for a month: its GPS start had
 * failed, the local tracker aged out (6h) and minted fresh local ids, and
 * from then on BOTH exits dead-ended on the id mismatch — stopTracking threw
 * ("A different voyage is currently using GPS logging") so End Voyage
 * refused to archive, and performStartTracking silently no-opped so Retry
 * GPS could never bind the row. Meanwhile the SQL cast_off_voyage guard
 * ("is already active. End it first.") blocked every future Cast Off.
 *
 * The fix: the mismatch becomes a typed, name-matchable error;
 * endVoyage treats it as "this voyage holds no GPS — archive anyway";
 * a targeted retry against a busy tracker throws honestly instead of
 * pretending success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const harness = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    startLeg: vi.fn(),
    closeLeg: vi.fn(),
    getActiveLeg: vi.fn(),
    deleteLegsForVoyage: vi.fn(),
    stopTracking: vi.fn(),
    stopFollowing: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: harness.getUser },
        from: harness.from,
        rpc: harness.rpc,
    },
}));

vi.mock('../services/VoyageLegService', () => ({
    startLeg: harness.startLeg,
    closeLeg: harness.closeLeg,
    getActiveLeg: harness.getActiveLeg,
    deleteLegsForVoyage: harness.deleteLegsForVoyage,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { stopTracking: harness.stopTracking },
}));

import { endVoyage, type Voyage } from '../services/VoyageService';

const OWNER = 'owner-1';
const VOYAGE_ID = 'voyage-july-zombie';

function activeRow(status = 'completed'): Voyage {
    return {
        id: VOYAGE_ID,
        user_id: OWNER,
        vessel_id: null,
        boat_id: null,
        saved_route_id: null,
        voyage_name: 'Newport - (2nd Leg) — start → Newport - (2nd Leg) — end',
        departure_port: 'Newport - (2nd Leg) — start',
        destination_port: 'Newport - (2nd Leg) — end',
        crew_count: 1,
        status,
        departure_time: '2026-07-26T01:14:00Z',
        eta: null,
        weather_master_id: null,
        notes: null,
        created_at: '2026-07-26T01:14:00Z',
        updated_at: '2026-07-26T01:14:00Z',
    } as unknown as Voyage;
}

function mockUpdateChain(result: Voyage | null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: result, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const eq3 = vi.fn(() => ({ select }));
    const eq2 = vi.fn(() => ({ eq: eq3 }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const update = vi.fn(() => ({ eq: eq1 }));
    harness.from.mockReturnValue({ update });
    return { update };
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope(OWNER);
    harness.getUser.mockResolvedValue({ data: { user: { id: OWNER } }, error: null });
    harness.getActiveLeg.mockReturnValue(null);
});

describe('endVoyage vs the tracker-id mismatch', () => {
    it('archives a voyage that holds no GPS — the typed mismatch is not a blocker', async () => {
        const mismatch = new Error('A different voyage is currently using GPS logging for this device.');
        mismatch.name = 'DifferentVoyageTrackingError';
        harness.stopTracking.mockRejectedValue(mismatch);
        mockUpdateChain(activeRow('completed'));

        await expect(endVoyage(VOYAGE_ID, 'completed')).resolves.toBe(true);
    });

    it('still refuses when teardown of THIS voyage genuinely failed', async () => {
        harness.stopTracking.mockRejectedValue(new Error('Background GPS is still active'));
        const { update } = mockUpdateChain(activeRow('completed'));

        await expect(endVoyage(VOYAGE_ID, 'completed')).resolves.toBe(false);
        expect(update).not.toHaveBeenCalled();
    });
});

describe('trap wiring (source tripwires)', () => {
    const shipLog = readFileSync(resolve(process.cwd(), 'services/ShipLogService.ts'), 'utf8');
    const voyageSvc = readFileSync(resolve(process.cwd(), 'services/VoyageService.ts'), 'utf8');
    const panel = readFileSync(resolve(process.cwd(), 'components/vessel/CastOffPanel.tsx'), 'utf8');
    const floatPlan = readFileSync(resolve(process.cwd(), 'components/vessel/FloatPlanSheet.tsx'), 'utf8');

    it('the mismatch error is a named, exported class and both stop throws use it', () => {
        expect(shipLog).toContain('export class DifferentVoyageTrackingError');
        const stopAt = shipLog.indexOf('async stopTracking(');
        const tail = shipLog.slice(stopAt);
        expect(tail).toContain('throw new DifferentVoyageTrackingError');
        expect(tail).not.toContain("throw new Error('A different voyage is currently using GPS logging");
    });

    it('a targeted retry against a busy tracker throws instead of silently no-opping', () => {
        const startAt = shipLog.indexOf('private async performStartTracking(');
        const guard = shipLog.slice(startAt, startAt + 2500);
        expect(guard).toContain('requestedVoyageId');
        expect(guard).toContain('throw new DifferentVoyageTrackingError');
        // The bare unconditional no-op is gone.
        expect(guard).not.toContain('if (stateBeforeStart.isTracking) return;');
    });

    it('endVoyage matches the mismatch by name, not instanceof, across mock boundaries', () => {
        expect(voyageSvc).toContain("error.name === 'DifferentVoyageTrackingError'");
    });

    it('the active card persists ports and crew through the active-capable writer', () => {
        expect(voyageSvc).toContain('export async function updateActiveVoyageDetails(');
        expect(voyageSvc).toContain(".in('status', ['planning', 'active'])");
        expect(panel).toContain('updateActiveVoyageDetails(activeVoyage.id, {');
        expect(panel).toContain('persistCrew');
    });

    it('both surfaces collapse legacy start/end artefacts at display time', () => {
        expect(panel).toContain('formatStoredPlannedRouteName(activeVoyage.voyage_name)');
        expect(panel).toContain('collapseGeneratedTraceEndpointPair(');
        expect(floatPlan).toContain('collapseGeneratedTraceEndpointPair(voyage?.departure_port');
        expect(floatPlan).toContain('formatStoredPlannedRouteName(voyage?.voyage_name)');
    });

    it('a stale active passage says its age out loud on the warning card', () => {
        expect(panel).toContain('This passage departed');
        expect(panel).toContain('48 * 3_600_000');
    });
});

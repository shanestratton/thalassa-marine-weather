import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ fleet: vi.fn(), rpc: vi.fn(), single: vi.fn() }));
vi.mock('../services/VesselFleetService', () => ({ loadOwnedVesselFleet: harness.fleet }));
vi.mock('../services/supabase', () => {
    const query = {
        select: () => query,
        eq: () => query,
        abortSignal: () => query,
        maybeSingle: () => harness.single(),
    };
    return {
        supabase: {
            from: () => query,
            rpc: (name: string, args: unknown) => ({
                abortSignal: (signal: AbortSignal) => harness.rpc(name, args, signal),
            }),
        },
    };
});
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    crowdRevokePending,
    readCrowdPermission,
    revokeCrowdPermission,
    saveCrowdPermission,
    flushCrowdRevoke,
} from '../services/seabed/crowdConsent';
import { CROWD_CONSENT_VERSION, type CrowdCalibration } from '../services/seabed/crowdPolicy';
const owner = '11111111-1111-4111-8111-111111111111';
let boat = '',
    counter = 0;
const now = Date.UTC(2026, 9, 17, 10);
const calibration: CrowdCalibration = {
    schema: 1,
    depthReference: 'T',
    depthSource: 'fixture:depth',
    sounderProduct: 'Fictional fixture',
    measuredAt: now - 1000,
    waterlineToTransducerM: 0.8,
    offsetUncertaintyM: 0.1,
    sounderUncertaintyM: 0.2,
    checkedDepthLimitM: 30,
    method: 'measured-offset-and-sounder-check',
};
const revision = '33333333-3333-4333-8333-333333333333';
function row(on = false, dcdb = false) {
    return {
        owner_id: owner,
        boat_id: boat,
        revision,
        consent_version: CROWD_CONSENT_VERSION,
        map_enabled: on,
        dcdb_enabled: dcdb,
        map_effective_from: on ? new Date(now).toISOString() : null,
        dcdb_effective_from: dcdb ? new Date(now).toISOString() : null,
        calibration: on || dcdb ? calibration : null,
    };
}
beforeEach(() => {
    boat = '22222222-2222-4222-8222-' + String(++counter).padStart(12, '0');
    localStorage.clear();
    setAuthIdentityScope(owner);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    harness.fleet.mockReset().mockResolvedValue({
        vessels: [
            {
                id: boat,
                owner_id: owner,
                profile: { name: 'Fictional owned boat' },
                archived_at: null,
                releasedAt: null,
            },
        ],
        activeBoatId: boat,
    });
    harness.single.mockReset().mockResolvedValue({ data: null, error: null });
    harness.rpc.mockReset().mockImplementation(async (_name, args) => ({
        data: row(args.p_map_enabled, args.p_dcdb_enabled),
        error: null,
    }));
});
afterEach(() => vi.restoreAllMocks());
describe('separate sounding owner consent', () => {
    it('has no import/startup work and reads current actual ownership before accepting a missing OFF row', async () => {
        expect(harness.fleet).not.toHaveBeenCalled();
        expect(harness.rpc).not.toHaveBeenCalled();
        const value = await readCrowdPermission(boat);
        expect(value.permission).toBeNull();
        expect(value.boatName).toBe('Fictional owned boat');
        expect(value.pendingRevoke).toBe(false);
        expect(harness.fleet).toHaveBeenCalledOnce();
        expect(harness.single).toHaveBeenCalledOnce();
    });
    it('rejects cached/crew/archived/other-owner selection and never sends an enabling write', async () => {
        harness.fleet.mockResolvedValue({ vessels: [], activeBoatId: boat });
        await expect(
            saveCrowdPermission({
                boatId: boat,
                expectedRevision: null,
                mapEnabled: true,
                dcdbEnabled: false,
                calibration,
            }),
        ).rejects.toThrow();
        expect(harness.rpc).not.toHaveBeenCalled();
    });
    it('uses explicit new map/DCDB choices and the current revision without changing capture settings', async () => {
        const value = await saveCrowdPermission({
            boatId: boat,
            expectedRevision: revision,
            mapEnabled: true,
            dcdbEnabled: false,
            calibration,
        });
        expect(value.mapEnabled).toBe(true);
        expect(value.dcdbEnabled).toBe(false);
        expect(harness.rpc).toHaveBeenCalledWith(
            'set_seabed_publication',
            expect.objectContaining({
                p_boat_id: boat,
                p_expected_revision: revision,
                p_terms_version: CROWD_CONSENT_VERSION,
                p_map_enabled: true,
                p_dcdb_enabled: false,
                p_calibration: calibration,
            }),
            expect.any(AbortSignal),
        );
        expect(harness.rpc.mock.calls.every(([name]) => name === 'set_seabed_publication')).toBe(true);
    });
    it('retains an offline OFF intent only in this owner/boat namespace and flushes it before any fresh ON', async () => {
        harness.rpc.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
        expect(await revokeCrowdPermission(boat)).toBe('pending');
        expect(crowdRevokePending(boat)).toBe(true);
        setAuthIdentityScope('99999999-9999-4999-8999-999999999999');
        expect(crowdRevokePending(boat)).toBe(false);
        setAuthIdentityScope(owner);
        expect(crowdRevokePending(boat)).toBe(true);
        await saveCrowdPermission({
            boatId: boat,
            expectedRevision: null,
            mapEnabled: true,
            dcdbEnabled: false,
            calibration,
        });
        expect(harness.rpc.mock.calls.map(([, args]) => args.p_map_enabled)).toEqual([false, false, true]);
        expect(harness.rpc.mock.calls[2][1].p_expected_revision).toBe(revision);
        expect(crowdRevokePending(boat)).toBe(false);
    });
    it('never treats a malformed stored OFF marker as absent or enables while its delivery fails', async () => {
        localStorage.setItem('seabed_public_revoke_v1:' + boat + '::' + encodeURIComponent('user:' + owner), 'null');
        harness.rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
        await expect(
            saveCrowdPermission({
                boatId: boat,
                expectedRevision: null,
                mapEnabled: true,
                dcdbEnabled: false,
                calibration,
            }),
        ).rejects.toThrow(/pending OFF/);
        expect(harness.rpc.mock.calls.every(([, args]) => args.p_map_enabled === false)).toBe(true);
    });
    it('an account A/B/A transition aborts and rejects a late owner read rather than restoring old ON', async () => {
        let release!: (v: unknown) => void;
        harness.single.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const reading = readCrowdPermission(boat);
        const held = expect(reading).rejects.toThrow();
        await vi.waitFor(() => expect(harness.single).toHaveBeenCalledOnce());
        setAuthIdentityScope('99999999-9999-4999-8999-999999999999');
        setAuthIdentityScope(owner);
        release({ data: row(true), error: null });
        await held;
        expect(harness.rpc).not.toHaveBeenCalled();
    });
    it('OFF delivery can be confirmed even when a retained inactive calibration has expired', async () => {
        harness.rpc.mockResolvedValue({
            data: { ...row(), calibration: { ...calibration, measuredAt: Date.UTC(2020, 0, 1) } },
            error: null,
        });
        expect(await revokeCrowdPermission(boat)).toBe('saved');
        expect(crowdRevokePending(boat)).toBe(false);
        expect(await flushCrowdRevoke(boat)).toBe(true);
        expect(harness.rpc).toHaveBeenCalledOnce();
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    handoff: vi.fn(),
    authorise: vi.fn(),
    send: vi.fn(),
    clear: vi.fn(),
    vessel: 'boat-a',
    vesselEpoch: 1,
    pair: { deviceId: 'pi-a', publicKeySpki: 'key-a', fingerprint: 'finger-a', pairedAt: '2026-10-01' },
}));
vi.mock('../services/anchorPiHandoff', () => ({
    handOffToPi: h.handoff,
    authoriseRelay: h.authorise,
    sendAssignmentToPi: h.send,
    clearWatchOnPi: h.clear,
    RENEW_INTERVAL_MS: 3_600_000,
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => h.pair, pinnedPiRequest: vi.fn() }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => ({ reachable: true, diaryRelayId: 'relay-a', lastCheck: Date.now() }),
        getBaseUrl: () => 'https://boat.invalid',
        getRemoteBaseUrl: () => null,
        ping: vi.fn(),
    },
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ activeVesselId: h.vessel }) } }));
vi.mock('../services/anchorSafeZoneContext', async () => {
    const { getAuthIdentityScope } = await import('../services/authIdentityScope');
    return { anchorSafeZoneContextKey: () => JSON.stringify([getAuthIdentityScope(), h.vessel, h.vesselEpoch]) };
});
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        onBroadcast: () => () => {},
        getState: () => ({ sessionCode: 'ABC123DEF456' }),
        getLatestPosition: () => null,
    },
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: () => {} }) } }));
import { AnchorPiWatchKeeper as keeper } from '../services/anchorPiWatchKeeper';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { anchorZonePosition } from '../utils/anchorSafeZone';
import type { PiWatchAssignment } from '../services/anchorPiHandoff';
import type { SyncBroadcast } from '../services/AnchorWatchSyncService';
const NOW = Date.parse('2026-10-17T03:00:00Z');
const anchor = { latitude: -27, longitude: 179.99999 };
const assignment: PiWatchAssignment = {
    sessionCode: 'ABC123DEF456',
    anchorLat: anchor.latitude,
    anchorLon: anchor.longitude,
    swingRadius: 60,
    rodeLength: 50,
    waterDepth: 8,
    safeZone: {
        version: 1,
        kind: 'polygon',
        anchor,
        vertices: [
            [-20, -20],
            [20, -20],
            [20, 20],
            [-20, 20],
        ].map(([x, y]) => anchorZonePosition(anchor, x, y)!),
    },
};
const live = () => ({ boatFix: { ...anchor, timestamp: Date.now() - 1_000 }, alarm: false, gpsLost: false });
const key = () => authScopedStorageKey('thalassa_pi_watch_assignment');
type Internal = {
    stopRenewing: () => void;
    disarmMoveWatch: () => void;
    current: null | { assignment: PiWatchAssignment; centreAtSet: typeof anchor };
    pending: unknown;
    queue: Promise<unknown>;
    hearReport: (data: SyncBroadcast, code: string) => void;
};
const internal = keeper as unknown as Internal;
const saved = () => JSON.parse(localStorage.getItem(key())!);
async function reset() {
    internal.stopRenewing();
    internal.disarmMoveWatch();
    internal.current = null;
    internal.pending = null;
    await internal.queue;
}
beforeEach(async () => {
    await reset();
    localStorage.clear();
    setAuthIdentityScope('owner-a');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    h.vessel = 'boat-a';
    h.vesselEpoch = 1;
    h.pair.pairedAt = '2026-10-01';
    h.handoff.mockReset().mockResolvedValue(true);
    h.authorise.mockReset().mockResolvedValue(true);
    h.send.mockReset().mockResolvedValue({ taken: true, status: 200 });
    h.clear.mockReset().mockResolvedValue(false);
});
afterEach(async () => {
    await reset();
    vi.useRealTimers();
});
describe('owner-bound Pi area keeper and explicit circle return', () => {
    it('saves the full pairing, owner and vessel with a fresh boundary UUID', async () => {
        expect(await keeper.begin(assignment)).toBe(true);
        expect(saved()).toMatchObject({
            safeAreaOwnerKey: getAuthIdentityScope().key,
            safeAreaVesselId: 'boat-a',
            safeAreaPairKey: JSON.stringify(['pi-a', 'key-a', 'finger-a', '2026-10-01']),
        });
        expect(saved().assignment.safeAreaRevision).toMatch(/^[0-9a-f-]{36}$/);
        expect(keeper.isKeeping()).toBe(true);
        expect(await keeper.begin(assignment)).toBe(true);
        expect(h.handoff).toHaveBeenCalledOnce();
        expect(await keeper.relocate(anchor.latitude, anchor.longitude, live())).toMatchObject({
            ok: false,
            outcome: 'invalid',
        });
        expect(h.send).not.toHaveBeenCalled();
    });
    it('requires fresh Pi GPS without an alarm before explicitly clearing its area', async () => {
        await keeper.begin(assignment);
        for (const patch of [{ alarm: true }, { gpsLost: true }, { boatFix: { ...anchor, timestamp: NOW - 31_000 } }])
            expect(await keeper.clearSafeArea({ ...live(), ...patch })).toMatchObject({ ok: false });
        expect(h.handoff).toHaveBeenCalledOnce();
        const old = saved().assignment.safeAreaRevision;
        const originalCentre = anchorZonePosition(anchor, 3, 0)!;
        internal.current!.centreAtSet = originalCentre;
        expect(await keeper.clearSafeArea(live())).toEqual({ ok: true });
        expect(saved().assignment).toMatchObject({
            safeZone: null,
            anchorLat: anchor.latitude,
            anchorLon: anchor.longitude,
            swingRadius: 60,
        });
        expect(saved().assignment.safeAreaRevision).not.toBe(old);
        expect(keeper.centreAtSet()).toEqual(originalCentre);
        expect(h.send).toHaveBeenCalledOnce();
    });
    it('does not revive the custom area after an unknown clear, and only an exact fresh report settles it', async () => {
        await keeper.begin(assignment);
        const old = saved().assignment;
        h.send.mockResolvedValueOnce({ taken: false, status: null, error: 'timeout' });
        expect(await keeper.clearSafeArea(live())).toMatchObject({ ok: false });
        expect(keeper.getPending()?.status).toBe('unknown');
        const next = saved().pending.assignment;
        expect(next.safeZone).toBeNull();
        h.handoff.mockClear();
        expect(await keeper.renewNow()).toBe('authorised');
        expect(h.authorise).toHaveBeenLastCalledWith('relay-a', assignment.sessionCode, next);
        expect(h.handoff).not.toHaveBeenCalled();
        const report = {
            type: 'position',
            anchor,
            swingRadius: 60,
            vessel: live().boatFix,
            isAlarm: false,
            safeZone: null,
            safeAreaRevision: next.safeAreaRevision,
            safeAreaVesselId: next.safeAreaVesselId,
            timestamp: NOW,
        } as SyncBroadcast;
        internal.hearReport({ ...report, safeAreaVesselId: 'boat-b' }, assignment.sessionCode);
        expect(keeper.getPending()?.status).toBe('unknown');
        internal.hearReport({ ...report, safeAreaRevision: old.safeAreaRevision }, assignment.sessionCode);
        expect(keeper.getPending()?.status).toBe('unknown');
        internal.hearReport({ ...report, timestamp: NOW - 1 }, assignment.sessionCode);
        expect(keeper.getPending()?.status).toBe('unknown');
        internal.hearReport({ ...report, swingRadius: 61 }, assignment.sessionCode);
        expect(keeper.getPending()?.status).toBe('unknown');
        internal.hearReport(report, assignment.sessionCode);
        expect(keeper.getPending()?.status).toBe('confirmed');
        expect(saved().assignment.safeZone).toBeNull();
    });
    it.each(['account', 'vessel', 'pairing'])('retires a late handoff after %s A/B/A or replacement', async (kind) => {
        h.handoff.mockImplementationOnce(async () => {
            if (kind === 'account') {
                setAuthIdentityScope('owner-b');
                setAuthIdentityScope('owner-a');
            }
            if (kind === 'vessel') {
                h.vessel = 'boat-b';
                h.vesselEpoch++;
                h.vessel = 'boat-a';
                h.vesselEpoch++;
            }
            if (kind === 'pairing') h.pair.pairedAt = '2026-10-02';
            return true;
        });
        expect(await keeper.begin(assignment)).toBe(false);
        expect(keeper.isKeeping()).toBe(false);
        expect(localStorage.getItem(key())).toBeNull();
    });
    it('hides and refuses commands on an existing area watch in another vessel or pairing context', async () => {
        await keeper.begin(assignment);
        h.vessel = 'boat-b';
        h.vesselEpoch++;
        expect(keeper.isKeeping()).toBe(false);
        expect(keeper.keepingSessionCode()).toBeNull();
        expect(keeper.centreAtSet()).toBeNull();
        expect(keeper.getPending()).toBeNull();
        expect(await keeper.renewNow()).toBe(false);
        expect(await keeper.end()).toBe(true);
        expect(h.clear).not.toHaveBeenCalled();
        expect(await keeper.clearSafeArea(live())).toMatchObject({ ok: false });
    });
    it('revalidates restored area/pending data and rejects a foreign paired-vessel record', async () => {
        await keeper.begin(assignment);
        const record = saved();
        await reset();
        localStorage.setItem(key(), JSON.stringify({ ...record, safeAreaVesselId: 'boat-b' }));
        expect(keeper.restore()).toBe(false);
        localStorage.setItem(
            key(),
            JSON.stringify({ ...record, assignment: { ...record.assignment, safeZone: { version: 9 } } }),
        );
        expect(keeper.restore()).toBe(false);
        localStorage.setItem(
            key(),
            JSON.stringify({
                ...record,
                pending: {
                    assignment: { ...record.assignment, safeZone: undefined },
                    target: anchor,
                    previous: anchor,
                    status: 'unknown',
                    at: NOW,
                },
            }),
        );
        expect(keeper.restore()).toBe(true);
        expect(keeper.getPending()).toBeNull();
    });
    it('renews the exact circle frame before a permitted move and retains the first-centre reach fence', async () => {
        await keeper.begin(assignment);
        await keeper.clearSafeArea(live());
        const target = anchorZonePosition(anchor, 5, 0)!;
        expect(await keeper.relocate(target.latitude, target.longitude, live())).toEqual({ ok: true, ashore: false });
        const next = h.send.mock.calls[1][0];
        expect(next).toMatchObject({ safeZone: null, anchorLat: target.latitude, anchorLon: target.longitude });
        expect(h.authorise).toHaveBeenLastCalledWith('relay-a', assignment.sessionCode, next);
        expect(keeper.centreAtSet()).toEqual(anchor);
        expect(keeper.getPending()?.status).toBe('sent');
    });
    it('restores the prior relay boundary on a known Pi refusal instead of suppressing its continuing custom-area reports', async () => {
        await keeper.begin(assignment);
        const previous = saved().assignment;
        h.send.mockResolvedValueOnce({ taken: false, status: 409, error: 'The Pi drag alarm is active.' });
        expect(await keeper.clearSafeArea(live())).toMatchObject({
            ok: false,
            error: expect.stringContaining('keeps the custom area'),
        });
        expect(h.authorise).toHaveBeenLastCalledWith('relay-a', assignment.sessionCode, previous);
        expect(saved().assignment).toEqual(previous);
        expect(keeper.getPending()).toBeNull();
    });
    it('does not restore a refused stop into another account after the command returns', async () => {
        await keeper.begin(assignment);
        h.clear.mockImplementationOnce(async () => {
            setAuthIdentityScope('owner-b');
            return true;
        });
        expect(await keeper.end()).toBe(true);
        expect(keeper.isKeeping()).toBe(false);
        expect(localStorage.getItem(key())).toBeNull();
    });
});

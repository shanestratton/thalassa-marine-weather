import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    scope: {
        key: 'user:00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000001' as string | null,
        generation: 0,
    },
    store: {} as Record<string, unknown>,
    authListeners: new Set<() => void>(),
    storeListeners: new Set<() => void>(),
    disk: new Map<string, unknown>(),
    retired: vi.fn(),
    rpc: vi.fn(),
    session: vi.fn(),
    rows: vi.fn(),
    marine: vi.fn(),
    status: vi.fn(),
    fix: vi.fn(),
    shore: vi.fn(),
    shelter: vi.fn(),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ ...f.scope }),
    isAuthIdentityScopeCurrent: (s: typeof f.scope) => s.key === f.scope.key && s.generation === f.scope.generation,
    subscribeAuthIdentityScope: (fn: () => void) => {
        f.authListeners.add(fn);
        return () => f.authListeners.delete(fn);
    },
    authScopedStorageKey: (base: string, s = f.scope) => `${base}::${encodeURIComponent(s.key)}`,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => f.store,
        subscribe: (fn: () => void) => {
            f.storeListeners.add(fn);
            return () => f.storeListeners.delete(fn);
        },
    },
}));
vi.mock('../services/supabase', () => ({ supabase: { auth: { getSession: f.session }, rpc: f.rpc } }));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: async (key: string) => structuredClone(f.disk.get(key) ?? null),
    saveLargeDataImmediate: async (key: string, value: unknown) => {
        f.disk.set(key, structuredClone(value));
    },
    deleteLargeData: async (key: string) => {
        f.disk.delete(key);
    },
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getPublishedTrackingStatus: f.status,
        getLastAcceptedFix: f.fix,
        getComfortShoreEvidence: f.shore,
    },
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({ getOfflineEntries: f.rows, shipLogCaptureRetired: f.retired }));
vi.mock('../services/weather/api/marineModel', () => ({ fetchMarineModelV2: f.marine }));
vi.mock('../services/weather/shelter', () => ({ assessShelterExactPoint: f.shelter }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const part = { hM: 0.9, periodS: 8, fromDeg: 90 },
    parts = { total: part, windSea: null, swell: null, secondarySwell: null };
const empty = () => ({
    boatId: id(1),
    context: id(3),
    epoch: id(4),
    revision: 1,
    profile: { type: 'sail', length: 40 },
    reports: [],
});
const pendingKey = () => `thalassa_private_comfort_pending_v1::${encodeURIComponent(f.scope.key)}`;
let api: typeof import('../services/comfort/privateComfort');
function notifyStore() {
    f.storeListeners.forEach((fn) => fn());
}
beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    f.authListeners.clear();
    f.storeListeners.clear();
    f.disk.clear();
    f.scope = {
        key: 'user:00000000-0000-4000-8000-000000000001',
        userId: '00000000-0000-4000-8000-000000000001',
        generation: 0,
    };
    f.store = {
        activeVesselId: id(1),
        vesselFleetStatus: 'saved',
        settings: { vessel: { type: 'sail', length: 40 } },
        vesselFleet: [{ id: id(1), owner_id: f.scope.userId, profile: { type: 'sail', length: 40 }, revision: 1 }],
    };
    f.session.mockResolvedValue({ data: { session: { user: { id: f.scope.userId } } } });
    f.rpc.mockResolvedValue({ data: empty(), error: null });
    f.retired.mockResolvedValue(false);
    f.status.mockReturnValue({ isTracking: true, isPaused: false, boatId: id(1), currentVoyageId: 'recording-voyage' });
    f.fix.mockImplementation(() => ({ latitude: -27, longitude: 153, timestamp: Date.now(), accuracy: 5 }));
    f.shore.mockReturnValue({ latitude: -27, longitude: 153, coastDistanceNm: 10 });
    f.shelter.mockResolvedValue({ enclosed: false, maxFetchKm: 20 });
    f.rows.mockImplementation(async () => [
        {
            id: 'offline_actual-capture',
            userId: f.scope.userId,
            boatId: id(1),
            voyageId: 'recording-voyage',
            latitude: -27,
            longitude: 153,
            timestamp: new Date().toISOString(),
            source: 'device',
            entryType: 'auto',
        },
    ]);
    f.marine.mockImplementation(async () => ({
        fetchedAtMs: Date.now(),
        waveCurrentAtMs: Date.now(),
        currentParts: parts,
        waveCell: { local: true, snappedKm: 0.2 },
    }));
    api = await import('../services/comfort/privateComfort');
});
afterEach(() => vi.useRealTimers());
describe('owner-private actual passage sidecar', () => {
    it('joins bounded private reads and starts uncalibrated without touching shared rows', async () => {
        const [a, b] = await Promise.all([api.loadPrivateComfort(), api.loadPrivateComfort()]);
        expect(a).toBe(b);
        expect(f.rpc).toHaveBeenCalledTimes(1);
        expect(api.personalComfortPreference()?.qualified.size.reports).toBe(0);
        expect(f.disk.size).toBe(0);
    });
    it('retires the preference and candidate fence when the original RAM lease expires', async () => {
        vi.useFakeTimers();
        await api.loadPrivateComfort();
        const key = api.privateComfortViewKey();
        expect(api.personalComfortPreference()).not.toBeNull();
        await vi.advanceTimersByTimeAsync(60001);
        expect(api.personalComfortPreference()).toBeNull();
        expect(api.privateComfortViewKey()).not.toBe(key);
    });
    it('uses the actual retained point and queues privately without forcing parent upload', async () => {
        await api.reportPrivateComfort(2);
        expect(f.marine).toHaveBeenCalledWith(-27, 153);
        expect(f.rows).toHaveBeenCalledWith(expect.objectContaining({ voyageId: 'recording-voyage' }));
        expect(f.rpc.mock.calls.map((c) => c[1].p_action)).toEqual(['state']);
        const disk = f.disk.get(pendingKey()) as { pending: { operation: string; input: Record<string, unknown> }[] };
        expect(disk.pending).toHaveLength(1);
        expect(disk.pending[0].operation).toBe('actual-capture');
        expect(disk.pending[0].input).toMatchObject({ latitude: -27, longitude: 153, level: 2, parts });
        expect(await api.pendingPrivateComfort()).toMatchObject({ rows: [{ operation: 'actual-capture', level: 2 }] });
        await expect(api.reportPrivateComfort(0)).rejects.toThrow('already has');
    });
    it.each(['old-fix', 'paused', 'wrong-boat', 'imported', 'distant-point'])(
        'refuses %s instead of fabricating an observation',
        async (kind) => {
            if (kind === 'old-fix')
                f.fix.mockReturnValue({ latitude: -27, longitude: 153, timestamp: Date.now() - 45001 });
            if (kind === 'paused')
                f.status.mockReturnValue({
                    isTracking: true,
                    isPaused: true,
                    boatId: id(1),
                    currentVoyageId: 'recording-voyage',
                });
            if (kind === 'wrong-boat')
                f.status.mockReturnValue({ isTracking: true, boatId: id(2), currentVoyageId: 'recording-voyage' });
            if (kind === 'imported')
                f.rows.mockResolvedValue([
                    {
                        id: 'offline_import',
                        userId: f.scope.userId,
                        boatId: id(1),
                        voyageId: 'recording-voyage',
                        latitude: -27,
                        longitude: 153,
                        timestamp: new Date().toISOString(),
                        source: 'gpx_import',
                        entryType: 'auto',
                    },
                ]);
            if (kind === 'distant-point')
                f.rows.mockResolvedValue([
                    {
                        id: 'offline_distant',
                        userId: f.scope.userId,
                        boatId: id(1),
                        voyageId: 'recording-voyage',
                        latitude: -28,
                        longitude: 153,
                        timestamp: new Date().toISOString(),
                        source: 'device',
                        entryType: 'auto',
                    },
                ]);
            await expect(api.reportPrivateComfort(1)).rejects.toThrow();
            expect(f.disk.size).toBe(0);
        },
    );
    it('keeps absent sea unknown and does not collect an unqualified report', async () => {
        f.marine.mockResolvedValue(null);
        await expect(api.reportPrivateComfort(1)).rejects.toThrow('No contemporaneous');
        expect(f.disk.size).toBe(0);
    });
    it('accepts the actual device rolling waypoint without backfilling legacy source', async () => {
        const rows = await f.rows();
        f.rows.mockResolvedValue([{ ...rows[0], entryType: 'waypoint' }]);
        await api.reportPrivateComfort(1);
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(1);
    });
    it.each(['unknown-coast', 'enclosed', 'unknown-shelter', 'foreign-cell', 'cell-crosses-coast', 'over-500m'])(
        'refuses %s rather than qualifying a borrowed sea state',
        async (kind) => {
            if (kind === 'unknown-coast') f.shore.mockReturnValue(null);
            if (kind === 'enclosed') f.shelter.mockResolvedValue({ enclosed: true, maxFetchKm: 2 });
            if (kind === 'unknown-shelter') f.shelter.mockResolvedValue(null);
            if (kind === 'foreign-cell') {
                const marine = await f.marine();
                f.marine.mockResolvedValue({ ...marine, waveCell: { local: false, snappedKm: 0.2 } });
            }
            if (kind === 'cell-crosses-coast')
                f.shore.mockReturnValue({ latitude: -27, longitude: 153, coastDistanceNm: 0.1 });
            if (kind === 'over-500m') {
                const rows = await f.rows();
                f.rows.mockResolvedValue([{ ...rows[0], latitude: -27.006 }]);
            }
            await expect(api.reportPrivateComfort(1)).rejects.toThrow();
            expect(f.disk.size).toBe(0);
        },
    );
    it('drains only through the explicit ordinary-sync seam and retains parent-not-yet-synced failures', async () => {
        await api.reportPrivateComfort(2);
        f.rpc.mockResolvedValueOnce({ data: null, error: { code: '23503' } });
        await api.drainPrivateComfortReports();
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(1);
        f.rpc.mockResolvedValueOnce({ data: empty(), error: null });
        await api.drainPrivateComfortReports();
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(0);
        expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
            p_action: 'save',
            p_input: { operation: 'actual-capture' },
        });
    });
    it('reuses real parent-deletion intent and refuses an unavailable ledger', async () => {
        await api.reportPrivateComfort(1);
        f.retired.mockResolvedValueOnce(null);
        const calls = f.rpc.mock.calls.length;
        await api.drainPrivateComfortReports();
        expect(f.rpc).toHaveBeenCalledTimes(calls);
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(1);
        f.retired.mockResolvedValueOnce(true);
        await api.drainPrivateComfortReports();
        expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
            p_action: 'delete',
            p_input: { operation: 'actual-capture' },
        });
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(0);
    });
    it('fences late account and boat A-B-A results synchronously', async () => {
        let finish!: (value: unknown) => void;
        f.rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const read = api.loadPrivateComfort();
        await vi.waitFor(() => expect(f.rpc).toHaveBeenCalled());
        f.store.activeVesselId = id(2);
        notifyStore();
        f.store.activeVesselId = id(1);
        notifyStore();
        finish({ data: empty(), error: null });
        expect(await read).toBeNull();
        expect(api.privateComfortSnapshot()).toBeNull();
        await api.loadPrivateComfort();
        expect(api.personalComfortPreference()).not.toBeNull();
        f.scope = { key: 'anonymous', userId: null, generation: 1 };
        f.authListeners.forEach((fn) => fn());
        expect(api.privateComfortSnapshot()).toBeNull();
        expect(api.personalComfortPreference()).toBeNull();
    });
    it('never issues an RPC after a timed-out session read finally completes', async () => {
        vi.useFakeTimers();
        let finish!: (value: unknown) => void;
        f.session.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const read = api.loadPrivateComfort();
        await vi.advanceTimersByTimeAsync(6001);
        expect(await read).toBeNull();
        finish({ data: { session: { user: { id: f.scope.userId } } } });
        await Promise.resolve();
        await Promise.resolve();
        expect(f.rpc).not.toHaveBeenCalled();
    });
    it('profile edits retire qualified data and mismatched server cohorts cannot refill it', async () => {
        await api.loadPrivateComfort();
        expect(api.personalComfortPreference()).not.toBeNull();
        const fleet = f.store.vesselFleet as { profile: { length: number }; revision: number }[];
        fleet[0].revision = 2;
        notifyStore();
        expect(api.personalComfortPreference()).toBeNull();
        expect(await api.loadPrivateComfort()).toBeNull();
    });
    it('delete sends a tombstone for an in-flight pending save and reset removes the old epoch', async () => {
        await api.reportPrivateComfort(1);
        await api.deletePrivateComfort('actual-capture');
        expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
            p_action: 'delete',
            p_input: { operation: 'actual-capture', epoch: id(4) },
        });
        expect((await api.pendingPrivateComfort())?.rows).toHaveLength(0);
        f.rpc.mockResolvedValueOnce({ data: { ...empty(), epoch: id(5) }, error: null });
        await api.resetPrivateComfort();
        expect(api.privateComfortSnapshot()?.epoch).toBe(id(5));
        expect(api.privateComfortSnapshot()?.reports).toEqual([]);
    });
    it('account deletion purges only the exact private owner namespace', async () => {
        await api.reportPrivateComfort(1);
        f.disk.set('unrelated', { safe: true });
        await api.purgePrivateComfortForUser(f.scope.userId!);
        expect(f.disk.has(pendingKey())).toBe(false);
        expect(f.disk.get('unrelated')).toEqual({ safe: true });
    });
});

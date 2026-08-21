import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    /** The LOCAL persisted tracking record the seed reads — null = nothing persisted. */
    persistedTracking: null as null | { isTracking: boolean; isPaused: boolean; currentVoyageId?: string },
    account: 'a',
    initialize: vi.fn(),
    getCachedSummaries: vi.fn(),
    getSummaries: vi.fn(),
    getVoyageEntries: vi.fn(),
    getOfflineEntries: vi.fn(),
    getArchivedEntries: vi.fn(),
    getLogEntries: vi.fn(),
    getCurrentVoyageId: vi.fn(),
    getTrackingStatus: vi.fn(),
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    pauseTracking: vi.fn(),
    archiveVoyage: vi.fn(),
    unarchiveVoyage: vi.fn(),
    deleteEntry: vi.fn(),
    deleteVoyage: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('../components/Toast', () => ({
    useToast: () => ({
        success: mocks.toastSuccess,
        error: mocks.toastError,
        info: vi.fn(),
        loading: vi.fn(),
        showToast: vi.fn(),
        hideToast: vi.fn(),
        ToastContainer: () => null,
    }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            vessel: { name: 'Test Vessel' },
            vesselUnits: {},
            units: { speed: 'kts', distance: 'nm', temp: 'C', length: 'm' },
        },
    }),
}));
vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: { ensureReady: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/shiplog/VoyageTrackCache', () => ({
    getCachedVoyageTrack: vi.fn().mockResolvedValue(null),
    setCachedVoyageTrack: vi.fn().mockResolvedValue(undefined),
    clearCachedVoyageTrack: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/TrackSharingService', () => ({
    TrackSharingService: {
        getSharedTracksByVoyageId: vi.fn().mockResolvedValue([]),
        deleteSharedTracksByVoyageId: vi.fn().mockResolvedValue(undefined),
        shareTrack: vi.fn().mockResolvedValue({ id: 'shared' }),
    },
}));
vi.mock('../services/gpxService', () => ({
    exportVoyageAsGPX: vi.fn(() => '<gpx/>'),
    shareGPXFile: vi.fn().mockResolvedValue(undefined),
    readGPXFile: vi.fn().mockResolvedValue('<gpx/>'),
    importGPXToEntries: vi.fn(() => []),
}));
vi.mock('../services/shiplog/TrackingStateStore', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/shiplog/TrackingStateStore')>();
    return {
        ...real,
        // The seed reads this directly, in parallel with initialize(), so it
        // can open the live-map gate before the native chain runs. Tests set
        // mocks.persistedTracking to model what is on the device.
        loadTrackingState: vi.fn(async () => mocks.persistedTracking),
    };
});

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        initialize: (...args: unknown[]) => mocks.initialize(...args),
        getCachedVoyageSummaries: (...args: unknown[]) => mocks.getCachedSummaries(...args),
        getVoyageSummaries: (...args: unknown[]) => mocks.getSummaries(...args),
        getVoyageEntries: (...args: unknown[]) => mocks.getVoyageEntries(...args),
        getOfflineEntries: (...args: unknown[]) => mocks.getOfflineEntries(...args),
        getArchivedEntries: (...args: unknown[]) => mocks.getArchivedEntries(...args),
        getLogEntries: (...args: unknown[]) => mocks.getLogEntries(...args),
        getCurrentVoyageId: (...args: unknown[]) => mocks.getCurrentVoyageId(...args),
        getTrackingStatus: (...args: unknown[]) => mocks.getTrackingStatus(...args),
        getGpsStatus: vi.fn(() => 'none'),
        startTracking: (...args: unknown[]) => mocks.startTracking(...args),
        stopTracking: (...args: unknown[]) => mocks.stopTracking(...args),
        pauseTracking: (...args: unknown[]) => mocks.pauseTracking(...args),
        setRapidMode: vi.fn().mockResolvedValue(undefined),
        setPrecisionMode: vi.fn().mockResolvedValue(undefined),
        archiveVoyage: (...args: unknown[]) => mocks.archiveVoyage(...args),
        unarchiveVoyage: (...args: unknown[]) => mocks.unarchiveVoyage(...args),
        deleteEntry: (...args: unknown[]) => mocks.deleteEntry(...args),
        deleteVoyage: (...args: unknown[]) => mocks.deleteVoyage(...args),
        importGPXVoyage: vi.fn().mockResolvedValue({ savedCount: 0 }),
    },
    // useLogPageState imports this as a NAMED export alongside the service, and
    // omitting it made every prune sweep throw. The sweep is scheduled, so the
    // throw landed as an Unhandled Rejection AFTER the test had finished — 22
    // of them in a full run, each firing into a worker that had already moved
    // on to another file. That is what intermittently corrupted an unrelated
    // suite's environment ("setTimeout is not a function" in
    // WeatherContextIdentity, which passes 5/5 in isolation). The tests here
    // all passed throughout; only the exit code and the collateral gave it
    // away (2026-08-22).
    getRecentDeviceStops: () => new Set<string>(),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useLogPageState, resetLogViewMemoForTest } from '../hooks/useLogPageState';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const summaryA = {
    voyageId: 'voyage-a',
    entryCount: 3,
    startedAt: '2026-07-23T00:00:00.000Z',
    endedAt: '2026-07-23T01:00:00.000Z',
    totalDistanceNM: 2,
    avgSpeedKts: 4,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -27.4,
    firstLon: 153,
    lastLat: -27.5,
    lastLon: 153.1,
    firstIsOnWater: true,
    landFraction: 0,
};

const entryA = {
    id: 'entry-a',
    user_id: 'account-a',
    voyageId: 'voyage-a',
    timestamp: '2026-07-23T00:30:00.000Z',
    latitude: -27.45,
    longitude: 153.05,
    positionFormatted: '27°27.0′S 153°03.0′E',
    entryType: 'auto' as const,
    cumulativeDistanceNM: 1,
    distanceNM: 1,
    source: 'device',
};

beforeEach(() => {
    vi.clearAllMocks();
    resetLogViewMemoForTest();
    mocks.account = 'a';
    mocks.persistedTracking = null;
    setAuthIdentityScope('account-a');
    mocks.initialize.mockResolvedValue(undefined);
    mocks.getCachedSummaries.mockImplementation(async () => (mocks.account === 'a' ? [summaryA] : []));
    mocks.getSummaries.mockImplementation(async () => (mocks.account === 'a' ? [summaryA] : []));
    mocks.getCurrentVoyageId.mockImplementation(() => (mocks.account === 'a' ? 'voyage-a' : undefined));
    mocks.getVoyageEntries.mockImplementation(async () => (mocks.account === 'a' ? [entryA] : []));
    mocks.getOfflineEntries.mockResolvedValue([]);
    mocks.getArchivedEntries.mockResolvedValue([]);
    mocks.getLogEntries.mockResolvedValue([]);
    mocks.getTrackingStatus.mockReturnValue({
        isTracking: false,
        isPaused: false,
        isRapidMode: false,
        isPrecisionMode: false,
    });
    mocks.startTracking.mockResolvedValue(undefined);
    mocks.stopTracking.mockResolvedValue(undefined);
    mocks.pauseTracking.mockResolvedValue(undefined);
    mocks.archiveVoyage.mockResolvedValue(true);
    mocks.unarchiveVoyage.mockResolvedValue(true);
    mocks.deleteEntry.mockResolvedValue(true);
    mocks.deleteVoyage.mockResolvedValue(true);
});

afterEach(() => {
    cleanup();
});

function switchToB() {
    mocks.account = 'b';
    act(() => {
        setAuthIdentityScope('account-b');
    });
}

describe('useLogPageState identity boundary', () => {
    it('hides A synchronously and discards a deferred A network load', async () => {
        const loadA = deferred<(typeof summaryA)[]>();
        mocks.getSummaries.mockReturnValueOnce(loadA.promise);
        const { result } = renderHook(() => useLogPageState());

        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));
        await waitFor(() => expect(mocks.getSummaries).toHaveBeenCalled());

        switchToB();
        expect(result.current.state.entries).toEqual([]);
        expect(result.current.state.summaries).toEqual([]);
        expect(result.current.listVoyages).toEqual([]);
        expect(result.current.archivedVoyages).toEqual([]);

        loadA.resolve([summaryA]);
        await act(async () => Promise.resolve());
        expect(result.current.state.entries).toEqual([]);
        expect(result.current.state.summaries).toEqual([]);
    });

    it('does not announce or restore a deferred A archive in B', async () => {
        const archiveA = deferred<boolean>();
        mocks.archiveVoyage.mockReturnValueOnce(archiveA.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));

        let archivePromise!: Promise<void>;
        act(() => {
            archivePromise = result.current.handleArchiveVoyage('voyage-a');
        });
        await waitFor(() => expect(mocks.archiveVoyage).toHaveBeenCalledWith('voyage-a'));
        switchToB();
        archiveA.resolve(true);
        await act(async () => archivePromise);

        expect(result.current.state.summaries).toEqual([]);
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Voyage archived');
    });

    it('drops a deferred A entry delete failure and rejects A undo after switching to B', async () => {
        const deletionA = deferred<boolean>();
        mocks.deleteEntry.mockReturnValueOnce(deletionA.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.entries.some((entry) => entry.id === 'entry-a')).toBe(true));

        act(() => result.current.handleDeleteEntry('entry-a'));
        expect(result.current.state.entries).toEqual([]);
        const staleUndo = result.current.handleUndoDeleteEntry;

        let dismissPromise!: Promise<void>;
        act(() => {
            dismissPromise = result.current.handleDismissDeleteEntry();
        });
        await waitFor(() => expect(mocks.deleteEntry).toHaveBeenCalledWith('entry-a'));
        switchToB();
        act(() => staleUndo());
        deletionA.resolve(false);
        await act(async () => dismissPromise);

        expect(result.current.state.entries).toEqual([]);
        expect(result.current.deletedEntry).toBeNull();
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Entry restored');
        expect(mocks.toastError).not.toHaveBeenCalledWith('Failed to delete entry');
    });

    it('keeps a deferred A start completion and failure out of B', async () => {
        const startA = deferred<void>();
        mocks.startTracking.mockReturnValueOnce(startA.promise);
        mocks.getCachedSummaries.mockResolvedValue([]);
        mocks.getSummaries.mockResolvedValue([]);
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));

        act(() => {
            void result.current.startTrackingWithNewVoyage();
        });
        expect(result.current.state.isTracking).toBe(true);
        switchToB();
        expect(result.current.state.isTracking).toBe(false);

        startA.reject(new Error('A GPS failed'));
        await act(async () => Promise.resolve());
        expect(result.current.state.isTracking).toBe(false);
        expect(mocks.toastError).not.toHaveBeenCalledWith('A GPS failed');
    });

    it('restores pending-stop UI and does not delete a voyage after native teardown fails', async () => {
        mocks.stopTracking.mockRejectedValueOnce(new Error('Background GPS is still active. Retry End Voyage.'));
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            isPrecisionMode: false,
        });
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        mocks.deleteVoyage.mockClear();

        await act(async () => result.current.confirmStopVoyage());

        expect(result.current.state).toMatchObject({ isTracking: false, isPaused: true });
        expect(mocks.toastError).toHaveBeenCalledWith('Background GPS is still active. Retry End Voyage.');
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
    });

    it('surfaces a pause teardown failure and reflects the service paused state', async () => {
        mocks.pauseTracking.mockRejectedValueOnce(
            new Error('Voyage recording is paused, but background GPS could not be stopped.'),
        );
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: false,
            isPaused: true,
            isRapidMode: false,
            isPrecisionMode: false,
        });
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));

        await act(async () => result.current.handlePauseTracking());

        expect(result.current.state).toMatchObject({ isTracking: false, isPaused: true });
        expect(mocks.toastError).toHaveBeenCalledWith(
            'Voyage recording is paused, but background GPS could not be stopped.',
        );
    });

    it('rejects a retained A voyage undo callback after B is active', async () => {
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));

        await act(async () => result.current.handleDeleteVoyageRequest('voyage-a'));
        expect(result.current.deletedVoyage?.voyageId).toBe('voyage-a');
        const staleUndo = result.current.handleUndoDeleteVoyage;

        switchToB();
        act(() => staleUndo());
        expect(result.current.state.summaries).toEqual([]);
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Voyage restored');
    });
});

describe('useLogPageState view memo — a tab-bounce keeps what the skipper had open', () => {
    it('restores the open voyage, expands, sheets and filters on a same-identity remount', async () => {
        // "When I come back to that page, I literally have to start all over
        // again" (Shane, mid-voyage 2026-08-01). The Log page unmounts on
        // every tab-bounce; the view state now survives at module scope.
        const first = renderHook(() => useLogPageState());
        await waitFor(() => expect(first.result.current.state.loading).toBe(false));

        act(() => {
            first.result.current.dispatch({ type: 'SELECT_VOYAGE', voyageId: 'voyage-a' });
            first.result.current.dispatch({ type: 'SHOW_TRACK_MAP', show: true });
            first.result.current.dispatch({ type: 'SET_FILTERS', filters: { types: ['manual'], searchQuery: 'reef' } });
        });
        first.unmount(); // tab away…

        const second = renderHook(() => useLogPageState()); // …and back
        expect(second.result.current.state.selectedVoyageId).toBe('voyage-a');
        expect(second.result.current.state.showTrackMap).toBe(true);
        expect(second.result.current.state.filters).toEqual({ types: ['manual'], searchQuery: 'reef' });

        // And the first data load must not clobber the restored expands with
        // its auto-expand-active-voyage default.
        await waitFor(() => expect(second.result.current.state.loading).toBe(false));
        expect(second.result.current.state.selectedVoyageId).toBe('voyage-a');
        second.unmount();
    });

    it('an identity CHANGE still resets to a clean slate — the boundary my restore must not weaken', async () => {
        const first = renderHook(() => useLogPageState());
        await waitFor(() => expect(first.result.current.state.loading).toBe(false));
        act(() => {
            first.result.current.dispatch({ type: 'SELECT_VOYAGE', voyageId: 'voyage-a' });
        });
        first.unmount();

        mocks.account = 'b';
        act(() => {
            setAuthIdentityScope('account-b');
        });
        const second = renderHook(() => useLogPageState());
        expect(second.result.current.state.selectedVoyageId).toBeNull();
        expect(second.result.current.state.showTrackMap).toBe(false);
        second.unmount();
    });

    /**
     * The live map is gated on isTracking && currentVoyageId. Both used to be
     * written only by LOAD_DATA — after five-plus serial Supabase calls — even
     * though ShipLogService already knew the answer from local storage the
     * moment initialize() returned. Shane, 2026-08-20: "it needs to be instant
     * along with everything in the log page." This pins the promise: the gate
     * opens BEFORE the network resolves, and LOAD_DATA stays authoritative.
     */
    it('opens the live-map gate from local tracking state before the network resolves', async () => {
        // Hold the network open indefinitely. If the gate depended on it, the
        // assertion below would never pass.
        let releaseSummaries!: (v: unknown[]) => void;
        mocks.getSummaries.mockImplementation(
            () => new Promise<unknown[]>((resolve) => (releaseSummaries = resolve)),
        );
        mocks.getVoyageEntries.mockImplementation(() => new Promise<unknown[]>(() => {}));
        // What is on the DEVICE: a voyage persisted as running. This is what
        // the seed reads — not the service, which is still initialising.
        mocks.persistedTracking = { isTracking: true, isPaused: false, currentVoyageId: 'voyage-a' };
        mocks.getCurrentVoyageId.mockReturnValue('voyage-a');
        // And make the eventual LOAD_DATA AGREE, so we are testing early-open
        // rather than a seed-then-revert.
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: true,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        });

        const { result } = renderHook(() => useLogPageState());

        // Gate open with the network still pending.
        await waitFor(() => {
            expect(result.current.state.isTracking).toBe(true);
            expect(result.current.state.currentVoyageId).toBe('voyage-a');
        });
        // Proof the NETWORK has not landed: the held promise is still held and
        // the entries fetch never resolves. (summaries may already be present
        // from the local cache — that is fine and is not the network.)
        expect(mocks.getSummaries).toHaveBeenCalled();
        expect(result.current.state.entries).toEqual([]);

        // Let the network land; nothing regresses.
        act(() => releaseSummaries([summaryA]));
        await waitFor(() => expect(result.current.state.isTracking).toBe(true));
        expect(result.current.state.currentVoyageId).toBe('voyage-a');
    });

    it('a local seed cannot talk the page OUT of a voyage it already believes is running', async () => {
        // SEED_TRACKING only ever adds knowledge. A seed of "not tracking" is
        // the default value, not evidence, and must not override a memo
        // restore or an in-flight start. Model a device record that the pure
        // helper resolves to "no active voyage" (paused), while LOAD_DATA
        // says tracking.
        mocks.persistedTracking = { isTracking: true, isPaused: true, currentVoyageId: 'voyage-a' };
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: true,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        });
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.isTracking).toBe(true));
        // LOAD_DATA said tracking; the undefined seed did not flip it false.
        expect(result.current.state.isTracking).toBe(true);
    });

    it('seeds the active track from the offline queue without defeating first-load auto-expand', async () => {
        // The live map draws from entries. On a cold start those used to wait
        // for the network even though the boat's own latest fixes sit in the
        // local offline queue. Seeding them early must behave exactly as if
        // LOAD_DATA had simply arrived sooner — including the auto-expand of
        // the active voyage, which LOAD_DATA keys on entries being empty and
        // would otherwise be skipped once a seed had filled them.
        let releaseEntries!: (v: unknown[]) => void;
        mocks.getVoyageEntries.mockImplementation(
            () => new Promise<unknown[]>((resolve) => (releaseEntries = resolve)),
        );
        mocks.persistedTracking = { isTracking: true, isPaused: false, currentVoyageId: 'voyage-a' };
        mocks.getCurrentVoyageId.mockReturnValue('voyage-a');
        mocks.getOfflineEntries.mockResolvedValue([entryA]); // local, instant
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: true,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        });

        const { result } = renderHook(() => useLogPageState());

        // Track present and voyage expanded — BEFORE the network entries land.
        await waitFor(() => expect(result.current.state.entries.length).toBeGreaterThan(0));
        expect(result.current.state.entries[0].voyageId).toBe('voyage-a');
        expect(result.current.state.expandedVoyages.has('voyage-a')).toBe(true);

        // Network lands: LOAD_DATA replaces the seed and the expand survives.
        act(() => releaseEntries([entryA]));
        await waitFor(() => expect(result.current.state.expandedVoyages.has('voyage-a')).toBe(true));
    });

    it('opens the live-map gate while initialize() is STILL RUNNING — before any GPS fix', async () => {
        // The case Shane saw on device (2026-08-20): the map "arrives after
        // there is a gps fix". On a cold start with a voyage to resume,
        // initialize() runs the native chain — BgGeo ready, authorisation,
        // lease, requestStart — and returns roughly when the first fix lands.
        // A seed behind it inherited that wait. The seed now reads the local
        // record IN PARALLEL with initialize(), so the gate opens while the
        // native chain has not even finished. Model that by never resolving
        // initialize() at all.
        mocks.initialize.mockImplementation(() => new Promise<void>(() => {}));
        mocks.persistedTracking = { isTracking: true, isPaused: false, currentVoyageId: 'voyage-a' };
        mocks.getOfflineEntries.mockResolvedValue([entryA]);

        const { result } = renderHook(() => useLogPageState());

        await waitFor(() => {
            expect(result.current.state.isTracking).toBe(true);
            expect(result.current.state.currentVoyageId).toBe('voyage-a');
            expect(result.current.state.entries.length).toBeGreaterThan(0);
        });
        // initialize() never returned, so loadData() never ran — and the map
        // gate is open anyway, with a track to draw.
        expect(mocks.getSummaries).not.toHaveBeenCalled();
    });
});

/**
 * Deleting a voyage must be instant on the ACCEPTANCE BOUNDARY — the durable
 * local tombstone — not when the cloud finishes. deleteVoyage() runs a
 * planned-route lookup (4 s cap), the cloud delete (8 s) and a verification
 * select (4 s) after the tombstone; awaiting all of it before touching the
 * screen made "delete a track" take up to ~16 s on a marine link for an
 * outcome decided in the first milliseconds (Shane, 2026-08-20: "it takes
 * quite a while to delete the track, can we make that instant as well?").
 */
describe('useLogPageState delete — instant on the acceptance boundary', () => {
    it('removes the row the moment the tombstone lands, while the cloud is still hanging', async () => {
        // deleteVoyage fires onAccepted (the tombstone) and then NEVER resolves
        // — the cloud is hanging. The row must be gone anyway.
        let acceptedCb!: () => void;
        mocks.deleteVoyage.mockImplementation(
            (_id: string, onAccepted?: () => void) =>
                new Promise<boolean>(() => {
                    acceptedCb = onAccepted!;
                }),
        );

        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.entries.length).toBeGreaterThan(0));

        act(() => result.current.dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: 'voyage-a' }));
        await act(async () => {
            void result.current.handleConfirmDeleteVoyage();
        });
        await waitFor(() => expect(mocks.deleteVoyage).toHaveBeenCalled());

        // Tombstone lands.
        act(() => acceptedCb());

        await waitFor(() => {
            expect(result.current.state.entries.filter((e) => e.voyageId === 'voyage-a')).toEqual([]);
            expect(result.current.state.deleteVoyageId).toBeNull(); // dialog closed
        });
        // The promise never resolved. The UI did not wait for it.
    });

    it('does not hold the tap hostage to a slow shared-track check', async () => {
        // The pre-confirm "is this shared?" query hangs. It must fail OPEN
        // within the bound and the delete must proceed.
        vi.useFakeTimers();
        try {
            const { TrackSharingService } = await import('../services/TrackSharingService');
            (TrackSharingService.getSharedTracksByVoyageId as ReturnType<typeof vi.fn>).mockImplementation(
                () => new Promise(() => {}),
            );
            mocks.deleteVoyage.mockImplementation(async (_id: string, onAccepted?: () => void) => {
                onAccepted?.();
                return true;
            });

            const { result } = renderHook(() => useLogPageState());
            await vi.advanceTimersByTimeAsync(50);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });

            act(() => result.current.dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: 'voyage-a' }));
            const run = act(async () => {
                void result.current.handleConfirmDeleteVoyage();
                await vi.advanceTimersByTimeAsync(3000); // past the 2.5 s bound
            });
            await run;

            expect(mocks.deleteVoyage).toHaveBeenCalledWith('voyage-a', expect.any(Function));
        } finally {
            vi.useRealTimers();
        }
    });

    it('LOAD_DATA cannot clobber the seed while the cold-start resume is still running', async () => {
        // The in-memory service status LIES during a native resume: it holds
        // isTracking=false from initializeForScope until startTracking
        // completes — roughly the first GPS fix. A loadData landing in that
        // window used to dispatch that falsehood over the seed, unmount the
        // live card, and the map "arrived with the fix" (Shane, 2026-08-20,
        // after the seed itself was verified working). The persisted record is
        // now the tie-breaker.
        mocks.persistedTracking = { isTracking: true, isPaused: false, currentVoyageId: 'voyage-a' };
        mocks.getCurrentVoyageId.mockReturnValue(undefined); // in-memory: mid-resume
        mocks.getTrackingStatus.mockReturnValue({
            isTracking: false, // the lie
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        });

        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.getSummaries).toHaveBeenCalled());
        // Give the LOAD_DATA dispatch time to land — and then assert it did
        // NOT downgrade the seeded state.
        await waitFor(() => expect(result.current.state.isTracking).toBe(true));
        expect(result.current.state.currentVoyageId).toBe('voyage-a');
    });

    it('the delete tap removes the card instantly, even with the shares check hanging', async () => {
        const { TrackSharingService } = await import('../services/TrackSharingService');
        (TrackSharingService.getSharedTracksByVoyageId as ReturnType<typeof vi.fn>).mockImplementation(
            () => new Promise(() => {}), // never answers
        );
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));

        await act(async () => {
            void result.current.handleDeleteVoyageRequest('voyage-a');
        });
        // Card gone and undo armed, with the network still hanging.
        expect(result.current.state.summaries).toEqual([]);
        expect(result.current.deletedVoyage?.voyageId).toBe('voyage-a');
    });

    it('restores the card and shows the warning when shares turn up behind the removal', async () => {
        const { TrackSharingService } = await import('../services/TrackSharingService');
        let releaseShares!: (v: unknown[]) => void;
        (TrackSharingService.getSharedTracksByVoyageId as ReturnType<typeof vi.fn>).mockImplementation(
            () => new Promise<unknown[]>((resolve) => (releaseShares = resolve)),
        );
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));

        await act(async () => {
            void result.current.handleDeleteVoyageRequest('voyage-a');
        });
        // Removed instantly, check still pending...
        expect(result.current.state.summaries).toEqual([]);
        // ...then the check finds shares: card restored, dialog takes over.
        await act(async () => releaseShares([{ title: 'Bay run', download_count: 3 }]));
        await waitFor(() => expect(result.current.state.summaries).toEqual([summaryA]));
        expect(result.current.showSharedVoyageWarning?.voyageId).toBe('voyage-a');
        expect(result.current.deletedVoyage).toBeNull();
    });
});

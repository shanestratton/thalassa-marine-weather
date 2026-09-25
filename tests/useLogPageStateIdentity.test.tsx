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
    getArchivedSummaries: vi.fn(),
    getLifetimeSummaries: vi.fn(),
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
    cleanupUndeparted: vi.fn(),
    endVoyage: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

// confirmStopVoyage dynamically imports VoyageService to archive the voyages
// row when its track is stopped (the stop dialog IS "End Voyage") — resolve
// that import to the mock so tests never touch the real service graph.
vi.mock('../services/VoyageService', () => ({
    endVoyage: (...args: unknown[]) => mocks.endVoyage(...args),
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
        getArchivedVoyageSummaries: (...args: unknown[]) => mocks.getArchivedSummaries(...args),
        getLifetimeVoyageSummaries: (...args: unknown[]) => mocks.getLifetimeSummaries(...args),
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
        cleanupUndepartedRecordings: (...args: unknown[]) => mocks.cleanupUndeparted(...args),
        importGPXVoyage: vi.fn().mockResolvedValue({ savedCount: 0 }),
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useLogPageState, resetLogViewMemoForTest } from '../hooks/useLogPageState';
import { clearCachedVoyageTrack } from '../services/shiplog/VoyageTrackCache';

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
    mocks.cleanupUndeparted.mockResolvedValue([]);
    mocks.getCachedSummaries.mockImplementation(async () => (mocks.account === 'a' ? [summaryA] : []));
    mocks.getSummaries.mockImplementation(async () => (mocks.account === 'a' ? [summaryA] : []));
    mocks.getCurrentVoyageId.mockImplementation(() => (mocks.account === 'a' ? 'voyage-a' : undefined));
    mocks.getVoyageEntries.mockImplementation(async () => (mocks.account === 'a' ? [entryA] : []));
    mocks.getOfflineEntries.mockResolvedValue([]);
    mocks.getArchivedSummaries.mockReset().mockResolvedValue([]);
    mocks.getLifetimeSummaries.mockReset().mockImplementation(async () => (mocks.account === 'a' ? [summaryA] : []));
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
    mocks.endVoyage.mockResolvedValue(true);
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
    it('keeps lifetime totals and all personal records unchanged through archive and restore', async () => {
        const second = { ...summaryA, voyageId: 'voyage-b', totalDistanceNM: 20, avgSpeedKts: 7 };
        let active = [summaryA, second];
        let archived: typeof active = [];
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getSummaries.mockImplementation(async () => active);
        mocks.getArchivedSummaries.mockImplementation(async () => archived);
        mocks.getLifetimeSummaries.mockImplementation(async () => [...active, ...archived]);
        mocks.archiveVoyage.mockImplementation(async (id: string) => {
            archived = active.filter((voyage) => voyage.voyageId === id);
            active = active.filter((voyage) => voyage.voyageId !== id);
            return true;
        });
        mocks.unarchiveVoyage.mockImplementation(async () => {
            active = [...active, ...archived];
            archived = [];
            return true;
        });
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.voyageStats.voyageCount).toBe(2));
        const baseline = result.current.lifetimeStats;
        await act(async () => result.current.handleArchiveVoyage('voyage-a'));
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(1));
        expect(result.current.lifetimeStats).toEqual(baseline);
        await act(async () => result.current.handleUnarchiveVoyage('voyage-a'));
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(0));
        expect(result.current.lifetimeStats).toEqual(baseline);
        expect(mocks.getLogEntries).not.toHaveBeenCalled();
    });

    it('deduplicates overlapping active/archive summaries and does not count never-departed records', async () => {
        const waiting = { ...summaryA, voyageId: 'waiting', departedAt: null };
        mocks.getSummaries.mockResolvedValue([summaryA, waiting]);
        mocks.getArchivedSummaries.mockResolvedValue([summaryA, waiting]);
        mocks.getLifetimeSummaries.mockResolvedValue([summaryA, waiting]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(2));
        expect(result.current.voyageStats).toEqual({ totalNm: 2, totalMs: 3600_000, voyageCount: 1 });
        expect(result.current.lifetimeStats.records.voyageCount).toBe(1);
        expect(result.current.careerTotals.totalVoyages).toBe(1);
    });

    it('retains last complete lifetime totals on refresh failure and clears them across accounts', async () => {
        const archived = { ...summaryA, voyageId: 'archived', totalDistanceNM: 100 };
        mocks.getArchivedSummaries.mockResolvedValue([archived]);
        mocks.getLifetimeSummaries.mockResolvedValue([summaryA, archived]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.voyageStats.totalNm).toBe(102));
        const baseline = result.current.lifetimeStats;
        mocks.getArchivedSummaries.mockRejectedValue(new Error('offline'));
        mocks.getLifetimeSummaries.mockRejectedValue(new Error('offline'));
        await act(async () => result.current.reloadArchivedVoyages());
        expect(result.current.lifetimeStats).toEqual(baseline);
        expect(result.current.archiveError).not.toBeNull();
        expect(result.current.lifetimeError).not.toBeNull();
        expect(result.current.lifetimeLoaded).toBe(true);
        switchToB();
        expect(result.current.voyageStats).toEqual({ totalNm: 0, totalMs: 0, voyageCount: 0 });
        expect(result.current.lifetimeStats.records.voyageCount).toBe(0);
    });

    it('uses one whole-history aggregate for a voyage split across active and archived rows', async () => {
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getSummaries.mockResolvedValue([{ ...summaryA, entryCount: 1, totalDistanceNM: 1 }]);
        mocks.getArchivedSummaries.mockResolvedValue([{ ...summaryA, entryCount: 2, totalDistanceNM: 2 }]);
        const complete = {
            ...summaryA,
            entryCount: 3,
            startedAt: '2026-07-22T22:00:00.000Z',
            departedAt: '2026-07-22T22:00:00.000Z',
            totalDistanceNM: 3,
            avgSpeedKts: 5,
        };
        mocks.getLifetimeSummaries.mockResolvedValue([complete]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.lifetimeLoaded).toBe(true));
        expect(result.current.voyageStats).toEqual({ totalNm: 3, totalMs: 3 * 3600_000, voyageCount: 1 });
        expect(result.current.lifetimeStats.entryCount).toBe(3);
        expect(result.current.lifetimeStats.records.longestDurationMs).toBe(3 * 3600_000);
        expect(mocks.getLogEntries).not.toHaveBeenCalled();
    });

    it('does not replace complete lifetime history with partial active/archive lists after a read failure', async () => {
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getLifetimeSummaries.mockResolvedValue([{ ...summaryA, entryCount: 5000, totalDistanceNM: 100 }]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.lifetimeLoaded).toBe(true));
        mocks.getLifetimeSummaries.mockRejectedValue(new Error('page 2 failed'));
        mocks.getArchivedSummaries.mockResolvedValue([{ ...summaryA, entryCount: 2 }]);
        await act(async () => result.current.reloadArchivedVoyages());
        expect(result.current.lifetimeStats.entryCount).toBe(5000);
        expect(result.current.voyageStats.totalNm).toBe(100);
        expect(result.current.lifetimeError).not.toBeNull();
    });

    it('discards late lifetime history from the previous account', async () => {
        const pending = deferred<(typeof summaryA)[]>();
        mocks.getLifetimeSummaries.mockReturnValueOnce(pending.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.getLifetimeSummaries).toHaveBeenCalled());
        switchToB();
        await act(async () => pending.resolve([summaryA]));
        expect(result.current.voyageStats.voyageCount).toBe(0);
        expect(result.current.lifetimeStats.records.voyageCount).toBe(0);
    });

    it('honours a valid empty lifetime response instead of restoring old totals from archive cards', async () => {
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getArchivedSummaries.mockResolvedValue([summaryA]);
        mocks.getLifetimeSummaries.mockResolvedValue([]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.lifetimeLoaded).toBe(true));
        expect(result.current.archivedVoyages).toHaveLength(1);
        expect(result.current.voyageStats.voyageCount).toBe(0);
        expect(result.current.lifetimeError).toBeNull();
    });

    it('reloads complete lifetime totals if initial empty-track cleanup invalidates the first read', async () => {
        const pending = deferred<(typeof summaryA)[]>();
        const archived = { ...summaryA, voyageId: 'real-archived', totalDistanceNM: 100 };
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getLifetimeSummaries.mockReturnValueOnce(pending.promise).mockResolvedValue([archived]);
        mocks.cleanupUndeparted.mockResolvedValueOnce(['voyage-a']);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.lifetimeLoaded).toBe(true));
        expect(result.current.voyageStats).toMatchObject({ totalNm: 100, voyageCount: 1 });
        await act(async () => pending.resolve([summaryA, archived]));
        expect(result.current.voyageStats).toMatchObject({ totalNm: 100, voyageCount: 1 });
    });

    it('lists five complete archived voyages independently of their GPS point counts', async () => {
        const voyages = [820, 1043, 5691, 18286, 16018].map((entryCount, index) => ({
            ...summaryA,
            voyageId: `archive-${index}`,
            entryCount,
        }));
        mocks.getArchivedSummaries.mockResolvedValue(voyages);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toEqual(voyages));
        expect(result.current.archiveError).toBeNull();
        expect(result.current.archivesLoading).toBe(false);
    });

    it('retains the complete archive on a failed refresh, and exposes a retry error', async () => {
        mocks.getArchivedSummaries.mockResolvedValue([summaryA]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toEqual([summaryA]));
        mocks.getArchivedSummaries.mockRejectedValueOnce(new Error('network lost'));
        await act(async () => result.current.reloadArchivedVoyages());
        expect(result.current.archivedVoyages).toEqual([summaryA]);
        expect(result.current.archiveError).toContain('Couldn’t refresh');
        expect(result.current.archivesLoading).toBe(false);
        await act(async () => result.current.reloadArchivedVoyages());
        expect(result.current.archiveError).toBeNull();
    });

    it('discards an older archive read after a newer refresh completes', async () => {
        const older = deferred<(typeof summaryA)[]>();
        mocks.getArchivedSummaries.mockReturnValueOnce(older.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.getArchivedSummaries).toHaveBeenCalled());
        mocks.getArchivedSummaries.mockResolvedValue([summaryA]);
        await act(async () => result.current.reloadArchivedVoyages());
        await act(async () => older.resolve([]));
        expect(result.current.archivedVoyages).toEqual([summaryA]);
    });

    it('does not render an old account’s late archive response', async () => {
        const older = deferred<(typeof summaryA)[]>();
        mocks.getArchivedSummaries.mockReturnValueOnce(older.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.getArchivedSummaries).toHaveBeenCalled());
        switchToB();
        await act(async () => older.resolve([summaryA]));
        expect(result.current.archivedVoyages).toEqual([]);
        expect(result.current.archiveError).toBeNull();
    });

    it('restores all exact passage members, leaving unrelated archived voyages alone', async () => {
        const passage = ['a', 'b', 'c'].map((id) => ({ ...summaryA, voyageId: id, passageGroupId: 'north' }));
        const other = { ...summaryA, voyageId: 'other' };
        mocks.getArchivedSummaries.mockResolvedValue([...passage, other]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(4));
        mocks.getArchivedSummaries.mockResolvedValue([other]);
        await act(async () => result.current.handleRestorePassage('north', ['a', 'b', 'c']));
        expect(mocks.unarchiveVoyage.mock.calls).toEqual([['a'], ['b'], ['c']]);
        expect(result.current.archivedVoyages).toEqual([other]);
        expect(mocks.toastSuccess).toHaveBeenCalledWith('Passage restored · 3 legs');
    });

    it('reports a partial restore without dropping the failed archived legs', async () => {
        const passage = ['a', 'b', 'c'].map((id) => ({ ...summaryA, voyageId: id, passageGroupId: 'north' }));
        mocks.getArchivedSummaries.mockResolvedValue(passage);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(3));
        mocks.unarchiveVoyage
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('offline'));
        mocks.getArchivedSummaries.mockResolvedValue(passage.slice(1));
        await act(async () => {
            await expect(result.current.handleRestorePassage('north', ['a', 'b', 'c'])).rejects.toThrow(
                'Restored 1 of 3',
            );
        });
        expect(result.current.archivedVoyages.map((voyage) => voyage.voyageId)).toEqual(['b', 'c']);
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    it('immediately restores the summary and retains it through a stale Log refresh', async () => {
        const archived = { ...summaryA, voyageId: 'archived-only' };
        mocks.getArchivedSummaries.mockResolvedValue([archived]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toEqual([archived]));
        const refresh = deferred<(typeof summaryA)[]>();
        mocks.getSummaries.mockReturnValueOnce(refresh.promise);
        mocks.getArchivedSummaries.mockResolvedValue([]);
        await act(async () => result.current.handleUnarchiveVoyage(archived.voyageId));
        expect(result.current.archivedVoyages).toEqual([]);
        expect(result.current.summaries).toContainEqual(archived);
        await act(async () => refresh.resolve([summaryA]));
        expect(result.current.summaries).toContainEqual(archived);
        expect(result.current.summaries.filter((summary) => summary.voyageId === archived.voyageId)).toHaveLength(1);
    });

    it('does not restore a later leg which changed passage during the first restore', async () => {
        const passage = ['a', 'b'].map((id) => ({ ...summaryA, voyageId: id, passageGroupId: 'north' }));
        mocks.getArchivedSummaries.mockResolvedValue(passage);
        const first = deferred<boolean>();
        mocks.unarchiveVoyage.mockReturnValueOnce(first.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(2));
        let operation!: Promise<void>;
        act(() => {
            operation = result.current.handleRestorePassage('north', ['a', 'b']);
        });
        const moved = { ...passage[1], passageGroupId: 'south' };
        mocks.getArchivedSummaries.mockResolvedValue([passage[0], moved]);
        await act(async () => result.current.reloadArchivedVoyages());
        mocks.getArchivedSummaries.mockResolvedValue([moved]);
        await act(async () => {
            first.resolve(true);
            await expect(operation).rejects.toThrow('Restored 1 of 2');
        });
        expect(mocks.unarchiveVoyage.mock.calls).toEqual([['a']]);
        expect(result.current.archivedVoyages).toEqual([moved]);
    });

    it('does not repaint an archived summary from an older parallel Log read', async () => {
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.summaries).toEqual([summaryA]));
        await act(async () => result.current.loadData());
        const offline = deferred<never[]>();
        mocks.getOfflineEntries.mockReturnValueOnce(offline.promise);
        let refresh!: Promise<void>;
        act(() => {
            refresh = result.current.loadData();
        });
        mocks.getArchivedSummaries.mockResolvedValue([summaryA]);
        await act(async () => result.current.handleArchiveVoyage(summaryA.voyageId));
        expect(result.current.summaries).toEqual([]);
        await act(async () => {
            offline.resolve([]);
            await refresh;
        });
        expect(result.current.summaries).toEqual([]);
        expect(result.current.archivedVoyages).toEqual([summaryA]);
    });

    it('rejects unrelated/stale restore requests without writing', async () => {
        mocks.getArchivedSummaries.mockResolvedValue([{ ...summaryA, passageGroupId: 'north' }]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(1));
        await expect(result.current.handleRestorePassage('north', ['other'])).rejects.toThrow('archive has changed');
        await expect(result.current.handleUnarchiveVoyage('other')).rejects.toThrow('archive has changed');
        expect(mocks.unarchiveVoyage).not.toHaveBeenCalled();
    });

    it('stops restoring a passage when the account changes mid-operation', async () => {
        const passage = ['a', 'b'].map((id) => ({ ...summaryA, voyageId: id, passageGroupId: 'north' }));
        mocks.getArchivedSummaries.mockResolvedValue(passage);
        const first = deferred<boolean>();
        mocks.unarchiveVoyage.mockReturnValueOnce(first.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.archivedVoyages).toHaveLength(2));
        let operation!: Promise<void>;
        act(() => {
            operation = result.current.handleRestorePassage('north', ['a', 'b']);
        });
        await waitFor(() => expect(mocks.unarchiveVoyage).toHaveBeenCalledWith('a'));
        mocks.getArchivedSummaries.mockResolvedValue([]);
        switchToB();
        await act(async () => {
            first.resolve(true);
            await operation;
        });
        expect(mocks.unarchiveVoyage).toHaveBeenCalledTimes(1);
        expect(result.current.archivedVoyages).toEqual([]);
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });

    function seedPassage() {
        const passage = ['voyage-a', 'voyage-b', 'voyage-c'].map((voyageId) => ({
            ...summaryA,
            voyageId,
            passageGroupId: 'north',
        }));
        const summaries = [...passage, { ...summaryA, voyageId: 'unrelated' }];
        mocks.getCachedSummaries.mockImplementation(async () => (mocks.account === 'a' ? summaries : []));
        mocks.getSummaries.mockImplementation(async () => (mocks.account === 'a' ? summaries : []));
        return passage;
    }
    it('archives every confirmed passage member through the durable voyage workflow, not unrelated logs', async () => {
        seedPassage();
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
        await act(async () =>
            result.current.handleArchivePassage('north', ['voyage-a', 'voyage-b', 'voyage-c', 'voyage-a']),
        );
        expect(mocks.archiveVoyage.mock.calls).toEqual([['voyage-a'], ['voyage-b'], ['voyage-c']]);
        expect(result.current.listVoyages.map((voyage) => voyage.voyageId)).toEqual(['unrelated']);
        expect(mocks.toastSuccess).toHaveBeenCalledWith('Passage archived · 3 legs');
    });
    it('retains failed legs and reports partial completion without a success toast', async () => {
        seedPassage();
        mocks.archiveVoyage
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('offline intent failed'));
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
        await act(async () => result.current.handleArchivePassage('north', ['voyage-a', 'voyage-b', 'voyage-c']));
        expect(result.current.listVoyages.map((voyage) => voyage.voyageId)).toEqual(
            expect.arrayContaining(['voyage-b', 'voyage-c', 'unrelated']),
        );
        expect(result.current.listVoyages).toHaveLength(3);
        expect(mocks.toastError).toHaveBeenCalledWith(
            'Archived 1 of 3 legs. 2 legs remain in the Log. Please try the remaining legs again.',
        );
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
    });
    it.each(['recording', 'paused', 'remote'] as const)(
        'protects a %s passage before any archive writes',
        async (kind) => {
            seedPassage();
            const { result } = renderHook(() => useLogPageState());
            await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
            if (kind !== 'remote')
                mocks.getTrackingStatus.mockReturnValue({
                    isTracking: kind === 'recording',
                    isPaused: kind === 'paused',
                    currentVoyageId: 'voyage-b',
                });
            await act(async () =>
                result.current.handleArchivePassage(
                    'north',
                    ['voyage-a', 'voyage-b', 'voyage-c'],
                    (id) => kind === 'remote' && id === 'voyage-b',
                ),
            );
            expect(mocks.archiveVoyage).not.toHaveBeenCalled();
            expect(mocks.toastError).toHaveBeenCalledWith(
                'This passage is still recording. End the active voyage before archiving the passage.',
            );
        },
    );
    it('rejects a stale confirmation or unrelated voyage ID before archiving', async () => {
        seedPassage();
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
        await act(async () => result.current.handleArchivePassage('north', ['voyage-a', 'voyage-b', 'unrelated']));
        expect(mocks.archiveVoyage).not.toHaveBeenCalled();
        expect(mocks.toastError).toHaveBeenCalledWith('This passage has changed. Review its legs and try again.');
    });
    it('ignores a passage confirmation opened under the previous account', async () => {
        seedPassage();
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        const originalConfirmation = result.current.handleArchivePassage;
        switchToB();
        await act(async () => originalConfirmation('north', ['voyage-a', 'voyage-b', 'voyage-c']));
        expect(mocks.archiveVoyage).not.toHaveBeenCalled();
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it('stops a passage batch at the account boundary and suppresses stale announcements', async () => {
        seedPassage();
        const first = deferred<boolean>();
        mocks.archiveVoyage.mockReturnValueOnce(first.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
        let operation!: Promise<void>;
        act(() => {
            operation = result.current.handleArchivePassage('north', ['voyage-a', 'voyage-b', 'voyage-c']);
        });
        await waitFor(() => expect(mocks.archiveVoyage).toHaveBeenCalledWith('voyage-a'));
        switchToB();
        await act(async () => {
            first.resolve(true);
            await operation;
        });
        expect(mocks.archiveVoyage).toHaveBeenCalledTimes(1);
        expect(mocks.toastSuccess).not.toHaveBeenCalled();
        expect(mocks.toastError).not.toHaveBeenCalled();
    });
    it('does not archive a leg which starts recording while an earlier archive is in flight', async () => {
        seedPassage();
        const first = deferred<boolean>();
        mocks.archiveVoyage.mockReturnValueOnce(first.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.listVoyages).toHaveLength(4));
        let operation!: Promise<void>;
        act(() => {
            operation = result.current.handleArchivePassage('north', ['voyage-a', 'voyage-b', 'voyage-c']);
        });
        mocks.getTrackingStatus.mockReturnValue({ isTracking: true, isPaused: false, currentVoyageId: 'voyage-b' });
        await act(async () => {
            first.resolve(true);
            await operation;
        });
        expect(mocks.archiveVoyage.mock.calls).toEqual([['voyage-a'], ['voyage-c']]);
        expect(mocks.toastError).toHaveBeenCalledWith(
            'Archived 2 of 3 legs. 1 leg remains in the Log. Active recording was left untouched.',
        );
    });
    it('removes a verified never-departed card and its resident points after history cleanup', async () => {
        const sweep = deferred<string[]>();
        mocks.cleanupUndeparted.mockReturnValueOnce(sweep.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.cleanupUndeparted).toHaveBeenCalledWith([summaryA]));
        expect(result.current.state.summaries).toEqual([summaryA]);
        expect(result.current.state.entries).toEqual([entryA]);
        await act(async () => sweep.resolve(['voyage-a']));
        expect(result.current.state.summaries).toEqual([]);
        expect(result.current.state.entries).toEqual([]);
        expect(result.current.listVoyages).toEqual([]);
    });

    it('nominates stopped local-only recordings even when no cloud summary exists', async () => {
        const localId = 'voyage_1790124398484_local';
        const local = { ...entryA, id: 'offline_start', voyageId: localId };
        mocks.getSummaries.mockResolvedValue([]);
        mocks.getCachedSummaries.mockResolvedValue([]);
        mocks.getOfflineEntries.mockResolvedValue([local]);
        mocks.getVoyageEntries.mockResolvedValue([]);
        const sweep = deferred<string[]>();
        mocks.cleanupUndeparted.mockReturnValueOnce(sweep.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() =>
            expect(mocks.cleanupUndeparted).toHaveBeenCalledWith([
                expect.objectContaining({ voyageId: localId, entryCount: 1 }),
            ]),
        );
        // Nomination is not a deletion decision; only service verification
        // returning the id removes its card, never the displayed 0.0nm alone.
        expect(result.current.listVoyages.some((voyage) => voyage.voyageId === localId)).toBe(true);
        await act(async () => sweep.resolve([localId]));
        expect(result.current.listVoyages.some((voyage) => voyage.voyageId === localId)).toBe(false);
    });

    it('does not apply an old account’s cleanup completion after switching accounts', async () => {
        const sweep = deferred<string[]>();
        mocks.cleanupUndeparted.mockReturnValueOnce(sweep.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(mocks.cleanupUndeparted).toHaveBeenCalled());
        switchToB();
        await waitFor(() => expect(mocks.cleanupUndeparted).toHaveBeenCalledTimes(2));
        act(() => result.current.dispatch({ type: 'SET_SUMMARIES', summaries: [summaryA] }));
        await act(async () => sweep.resolve(['voyage-a']));
        expect(result.current.state.summaries).toEqual([summaryA]);
    });

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

    it.each(['handleStartTracking', 'startTrackingWithNewVoyage', 'continueLastVoyage'] as const)(
        'commits %s choice after the page unmounts while native start is pending',
        async (handler) => {
            const start = deferred<void>();
            mocks.startTracking.mockReturnValueOnce(start.promise);
            mocks.getCachedSummaries.mockResolvedValue([]);
            mocks.getSummaries.mockResolvedValue([]);
            const onStarted = vi.fn();
            const { result, unmount } = renderHook(() => useLogPageState(onStarted));
            await waitFor(() => expect(result.current.state.loading).toBe(false));
            act(() => {
                void result.current[handler]();
            });
            unmount();
            mocks.getTrackingStatus.mockReturnValue({ isTracking: true, currentVoyageId: 'started-voyage' });
            start.resolve();
            await waitFor(() => expect(onStarted).toHaveBeenCalledWith('started-voyage'));
            expect(onStarted).toHaveBeenCalledTimes(1);
        },
    );

    it('does not commit a previous account’s deferred recording choice', async () => {
        const start = deferred<void>();
        mocks.startTracking.mockReturnValueOnce(start.promise);
        const onStarted = vi.fn();
        const { result } = renderHook(() => useLogPageState(onStarted));
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        act(() => {
            void result.current.startTrackingWithNewVoyage();
        });
        switchToB();
        mocks.getTrackingStatus.mockReturnValue({ isTracking: true, currentVoyageId: 'account-b-voyage' });
        await act(async () => {
            start.resolve();
        });
        expect(onStarted).not.toHaveBeenCalled();
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

    it('collapses only the stopping voyage before leaving the compact live view and retains its entries', async () => {
        const stop = deferred<void>();
        const recordedEntries = [entryA, { ...entryA, id: 'entry-end', latitude: -27.5, longitude: 153.1 }];
        mocks.getVoyageEntries.mockResolvedValue(recordedEntries);
        mocks.stopTracking.mockReturnValueOnce(stop.promise);
        mocks.getTrackingStatus.mockReturnValue({ isTracking: true, isPaused: false, isRapidMode: false });
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.entries).toEqual(recordedEntries));
        expect(result.current.state.expandedVoyages.has('voyage-a')).toBe(true);
        act(() => result.current.dispatch({ type: 'TOGGLE_VOYAGE', voyageId: 'other-expanded-voyage' }));

        let ending!: Promise<void>;
        act(() => {
            ending = result.current.confirmStopVoyage();
        });
        try {
            expect(result.current.state.isTracking).toBe(false);
            expect(result.current.state.expandedVoyages.has('voyage-a')).toBe(false);
            expect(result.current.state.expandedVoyages.has('other-expanded-voyage')).toBe(true);
            expect(result.current.state.entries).toEqual(recordedEntries);
        } finally {
            mocks.getTrackingStatus.mockReturnValue({ isTracking: false, isPaused: false, isRapidMode: false });
            mocks.getCurrentVoyageId.mockReturnValue(undefined);
            stop.resolve();
            await act(async () => ending);
        }
        expect(result.current.state.expandedVoyages.has('voyage-a')).toBe(false);
        expect(result.current.state.entries).toEqual(recordedEntries);
    });

    it('does not start a second stop while the first native teardown is pending', async () => {
        const stop = deferred<void>();
        mocks.stopTracking.mockReturnValue(stop.promise);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.entries).toEqual([entryA]));
        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => {
            first = result.current.confirmStopVoyage();
            second = result.current.confirmStopVoyage();
        });
        try {
            expect(mocks.stopTracking).toHaveBeenCalledTimes(1);
        } finally {
            stop.resolve();
            await act(async () => Promise.all([first, second]));
        }
        expect(mocks.endVoyage).toHaveBeenCalledTimes(1);
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
        // A failed teardown must leave the voyages row active too.
        expect(mocks.endVoyage).not.toHaveBeenCalled();
    });

    it('stopping a cast-off voyage archives its voyages row — the dialog IS "End Voyage"', async () => {
        // Shane 2026-08-27: "i have to end voyage and archive. even though
        // i stopped the route in the log???" — the stop dialog promised
        // "End Voyage" but only stopped GPS.
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));

        await act(async () => result.current.confirmStopVoyage());

        expect(mocks.stopTracking).toHaveBeenCalledWith('voyage-a');
        expect(mocks.endVoyage).toHaveBeenCalledWith('voyage-a', 'completed');
        expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it('stopping a casual Log-page voyage archives nothing — local ids have no voyages row', async () => {
        mocks.getCurrentVoyageId.mockReturnValue('voyage_1724900000000_ab12cd34e');
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));

        await act(async () => result.current.confirmStopVoyage());

        expect(mocks.endVoyage).not.toHaveBeenCalled();
    });

    it('an unconfirmed archive on stop says so instead of pretending', async () => {
        mocks.endVoyage.mockResolvedValue(false);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));

        await act(async () => result.current.confirmStopVoyage());

        // endVoyage=false also means "already archived elsewhere" — the
        // toast must not assert the passage is still active.
        expect(mocks.toastError).toHaveBeenCalledWith(
            'Track stopped. The passage could not be confirmed as ended — if it still shows active, End Voyage from the Vessel tab.',
        );
    });

    it('ending a voyage completes its passage row and retains a locally empty track', async () => {
        mocks.getVoyageEntries.mockResolvedValue([{ ...entryA, cumulativeDistanceNM: 0, distanceNM: 0 }]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        mocks.deleteVoyage.mockClear();

        await act(async () => result.current.confirmStopVoyage());

        expect(mocks.endVoyage).toHaveBeenCalledWith('voyage-a', 'completed');
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
        expect(result.current.state.entries).toEqual([{ ...entryA, cumulativeDistanceNM: 0, distanceNM: 0 }]);
        expect(result.current.state.summaries).toEqual([summaryA]);
    });

    it('an unconfirmed passage completion still retains the locally empty track', async () => {
        mocks.endVoyage.mockResolvedValue(false);
        mocks.getVoyageEntries.mockResolvedValue([{ ...entryA, cumulativeDistanceNM: 0, distanceNM: 0 }]);
        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        mocks.deleteVoyage.mockClear();

        await act(async () => result.current.confirmStopVoyage());

        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
        expect(result.current.state.entries).toEqual([{ ...entryA, cumulativeDistanceNM: 0, distanceNM: 0 }]);
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
        // Pause ≠ stop: a moored-for-a-refuel pause must NEVER archive the
        // voyages row (VesselHub's Underway card depends on it).
        expect(mocks.endVoyage).not.toHaveBeenCalled();
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
        mocks.getSummaries.mockImplementation(() => new Promise<unknown[]>((resolve) => (releaseSummaries = resolve)));
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
describe('useLogPageState keeps history until an explicit delete', () => {
    it('opening and refreshing the Log retains cloud and offline-only zero-distance tracks', async () => {
        const emptyCloud = { ...summaryA, totalDistanceNM: 0, spanM: 0 };
        const emptyOffline = {
            ...entryA,
            id: 'offline-empty',
            voyageId: 'offline-empty',
            cumulativeDistanceNM: 0,
            distanceNM: 0,
        };
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getCachedSummaries.mockResolvedValue([emptyCloud]);
        mocks.getSummaries.mockResolvedValue([emptyCloud]);
        mocks.getOfflineEntries.mockResolvedValue([emptyOffline]);

        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        await act(async () => result.current.loadData());

        expect(result.current.listVoyages.map((voyage) => voyage.voyageId)).toEqual(['voyage-a', 'offline-empty']);
        expect(result.current.state.entries).toEqual([emptyOffline]);
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
        expect(clearCachedVoyageTrack).not.toHaveBeenCalled();
    });

    it('retains a 230 NM cloud passage and its cache with only one local arrival fix', async () => {
        const cloud = {
            ...summaryA,
            entryCount: 18_286,
            totalDistanceNM: 230.1,
            spanM: 300_000,
            startedAt: '2026-09-15T04:00:00.000Z',
            endedAt: '2026-09-17T10:00:00.000Z',
        };
        const tail = { ...entryA, timestamp: cloud.endedAt, cumulativeDistanceNM: 230.1 };
        mocks.getCurrentVoyageId.mockReturnValue(undefined);
        mocks.getCachedSummaries.mockResolvedValue([cloud]);
        mocks.getSummaries.mockResolvedValue([cloud]);
        mocks.getOfflineEntries.mockResolvedValue([tail]);

        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        await act(async () => result.current.loadData());

        expect(result.current.listVoyages).toEqual([cloud]);
        expect(result.current.state.entries).toEqual([tail]);
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
        expect(clearCachedVoyageTrack).not.toHaveBeenCalled();
    });

    it('End Voyage retains an empty track and preserves explicit delete and undo', async () => {
        const cloud = { ...summaryA, totalDistanceNM: 0, spanM: 0 };
        const point = { ...entryA, cumulativeDistanceNM: 0, distanceNM: 0 };
        mocks.getCachedSummaries.mockResolvedValue([cloud]);
        mocks.getSummaries.mockResolvedValue([cloud]);
        mocks.getVoyageEntries.mockResolvedValue([point]);
        mocks.stopTracking.mockImplementation(async () => {
            mocks.getCurrentVoyageId.mockReturnValue(undefined);
        });
        mocks.deleteVoyage.mockImplementation(async (_id: string, onAccepted?: () => void) => {
            onAccepted?.();
            return true;
        });

        const { result } = renderHook(() => useLogPageState());
        await waitFor(() => expect(result.current.state.loading).toBe(false));
        await act(async () => result.current.confirmStopVoyage());

        expect(mocks.stopTracking).toHaveBeenCalledWith('voyage-a');
        expect(result.current.state.entries).toEqual([point]);
        expect(result.current.state.summaries).toEqual([cloud]);
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();
        expect(clearCachedVoyageTrack).not.toHaveBeenCalled();

        await act(async () => result.current.handleDeleteVoyageRequest('voyage-a'));
        expect(result.current.state.summaries).toEqual([]);
        expect(result.current.deletedVoyage?.voyageId).toBe('voyage-a');
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();

        act(() => result.current.handleUndoDeleteVoyage());
        expect(result.current.state.entries).toEqual([point]);
        expect(result.current.state.summaries).toEqual([cloud]);
        expect(result.current.deletedVoyage).toBeNull();
        expect(mocks.deleteVoyage).not.toHaveBeenCalled();

        act(() => result.current.dispatch({ type: 'REQUEST_DELETE_VOYAGE', voyageId: 'voyage-a' }));
        await act(async () => result.current.handleConfirmDeleteVoyage());

        expect(mocks.deleteVoyage).toHaveBeenCalledWith('voyage-a', expect.any(Function));
        expect(result.current.state.entries).toEqual([]);
        expect(result.current.state.summaries).toEqual([]);
    });
});

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
        await waitFor(() => expect(result.current.lifetimeLoaded).toBe(true));
        const oldTotals = deferred<(typeof summaryA)[]>();
        mocks.getLifetimeSummaries.mockReturnValueOnce(oldTotals.promise);
        let oldRead!: Promise<void>;
        act(() => {
            oldRead = result.current.reloadArchivedVoyages();
        });

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
        expect(result.current.voyageStats.voyageCount).toBe(0);
        await act(async () => {
            oldTotals.resolve([summaryA]);
            await oldRead;
        });
        expect(result.current.voyageStats.voyageCount).toBe(0);
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

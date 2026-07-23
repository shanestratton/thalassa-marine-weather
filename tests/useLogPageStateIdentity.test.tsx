import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
        stopTracking: vi.fn().mockResolvedValue(undefined),
        pauseTracking: vi.fn().mockResolvedValue(undefined),
        setRapidMode: vi.fn().mockResolvedValue(undefined),
        setPrecisionMode: vi.fn().mockResolvedValue(undefined),
        archiveVoyage: (...args: unknown[]) => mocks.archiveVoyage(...args),
        unarchiveVoyage: (...args: unknown[]) => mocks.unarchiveVoyage(...args),
        deleteEntry: (...args: unknown[]) => mocks.deleteEntry(...args),
        deleteVoyage: (...args: unknown[]) => mocks.deleteVoyage(...args),
        importGPXVoyage: vi.fn().mockResolvedValue({ savedCount: 0 }),
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useLogPageState } from '../hooks/useLogPageState';

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
    mocks.account = 'a';
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

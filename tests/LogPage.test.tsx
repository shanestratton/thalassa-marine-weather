/**
 * LogPage — component tests.
 *
 * LogPage depends on useLogPageState hook and many sub-components.
 * We mock the heavy dependencies and test rendering & key interactions.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const logPageStateOverrides = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    hook: {} as Record<string, unknown>,
}));

const followRouteMock = vi.hoisted(() => {
    const state = {
        isFollowing: false,
        voyageId: null as string | null,
        routeCoords: [] as Array<{ lat: number; lon: number }>,
        startedAt: null as string | null,
        startFollowing: vi.fn(),
        stopFollowing: vi.fn(),
    };
    state.startFollowing.mockImplementation(
        (_plan: unknown, voyageId: string, routeCoords: Array<{ lat: number; lon: number }>) => {
            state.isFollowing = true;
            state.voyageId = voyageId;
            state.routeCoords = routeCoords;
            state.startedAt = '2026-07-23T00:00:00.000Z';
        },
    );
    state.stopFollowing.mockImplementation(() => {
        state.isFollowing = false;
        state.voyageId = null;
        state.routeCoords = [];
        state.startedAt = null;
    });
    const hook = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
        getState: () => state,
    });
    return { state, hook };
});

const fetchVoyageAsTrackMock = vi.hoisted(() => vi.fn());
const publishFollowedRouteMock = vi.hoisted(() => vi.fn());
const clearFollowedRouteMock = vi.hoisted(() => vi.fn(async () => true));
const traceDirectUseBlockReasonMock = vi.hoisted(() => vi.fn((_route?: unknown) => null as string | null));
/** Build 124: the non-red verdict a linked trace gets (green by default). */
/** A row's Check now on a route only the account holds (build 124 review). */
const fetchSavedRoutePointsMock = vi.hoisted(() => vi.fn());
const enqueueTraceChecksSpy = vi.hoisted(() => vi.fn());
const traceDirectUseAmberMock = vi.hoisted(() => ({
    value: { tone: 'checked', code: 'ok', reason: null } as { tone: string; code: string; reason: string | null },
}));
const gpsHealthMock = vi.hoisted(() => ({
    value: null as null | { usable: boolean; reason: string; actionable: boolean },
}));
const acquireFreshOwnshipPositionMock = vi.hoisted(() => vi.fn());
/** The Start's source plan (services/shiplog/trackSourceInputs); a phone-only punter unless a test says otherwise. */
const sourcePlanMock = vi.hoisted(() => {
    const phonePlan = {
        source: 'phone',
        lane: 'none',
        where: 'unknown',
        keepAlive: 'always-advised',
        showPhoneNotice: true,
        standIn: 'allowed',
        standInOptIn: false,
        phoneAccessory: false,
    };
    return { phonePlan, resolve: vi.fn(async () => ({ ...phonePlan }) as Record<string, unknown>) };
});
const activeVoyageMock = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
/** The live voyage's stand-in question and location caution, as ShipLogService reports them (build 123). */
const liveVoyageMock = vi.hoisted(() => ({
    standInPending: false,
    advisory: null as string | null,
    answer: vi.fn(async (_answer: 'phone' | 'wait') => undefined),
}));
const shipLogHandoffMock = vi.hoisted(() => ({
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    getTrackingStatus: vi.fn(() => ({ isTracking: false, currentVoyageId: null as string | null })),
}));

// ── Mock services & context ──
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { units: { speed: 'kts', temp: 'C', length: 'ft', distance: 'nm' }, isPro: true },
        updateSettings: vi.fn(),
    }),
}));

vi.mock('../services/weatherService', () => ({
    reverseGeocode: vi.fn().mockResolvedValue('Test Port'),
}));

vi.mock('../services/weather/api/geocoding', () => ({
    reverseGeocodeContext: vi.fn().mockResolvedValue({ name: 'Test Port', country: 'AU' }),
}));

vi.mock('../components/Toast', () => ({
    useToast: () => ({
        showToast: vi.fn(),
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        ToastContainer: () => null,
    }),
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: followRouteMock.hook,
}));

vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchVoyageAsTrack: fetchVoyageAsTrackMock,
    groupByVoyage: vi.fn(() => []),
}));

vi.mock('../services/VoyageService', () => ({
    getActiveVoyage: vi.fn(async () => activeVoyageMock.value),
}));

vi.mock('../services/routeTracer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/routeTracer')>()),
    // The cast-off handoff resolves the planned-route mirror id from the
    // saved trace before publishing to the public page.
    loadSavedTraces: () => [
        {
            id: 'route-x',
            name: 'Mackay → Airlie',
            createdAt: '2026-08-20T00:00:00Z',
            points: [
                { lat: -21.1, lon: 149.2 },
                { lat: -20.3, lon: 148.7 },
            ],
            plannedRouteId: 'planned-x',
        },
    ],
}));

vi.mock('../services/savedRoutePoints', () => ({
    fetchSavedRoutePoints: (...args: unknown[]) => fetchSavedRoutePointsMock(...args),
}));

vi.mock('../services/traceBackgroundCheck', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/traceBackgroundCheck')>();
    return {
        ...real,
        enqueueTraceChecks: (...args: Parameters<typeof real.enqueueTraceChecks>) => {
            enqueueTraceChecksSpy(...args);
            return real.enqueueTraceChecks(...args);
        },
    };
});

vi.mock('../services/shiplog/publishFollowedRoute', () => ({
    publishFollowedRoute: publishFollowedRouteMock,
    // The page publishes through the detailed form (authorship 2026-09-08);
    // these tests drive the same result strings through the plain mock.
    publishFollowedRouteDetailed: async (planVoyageId: string, opts?: { forVoyageId?: string; replace?: boolean }) => ({
        result: await (opts?.forVoyageId || opts?.replace
            ? publishFollowedRouteMock(planVoyageId, opts)
            : publishFollowedRouteMock(planVoyageId)),
    }),
    clearFollowedRoute: clearFollowedRouteMock,
}));

vi.mock('../services/traceDirectUseGate', () => ({
    tracedRouteDirectUseBlockReason: traceDirectUseBlockReasonMock,
    // A red finding (the block-reason mock) refuses until accepted; anything
    // else is the amber/green value — amber never blocks (build 124).
    tracedRouteDirectUseStatus: (route: unknown, opts?: { acceptFinding?: boolean }) => {
        const red = traceDirectUseBlockReasonMock(route);
        if (red) return { tone: 'finding', code: 'finding', reason: red, blocked: opts?.acceptFinding !== true };
        return { ...traceDirectUseAmberMock.value, blocked: false };
    },
    // Identity: these tests exercise the gate's VERDICT, not the geometry
    // substitution (that has its own suite). Returning the route unchanged
    // keeps them asserting what they were written to assert.
    tracedRouteFollowGeometry: <T,>(route: T): T => route,
    // The picker filter's link sources — empty/permissive here so every
    // seeded plan stays offered; the filter has its own suite.
    localTraceLinkByVoyageId: () => new Map<string, string>(),
    savedTraceFollowStatus: () => ({ tone: 'checked', code: 'ok', reason: null }),
    // No trip grouping in these fixtures, so every offered route is a day sail
    // and the sheet renders the flat shape these tests were written against.
    // The grouping has its own suite.
    tripIdentityByTraceId: () => new Map(),
}));

vi.mock('../hooks/useGpsHealth', () => ({
    useGpsHealth: () => gpsHealthMock.value,
    gpsHealthMessage: (reason: string) =>
        reason === 'denied' ? { title: 'Location access is off', detail: 'Nothing is being recorded.' } : null,
    openDeviceSettings: vi.fn(),
}));

vi.mock('../services/ownshipPosition', () => ({
    acquireFreshOwnshipPosition: acquireFreshOwnshipPositionMock,
}));

vi.mock('../services/shiplog/trackSourceInputs', () => ({
    resolveTrackSourcePlan: sourcePlanMock.resolve,
}));

vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: (fn: () => Promise<{ default: React.ComponentType }>) => React.lazy(fn),
}));

// ── Mock heavy sub-components (paths relative to pages/LogPage.tsx) ──
vi.mock('../components/AddEntryModal', () => ({ AddEntryModal: () => null }));
vi.mock('../components/EditEntryModal', () => ({ EditEntryModal: () => null }));
vi.mock('../components/TrackMapViewer', () => ({
    TrackMapViewer: ({
        isOpen,
        entries,
        followedRouteCoords,
    }: {
        isOpen: boolean;
        entries?: Array<{ voyageId?: string }>;
        followedRouteCoords?: Array<{ lat: number; lon: number }>;
    }) =>
        isOpen ? (
            <div
                data-testid="track-map"
                data-followed-route={JSON.stringify(followedRouteCoords ?? [])}
                data-entry-voyages={JSON.stringify((entries ?? []).map((entry) => entry.voyageId))}
            >
                TrackMap
            </div>
        ) : null,
}));
vi.mock('../components/LiveMiniMap', () => ({
    LiveMiniMap: ({
        followedRouteCoords,
        freeZoom,
    }: {
        followedRouteCoords?: Array<{ lat: number; lon: number }>;
        freeZoom?: boolean;
    }) => (
        <div
            data-testid={freeZoom ? 'large-live-map' : 'small-live-map'}
            data-followed-route={JSON.stringify(followedRouteCoords ?? [])}
        >
            LiveMap
        </div>
    ),
}));
vi.mock('../components/DeleteVoyageModal', () => ({ DeleteVoyageModal: () => null }));
vi.mock('../components/CommunityTrackBrowser', () => ({ CommunityTrackBrowser: () => null }));
vi.mock('../components/VoyageStatsPanel', () => ({
    VoyageStatsPanel: ({ entries }: { entries: Array<{ voyageId?: string }> }) => (
        <div data-testid="voyage-stats" data-entry-voyages={JSON.stringify(entries.map((entry) => entry.voyageId))}>
            Stats
        </div>
    ),
}));
vi.mock('../components/ui/SlideToAction', () => ({
    SlideToAction: ({
        label,
        onConfirm,
        loading,
        loadingText,
    }: {
        label: string;
        onConfirm: () => void;
        loading?: boolean;
        loadingText?: string;
    }) => (
        <button data-testid="slide-to-action" onClick={onConfirm} disabled={loading}>
            {loading ? loadingText : label}
        </button>
    ),
}));
vi.mock('../components/ui/UndoToast', () => ({ UndoToast: () => null }));
vi.mock('../components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../components/Icons', () => ({
    PlayIcon: () => <span>▶</span>,
    StopIcon: () => <span>■</span>,
    MapPinIcon: () => <span>📍</span>,
}));

// Sub-components from pages/log/ — use path relative to test file
vi.mock('../pages/log/LogSubComponents', () => ({
    VoyageCard: ({
        summary,
        onFollowPlannedRoute,
    }: {
        summary: { voyageId: string; isPlannedRoute?: boolean };
        onFollowPlannedRoute: (summary: unknown) => Promise<boolean>;
    }) => (
        <div data-testid={`voyage-${summary.voyageId}`}>
            Voyage {summary.voyageId}
            {summary.isPlannedRoute && (
                <button onClick={() => void onFollowPlannedRoute(summary)}>Follow card {summary.voyageId}</button>
            )}
        </div>
    ),
    StatBox: ({ label }: { label: string }) => <div data-testid="stat-box">{label}</div>,
    MenuBtn: ({ label, onClick }: { label: string; onClick: () => void }) => (
        <button onClick={onClick} data-testid={`menu-${label}`}>
            {label}
        </button>
    ),
    FollowRouteChoice: ({
        summary,
        onPick,
        onCheckNow,
    }: {
        summary: { voyageId: string };
        onPick: (accept?: boolean) => void;
        onCheckNow?: () => void;
    }) => (
        <>
            <button onClick={() => onPick()}>Follow route {summary.voyageId}</button>
            <button onClick={() => onPick(true)}>Follow anyway {summary.voyageId}</button>
            {onCheckNow && <button onClick={onCheckNow}>Check now {summary.voyageId}</button>}
        </>
    ),
}));
vi.mock('../pages/log/VoyageDialogs', () => ({ VoyageChoiceDialog: () => null, StopVoyageDialog: () => null }));
vi.mock('../pages/log/ExportSheet', () => ({ ExportSheet: () => null }));
// A stand-in with the real dialog's name and its one decision, so the page's
// gating (shown or not, and what happens after) is what these tests see.
vi.mock('../pages/log/GpsDisclaimerModal', () => ({
    GpsDisclaimerModal: ({
        isOpen,
        onDismiss,
        alwaysAdvice,
    }: {
        isOpen: boolean;
        onDismiss: (dontShowAgain: boolean) => void;
        alwaysAdvice?: boolean;
    }) =>
        isOpen ? (
            <div role="dialog" aria-label="Logging from this phone" data-always-advice={String(!!alwaysAdvice)}>
                <button onClick={() => onDismiss(false)}>Start tracking</button>
            </div>
        ) : null,
}));
vi.mock('../pages/log/ImportSheet', () => ({ ImportSheet: () => null }));
vi.mock('../pages/log/ShareSheet', () => ({ ShareSheet: () => null }));
vi.mock('../pages/log/ShareFormSheet', () => ({ ShareFormSheet: () => null }));
vi.mock('../pages/log/StatsSheet', () => ({
    StatsSheet: ({ voyageGroups }: { voyageGroups: Array<{ voyageId: string }> }) => (
        <div data-testid="stats-sheet" data-voyages={JSON.stringify(voyageGroups.map((voyage) => voyage.voyageId))} />
    ),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        initialize: vi.fn(),
        getCurrentVoyageId: vi.fn(() => null),
        getEngineRunning: vi.fn(() => undefined),
        setEngineRunning: vi.fn(),
        getTrackingStatus: shipLogHandoffMock.getTrackingStatus,
        startTracking: shipLogHandoffMock.startTracking,
        stopTracking: shipLogHandoffMock.stopTracking,
        subscribeStandInQuestion: () => () => {},
        isStandInQuestionPending: () => liveVoyageMock.standInPending,
        answerStandInQuestion: liveVoyageMock.answer,
        getLocationAdvisory: () => liveVoyageMock.advisory,
    },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: { get: vi.fn().mockResolvedValue({ value: null }), set: vi.fn(), remove: vi.fn() },
}));

// ── Mock the consolidated hook — MUST match full public API ──
vi.mock('../hooks/useLogPageState', () => ({
    useLogPageState: vi.fn(() => ({
        state: {
            entries: [],
            isTracking: false,
            isPaused: false,
            isRapidMode: false,
            loading: false,
            showAddModal: false,
            showTrackMap: false,
            showStats: false,
            showStopVoyageDialog: false,
            showVoyageChoiceDialog: false,
            showCommunityBrowser: false,
            actionSheet: null,
            editEntry: null,
            selectedVoyageId: null,
            deleteVoyageId: null,
            currentVoyageId: undefined,
            lastVoyageId: null,
            expandedVoyages: new Set(),
            gpsStatus: 'none' as const,
            filters: { types: ['auto', 'manual', 'waypoint'], searchQuery: '' },
            summaries: [],
            ...logPageStateOverrides.state,
        },
        dispatch: vi.fn(),
        settings: { units: { speed: 'kts', temp: 'C', length: 'ft', distance: 'nm' }, isPro: true },
        handleStartTracking: vi.fn(),
        startTrackingWithNewVoyage: vi.fn(),
        continueLastVoyage: vi.fn(),
        handlePauseTracking: vi.fn(),
        handleToggleRapidMode: vi.fn(),
        handleStopTracking: vi.fn(),
        confirmStopVoyage: vi.fn(),
        handleDeleteEntry: vi.fn(),
        handleUndoDeleteEntry: vi.fn(),
        handleDismissDeleteEntry: vi.fn(),
        deletedEntry: null,
        handleEditEntry: vi.fn(),
        handleSaveEdit: vi.fn(),
        loadData: vi.fn(),
        toggleVoyage: vi.fn(),
        handleDeleteVoyageRequest: vi.fn(),
        handleConfirmDeleteVoyage: vi.fn(),
        deletedVoyage: null,
        handleUndoDeleteVoyage: vi.fn(),
        handleDismissDeleteVoyage: vi.fn(),
        showSharedVoyageWarning: null,
        confirmDeleteSharedVoyage: vi.fn(),
        cancelDeleteSharedVoyage: vi.fn(),
        handleExportCSV: vi.fn(),
        handleShare: vi.fn(),
        handleExportThenDelete: vi.fn(),
        handleExportGPX: vi.fn(),
        handleImportGPXFile: vi.fn(),
        handleShareToCommunity: vi.fn(),
        filteredEntries: [],
        groupedEntries: [],
        entryCounts: { auto: 0, manual: 0, waypoint: 0 },
        voyageGroups: [
            {
                voyageId: 'v1',
                entries: [
                    {
                        id: 'e1',
                        timestamp: '2026-01-01T00:00:00Z',
                        voyageId: 'v1',
                        lat: -27.5,
                        lon: 153,
                        speedKts: 6,
                        cumulativeDistanceNM: 12,
                    },
                ],
            },
            {
                voyageId: 'v2',
                entries: [
                    {
                        id: 'e2',
                        timestamp: '2026-01-05T00:00:00Z',
                        voyageId: 'v2',
                        lat: -20,
                        lon: 148,
                        speedKts: 5,
                        cumulativeDistanceNM: 50,
                    },
                ],
            },
        ],
        // sailedVoyageGroups: the SAILED subset used for the stats
        // tiles. Both mock voyages are device-sourced (no planned_route),
        // so it mirrors voyageGroups here. Added 2026-06-08 — the mock
        // had drifted out of sync with the hook's public API after
        // commit 51bbe6d2 introduced this field, which crashed the page
        // (sailedVoyageGroups.reduce on undefined).
        sailedVoyageGroups: [
            {
                voyageId: 'v1',
                entries: [
                    {
                        id: 'e1',
                        timestamp: '2026-01-01T00:00:00Z',
                        voyageId: 'v1',
                        lat: -27.5,
                        lon: 153,
                        speedKts: 6,
                        cumulativeDistanceNM: 12,
                    },
                ],
            },
            {
                voyageId: 'v2',
                entries: [
                    {
                        id: 'e2',
                        timestamp: '2026-01-05T00:00:00Z',
                        voyageId: 'v2',
                        lat: -20,
                        lon: 148,
                        speedKts: 5,
                        cumulativeDistanceNM: 50,
                    },
                ],
            },
        ],
        // Summary-driven list + stats (the new Stage-2 contract)
        summaries: [
            { voyageId: 'v1', entryCount: 1, isPlannedRoute: false, isImported: false },
            { voyageId: 'v2', entryCount: 1, isPlannedRoute: false, isImported: false },
        ],
        listVoyages: [
            {
                voyageId: 'v1',
                entryCount: 1,
                startedAt: '2026-01-01T00:00:00Z',
                endedAt: '2026-01-01T02:00:00Z',
                totalDistanceNM: 12,
                avgSpeedKts: 6,
                hasManual: false,
                isPlannedRoute: false,
                isImported: false,
                firstLat: -27.5,
                firstLon: 153,
                lastLat: -27.6,
                lastLon: 153.1,
                firstIsOnWater: true,
            },
            {
                voyageId: 'v2',
                entryCount: 1,
                startedAt: '2026-01-05T00:00:00Z',
                endedAt: '2026-01-05T05:00:00Z',
                totalDistanceNM: 50,
                avgSpeedKts: 5,
                hasManual: false,
                isPlannedRoute: false,
                isImported: false,
                firstLat: -20,
                firstLon: 148,
                lastLat: -20.5,
                lastLon: 148.5,
                firstIsOnWater: true,
            },
        ],
        voyageStats: { totalNm: 62, totalMs: 25200000, voyageCount: 2 },
        lifetimeLoading: false,
        lifetimeError: null,
        lifetimeLoaded: true,
        lifetimeStats: {
            summaries: [],
            totals: { totalNm: 62, totalMs: 25200000, voyageCount: 2 },
            records: {
                longestPassageNM: 50,
                longestPassageVoyageId: 'v2',
                fastestAvgKts: 6,
                fastestVoyageId: 'v1',
                longestDurationMs: 18000000,
                longestDurationVoyageId: 'v2',
                voyageCount: 2,
            },
            careerTotals: { totalDistance: 62, totalTimeAtSeaHrs: 7, totalVoyages: 2 },
            entryCount: 2,
        },
        loadVoyageEntries: vi.fn(),
        loadAllEntries: vi.fn(),
        hasNonDeviceEntries: false,
        totalDistance: 62,
        avgSpeed: 5.5,
        careerTotals: { totalDistance: 62, totalTimeAtSeaHrs: 12, totalVoyages: 2 },
        archivedVoyages: [],
        archivesLoading: false,
        archiveError: null,
        reloadArchivedVoyages: vi.fn(),
        handleArchiveVoyage: vi.fn(),
        handleArchivePassage: vi.fn().mockResolvedValue(undefined),
        handleUnarchiveVoyage: vi.fn().mockResolvedValue(undefined),
        handleRestorePassage: vi.fn().mockResolvedValue(undefined),
        ...logPageStateOverrides.hook,
    })),
}));

import { LogPage, resetFollowPromptGuardsForTest } from '../pages/LogPage';
import { useLogPageState } from '../hooks/useLogPageState';
import {
    castOffHandoffIdle,
    clearCastOffHandoff,
    peekCastOffHandoff,
    stashCastOffHandoff,
    updateCastOffHandoff,
} from '../services/castOffHandoff';

describe('LogPage', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        resetFollowPromptGuardsForTest();
        localStorage.clear();

        vi.clearAllMocks();
        for (const key of Object.keys(logPageStateOverrides.state)) delete logPageStateOverrides.state[key];
        for (const key of Object.keys(logPageStateOverrides.hook)) delete logPageStateOverrides.hook[key];
        Object.assign(followRouteMock.state, {
            isFollowing: false,
            voyageId: null,
            routeCoords: [],
            startedAt: null,
        });
        fetchVoyageAsTrackMock.mockResolvedValue(null);
        publishFollowedRouteMock.mockResolvedValue('linked');
        traceDirectUseBlockReasonMock.mockReturnValue(null);
        traceDirectUseAmberMock.value = { tone: 'checked', code: 'ok', reason: null };
        gpsHealthMock.value = null;
        sourcePlanMock.resolve.mockImplementation(async () => ({ ...sourcePlanMock.phonePlan }));
        liveVoyageMock.standInPending = false;
        liveVoyageMock.advisory = null;
        liveVoyageMock.answer.mockClear();
        acquireFreshOwnshipPositionMock.mockResolvedValue({
            lat: -27.5,
            lon: 153,
            sog: 0,
            cog: 0,
            timestamp: Date.now(),
            source: 'gps',
        });
    });

    it('renders without crashing', () => {
        const { container } = render(<LogPage />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<LogPage />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('renders voyage cards when voyages exist', () => {
        render(<LogPage />);
        expect(screen.getByTestId('voyage-v1')).toBeDefined();
        expect(screen.getByTestId('voyage-v2')).toBeDefined();
    });

    it('keeps all six metrics behind the Voyage stats roll-up without hiding the logs', () => {
        logPageStateOverrides.state.summaries = ['v1', 'v2'].map((voyageId) => ({
            voyageId,
            totalDistanceNM: 12,
            entryCount: 100,
            avgSpeedKts: 5,
            startedAt: '2026-09-22T00:00:00Z',
            endedAt: '2026-09-22T03:00:00Z',
        }));
        render(<LogPage />);
        const toggle = screen.getByRole('button', { name: 'Voyage stats' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
        expect(screen.queryByText('Distance')).not.toBeInTheDocument();
        expect(screen.getByTestId('voyage-v1')).toBeVisible();
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const sheet = screen.getByRole('dialog', { name: 'Voyage stats' });
        for (const label of ['Distance', 'Sea Time', 'Voyages', 'Farthest', 'Fastest avg', 'Longest']) {
            expect(within(sheet).getByText(label)).toBeVisible();
        }
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
        expect(screen.queryByText('Longest')).not.toBeInTheDocument();
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows actual and imported tracks but hides planned routes from the main Log list', () => {
        logPageStateOverrides.hook.listVoyages = [
            {
                voyageId: 'actual-voyage',
                isPlannedRoute: false,
                isImported: false,
            },
            {
                voyageId: 'planned-voyage',
                isPlannedRoute: true,
                isImported: false,
            },
            {
                voyageId: 'imported-track',
                isPlannedRoute: false,
                isImported: true,
            },
        ];
        logPageStateOverrides.state.summaries = logPageStateOverrides.hook.listVoyages;

        render(<LogPage />);

        expect(screen.getByTestId('voyage-actual-voyage')).toBeInTheDocument();
        expect(screen.getByTestId('voyage-imported-track')).toBeInTheDocument();
        expect(screen.queryByTestId('voyage-planned-voyage')).not.toBeInTheDocument();
    });

    it('shows the genuine empty Log state when only planned routes exist', () => {
        const planned = {
            voyageId: 'planned-only',
            isPlannedRoute: true,
            isImported: false,
        };
        logPageStateOverrides.hook.listVoyages = [planned];
        logPageStateOverrides.state.summaries = [planned];

        render(<LogPage />);

        expect(screen.getByRole('heading', { name: 'Begin your log' })).toBeInTheDocument();
        expect(screen.queryByTestId('voyage-planned-only')).not.toBeInTheDocument();
    });

    it('hides a route when entry provenance is newer than a stale non-planned summary', () => {
        const staleSummary = {
            voyageId: 'stale-planned-route',
            isPlannedRoute: false,
            isImported: false,
        };
        logPageStateOverrides.hook.listVoyages = [staleSummary];
        Object.assign(logPageStateOverrides.state, {
            summaries: [staleSummary],
            entries: [
                {
                    id: 'planned-entry',
                    voyageId: 'stale-planned-route',
                    source: 'planned_route',
                },
            ],
        });

        render(<LogPage />);

        expect(screen.getByRole('heading', { name: 'Begin your log' })).toBeInTheDocument();
        expect(screen.queryByTestId('voyage-stale-planned-route')).not.toBeInTheDocument();
    });

    it('hides planned routes from the archived Log count and rows', () => {
        logPageStateOverrides.hook.archivedVoyages = [
            {
                voyageId: 'actual-archive',
                entryCount: 3,
                isPlannedRoute: false,
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T02:00:00.000Z',
                totalDistanceNM: 8,
            },
            {
                voyageId: 'planned-archive',
                entryCount: 3,
                isPlannedRoute: true,
                startedAt: '2026-01-02T00:00:00.000Z',
                endedAt: '2026-01-02T02:00:00.000Z',
                totalDistanceNM: 12,
            },
        ];

        render(<LogPage />);

        // The expander is named by its visible text now (the placeholder
        // aria-label went 2026-09-03; it announces aria-expanded instead).
        const toggle = screen.getByRole('button', { name: /Archived voyages/i });
        expect(toggle).toHaveTextContent('1');
        fireEvent.click(toggle);
        expect(screen.getAllByRole('button', { name: /^Restore voyage/ })).toHaveLength(1);
    });

    it('keeps the archive close to hand instead of showing a first-voyage welcome when everything is archived', () => {
        logPageStateOverrides.hook.listVoyages = [];
        logPageStateOverrides.hook.archivedVoyages = [{ voyageId: 'past', isPlannedRoute: false }];
        render(<LogPage />);
        expect(screen.queryByText('Begin your log')).not.toBeInTheDocument();
        expect(screen.queryByTestId('log-watermark')).not.toBeInTheDocument();
        expect(screen.getByText('Your past voyages are in the archive above.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Archived voyages/i })).toHaveTextContent('1 voyage');
    });

    it('anchors Voyage stats and Archived voyages above the free-scrolling voyage list, and each opens its sheet', () => {
        // Shane 2026-10-06: "can we make the voyage stats and the archive
        // voyages anchored to the page and also make them look the same as the
        // diary and scuttlebutt boxes for consistency".
        render(<LogPage />);
        const history = screen.getByRole('region', { name: 'Voyage history' });
        const archive = screen.getByRole('button', { name: 'Archived voyages' });
        const stats = screen.getByRole('button', { name: 'Voyage stats' });
        // Outside the scroll region, side by side in one fixed pair, before it.
        expect(history).not.toContainElement(archive);
        expect(history).not.toContainElement(stats);
        expect(history).toContainElement(screen.getByTestId('voyage-v1'));
        const pair = stats.parentElement!;
        expect(pair).toContainElement(archive);
        expect(pair).toHaveClass('log-journal-pair', 'vessel-hub-journal', 'grid-cols-2', 'shrink-0');
        expect(pair.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The Vessel page's Diary/Scuttlebutt card.
        for (const card of [stats, archive]) expect(card).toHaveClass('vessel-hub-tile');
        expect(history).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-y-contain');
        expect(history.className).not.toMatch(/snap-(?:y|mandatory|proximity)/);
        fireEvent.click(stats);
        const statsSheet = screen.getByRole('dialog', { name: 'Voyage stats' });
        expect(within(statsSheet).getByText('Distance')).toBeVisible();
        fireEvent.click(within(statsSheet).getByRole('button', { name: 'Close' }));
        fireEvent.click(archive);
        expect(archive).toHaveAttribute('aria-expanded', 'true');
        const archiveSheet = screen.getByRole('dialog', { name: 'Archived voyages' });
        expect(within(archiveSheet).getByText('No archived voyages')).toBeVisible();
        expect(archive).toHaveAccessibleDescription('None yet');
    });

    it('never reopens the archive sheet by itself: not on a tab-bounce, not when recording stops', () => {
        // Split view keeps the tab bar live beside the pane-scoped sheet, so
        // Plan → Log remounts the page with the sheet left open (2026-10-06).
        const first = render(<LogPage />);
        fireEvent.click(screen.getByRole('button', { name: 'Archived voyages' }));
        expect(screen.getByRole('dialog', { name: 'Archived voyages' })).toBeInTheDocument();
        first.unmount();
        const { rerender } = render(<LogPage />);
        expect(screen.queryByRole('dialog', { name: 'Archived voyages' })).not.toBeInTheDocument();
        // Recording starts with the sheet up, then stops.
        fireEvent.click(screen.getByRole('button', { name: 'Archived voyages' }));
        expect(screen.getByRole('dialog', { name: 'Archived voyages' })).toBeInTheDocument();
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'active-fix',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                    cumulativeDistanceNM: 1.2,
                    speed: 5,
                },
            ],
        });
        rerender(<LogPage />);
        expect(screen.queryByRole('dialog', { name: 'Archived voyages' })).not.toBeInTheDocument();
        Object.assign(logPageStateOverrides.state, { isTracking: false, currentVoyageId: null, entries: [] });
        rerender(<LogPage />);
        expect(screen.queryByRole('dialog', { name: 'Archived voyages' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Archived voyages' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('says a failed history read once, with one Retry that re-runs both loads (UX scorecard run 7)', () => {
        const reload = vi.fn().mockResolvedValue(undefined);
        Object.assign(logPageStateOverrides.hook, {
            lifetimeError: 'Couldn’t refresh lifetime totals.',
            lifetimeLoaded: false,
            archiveError: 'Couldn’t refresh the archive. Your saved voyages have not been changed.',
            archivedVoyages: [],
            reloadArchivedVoyages: reload,
        });
        render(<LogPage />);
        expect(screen.getByText(/Your full voyage history didn’t load — showing this phone only\./)).toBeVisible();
        // Both cards keep their short status lines, collapsed, without a Retry each.
        expect(screen.getByRole('button', { name: 'Voyage stats' })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByRole('button', { name: 'Archived voyages' })).toHaveAccessibleDescription(
            'Archive didn’t load',
        );
        const retries = screen.getAllByRole('button', { name: 'Retry' });
        expect(retries).toHaveLength(1);
        fireEvent.click(retries[0]);
        expect(reload).toHaveBeenCalledOnce();
    });

    it('keeps the card’s own Refresh, in its sheet, when only one history read failed', () => {
        const reload = vi.fn().mockResolvedValue(undefined);
        Object.assign(logPageStateOverrides.hook, {
            archiveError: 'Couldn’t refresh the archive. Your saved voyages have not been changed.',
            archivedVoyages: [],
            reloadArchivedVoyages: reload,
        });
        render(<LogPage />);
        expect(screen.queryByText(/showing this phone only/)).not.toBeInTheDocument();
        const archive = screen.getByRole('button', { name: 'Archived voyages' });
        expect(archive).toHaveAccessibleDescription('Archive didn’t load');
        fireEvent.click(archive);
        const sheet = screen.getByRole('dialog', { name: 'Archived voyages' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Refresh archive' }));
        expect(reload).toHaveBeenCalledOnce();
    });

    it('accepts onBack callback without crashing', () => {
        const onBack = vi.fn();
        expect(() => {
            render(<LogPage onBack={onBack} />);
        }).not.toThrow();
    });

    it('fails closed before tracking when location permission is denied', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        acquireFreshOwnshipPositionMock.mockResolvedValueOnce(null);

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        expect(await screen.findByRole('alert')).toHaveTextContent('Location access is off');
        expect(await screen.findByRole('alert')).toHaveTextContent('Nothing is being recorded');
        expect(acquireFreshOwnshipPositionMock).toHaveBeenCalledOnce();
        expect(startTracking).not.toHaveBeenCalled();
    });

    it('allows a fresh vessel/NMEA fix to override unavailable phone location', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        const { Preferences } = await import('@capacitor/preferences');
        vi.mocked(Preferences.get).mockResolvedValueOnce({ value: 'true' });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        await waitFor(() => expect(acquireFreshOwnshipPositionMock).toHaveBeenCalledOnce());
        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    // ── Build 123, package VL: the phone notice is for the phone ──────────────
    // Shane 2026-10-07: the phone's "GPS Accuracy Notice" while the app knew
    // exactly where the boat was, from her own GPS.
    it('a fresh fix from the boat never shows the phone notice, even when it was never dismissed', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        acquireFreshOwnshipPositionMock.mockResolvedValueOnce({
            lat: 50.7712,
            lon: -1.3005,
            sog: 0,
            cog: 0,
            timestamp: Date.now(),
            source: 'nmea',
        });
        const { Preferences } = await import('@capacitor/preferences');
        vi.mocked(Preferences.get).mockResolvedValue({ value: null });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(screen.queryByRole('dialog', { name: /GPS Accuracy Notice|Logging from this phone/ })).toBeNull();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a vessel plan starts from her GPS without asking this phone for a fix or showing the notice', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        sourcePlanMock.resolve.mockResolvedValueOnce({
            ...sourcePlanMock.phonePlan,
            source: 'vessel',
            lane: 'pi',
            where: 'aboard',
            keepAlive: 'none-needed',
            showPhoneNotice: false,
        });
        const { Preferences } = await import('@capacitor/preferences');
        vi.mocked(Preferences.get).mockResolvedValue({ value: null });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(startTracking).toHaveBeenCalledWith(
            expect.objectContaining({
                sourcePlan: expect.objectContaining({ source: 'vessel', keepAlive: 'none-needed' }),
            }),
        );
        expect(acquireFreshOwnshipPositionMock).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: 'Logging from this phone' })).toBeNull();
    });

    it('a gateway-only boat with Location off says so in the page card (While Using is enough), never a toast', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        sourcePlanMock.resolve.mockResolvedValueOnce({
            ...sourcePlanMock.phonePlan,
            source: 'vessel',
            lane: 'bus',
            where: 'aboard',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
        });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('While Using is enough');
        expect(alert).toHaveTextContent('Tracking did not start');
        expect(within(alert).getByRole('button', { name: 'Open location settings' })).toBeInTheDocument();
        expect(startTracking).not.toHaveBeenCalled();
        expect(acquireFreshOwnshipPositionMock).not.toHaveBeenCalled();
    });

    it('a boat-only Start from ashore with Location off: nothing is asked of this phone', async () => {
        // (Aboard, a Pi recording her track no longer means "nothing needed":
        // its track cannot fill a voyage's gaps until phase 2, so the plan is
        // While Using like a gateway-only boat — the card above.)
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        sourcePlanMock.resolve.mockResolvedValueOnce({
            ...sourcePlanMock.phonePlan,
            source: 'vessel',
            lane: 'cloud',
            where: 'ashore',
            keepAlive: 'none-needed',
            standIn: 'never',
            showPhoneNotice: false,
        });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it("the phone's own fix still shows the phone notice once before tracking starts", async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
        const { Preferences } = await import('@capacitor/preferences');
        vi.mocked(Preferences.get).mockResolvedValue({ value: null });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        const notice = await screen.findByRole('dialog', { name: 'Logging from this phone' });
        expect(startTracking).not.toHaveBeenCalled();
        fireEvent.click(within(notice).getByRole('button', { name: 'Start tracking' }));
        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(startTracking).toHaveBeenCalledWith(
            expect.objectContaining({ sourcePlan: expect.objectContaining({ source: 'phone' }) }),
        );
    });

    it('a location refusal from the voyage preflight lands in the start card, never a toast (build 123 review)', async () => {
        const { VoyageLocationError } = await import('../services/BgGeoManager');
        let handled: boolean | undefined;
        const startTracking = vi.fn((options?: { onFailed?: (error: unknown) => boolean }) => {
            // What useLogPageState does when ShipLogService.startTracking rejects.
            handled = options?.onFailed?.(
                new VoyageLocationError(
                    "To keep logging your boat's GPS with the screen locked, Thalassa needs Location — While Using is enough.",
                    'permission',
                ),
            );
        });
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        sourcePlanMock.resolve.mockResolvedValueOnce({
            ...sourcePlanMock.phonePlan,
            source: 'vessel',
            lane: 'bus',
            where: 'aboard',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
        });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        const alert = await screen.findByRole('alert');
        expect(handled).toBe(true);
        expect(alert).toHaveTextContent('Tracking did not start');
        expect(alert).toHaveTextContent('While Using is enough');
        expect(within(alert).getByRole('button', { name: 'Open location settings' })).toBeInTheDocument();
    });

    it('any other start failure is left to the toast', async () => {
        let handled: boolean | undefined;
        logPageStateOverrides.hook.handleStartTracking = vi.fn(
            (options?: { onFailed?: (error: unknown) => boolean }) => {
                handled = options?.onFailed?.(new Error('Background GPS did not confirm.'));
            },
        );
        sourcePlanMock.resolve.mockResolvedValueOnce({
            ...sourcePlanMock.phonePlan,
            source: 'vessel',
            lane: 'bus',
            where: 'aboard',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
        });
        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));
        await waitFor(() => expect(handled).toBe(false));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it("the phone notice's Always line shows only when Location is not Always already", async () => {
        const { Capacitor } = await import('@capacitor/core');
        const { BgGeoManager } = await import('../services/BgGeoManager');
        const platform = vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
        const always = vi.spyOn(BgGeoManager, 'hasAlwaysLocation').mockResolvedValue(true);
        try {
            logPageStateOverrides.hook.handleStartTracking = vi.fn();
            gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
            const { Preferences } = await import('@capacitor/preferences');
            vi.mocked(Preferences.get).mockResolvedValue({ value: null });

            const first = render(<LogPage />);
            fireEvent.click(screen.getByTestId('slide-to-action'));
            const granted = await screen.findByRole('dialog', { name: 'Logging from this phone' });
            expect(granted).toHaveAttribute('data-always-advice', 'false');
            first.unmount();

            always.mockResolvedValue(false);
            render(<LogPage />);
            fireEvent.click(screen.getByTestId('slide-to-action'));
            const whileUsing = await screen.findByRole('dialog', { name: 'Logging from this phone' });
            expect(whileUsing).toHaveAttribute('data-always-advice', 'true');
        } finally {
            platform.mockRestore();
            always.mockRestore();
        }
    });

    describe('a live voyage that never heard her (Cast Off, a Start while her lane was connecting)', () => {
        const tracking = () =>
            Object.assign(logPageStateOverrides.state, { isTracking: true, currentVoyageId: 'cast-off-voyage' });

        it('asks the stand-in question on the Log page; "Log from this phone" goes to the live voyage', async () => {
            tracking();
            liveVoyageMock.standInPending = true;
            render(<LogPage />);
            const question = await screen.findByRole('dialog', { name: /GPS isn.t answering/ });
            fireEvent.click(within(question).getByRole('button', { name: 'Log from this phone' }));
            expect(liveVoyageMock.answer).toHaveBeenCalledWith('phone');
        });

        it('Cancel puts it away for this voyage', async () => {
            tracking();
            liveVoyageMock.standInPending = true;
            const { rerender } = render(<LogPage />);
            const question = await screen.findByRole('dialog', { name: /GPS isn.t answering/ });
            fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
            rerender(<LogPage />);
            expect(screen.queryByRole('dialog', { name: /GPS isn.t answering/ })).toBeNull();
            expect(liveVoyageMock.answer).not.toHaveBeenCalled();
        });

        it('nothing is asked while the service has nothing to ask', () => {
            tracking();
            render(<LogPage />);
            expect(screen.queryByRole('dialog', { name: /GPS isn.t answering/ })).toBeNull();
        });

        it('the location caution for the live voyage is a card with the settings link, put away with Got it', () => {
            tracking();
            liveVoyageMock.advisory =
                'Recording only while Thalassa is open. To keep logging with the screen locked, allow Location for Thalassa — While Using is enough.';
            render(<LogPage />);
            const card = screen.getByTestId('voyage-location-advisory');
            expect(card).toHaveTextContent('Recording only while Thalassa is open');
            expect(within(card).getByRole('button', { name: 'Open location settings' })).toBeInTheDocument();
            fireEvent.click(within(card).getByRole('button', { name: 'Got it' }));
            expect(screen.queryByTestId('voyage-location-advisory')).toBeNull();
        });
    });

    describe('her GPS silent at Start: the one stand-in question', () => {
        const silentPlan = () => ({
            ...sourcePlanMock.phonePlan,
            source: 'vessel-silent',
            lane: 'none',
            where: 'unknown',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
            standIn: 'ask',
        });

        it('asks "Log from this phone / Wait for the boat"; Wait starts a boat-only voyage without touching the phone', async () => {
            const startTracking = vi.fn();
            logPageStateOverrides.hook.handleStartTracking = startTracking;
            sourcePlanMock.resolve.mockResolvedValueOnce(silentPlan());

            render(<LogPage />);
            fireEvent.click(screen.getByTestId('slide-to-action'));

            const question = await screen.findByRole('dialog', { name: /GPS isn.t answering/ });
            expect(within(question).getByRole('button', { name: 'Log from this phone' })).toBeInTheDocument();
            fireEvent.click(within(question).getByRole('button', { name: 'Wait for the boat' }));

            await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
            expect(startTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourcePlan: expect.objectContaining({
                        source: 'vessel-silent',
                        standIn: 'never',
                        standInOptIn: false,
                    }),
                }),
            );
            expect(acquireFreshOwnshipPositionMock).not.toHaveBeenCalled();
            expect(screen.queryByRole('dialog', { name: /GPS isn.t answering/ })).toBeNull();
        });

        it('"Log from this phone" checks the phone, shows the phone notice, then starts opted in', async () => {
            const startTracking = vi.fn();
            logPageStateOverrides.hook.handleStartTracking = startTracking;
            gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
            sourcePlanMock.resolve.mockResolvedValueOnce(silentPlan());
            const { Preferences } = await import('@capacitor/preferences');
            vi.mocked(Preferences.get).mockResolvedValue({ value: null });

            render(<LogPage />);
            fireEvent.click(screen.getByTestId('slide-to-action'));

            const question = await screen.findByRole('dialog', { name: /GPS isn.t answering/ });
            fireEvent.click(within(question).getByRole('button', { name: 'Log from this phone' }));

            const notice = await screen.findByRole('dialog', { name: 'Logging from this phone' });
            expect(acquireFreshOwnshipPositionMock).toHaveBeenCalledOnce();
            fireEvent.click(within(notice).getByRole('button', { name: 'Start tracking' }));
            await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
            expect(startTracking).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourcePlan: expect.objectContaining({ source: 'phone', standIn: 'allowed', standInOptIn: true }),
                }),
            );
        });

        it('a Start from ashore never asks: a boat-only voyage, no phone fix, no notice', async () => {
            const startTracking = vi.fn();
            logPageStateOverrides.hook.handleStartTracking = startTracking;
            sourcePlanMock.resolve.mockResolvedValueOnce({
                ...silentPlan(),
                where: 'ashore',
                standIn: 'never',
                keepAlive: 'none-needed',
            });

            render(<LogPage />);
            fireEvent.click(screen.getByTestId('slide-to-action'));

            await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
            expect(screen.queryByRole('dialog', { name: /GPS isn.t answering/ })).toBeNull();
            expect(acquireFreshOwnshipPositionMock).not.toHaveBeenCalled();
            expect(startTracking).toHaveBeenCalledWith(
                expect.objectContaining({ sourcePlan: expect.objectContaining({ standIn: 'never' }) }),
            );
        });
    });

    it('does not enter Live Recording when a fresh GPS fix cannot be acquired', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
        acquireFreshOwnshipPositionMock.mockResolvedValueOnce(null);

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        expect(await screen.findByRole('alert')).toHaveTextContent('No fresh GPS fix');
        expect(screen.getByRole('alert')).toHaveTextContent('Tracking did not start');
        expect(startTracking).not.toHaveBeenCalled();
        expect(screen.queryByText('Live Recording')).not.toBeInTheDocument();
    });

    it('starts only after the fresh-fix preflight succeeds', async () => {
        const startTracking = vi.fn();
        logPageStateOverrides.hook.handleStartTracking = startTracking;
        gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
        const { Preferences } = await import('@capacitor/preferences');
        vi.mocked(Preferences.get).mockResolvedValueOnce({ value: 'true' });

        render(<LogPage />);
        fireEvent.click(screen.getByTestId('slide-to-action'));

        await waitFor(() => expect(acquireFreshOwnshipPositionMock).toHaveBeenCalledOnce());
        await waitFor(() => expect(startTracking).toHaveBeenCalledOnce());
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('does not throw on rerender', () => {
        expect(() => {
            const { rerender } = render(<LogPage />);
            rerender(<LogPage />);
        }).not.toThrow();
    });

    it('opens the live recording map in a body portal and restores its expand control on Escape', () => {
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'active-fix',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                    cumulativeDistanceNM: 1.2,
                    speed: 5,
                },
            ],
        });

        render(<LogPage />);
        const opener = screen.getByRole('button', { name: 'Expand live map' });
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Live Recording' });
        const close = screen.getByRole('button', { name: 'Shrink map' });
        const overlay = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.zIndex).toBe('1100');
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Live Recording' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('shows live followed-route geometry on the compact and expanded maps', () => {
        const route = [
            { lat: -27.5, lon: 153 },
            { lat: -27.45, lon: 153.08 },
            { lat: -27.4, lon: 153.16 },
        ];
        Object.assign(followRouteMock.state, {
            isFollowing: true,
            // Route Tracer intentionally follows before its background save
            // can assign an id; geometry must still render immediately.
            voyageId: '',
            routeCoords: route,
        });
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'fix-1',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                },
                {
                    id: 'fix-2',
                    voyageId: 'active-voyage',
                    latitude: -27.49,
                    longitude: 153.01,
                    timestamp: '2026-07-23T00:01:00.000Z',
                },
            ],
        });

        render(<LogPage />);
        expect(screen.getByTestId('small-live-map')).toHaveAttribute('data-followed-route', JSON.stringify(route));
        expect(screen.queryByTestId('track-map')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Expand live map' }));
        expect(screen.getByTestId('large-live-map')).toHaveAttribute('data-followed-route', JSON.stringify(route));
    });

    it('updates and clears followed-route geometry without leaking stale coordinates', () => {
        const view = () => <LogPage />;
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'fix-1',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                },
            ],
        });
        Object.assign(followRouteMock.state, {
            isFollowing: true,
            voyageId: 'plan-1',
            routeCoords: [
                { lat: -27.5, lon: 153 },
                { lat: -27.4, lon: 153.1 },
            ],
        });

        const { rerender } = render(view());
        const refreshed = [
            { lat: -27.5, lon: 153 },
            { lat: -27.42, lon: 153.12 },
            { lat: -27.3, lon: 153.2 },
        ];
        followRouteMock.state.routeCoords = refreshed;
        rerender(view());
        expect(screen.getByTestId('small-live-map')).toHaveAttribute('data-followed-route', JSON.stringify(refreshed));

        followRouteMock.state.isFollowing = false;
        rerender(view());
        expect(screen.getByTestId('small-live-map')).toHaveAttribute('data-followed-route', '[]');
    });

    it('shows the followed route in an open current-voyage map but not an unrelated historical map', () => {
        const route = [
            { lat: -27.5, lon: 153 },
            { lat: -27.4, lon: 153.1 },
        ];
        Object.assign(followRouteMock.state, {
            isFollowing: true,
            voyageId: 'planned-voyage',
            routeCoords: route,
        });
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            showTrackMap: true,
            currentVoyageId: 'active-voyage',
            selectedVoyageId: 'active-voyage',
            entries: [
                { id: 'active', voyageId: 'active-voyage' },
                { id: 'plan', voyageId: 'planned-voyage' },
                { id: 'old', voyageId: 'old-voyage' },
            ],
        });

        const { rerender } = render(<LogPage />);
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-followed-route', JSON.stringify(route));
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-entry-voyages', '["active-voyage"]');

        logPageStateOverrides.state.selectedVoyageId = 'old-voyage';
        rerender(<LogPage />);
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-followed-route', '[]');
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-entry-voyages', '["old-voyage"]');

        logPageStateOverrides.state.selectedVoyageId = null;
        rerender(<LogPage />);
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-followed-route', JSON.stringify(route));
        expect(screen.getByTestId('track-map')).toHaveAttribute('data-entry-voyages', '["active-voyage","old-voyage"]');
    });

    it('excludes stored plans from the all-voyages map', () => {
        Object.assign(logPageStateOverrides.state, {
            showTrackMap: true,
            selectedVoyageId: null,
            entries: [
                { id: 'actual', voyageId: 'actual-voyage', source: 'device' },
                { id: 'plan', voyageId: 'planned-voyage', source: 'planned_route' },
            ],
            summaries: [
                { voyageId: 'actual-voyage', isPlannedRoute: false },
                { voyageId: 'planned-voyage', isPlannedRoute: true },
            ],
        });

        render(<LogPage />);

        expect(screen.getByTestId('track-map')).toHaveAttribute('data-entry-voyages', '["actual-voyage"]');
    });

    it('preserves a matched planned overlay when a sailed voyage is selected', () => {
        Object.assign(logPageStateOverrides.state, {
            showTrackMap: true,
            selectedVoyageId: 'actual-voyage',
            entries: [
                { id: 'actual', voyageId: 'actual-voyage', source: 'device' },
                { id: 'plan', voyageId: 'planned-voyage', source: 'planned_route' },
            ],
            summaries: [
                {
                    voyageId: 'actual-voyage',
                    isPlannedRoute: false,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });

        render(<LogPage />);

        expect(screen.getByTestId('track-map')).toHaveAttribute(
            'data-entry-voyages',
            '["actual-voyage","planned-voyage"]',
        );
    });

    it('uses lifetime summaries rather than resident points for all-voyages stats and excludes plans from the picker', () => {
        const actualEntry = { id: 'actual', voyageId: 'actual-voyage', source: 'device' };
        const plannedEntry = { id: 'plan', voyageId: 'planned-voyage', source: 'planned_route' };
        const actualSummary = { voyageId: 'actual-voyage', isPlannedRoute: false };
        const plannedSummary = { voyageId: 'planned-voyage', isPlannedRoute: true };
        Object.assign(logPageStateOverrides.state, {
            showStats: true,
            selectedVoyageId: null,
            entries: [actualEntry, plannedEntry],
            summaries: [actualSummary, plannedSummary],
        });
        Object.assign(logPageStateOverrides.hook, {
            filteredEntries: [actualEntry, plannedEntry],
            listVoyages: [actualSummary, plannedSummary],
        });

        const { rerender } = render(<LogPage />);
        expect(screen.queryByTestId('voyage-stats')).not.toBeInTheDocument();
        expect(screen.getByText('Lifetime · includes archived voyages')).toBeVisible();
        expect(screen.getByText('62.0')).toBeVisible();

        logPageStateOverrides.state.showStats = false;
        logPageStateOverrides.state.actionSheet = 'stats';
        rerender(<LogPage />);
        expect(screen.getByTestId('stats-sheet')).toHaveAttribute('data-voyages', '["actual-voyage"]');
    });

    it('contains the follow-route prompt, defaults to recording, and restores its opener on Escape', () => {
        const view = () => (
            <>
                <button>Cast off</button>
                <LogPage />
            </>
        );
        const { rerender } = render(view());
        const opener = screen.getByRole('button', { name: 'Cast off' });
        opener.focus();

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'active-fix',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                },
            ],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        const dialog = screen.getByRole('dialog', { name: 'Following a route?' });
        const dismiss = screen.getByRole('button', { name: 'Just recording' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription('Pick one to show on your public page — or just record the track.');
        expect(dismiss).toHaveFocus();

        const routeChoice = screen.getByRole('button', { name: 'Follow route planned-voyage' });
        fireEvent.keyDown(dismiss, { key: 'Tab' });
        expect(routeChoice).toHaveFocus();
        fireEvent.keyDown(routeChoice, { key: 'Tab', shiftKey: true });
        expect(dismiss).toHaveFocus();
        fireEvent.keyDown(dismiss, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('never covers the follow question with an acquiring takeover — before OR after answering', () => {
        // TOMBSTONE (Shane 2026-08-03: "remove the large full screen acquiring
        // gps fix, as well as the smaller background one — just keep the green
        // one below the heading"). The critical-band takeover used to bury the
        // already-open follow sheet for the whole 20-30 s acquisition
        // (2026-08-02 reorder made it yield); now it is gone entirely and the
        // header badge is the one acquiring surface, so no alertdialog may
        // ever appear at any point in the cast-off flow.
        const view = () => <LogPage />;
        const { rerender } = render(view());

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [], // no recorded fix yet — the old takeover's open condition
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Just recording' }));
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        // The badge still tells the acquiring story.
        expect(screen.getAllByText(/Acquiring GPS fix… \d+:\d{2}/)).not.toHaveLength(0);
    });

    it('keeps the cast-off route prompt open through React StrictMode effect replay', async () => {
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });

        render(
            <React.StrictMode>
                <LogPage />
            </React.StrictMode>,
        );

        expect(await screen.findByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('a DISMISSED voyage stays dismissed across remounts — but an unanswered sheet re-asks', async () => {
        // Guards key on the ANSWER, not on having shown the sheet (hardening
        // 2026-08-01): marking at show time meant a deep-link/notification
        // navigation while the sheet was up forfeited the question for the
        // whole voyage. And the guards are module-scope because instance refs
        // die on tab-bounce (lesson_session_guards_module_scope).
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });

        // Unanswered unmount: the question comes back.
        const first = render(<LogPage />);
        expect(await screen.findByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
        first.unmount();
        const second = render(<LogPage />);
        expect(await screen.findByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();

        // Explicit dismissal: recorded durably, never asked again this voyage.
        fireEvent.click(screen.getByRole('button', { name: 'Just recording' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument(),
        );
        second.unmount();
        // A webview reload also loses the old in-memory guards.
        resetFollowPromptGuardsForTest();
        const restored = render(<LogPage />);
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
        expect(clearFollowedRouteMock).toHaveBeenCalledTimes(1); // reading an answer must not clear a route again
        restored.unmount();
        Object.assign(logPageStateOverrides.state, { currentVoyageId: 'different-voyage' });
        render(<LogPage />);
        expect(await screen.findByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('keeps Just recording when Log unmounts before native tracking finishes starting', async () => {
        Object.assign(logPageStateOverrides.state, {
            summaries: [
                {
                    voyageId: 'plan',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        const first = render(<LogPage />);
        fireEvent.click(screen.getByRole('button', { name: 'Slide to Start Tracking' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Just recording' }));
        const onStarted = vi.mocked(useLogPageState).mock.calls.at(-1)![0]!;
        first.unmount();
        // Return before native startup completes: the replacement instance
        // must also retire any question when the old start commits its answer.
        Object.assign(logPageStateOverrides.state, { isTracking: true, currentVoyageId: 'new-recording' });
        const returned = render(<LogPage />);
        await act(async () => onStarted('new-recording'));
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
        returned.unmount();
        resetFollowPromptGuardsForTest();
        render(<LogPage />); // Also survives losing all in-memory guards.
        await act(async () => Promise.resolve());
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
    });

    it('clears a previously followed route when the skipper chooses Just recording', async () => {
        Object.assign(followRouteMock.state, {
            isFollowing: true,
            voyageId: 'old-planned-route',
            routeCoords: [
                { lat: -27.5, lon: 153 },
                { lat: -27.4, lon: 153.1 },
            ],
        });
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Just recording' }));

        expect(followRouteMock.state.stopFollowing).toHaveBeenCalledTimes(1);
        expect(followRouteMock.state.isFollowing).toBe(false);
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
    });

    it('does not publish a route whose exact geometry cannot be verified', async () => {
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'missing-planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        fetchVoyageAsTrackMock.mockResolvedValue(null);
        publishFollowedRouteMock.mockResolvedValue('linked');

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route missing-planned-voyage' }));

        await waitFor(() => expect(screen.getByRole('button', { name: 'Just recording' })).toBeEnabled());
        expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('keeps the sheet open when BOTH the geometry and the publish fail', async () => {
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'missing-planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        fetchVoyageAsTrackMock.mockResolvedValue(null);
        publishFollowedRouteMock.mockResolvedValue('error');

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route missing-planned-voyage' }));

        await waitFor(() => expect(screen.getByRole('button', { name: 'Just recording' })).toBeEnabled());
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
        expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('unlocks a stalled cast-off prompt and ignores geometry that arrives after the deadline', async () => {
        vi.useFakeTimers();
        publishFollowedRouteMock.mockResolvedValue('error');
        let resolveRoute!: (route: {
            id: string;
            label: string;
            sublabel: string;
            points: Array<{ lat: number; lon: number }>;
            bbox: [number, number, number, number];
            timestamp: number;
            distanceNm: number;
            isLocal: boolean;
            kind: 'sea';
        }) => void;
        fetchVoyageAsTrackMock.mockReturnValue(
            new Promise((resolve) => {
                resolveRoute = resolve;
            }),
        );
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'slow-planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });

        render(<LogPage />);
        fireEvent.click(screen.getByRole('button', { name: 'Follow route slow-planned-voyage' }));
        expect(screen.getByRole('button', { name: 'Loading route…' })).toBeDisabled();

        await act(async () => {
            vi.advanceTimersByTime(10_000);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.getByRole('button', { name: 'Just recording' })).toBeEnabled();
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();

        await act(async () => {
            resolveRoute({
                id: 'slow-planned-voyage',
                label: 'Late route',
                sublabel: 'Planned',
                points: [
                    { lat: -27.5, lon: 153 },
                    { lat: -27.4, lon: 153.1 },
                ],
                bbox: [153, -27.5, 153.1, -27.4],
                timestamp: Date.now(),
                distanceNm: 12,
                isLocal: false,
                kind: 'sea',
            });
            await Promise.resolve();
        });

        expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
    });

    it('starts local follow mode when a route is chosen from the Log cast-off prompt', async () => {
        let resolvePublication!: (result: 'linked') => void;
        publishFollowedRouteMock.mockReturnValue(
            new Promise((resolve) => {
                resolvePublication = resolve;
            }),
        );
        fetchVoyageAsTrackMock.mockResolvedValue({
            id: 'planned-voyage',
            label: 'Newport → Lady Musgrave',
            sublabel: 'Planned · 12 NM',
            points: [
                { lat: -27.5, lon: 153 },
                { lat: -26.2, lon: 152.7 },
                { lat: -23.9, lon: 152.4 },
            ],
            bbox: [152.4, -27.5, 153, -23.9],
            timestamp: Date.parse('2026-07-23T00:00:00.000Z'),
            distanceNm: 12,
            durationHours: 3,
            isLocal: false,
            kind: 'sea',
        });
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [
                {
                    id: 'active-fix',
                    voyageId: 'active-voyage',
                    latitude: -27.5,
                    longitude: 153,
                    timestamp: '2026-07-23T00:00:00.000Z',
                },
            ],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    startedAt: '2026-07-23T00:00:00.000Z',
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -23.9,
                    lastLon: 152.4,
                },
            ],
        });

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route planned-voyage' }));

        await waitFor(() => expect(followRouteMock.state.startFollowing).toHaveBeenCalledTimes(1));
        expect(followRouteMock.state.startFollowing).toHaveBeenLastCalledWith(
            expect.objectContaining({
                origin: 'Newport',
                destination: 'Lady Musgrave',
            }),
            'planned-voyage',
            [
                { lat: -27.5, lon: 153 },
                { lat: -26.2, lon: 152.7 },
                { lat: -23.9, lon: 152.4 },
            ],
        );
        expect(publishFollowedRouteMock).toHaveBeenCalledWith('planned-voyage');
        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();

        await act(async () => {
            resolvePublication('linked');
            await Promise.resolve();
        });
    });

    const linkedTraceVoyage = () => {
        fetchVoyageAsTrackMock.mockResolvedValue({
            id: 'planned-trace',
            label: 'Cowes → Lymington',
            sublabel: 'Planned',
            points: [
                { lat: 50.766, lon: -1.297 },
                { lat: 50.754, lon: -1.533 },
            ],
            bbox: [-1.533, 50.754, -1.297, 50.766],
            timestamp: Date.now(),
            distanceNm: 8,
            isLocal: false,
            kind: 'sea',
            savedRouteId: 'trace-solent',
        });
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            summaries: [
                {
                    voyageId: 'planned-trace',
                    isPlannedRoute: true,
                    totalDistanceNM: 8,
                    entryCount: 2,
                    firstLat: 50.766,
                    firstLon: -1.297,
                    lastLat: 50.754,
                    lastLon: -1.533,
                },
            ],
        });
    };

    // Build 124 (Shane 2026-10-08: "maybe just a warning rather than having to
    // almost start again"): only a real check's red finding refuses, and only
    // until the skipper's second tap accepts it.
    it('blocks both local follow and public publication for a red finding until it is accepted', async () => {
        traceDirectUseBlockReasonMock.mockReturnValue('Pins 2→3: charted wreck');
        linkedTraceVoyage();

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route planned-trace' }));

        await waitFor(() => expect(traceDirectUseBlockReasonMock).toHaveBeenCalled());
        expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Follow anyway planned-trace' }));
        await waitFor(() => expect(followRouteMock.state.startFollowing).toHaveBeenCalledTimes(1));
        expect(publishFollowedRouteMock).toHaveBeenCalledWith('planned-trace');
    });

    it('follows an amber (unchecked) route on the first tap and says so once, quietly', async () => {
        traceDirectUseAmberMock.value = { tone: 'unchecked', code: 'none', reason: 'Not checked yet' };
        linkedTraceVoyage();

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route planned-trace' }));

        await waitFor(() => expect(followRouteMock.state.startFollowing).toHaveBeenCalledTimes(1));
        expect(publishFollowedRouteMock).toHaveBeenCalledWith('planned-trace');
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument(),
        );
        expect(await screen.findByText('Following, not checked yet. Keep a good lookout.')).toBeInTheDocument();
    });

    it('says WHY a followed amber route is amber: a route checked last month is not "not checked yet"', async () => {
        traceDirectUseAmberMock.value = { tone: 'unchecked', code: 'aged', reason: 'Last checked 4 Sep' };
        linkedTraceVoyage();

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route planned-trace' }));

        await waitFor(() => expect(followRouteMock.state.startFollowing).toHaveBeenCalledTimes(1));
        expect(
            await screen.findByText('Following, but its check is out of date. Keep a good lookout.'),
        ).toBeInTheDocument();
        expect(screen.queryByText('Following, not checked yet. Keep a good lookout.')).not.toBeInTheDocument();
    });

    it('Check now on a route only the account holds adopts it onto this phone first, then queues the check', async () => {
        linkedTraceVoyage();
        // The plan's link lives on its entries; the trace is NOT on this phone
        // (the routeTracer mock's library holds only route-x).
        Object.assign(logPageStateOverrides.state, {
            entries: [
                {
                    id: 'planned-trace-entry',
                    voyageId: 'planned-trace',
                    savedRouteId: 'trace-solent',
                    source: 'planned_route',
                    latitude: 50.766,
                    longitude: -1.297,
                    timestamp: new Date().toISOString(),
                },
            ],
        });
        fetchSavedRoutePointsMock.mockResolvedValue({
            ok: true,
            id: 'trace-solent',
            name: 'Cowes → Lymington',
            points: [
                { lat: 50.766, lon: -1.297 },
                { lat: 50.754, lon: -1.533 },
            ],
        });

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Check now planned-trace' }));

        await waitFor(() => expect(enqueueTraceChecksSpy).toHaveBeenCalledWith(['trace-solent'], 'manual'));
        expect(fetchSavedRoutePointsMock).toHaveBeenCalledWith('trace-solent');
        expect(fetchSavedRoutePointsMock.mock.invocationCallOrder[0]).toBeLessThan(
            enqueueTraceChecksSpy.mock.invocationCallOrder[
                enqueueTraceChecksSpy.mock.calls.findIndex((call) => call[1] === 'manual')
            ],
        );
    });

    it('Check now says why when the account copy cannot be fetched, and queues nothing', async () => {
        linkedTraceVoyage();
        Object.assign(logPageStateOverrides.state, {
            entries: [
                {
                    id: 'planned-trace-entry',
                    voyageId: 'planned-trace',
                    savedRouteId: 'trace-solent',
                    source: 'planned_route',
                    latitude: 50.766,
                    longitude: -1.297,
                    timestamp: new Date().toISOString(),
                },
            ],
        });
        fetchSavedRoutePointsMock.mockResolvedValue({ ok: false, reason: 'You’re offline. Try again when connected.' });

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Check now planned-trace' }));

        expect(await screen.findByText('You’re offline. Try again when connected.')).toBeInTheDocument();
        expect(enqueueTraceChecksSpy).not.toHaveBeenCalledWith(['trace-solent'], 'manual');
    });
});

describe('LogPage — the acquiring surfaces tell the truth', () => {
    const trackingNoFix = () =>
        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [],
            summaries: [],
        });

    it('counts the wait on the header badge — the ONE remaining acquiring surface', async () => {
        // Shane 2026-08-03: the takeover, top banner and both live-map veils
        // are gone — "just keep the green one that is just below the heading".
        // The badge inherits the honesty duties: it must carry the elapsed
        // clock, and there must be EXACTLY one surface saying it.
        gpsHealthMock.value = { usable: true, reason: 'ok', actionable: false };
        trackingNoFix();
        render(<LogPage />);
        expect(await screen.findAllByText(/Acquiring GPS fix… \d+:\d{2}/)).toHaveLength(1);
    });

    it('names a permission problem instead of claiming to be acquiring', async () => {
        gpsHealthMock.value = { usable: false, reason: 'denied', actionable: true };
        trackingNoFix();
        render(<LogPage />);

        expect(await screen.findAllByText('Location access is off')).not.toHaveLength(0);
        expect(screen.queryByText(/Acquiring GPS fix…/)).not.toBeInTheDocument();
        // The banner's Fix deep-link went with the banner — the badge names
        // the cause and the GPS disclaimer modal remains the actionable door.
        expect(screen.queryByRole('button', { name: 'Fix' })).not.toBeInTheDocument();
    });
});

describe('LogPage — Cast Off handoff', () => {
    beforeEach(() => {
        resetFollowPromptGuardsForTest();
        logPageStateOverrides.state = {};
        logPageStateOverrides.hook = {};
        clearCastOffHandoff();
        shipLogHandoffMock.startTracking.mockReset();
        shipLogHandoffMock.getTrackingStatus.mockReturnValue({ isTracking: false, currentVoyageId: null });
        publishFollowedRouteMock.mockClear();
        publishFollowedRouteMock.mockResolvedValue('linked');
        activeVoyageMock.value = null;
        followRouteMock.state.isFollowing = false;
        followRouteMock.state.voyageId = null;
        followRouteMock.state.routeCoords = [];
        followRouteMock.state.startedAt = null;
        followRouteMock.state.startFollowing.mockClear();
        shipLogHandoffMock.stopTracking.mockReset();
        shipLogHandoffMock.stopTracking.mockResolvedValue(undefined);
        fetchVoyageAsTrackMock.mockReset();
        fetchVoyageAsTrackMock.mockResolvedValue(null);
        traceDirectUseBlockReasonMock.mockReset();
        traceDirectUseBlockReasonMock.mockReturnValue(null);
    });

    afterEach(async () => {
        // The page's auto-retry, Retry button and publish retry start Cast
        // Off background work nobody awaits; let it settle inside this test
        // (the page is still mounted, hence act) so it cannot overlap the
        // next test's chains or run on past teardown.
        await act(async () => {
            await castOffHandoffIdle();
        });
        clearCastOffHandoff();
    });

    it('shows the honest GPS-starting state instead of the slide', async () => {
        stashCastOffHandoff({
            voyageId: 'voyage-handoff',
            voyageName: 'Mackay → Airlie',
            caution: null,
        });
        render(<LogPage />);

        expect(await screen.findByText(/GPS voyage logging is starting for/)).toBeInTheDocument();
        // The slide would mint a SECOND voyage while the cast-off one is
        // still attaching its GPS log — it must not be offered.
        expect(screen.queryByText('Slide to Start Tracking')).not.toBeInTheDocument();
    });

    it('never renders a route-check heads-up, even if a caution is somehow present', async () => {
        // Removed 2026-08-30 ("not necessary"). castOff() still computes a
        // caution, so this guards the surface staying gone rather than the value
        // never existing — and a caution must not pin the handoff open, because
        // there is no longer anything that could acknowledge it.
        stashCastOffHandoff({
            voyageId: 'voyage-handoff',
            voyageName: 'Mackay → Airlie',
            caution: 'The traced route changed after it was checked.',
        });
        render(<LogPage />);

        expect(await screen.findByText(/GPS voyage logging is starting for/)).toBeInTheDocument();
        expect(screen.queryByText('Route check heads-up')).not.toBeInTheDocument();
        expect(screen.queryByText('The traced route changed after it was checked.')).not.toBeInTheDocument();
    });

    it('auto-retries a failed GPS start once, then hands the skipper the Retry card', async () => {
        stashCastOffHandoff({
            voyageId: 'voyage-handoff',
            voyageName: 'Mackay → Airlie',
            caution: null,
            savedRouteId: 'route-x',
        });
        updateCastOffHandoff({ gps: 'failed', gpsError: 'Background GPS did not confirm the newly active passage.' });
        // The page's ONE automatic retry fails too — the amber card with the
        // manual Retry is the surface that remains.
        shipLogHandoffMock.startTracking.mockRejectedValueOnce(new Error('Still no location access.'));
        shipLogHandoffMock.startTracking.mockResolvedValue(undefined);
        shipLogHandoffMock.getTrackingStatus.mockReturnValue({
            isTracking: true,
            currentVoyageId: 'voyage-handoff',
        });
        render(<LogPage />);

        await waitFor(() => expect(shipLogHandoffMock.startTracking).toHaveBeenCalledTimes(1));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Passage is active, but GPS voyage logging did not start.');
        expect(alert).toHaveTextContent('Still no location access.');

        fireEvent.click(screen.getByRole('button', { name: 'Retry GPS Logging' }));
        // Confirmation then auto-clear: the page wipes a confirmed handoff
        // with no outstanding heads-up, so the settled state is null.
        await waitFor(() => expect(peekCastOffHandoff()).toBeNull());
        expect(shipLogHandoffMock.startTracking).toHaveBeenCalledTimes(2);
        // GPS retries still belong to this fresh Cast Off until its first
        // successful confirmation; the recorder must retain departure intent.
        expect(shipLogHandoffMock.startTracking).toHaveBeenLastCalledWith(
            true,
            'voyage-handoff',
            expect.anything(),
            true,
        );
        // Tracking just confirmed — THIS is the moment the public page can
        // link the passage, so the publish fires here (default: show), and
        // it targets the planned-route MIRROR voyage the public page draws
        // from, never the cast-off voyage itself.
        expect(publishFollowedRouteMock).toHaveBeenCalledWith('planned-x');
    });

    it('respects the skipper who kept the passage private', async () => {
        stashCastOffHandoff({
            voyageId: 'voyage-private',
            voyageName: 'Quiet trip',
            caution: null,
            publishRoute: false,
            savedRouteId: 'route-x',
        });
        updateCastOffHandoff({ gps: 'failed', gpsError: 'first start died' });
        shipLogHandoffMock.startTracking.mockResolvedValue(undefined);
        shipLogHandoffMock.getTrackingStatus.mockReturnValue({
            isTracking: true,
            currentVoyageId: 'voyage-private',
        });
        render(<LogPage />);

        // The auto-retry confirms GPS — and publishes NOTHING.
        await waitFor(() => expect(peekCastOffHandoff()).toBeNull());
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
    });

    it('clears itself once GPS is confirmed and no heads-up remains', async () => {
        stashCastOffHandoff({ voyageId: 'voyage-handoff', voyageName: 'Mackay → Airlie', caution: null });
        updateCastOffHandoff({ gps: 'confirmed' });
        render(<LogPage />);

        await waitFor(() => expect(peekCastOffHandoff()).toBeNull());
        expect(screen.queryByText(/GPS voyage logging is starting/)).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('never asks "which route?" on a voyage that was cast off — the passage IS its route', () => {
        stashCastOffHandoff({
            voyageId: 'active-voyage',
            voyageName: 'Newport → Coral Sea',
            caution: null,
            savedRouteId: 'route-x',
        });
        const view = () => <LogPage />;
        const { rerender } = render(view());

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument();
    });

    it('a DIFFERENT voyage (casual slide-start) still gets its honest question', () => {
        stashCastOffHandoff({
            voyageId: 'some-other-cast-off',
            voyageName: 'Old trip',
            caution: null,
            savedRouteId: 'route-x',
        });
        const view = () => <LogPage />;
        const { rerender } = render(view());

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('the ACTIVE VOYAGE suppresses the route question even with no handoff at all', async () => {
        // The handoff can die with the process; the voyages table cannot.
        activeVoyageMock.value = {
            id: 'active-voyage',
            voyage_name: 'Newport → Coral Sea',
            saved_route_id: 'route-x',
            status: 'active',
        };
        const view = () => <LogPage />;
        const { rerender } = render(view());

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'active-voyage',
            entries: [],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Following a route?' })).not.toBeInTheDocument(),
        );
        // And the route line arms itself from the active voyage.
        await waitFor(() => expect(followRouteMock.state.startFollowing).toHaveBeenCalled());
    });

    it('a stale active voyage must NOT answer for a casual track — the publish regression', async () => {
        // The 2026-08-26 "route authority" gate checked that ANY active row
        // existed, not that it was THIS voyage's. With a zombie-active row
        // parked (the pre-archive-on-stop stop bug), every casual Log-page
        // start lost its route question — so nothing ever published (Shane
        // 2026-08-27: "if you just use the log from the log page… it no
        // longer shows up on your public page").
        activeVoyageMock.value = {
            id: 'stuck-active-voyage',
            voyage_name: 'Newport → Coral Sea',
            saved_route_id: 'route-x',
            status: 'active',
        };
        const view = () => <LogPage />;
        const { rerender } = render(view());

        Object.assign(logPageStateOverrides.state, {
            isTracking: true,
            currentVoyageId: 'voyage_1724900000000_casual12',
            entries: [],
            summaries: [
                {
                    voyageId: 'planned-voyage',
                    isPlannedRoute: true,
                    totalDistanceNM: 12,
                    entryCount: 4,
                    firstLat: -27.5,
                    firstLon: 153,
                    lastLat: -27.4,
                    lastLon: 153.1,
                },
            ],
        });
        rerender(view());

        expect(await screen.findByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
        // …and the stale row must not arm ITS route against this track. The
        // auto-arm sits directly under the same gate: left ungated it put
        // the zombie's line on the cockpit and published it against the
        // casual voyage, whose plan-link event then auto-answered the very
        // question this test just proved was asked.
        await waitFor(() => {
            expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
            expect(publishFollowedRouteMock).not.toHaveBeenCalled();
        });
    });

    it('absorbs an orphan track first — one log at a time', async () => {
        stashCastOffHandoff({
            voyageId: 'voyage-new',
            voyageName: 'Fresh passage',
            caution: null,
            savedRouteId: 'route-x',
        });
        updateCastOffHandoff({ gps: 'failed', gpsError: 'GPS logging is already recording a different voyage.' });
        // The tracker is squatting on an earlier cycle's voyage.
        shipLogHandoffMock.getTrackingStatus
            .mockReturnValueOnce({ isTracking: true, currentVoyageId: 'voyage-orphan' })
            .mockReturnValue({ isTracking: true, currentVoyageId: 'voyage-new' });
        render(<LogPage />);

        // The auto-retry stops the orphan, then starts our fresh departure.
        await waitFor(() => expect(shipLogHandoffMock.stopTracking).toHaveBeenCalledWith('voyage-orphan'));
        await waitFor(() =>
            expect(shipLogHandoffMock.startTracking).toHaveBeenCalledWith(true, 'voyage-new', expect.anything(), true),
        );
        await waitFor(() => expect(peekCastOffHandoff()).toBeNull());
    });
});

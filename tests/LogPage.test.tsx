/**
 * LogPage — component tests.
 *
 * LogPage depends on useLogPageState hook and many sub-components.
 * We mock the heavy dependencies and test rendering & key interactions.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../services/shiplog/publishFollowedRoute', () => ({
    publishFollowedRoute: publishFollowedRouteMock,
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
    VoyageStatsPanel: () => <div data-testid="voyage-stats">Stats</div>,
}));
vi.mock('../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label }: { label: string }) => <button data-testid="slide-to-action">{label}</button>,
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
    FollowRouteChoice: ({ summary, onPick }: { summary: { voyageId: string }; onPick: () => void }) => (
        <button onClick={onPick}>Follow route {summary.voyageId}</button>
    ),
}));
vi.mock('../pages/log/VoyageDialogs', () => ({ VoyageChoiceDialog: () => null, StopVoyageDialog: () => null }));
vi.mock('../pages/log/ExportSheet', () => ({ ExportSheet: () => null }));
vi.mock('../pages/log/GpsDisclaimerModal', () => ({ GpsDisclaimerModal: () => null }));
vi.mock('../pages/log/ImportSheet', () => ({ ImportSheet: () => null }));
vi.mock('../pages/log/ShareSheet', () => ({ ShareSheet: () => null }));
vi.mock('../pages/log/ShareFormSheet', () => ({ ShareFormSheet: () => null }));
vi.mock('../pages/log/StatsSheet', () => ({ StatsSheet: () => null }));

vi.mock('@capacitor/preferences', () => ({
    Preferences: { get: vi.fn().mockResolvedValue({ value: null }), set: vi.fn(), remove: vi.fn() },
}));

// ── Mock the consolidated hook — MUST match full public API ──
vi.mock('../hooks/useLogPageState', () => ({
    useLogPageState: () => ({
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
        loadVoyageEntries: vi.fn(),
        loadAllEntries: vi.fn(),
        hasNonDeviceEntries: false,
        totalDistance: 62,
        avgSpeed: 5.5,
        careerTotals: { totalDistance: 62, totalTimeAtSeaHrs: 12, totalVoyages: 2 },
        archivedVoyages: [],
        handleArchiveVoyage: vi.fn(),
        handleUnarchiveVoyage: vi.fn(),
        ...logPageStateOverrides.hook,
    }),
}));

import { LogPage } from '../pages/LogPage';

describe('LogPage', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
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

    it('accepts onBack callback without crashing', () => {
        const onBack = vi.fn();
        expect(() => {
            render(<LogPage onBack={onBack} />);
        }).not.toThrow();
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

    it('does not publish a cast-off choice when its local route geometry cannot be loaded', async () => {
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

        render(<LogPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Follow route missing-planned-voyage' }));

        await waitFor(() => expect(fetchVoyageAsTrackMock).toHaveBeenCalledWith('missing-planned-voyage'));
        expect(followRouteMock.state.startFollowing).not.toHaveBeenCalled();
        expect(publishFollowedRouteMock).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Following a route?' })).toBeInTheDocument();
    });

    it('unlocks a stalled cast-off prompt and ignores geometry that arrives after the deadline', async () => {
        vi.useFakeTimers();
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

    it('hydrates exact geometry when Follow is chosen from a collapsed planned-route card', async () => {
        const summary = {
            voyageId: 'planned-card-route',
            entryCount: 3,
            startedAt: '2026-07-23T00:00:00.000Z',
            endedAt: '2026-07-23T03:00:00.000Z',
            totalDistanceNM: 12,
            avgSpeedKts: 4,
            hasManual: false,
            isPlannedRoute: true,
            isImported: false,
            firstLat: -27.5,
            firstLon: 153,
            lastLat: -23.9,
            lastLon: 152.4,
            firstIsOnWater: true,
        };
        const exactPoints = [
            { lat: -27.5, lon: 153 },
            { lat: -26.2, lon: 152.7 },
            { lat: -23.9, lon: 152.4 },
        ];
        logPageStateOverrides.hook.listVoyages = [summary];
        fetchVoyageAsTrackMock.mockResolvedValue({
            id: summary.voyageId,
            label: 'Newport → Lady Musgrave',
            sublabel: 'Planned · 12 NM',
            points: exactPoints,
            bbox: [152.4, -27.5, 153, -23.9],
            timestamp: Date.parse(summary.startedAt),
            distanceNm: 12,
            durationHours: 3,
            isLocal: false,
            kind: 'sea',
        });

        render(<LogPage />);
        fireEvent.click(screen.getByRole('button', { name: 'Follow card planned-card-route' }));

        await waitFor(() =>
            expect(followRouteMock.state.startFollowing).toHaveBeenCalledWith(
                expect.objectContaining({
                    origin: 'Newport',
                    destination: 'Lady Musgrave',
                }),
                summary.voyageId,
                exactPoints,
            ),
        );
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
});

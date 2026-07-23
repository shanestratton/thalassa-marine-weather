/**
 * LogPage — component tests.
 *
 * LogPage depends on useLogPageState hook and many sub-components.
 * We mock the heavy dependencies and test rendering & key interactions.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logPageStateOverrides = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
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
    useToast: () => ({ showToast: vi.fn(), ToastContainer: () => null }),
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/lazyRetry', () => ({
    lazyRetry: (fn: () => Promise<{ default: React.ComponentType }>) => React.lazy(fn),
}));

// ── Mock heavy sub-components (paths relative to pages/LogPage.tsx) ──
vi.mock('../components/AddEntryModal', () => ({ AddEntryModal: () => null }));
vi.mock('../components/EditEntryModal', () => ({ EditEntryModal: () => null }));
vi.mock('../components/TrackMapViewer', () => ({ TrackMapViewer: () => <div data-testid="track-map">TrackMap</div> }));
vi.mock('../components/LiveMiniMap', () => ({ LiveMiniMap: () => <div data-testid="live-mini-map">LiveMap</div> }));
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
    VoyageCard: ({ summary }: { summary: { voyageId: string } }) => (
        <div data-testid={`voyage-${summary.voyageId}`}>Voyage {summary.voyageId}</div>
    ),
    StatBox: ({ label }: { label: string }) => <div data-testid="stat-box">{label}</div>,
    MenuBtn: ({ label, onClick }: { label: string; onClick: () => void }) => (
        <button onClick={onClick} data-testid={`menu-${label}`}>
            {label}
        </button>
    ),
    FollowRouteChoice: ({ summary }: { summary: { voyageId: string } }) => (
        <button>Follow route {summary.voyageId}</button>
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
    }),
}));

import { LogPage } from '../pages/LogPage';

describe('LogPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(logPageStateOverrides.state)) delete logPageStateOverrides.state[key];
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
});

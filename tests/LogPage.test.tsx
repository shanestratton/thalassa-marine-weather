/**
 * LogPage — component tests.
 *
 * LogPage depends on useLogPageState hook and many sub-components.
 * We mock the heavy dependencies and test rendering & key interactions.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    VoyageCard: ({ voyage }: { voyage: { voyageId: string } }) => (
        <div data-testid={`voyage-${voyage.voyageId}`}>Voyage {voyage.voyageId}</div>
    ),
    StatBox: ({ label }: { label: string }) => <div data-testid="stat-box">{label}</div>,
    MenuBtn: ({ label, onClick }: { label: string; onClick: () => void }) => (
        <button onClick={onClick} data-testid={`menu-${label}`}>
            {label}
        </button>
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
});

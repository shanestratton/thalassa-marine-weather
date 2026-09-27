/**
 * The Vessel hub as a screen reader and a thumb meet it (UX scorecard run 7):
 *
 *  - no two controls share a name (the Music section toggle and the Music row
 *    were both "Music", so VoiceOver read "Music, button" twice);
 *  - the vessel card's title is a heading, and no heading sits inside a button
 *    (a heading inside a button is flattened into the button's name);
 *  - Settings is one tap from the hub, not behind the collapsed group at its
 *    foot, and the one collapsible group names the panel it opens.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const vessel = vi.hoisted(() => ({ name: 'Serene Summer', type: 'sail' }));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vessel },
        updateSettings: vi.fn(),
    }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: null, refreshData: vi.fn() }),
}));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (select: (state: { isOffline: boolean }) => unknown) => select({ isOffline: true }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (state: { user: null }) => unknown) => select({ user: null }),
}));
vi.mock('../stores/settingsStore', () => ({ refreshSkipperClaim: vi.fn(async () => undefined) }));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        watchPosition: () => () => undefined,
        getCurrentPositionIfGranted: async () => null,
    },
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: () => null,
    getActiveVoyage: async () => null,
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { subscribe: () => () => undefined },
}));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: { onStateChange: () => () => undefined },
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: async () => [] }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../hooks/useVesselReadinessCounts', () => ({
    useVesselReadinessCounts: () => ({ overdueCount: 0, expiringDocsCount: 0, expiringEquipCount: 0 }),
}));
vi.mock('../hooks/useCloudTelemetry', () => ({ useCloudTelemetry: () => ({ latest: null, piPrimary: false }) }));
vi.mock('../hooks/useTripRoute', () => ({ useTripRoute: () => null }));
vi.mock('../components/nmea/useNmeaStore', () => ({
    useNmeaConnectionStatus: () => ({ status: 'disconnected' }),
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getFeedStatus: () => 'unavailable' } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/routeTracer', () => ({ loadSavedTraces: () => [] }));
vi.mock('../services/savedRoutesSync', () => ({ syncSavedRoutes: async () => [] }));
vi.mock('../stores/PassageStore', () => ({
    PassageStore: {
        getState: () => ({ hasRoute: false, arriveLat: null, arriveLon: null, totalDistanceNM: 0 }),
        subscribe: () => () => undefined,
    },
}));
vi.mock('../components/vesselHub/usePendingCrewInvites', () => ({ usePendingCrewInvites: () => 0 }));
vi.mock('../components/vesselHub/useGuardianTileState', () => ({
    useGuardianTileState: () => ({ guardianArmed: false, guardianNearby: 0 }),
}));
vi.mock('../components/vesselHub/useTripLogActive', () => ({ useTripLogActive: () => false }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));

import { VesselHub } from '../components/VesselHub';

function renderHub() {
    const onNavigate = vi.fn();
    render(<VesselHub onNavigate={onNavigate} settings={{}} onSave={vi.fn()} />);
    return onNavigate;
}

afterEach(() => {
    cleanup();
    vessel.name = 'Serene Summer';
    // The Connections & music group remembers how it was left (UX scorecard
    // run 8), so each test starts from a first visit.
    localStorage.removeItem('thalassa_vessel_connections_open');
});

describe('Vessel hub accessible structure', () => {
    it('gives every control its own name', () => {
        renderHub();
        fireEvent.click(screen.getByRole('button', { name: 'Connections & music', expanded: false }));
        const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '');
        const repeated = names.filter((name, index) => name && names.indexOf(name) !== index);
        expect(repeated).toEqual([]);
        expect(screen.getAllByRole('button', { name: 'Music' })).toHaveLength(1);
    });

    it('makes the vessel card title a heading, and keeps headings out of buttons', () => {
        renderHub();
        expect(screen.getByRole('heading', { level: 2, name: 'Serene Summer' })).toBeInTheDocument();
        for (const button of screen.getAllByRole('button')) {
            expect(within(button).queryAllByRole('heading')).toEqual([]);
        }
    });

    it('keeps headings out of the hero card button on a fresh install', () => {
        // With no vessel name the hero shows its "Set up your vessel" button;
        // its title is a span, not an h2 nested in the button.
        vessel.name = '';
        renderHub();
        const setUp = screen.getByRole('button', { name: 'Set up your vessel' });
        expect(within(setUp).queryAllByRole('heading')).toEqual([]);
        for (const button of screen.getAllByRole('button')) {
            expect(within(button).queryAllByRole('heading')).toEqual([]);
        }
    });

    it('opens Settings in one tap, without expanding a group', () => {
        const onNavigate = renderHub();
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(onNavigate).toHaveBeenCalledWith('settings');
    });

    it('keeps the group rows out of reach until opened, and names the panel it opens', () => {
        renderHub();
        const toggle = screen.getByRole('button', { name: 'Connections & music', expanded: false });
        expect(screen.queryByRole('button', { name: 'NMEA Gateway' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Music' })).toBeNull();
        const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
        expect(panel).not.toBeNull();
        fireEvent.click(toggle);
        expect(within(panel!).getByRole('button', { name: 'NMEA Gateway' })).toBeInTheDocument();
        expect(within(panel!).getByRole('button', { name: 'Boat Network' })).toBeInTheDocument();
        expect(within(panel!).getByRole('button', { name: 'Music' })).toBeInTheDocument();
    });

    it('reopens Connections & music the way the skipper left it', () => {
        renderHub();
        fireEvent.click(screen.getByRole('button', { name: 'Connections & music', expanded: false }));
        cleanup();

        renderHub();
        expect(screen.getByRole('button', { name: 'Connections & music', expanded: true })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'NMEA Gateway' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Connections & music', expanded: true }));
        cleanup();

        renderHub();
        expect(screen.getByRole('button', { name: 'Connections & music', expanded: false })).toBeInTheDocument();
    });

    it('tells the two connection rows apart', () => {
        renderHub();
        fireEvent.click(screen.getByRole('button', { name: 'Connections & music', expanded: false }));
        const gateway = screen.getByRole('button', { name: 'NMEA Gateway' });
        const network = screen.getByRole('button', { name: 'Boat Network' });
        expect(gateway).toHaveAccessibleDescription(/AIS/);
        // "Boat computer", not the hobbyist "The Pi" (UX scorecard run 9).
        expect(network).toHaveAccessibleDescription('Boat computer, charts & devices');
        expect(network).not.toHaveAccessibleDescription(/instruments/i);
    });
});

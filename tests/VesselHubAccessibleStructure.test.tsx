/**
 * The Vessel hub as a screen reader and a thumb meet it (UX scorecard run 7):
 *
 *  - no two controls share a name (the Music section toggle and the Music row
 *    were both "Music", so VoiceOver read "Music, button" twice);
 *  - the vessel card's title is a heading, and no heading sits inside a button
 *    (a heading inside a button is flattened into the button's name);
 *  - Settings is one tap from the hub. Since 2026-10-04 nothing on the hub is
 *    folded: the six menu rows are one box (tests/VesselHubMenuBox.test.tsx).
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
});

describe('Vessel hub accessible structure', () => {
    it('gives every control its own name', () => {
        renderHub();
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

    it('gives the menu box a heading, so the rotor finds it between the cards', () => {
        renderHub();
        const box = screen.getByTestId('vessel-hub-menu');
        expect(within(box).getByRole('heading', { level: 2, name: 'Vessel menu' })).toBeInTheDocument();
    });

    it('tells the two connection rows apart', () => {
        renderHub();
        const gateway = screen.getByRole('button', { name: 'NMEA Gateway' });
        const network = screen.getByRole('button', { name: 'Boat Network' });
        expect(gateway).toHaveAccessibleDescription(/AIS/);
        // "Boat computer", not the hobbyist "The Pi" (UX scorecard run 9).
        expect(network).toHaveAccessibleDescription('Boat computer, charts & devices');
        expect(network).not.toHaveAccessibleDescription(/instruments/i);
    });

    it('says what the Diary and Scuttlebutt cards hold, and the unread count when there is one', () => {
        renderHub();
        expect(screen.getByRole('button', { name: 'Open Diary' })).toHaveAccessibleDescription('Notes & photos');
        expect(screen.getByRole('button', { name: 'Open Scuttlebutt' })).toHaveAccessibleDescription('Sailor chat');
        cleanup();
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} chatUnread={3} />);
        const chat = screen.getByRole('button', { name: 'Open Scuttlebutt' });
        // Shane 2026-10-04: the cards should invite a tap; unread DMs (the
        // Vessel tab's badge) are said on the card, the count drawn beside.
        expect(chat).toHaveAccessibleDescription('3 new messages');
        expect(chat).toHaveTextContent('3');
    });
});

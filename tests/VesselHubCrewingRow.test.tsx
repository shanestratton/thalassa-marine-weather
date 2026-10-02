/**
 * The Vessel hub's Crew & Float Plan row while crewing (2026-10-03): it names
 * the skipper's boat and counts ITS people, not the crew member's own boat.
 * Pending invites still take the status line, in amber. Fictional boats only.
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const vessel = vi.hoisted(() => ({ name: 'Kestrel', type: 'sail', crewCount: 2 }));
const hub = vi.hoisted(() => ({
    pending: 0,
    getMyCrew: vi.fn(async () => [{ id: 'own-1' }, { id: 'own-2' }, { id: 'own-3' }, { id: 'own-4' }, { id: 'own-5' }]),
    crewing: null as null | { ownerId: string; vesselName: string | null; role: string; lastAcceptedAt: string },
    view: null as unknown,
}));

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
    useAuthStore: (select: (state: { user: { id: string } }) => unknown) => select({ user: { id: 'crew-user' } }),
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
vi.mock('../services/CrewService', () => ({ getMyCrew: hub.getMyCrew }));
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
vi.mock('../components/vesselHub/usePendingCrewInvites', () => ({ usePendingCrewInvites: () => hub.pending }));
vi.mock('../components/vesselHub/useGuardianTileState', () => ({
    useGuardianTileState: () => ({ guardianArmed: false, guardianNearby: 0 }),
}));
vi.mock('../components/vesselHub/useTripLogActive', () => ({ useTripLogActive: () => false }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));

vi.mock('../hooks/useCrewingVessel', () => ({
    useCrewingVessel: () => ({ vessel: hub.crewing, vessels: hub.crewing ? [hub.crewing] : [], version: 1 }),
}));
vi.mock('../hooks/useCrewVesselView', () => ({
    useCrewVesselView: (ownerId: string | null) => ({ view: ownerId ? hub.view : null, stale: false, loading: false }),
}));

import { VesselHub } from '../components/VesselHub';

function crewRow() {
    return screen.getByRole('button', { name: 'Crew & Float Plan' });
}

beforeEach(() => {
    setAuthIdentityScope(null);
    setAuthIdentityScope('crew-user');
    hub.pending = 0;
    hub.crewing = null;
    hub.view = null;
    hub.getMyCrew.mockClear();
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('Vessel hub Crew & Float Plan row while crewing', () => {
    it("names the skipper's boat and counts its people", async () => {
        hub.crewing = { ownerId: 'skipper-1', vesselName: 'Wandering Albatross', role: 'deckhand', lastAcceptedAt: '' };
        hub.view = {
            ownerId: 'skipper-1',
            vessel: { name: 'Wandering Albatross', crewCount: 4 },
            vesselUnits: null,
            roster: [],
            manifest: [
                { isSkipper: true, isSelf: false, role: 'skipper', name: 'Ana' },
                { isSkipper: false, isSelf: true, role: 'deckhand', name: 'Tom' },
            ],
            fetchedAt: '2026-10-03T00:00:00.000Z',
            source: 'rpc',
        };
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        expect(crewRow()).toHaveTextContent('Crewing on Wandering Albatross');
        expect(crewRow()).toHaveTextContent('4 crew');
        // The crew member's own crew list is not what this row counts.
        expect(crewRow()).not.toHaveTextContent('6 crew');
        expect(hub.getMyCrew).not.toHaveBeenCalled();
    });

    it('pending invites still take the status line', () => {
        hub.pending = 1;
        hub.crewing = { ownerId: 'skipper-1', vesselName: 'Wandering Albatross', role: 'deckhand', lastAcceptedAt: '' };
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        expect(crewRow()).toHaveTextContent('1 crew invite pending');
    });

    it('not crewing: the row reads as it always did', async () => {
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        expect(crewRow()).toHaveTextContent('Readiness checks & cast off');
        await waitFor(() => expect(crewRow()).toHaveTextContent('6 crew'));
    });
});

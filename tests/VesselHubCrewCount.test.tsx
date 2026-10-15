/**
 * The Crew & Float Plan card counts everyone on the crew register (129-14,
 * Shane 2026-10-14: "the crew and float plan card says two crew. But there is
 * actually three. 2+1 invitee").
 *
 * It read the larger of the profile's "Crew aboard" (2) and the app's crew
 * rows plus the skipper (1 + 1), so two people on the profile and one
 * accepted invitee read "2 crew". It now counts the float plan's way, each
 * person once, pending invitees included, and says how many are still
 * invited. The card and the float plan agree on the same boat. Fictional
 * people only: the repository is public.
 */
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { FloatPlanCrew, FloatPlanRosterSeed } from '../services/floatPlanCrew';

const hub = vi.hoisted(() => ({
    vessel: {} as Record<string, unknown>,
    crew: null as FloatPlanCrew | null,
    load: vi.fn(),
    // What the card read before 129: the account's vessel_crew rows.
    getMyCrew: vi.fn(),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: hub.vessel }, updateSettings: vi.fn() }),
}));
vi.mock('../stores/settingsStore', () => ({
    refreshSkipperClaim: vi.fn(async () => undefined),
    useSettingsStore: (select: (state: { settings: { vessel: unknown } }) => unknown) =>
        select({ settings: { vessel: hub.vessel } }),
}));
vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({ weatherData: null, refreshData: vi.fn() }),
}));
vi.mock('../stores/uiStore', () => ({
    useUIStore: (select: (state: { isOffline: boolean }) => unknown) => select({ isOffline: true }),
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (state: { user: { id: string } }) => unknown) => select({ user: { id: 'owner-1' } }),
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { watchPosition: () => () => undefined, getCurrentPositionIfGranted: async () => null },
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => null, getActiveVoyage: async () => null }));
vi.mock('../services/AnchorWatchService', () => ({ AnchorWatchService: { subscribe: () => () => undefined } }));
vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: { onStateChange: () => () => undefined },
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: hub.getMyCrew }));
vi.mock('../services/floatPlanCrew', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/floatPlanCrew')>()),
    loadFloatPlanCrew: hub.load,
}));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../hooks/useVesselReadinessCounts', () => ({
    useVesselReadinessCounts: () => ({
        overdueCount: 0,
        expiredDocsCount: 0,
        expiringDocsCount: 0,
        expiringEquipCount: 0,
    }),
}));
vi.mock('../hooks/useCloudTelemetry', () => ({ useCloudTelemetry: () => ({ latest: null, piPrimary: false }) }));
vi.mock('../hooks/useTripRoute', () => ({ useTripRoute: () => null }));
vi.mock('../components/nmea/useNmeaStore', () => ({ useNmeaConnectionStatus: () => ({ status: 'disconnected' }) }));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { getFeedStatus: () => 'unavailable' } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { isAvailable: () => false } }));
vi.mock('../services/savedTraceStore', () => ({ loadSavedTraces: () => [] }));
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
vi.mock('../hooks/useCrewingVessel', () => ({ useCrewingVessel: () => ({ vessel: null, vessels: [], version: 1 }) }));
vi.mock('../hooks/useCrewVesselView', () => ({
    useCrewVesselView: () => ({ view: null, stale: false, loading: false }),
}));

import { VesselHub } from '../components/VesselHub';
import { FloatPlanSheet } from '../components/vessel/FloatPlanSheet';

const SKIPPER: FloatPlanRosterSeed = {
    name: 'Ingrid Solberg',
    role: 'Skipper',
    source: 'skipper',
    crewUserId: 'owner-1',
};
const AMARA: FloatPlanRosterSeed = { name: 'Amara Okafor', role: 'Co-skipper', source: 'crew', crewUserId: 'u-amara' };
const LUCAS: FloatPlanRosterSeed = { name: 'Lucas Moreau', role: 'Guest', source: 'invite', crewUserId: 'u-lucas' };
const TWO_ON_PROFILE = {
    name: 'Southerly Spirit',
    type: 'sail',
    crewCount: 2,
    crewRoster: [
        { name: 'Ingrid Solberg', rank: 'Skipper' },
        { name: 'Kenji Watanabe', rank: 'First mate' },
    ],
};

const crewRow = () => screen.getByRole('button', { name: 'Crew & Float Plan' });

function boat(vessel: Record<string, unknown>, crew: FloatPlanCrew) {
    hub.vessel = vessel;
    hub.crew = crew;
    hub.load.mockResolvedValue(crew);
    // The rows vessel_crew holds for the same boat: one per app person.
    hub.getMyCrew.mockResolvedValue(
        [...crew.aboard.slice(1), ...crew.invited].map((seed) => ({ id: seed.crewUserId })),
    );
}

beforeEach(() => {
    setAuthIdentityScope(null);
    setAuthIdentityScope('owner-1');
    hub.load.mockReset();
    hub.getMyCrew.mockReset();
    hub.getMyCrew.mockResolvedValue([]);
});

afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});

describe('Crew & Float Plan card count', () => {
    it("Shane's boat: two on the profile and one accepted invitee read 3 crew, not 2", async () => {
        boat(TWO_ON_PROFILE, { aboard: [SKIPPER, AMARA], invited: [] });
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        await waitFor(() => expect(crewRow()).toHaveTextContent('3 crew'));
        expect(crewRow()).toHaveTextContent('Readiness checks & cast off');
        expect(hub.load).toHaveBeenCalledWith(null, { forCount: true });
    });

    it('two accepted and one still invited read 3 crew, and say 1 is invited', async () => {
        boat({ name: 'Southerly Spirit', type: 'sail', crewCount: 2 }, { aboard: [SKIPPER, AMARA], invited: [LUCAS] });
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        await waitFor(() => expect(crewRow()).toHaveTextContent('3 crew'));
        // The whole subtitle: short enough to stay whole at 320 pt in large text.
        expect(within(crewRow()).getByText('1 invited', { exact: true })).toBeInTheDocument();
        // Read with the row, not as a separate control.
        expect(crewRow()).toHaveAccessibleDescription(/1 invited/);
    });

    it('agrees with the float plan on the same boat: aboard, plus its invite chips', async () => {
        boat(TWO_ON_PROFILE, { aboard: [SKIPPER, AMARA], invited: [LUCAS] });
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        await waitFor(() => expect(crewRow()).toHaveTextContent('4 crew'));
        cleanup();
        render(
            <FloatPlanSheet
                preset={{ route: { name: 'Gulf crossing' }, departureMs: Date.now() + 3_600_000 }}
                onClose={vi.fn()}
            />,
        );
        // The plan lists the three aboard and offers the one invitee as a chip.
        await waitFor(() => expect(screen.getAllByTestId('float-plan-invite-chip')).toHaveLength(1));
        await waitFor(() => expect(document.querySelector('output')?.textContent).toBe('3'));
    });

    it('with nobody still invited, the card and the float plan say the same number', async () => {
        boat(TWO_ON_PROFILE, { aboard: [SKIPPER, AMARA], invited: [] });
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        await waitFor(() => expect(crewRow()).toHaveTextContent('3 crew'));
        cleanup();
        render(
            <FloatPlanSheet
                preset={{ route: { name: 'Gulf crossing' }, departureMs: Date.now() + 3_600_000 }}
                onClose={vi.fn()}
            />,
        );
        await waitFor(() => expect(document.querySelector('output')?.textContent).toBe('3'));
    });

    it('signed in but the crew list cannot answer: the profile alone, never a guess', async () => {
        hub.vessel = TWO_ON_PROFILE;
        hub.load.mockResolvedValue(null);
        render(<VesselHub onNavigate={vi.fn()} settings={{}} onSave={vi.fn()} />);
        await waitFor(() => expect(hub.load).toHaveBeenCalled());
        expect(crewRow()).toHaveTextContent('2 crew');
        expect(crewRow()).not.toHaveTextContent('invited');
    });
});

/**
 * On a passage the viewer does not own (the crewing view, 2026-10-03), every
 * card reads the SKIPPER'S boat, never the crew member's own (Shane: "it
 * should all pertain to the vessel that the punter has been invited on").
 *
 *   - Weather Windows scores against the skipper's boat's limits.
 *   - Ocean Currents uses the skipper's boat's cruising speed.
 *   - The Watch Schedule is the skipper's: read-only, names only, never a
 *     peer's email, and never the crew member's own crew list.
 *
 * Fictional boats and people only.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchAssignment } from '../services/WatchAssignmentService';
import type { WeatherWindowResult } from '../services/WeatherWindowService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    analyse: vi.fn(),
    fetchCurrents: vi.fn(),
    loadCardChecks: vi.fn(),
    upsertCheck: vi.fn(),
    clearChecks: vi.fn(),
    list: vi.fn(),
    subscribeToUpdates: vi.fn(() => vi.fn()),
    publishToCrew: vi.fn(),
    assign: vi.fn(),
    clear: vi.fn(),
    clearAll: vi.fn(),
    getMyCrew: vi.fn(),
    getUser: vi.fn(),
    // The crew member's OWN boat: nothing of it may reach these cards.
    settings: {
        vessel: {
            name: 'Kestrel',
            type: 'power' as const,
            cruisingSpeed: 15,
            maxWindSpeed: 45,
            maxWaveHeight: 13,
            length: 30,
        },
        comfortParams: {},
        units: { speed: 'kts' as const },
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: mocks.settings }),
}));

vi.mock('../services/ReadinessCheckService', () => ({
    ReadinessCheckService: {
        loadCardChecks: mocks.loadCardChecks,
        upsertCheck: mocks.upsertCheck,
        clearChecks: mocks.clearChecks,
    },
}));

vi.mock('../services/WeatherWindowService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/WeatherWindowService')>();
    return { ...actual, WeatherWindowService: { ...actual.WeatherWindowService, analyse: mocks.analyse } };
});

vi.mock('../services/OceanCurrentService', () => ({
    OceanCurrentService: { fetchCurrents: mocks.fetchCurrents },
}));

vi.mock('../services/WatchAssignmentService', () => ({
    WatchAssignmentService: {
        list: mocks.list,
        subscribeToUpdates: mocks.subscribeToUpdates,
        publishToCrew: mocks.publishToCrew,
        assign: mocks.assign,
        clear: mocks.clear,
        clearAll: mocks.clearAll,
    },
}));

vi.mock('../services/CrewService', () => ({ getMyCrew: mocks.getMyCrew }));

vi.mock('../services/supabase', () => ({ supabase: { auth: { getUser: mocks.getUser } } }));

vi.mock('../components/passage/WatchAssignSheet', () => ({
    WatchAssignSheet: () => <div data-testid="watch-assign-sheet" />,
}));

vi.mock('../utils/system', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/system')>();
    return { ...actual, triggerHaptic: vi.fn() };
});

import { WatchScheduleCard } from '../components/passage/WatchScheduleCard';
import { WeatherWindowCard } from '../components/passage/WeatherWindowCard';
import { OceanCurrentsCard } from '../components/passage/OceanCurrentsCard';
import { passageDataFingerprint } from '../services/passageEnvironmentReadiness';
import { useSettingsStore } from '../stores/settingsStore';

const SKIPPER_BOAT = {
    name: 'Wandering Albatross',
    type: 'sail',
    cruisingSpeed: 6.5,
    maxWindSpeed: 28,
    maxWaveHeight: 8,
    length: 44,
    hullType: 'monohull',
};

const DEPARTURE = { lat: -27.2, lon: 153.1 };
const DESTINATION = { lat: -26.4, lon: 153.4 };

function assignment(index: number, fields: Partial<WatchAssignment>): WatchAssignment {
    return {
        id: `assignment-${index}`,
        voyage_id: 'voyage-1',
        watch_index: index,
        watch_label: `Watch ${index}`,
        watch_time_label: '00:00',
        assigned_crew_email: null,
        assigned_crew_name: null,
        assigned_crew_user_id: null,
        assigned_at: '2026-10-01T00:00:00.000Z',
        assigned_by: 'skipper-1',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...fields,
    };
}

const UNAVAILABLE: WeatherWindowResult = {
    availability: 'unavailable',
    failureReason: 'No forecast in this test.',
    analysisContextFingerprint: 'context',
} as unknown as WeatherWindowResult;

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('crew-1');
    for (const fn of [mocks.analyse, mocks.fetchCurrents, mocks.list, mocks.getMyCrew, mocks.getUser]) fn.mockReset();
    mocks.loadCardChecks.mockReset().mockResolvedValue({});
    mocks.upsertCheck.mockReset().mockResolvedValue(undefined);
    mocks.clearChecks.mockReset().mockResolvedValue(undefined);
    mocks.subscribeToUpdates.mockClear();
    mocks.publishToCrew.mockReset().mockResolvedValue(0);
    mocks.clearAll.mockReset().mockResolvedValue(true);
    mocks.analyse.mockResolvedValue(UNAVAILABLE);
    mocks.fetchCurrents.mockRejectedValue(new Error('no currents in this test'));
    mocks.list.mockResolvedValue([]);
    mocks.getMyCrew.mockResolvedValue([]);
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'crew-1', email: 'tom@example.com' } }, error: null });
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe("Weather Windows on the skipper's passage", () => {
    it("asks for windows scored against the skipper's boat, not your own", async () => {
        render(
            <WeatherWindowCard
                voyageId="voyage-1"
                departure={DEPARTURE}
                destination={DESTINATION}
                vesselOverride={SKIPPER_BOAT}
            />,
        );
        await waitFor(() => expect(mocks.analyse).toHaveBeenCalled());
        const vessel = mocks.analyse.mock.calls[0][4];
        expect(vessel).toMatchObject({ cruisingSpeed: 6.5, maxWindSpeed: 28, maxWaveHeight: 8, type: 'sail' });
    });

    it('with no profile for that boat, never falls back to your own limits', async () => {
        render(
            <WeatherWindowCard
                voyageId="voyage-1"
                departure={DEPARTURE}
                destination={DESTINATION}
                vesselOverride={null}
            />,
        );
        await waitFor(() => expect(mocks.analyse).toHaveBeenCalled());
        expect(mocks.analyse.mock.calls[0][4]).toBeNull();
    });

    it('your own passage still reads your own boat', async () => {
        render(<WeatherWindowCard voyageId="voyage-1" departure={DEPARTURE} destination={DESTINATION} />);
        await waitFor(() => expect(mocks.analyse).toHaveBeenCalled());
        expect(mocks.analyse.mock.calls[0][4]).toBeUndefined();
    });

    it("the service's scoring caps come from the boat it is given", async () => {
        const { WeatherWindowService } = await vi.importActual<typeof import('../services/WeatherWindowService')>(
            '../services/WeatherWindowService',
        );
        const previous = useSettingsStore.getState().settings;
        type Vessel = NonNullable<typeof previous.vessel>;
        const ownVessel = { ...previous.vessel, ...mocks.settings.vessel } as Vessel;
        useSettingsStore.setState({ settings: { ...previous, vessel: ownVessel, comfortParams: {} } });
        try {
            // Invalid coordinates answer at once, with the scoring context's fingerprint.
            const skipper = await WeatherWindowService.analyse(999, 0, undefined, undefined, SKIPPER_BOAT);
            const unknown = await WeatherWindowService.analyse(999, 0, undefined, undefined, null);
            const own = await WeatherWindowService.analyse(999, 0);
            const context = (maxWindKts: number, maxWaveM: number) =>
                passageDataFingerprint('weather-window-context', {
                    lat: 999,
                    lon: 0,
                    courseBearing: undefined,
                    comfort: { maxWindKts, maxWaveM, preferredAngles: [] },
                });
            expect(skipper.analysisContextFingerprint).toBe(context(28, 8 / 3.28084));
            expect(unknown.analysisContextFingerprint).toBe(context(35, 4));
            expect(own.analysisContextFingerprint).toBe(context(45, 13 / 3.28084));
        } finally {
            useSettingsStore.setState({ settings: previous });
        }
    });
});

describe("Ocean Currents on the skipper's passage", () => {
    it("briefs at the skipper's boat's cruising speed", async () => {
        render(
            <OceanCurrentsCard
                voyageId="voyage-1"
                departure={DEPARTURE}
                destination={DESTINATION}
                distanceNM={50}
                vesselOverride={SKIPPER_BOAT}
            />,
        );
        await waitFor(() => expect(mocks.fetchCurrents).toHaveBeenCalled());
        expect(mocks.fetchCurrents.mock.calls[0][3]).toBe(6.5);
    });

    it("an unknown boat briefs at the default 6 kt, never at your own boat's speed", async () => {
        render(
            <OceanCurrentsCard
                voyageId="voyage-1"
                departure={DEPARTURE}
                destination={DESTINATION}
                distanceNM={50}
                vesselOverride={null}
            />,
        );
        await waitFor(() => expect(mocks.fetchCurrents).toHaveBeenCalled());
        expect(mocks.fetchCurrents.mock.calls[0][3]).toBe(6);
    });
});

describe("the Watch Schedule on the skipper's passage", () => {
    beforeEach(() => {
        mocks.list.mockResolvedValue([
            assignment(0, { assigned_crew_email: 'lena@example.com', assigned_crew_user_id: 'crew-2' }),
            assignment(1, {
                assigned_crew_email: 'tom@example.com',
                assigned_crew_name: 'Tom Okafor',
                assigned_crew_user_id: 'crew-1',
            }),
            assignment(2, {
                assigned_crew_email: 'ana@example.com',
                assigned_crew_name: 'Ana Reyes',
                assigned_crew_user_id: 'skipper-1',
            }),
        ]);
    });

    it("is read-only, by name, and never shows a peer's email or your own crew", async () => {
        render(<WatchScheduleCard voyageId="voyage-1" crewCount={3} readOnly />);

        expect(await screen.findByText('👤 Ana Reyes')).toBeInTheDocument();
        // Your own watch reads as you; an unnamed peer reads 'Crew', never the email.
        expect(screen.getByText('👤 You')).toBeInTheDocument();
        expect(screen.getByText('👤 Crew')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/@example\.com/);

        // Nobody else's crew list, nor your email, is fetched for the skipper's passage.
        expect(mocks.getMyCrew).not.toHaveBeenCalled();
        expect(mocks.getUser).not.toHaveBeenCalled();

        // Watches cannot be (re)assigned, published or re-planned from here.
        expect(screen.queryByRole('button', { name: /^Assign / })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Publish watch schedule to crew' })).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Watch system' })).toBeDisabled();
        expect(screen.getByText(/set by the skipper/i)).toBeInTheDocument();
        expect(screen.queryByTestId('watch-assign-sheet')).not.toBeInTheDocument();
    });

    it("the skipper's own card still assigns and publishes", async () => {
        render(<WatchScheduleCard voyageId="voyage-1" crewCount={3} />);
        const [row] = await screen.findAllByRole('button', { name: /^Assign / });
        await waitFor(() => expect(within(row).getByText(/lena@example\.com/)).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Publish watch schedule to crew' })).toBeInTheDocument();
        await waitFor(() => expect(mocks.getMyCrew).toHaveBeenCalledWith('voyage-1'));
    });
});

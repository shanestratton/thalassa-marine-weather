/**
 * The float plan prints AGE, worked out on its departure day, never the date
 * of birth (129-14, Shane 2026-10-14: "can we change punters age for date of
 * birth. Otherwise we will have to change the age every year. This only shows
 * up in the float plan").
 *
 * A float plan's holder and a rescue service need the age; the date of birth
 * is more personal and of no use on it. A birthday during the passage does
 * not matter: the departure day's age is the one printed. An age typed before
 * 129 keeps printing until someone enters a date of birth. Fictional people.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { FloatPlanSheet, type FloatPlanPreset } from '../components/vessel/FloatPlanSheet';
import { loadFloatPlanCrew, type FloatPlanRosterSeed } from '../services/floatPlanCrew';
import { dayIn } from '../services/crew/dateOfBirth';

const mocks = vi.hoisted(() => ({
    vessel: {
        name: 'Southerly Spirit',
        type: 'sail' as const,
        length: 46,
        contactPhone: '+61 400 000 000',
        crewCount: 3,
        crewRoster: [
            // Her birthday is the departure day.
            { name: 'Ingrid Solberg', rank: 'Skipper', dateOfBirth: '1979-10-15' },
            // An age typed before 129: it stays until a date of birth is entered.
            { name: 'Kenji Watanabe', rank: 'First mate', age: 52 },
            // His birthday is two days into the passage: the plan says 40.
            { name: 'Mateus Silva', rank: 'Crew', dateOfBirth: '1985-10-17' },
        ] as Array<{ name: string; age?: number; rank?: string; dateOfBirth?: string }>,
    },
}));

vi.mock('../stores/settingsStore', () => {
    const state = () => ({ settings: { vessel: mocks.vessel }, activeVesselId: null });
    return {
        useSettingsStore: Object.assign((select: (snapshot: ReturnType<typeof state>) => unknown) => select(state()), {
            getState: state,
        }),
    };
});
vi.mock('../services/savedTraceStore', () => ({ loadSavedTraces: () => [] }));
vi.mock('../services/floatPlanCrew', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/floatPlanCrew')>()),
    loadFloatPlanCrew: vi.fn(),
}));

/** Noon UTC on 15 October 2026: the 15th from UTC-11 to UTC+11. */
const DEPARTURE = Date.UTC(2026, 9, 15, 12, 0);
const PRESET: FloatPlanPreset = {
    route: { name: 'Gulf crossing', from: 'Lisbon', to: 'Funchal', distanceNM: 520 },
    departureMs: DEPARTURE,
    etaMs: DEPARTURE + 4 * 24 * 3_600_000,
};
const SKIPPER: FloatPlanRosterSeed = {
    name: 'Ingrid Solberg',
    role: 'Skipper',
    source: 'skipper',
    crewUserId: 'owner-1',
};
/** An accepted invitee whose own Settings shared an age the loader worked out on the departure day. */
const INVITEE: FloatPlanRosterSeed = {
    name: 'Thomas Okafor',
    role: 'Deckhand',
    source: 'crew',
    crewUserId: 'u-tom',
    shared: { name: 'Thomas Okafor', phone: '0400 000 002', age: 34, appName: 'Tom' },
};
const load = vi.mocked(loadFloatPlanCrew);
const ages = () => (screen.queryAllByLabelText(/^Person \d+ age$/) as HTMLInputElement[]).map((input) => input.value);

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('owner-1');
});
afterEach(() => {
    setAuthIdentityScope(null);
});

describe('FloatPlanSheet ages from dates of birth', () => {
    it('prints each age on the departure day, keeps the old age, and asks the crew list for that day', async () => {
        load.mockResolvedValue({ aboard: [SKIPPER, INVITEE], invited: [] });
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        await waitFor(() => expect(ages()).toHaveLength(4));
        // Rank order: Skipper, First mate, then Crew and Deckhand (one rank) by name.
        expect(ages()).toEqual(['47', '52', '40', '34']);
        const departureDay = dayIn(DEPARTURE, Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(load).toHaveBeenCalledWith(null, { onDay: departureDay });
    });

    it('the plan text carries the ages and never a date of birth', async () => {
        load.mockResolvedValue({ aboard: [SKIPPER, INVITEE], invited: [] });
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        await waitFor(() => expect(ages()).toHaveLength(4));
        const sheet = screen.getByTestId('float-plan-sheet').textContent ?? '';
        expect(sheet).toContain('Ingrid Solberg — Skipper, 47');
        expect(sheet).toContain('Kenji Watanabe — First mate, 52');
        expect(sheet).toContain('Mateus Silva — Crew, 40');
        for (const birth of [
            '1979-10-15',
            '1985-10-17',
            '15/10/1979',
            '10/15/1979',
            'Oct 1979',
            'October 1979',
            '1979',
        ]) {
            expect(sheet, birth).not.toContain(birth);
        }
    });
});

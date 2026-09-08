/**
 * FloatPlanSheet — roster prefill from the crew list (Shane 2026-09-08: "scrape
 * the names of crew from the invites, with the option of adding crew and
 * deleting crew").
 *
 * loadFloatPlanCrew is mocked; the sheet's own behaviour is under test: seeded
 * rows with names and roles, the people-aboard count following the seeds
 * unless the stepper was touched, invite chips that add a row and vanish, a
 * saved plan's roster left alone, a null load leaving the roster empty and
 * editable, and "Refresh from crew" replacing crew rows while keeping typed
 * ones.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { FloatPlanSheet, type FloatPlanPreset } from '../components/vessel/FloatPlanSheet';
import { loadFloatPlanCrew, type FloatPlanRosterSeed } from '../services/floatPlanCrew';

const mocks = vi.hoisted(() => ({
    vessel: {
        name: 'Serene Summer',
        type: 'sail' as const,
        model: 'Tayana 55',
        hullType: 'monohull' as const,
        length: 55,
        hullColor: 'white',
        registration: 'MQ258Q',
        mmsi: '501240101',
        callSign: 'VK4AFY',
        epirbHexId: '1D0E7A2B3C4D5E6',
        liferaftCapacity: 6,
        flaresExpiry: '2027-06-30',
        contactPhone: '+61 400 000 000',
        crewCount: undefined as number | undefined,
        crewRoster: undefined as Array<{ name: string; age?: number; rank?: string }> | undefined,
    },
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: typeof mocks.vessel } }) => unknown) =>
        selector({ settings: { vessel: mocks.vessel } }),
}));

vi.mock('../services/routeTracer', () => ({ loadSavedTraces: () => [] }));

vi.mock('../services/floatPlanCrew', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/floatPlanCrew')>()),
    loadFloatPlanCrew: vi.fn(),
}));

const DEPARTURE = Date.now() + 6 * 3_600_000;
const PRESET: FloatPlanPreset = {
    route: {
        name: 'Capricorn passage',
        from: 'Newport',
        to: 'Lady Musgrave',
        distanceNM: 178,
        waypoints: [
            { lat: -27.14, lon: 153.09 },
            { lat: -23.9, lon: 152.4 },
        ],
    },
    departureMs: DEPARTURE,
    etaMs: DEPARTURE + 30 * 3_600_000,
    personsOnBoard: 5,
};

const SKIPPER: FloatPlanRosterSeed = {
    name: 'Capt. Shane Stratton',
    role: 'Skipper',
    source: 'skipper',
    crewUserId: 'owner-1',
};
const MARTA: FloatPlanRosterSeed = {
    name: 'Marta "M" Kowalski',
    role: 'First mate',
    source: 'crew',
    crewUserId: 'u-m',
};
const LEE: FloatPlanRosterSeed = { name: 'Lee Chen', role: 'Navigator', source: 'crew', crewUserId: 'u-lee' };
const TOM: FloatPlanRosterSeed = { name: 'Tom', role: 'Guest', source: 'invite', crewUserId: 'u-tom' };

const load = vi.mocked(loadFloatPlanCrew);

function nameInputs(): HTMLInputElement[] {
    return screen.queryAllByLabelText(/^Person \d+ name$/) as HTMLInputElement[];
}

/** The People-aboard stepper's readout — the sheet's only <output>. */
function peopleAboard(): string {
    return document.querySelector('output')?.textContent ?? '';
}

async function renderSeeded(result = { aboard: [SKIPPER, MARTA, LEE], invited: [TOM] }) {
    load.mockResolvedValue(result);
    render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
    await waitFor(() => expect(nameInputs()).toHaveLength(result.aboard.length));
}

describe('FloatPlanSheet crew prefill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope('owner-1');
        mocks.vessel.crewCount = undefined;
        mocks.vessel.crewRoster = undefined;
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('seeds the roster with names and roles and sets people aboard to the crew count', async () => {
        await renderSeeded();

        expect(load).toHaveBeenCalledWith(null);
        const names = nameInputs().map((input) => input.value);
        expect(names).toEqual(['Capt. Shane Stratton', 'Marta "M" Kowalski', 'Lee Chen']);
        expect((screen.getByLabelText('Person 1 role') as HTMLSelectElement).value).toBe('Skipper');
        expect((screen.getByLabelText('Person 2 role') as HTMLSelectElement).value).toBe('First mate');
        expect((screen.getByLabelText('Person 3 role') as HTMLSelectElement).value).toBe('Navigator');
        // The preset said 5; three named people came off the crew list.
        expect(peopleAboard()).toBe('3');
        expect(screen.getByText('From your crew list — edit, add or remove as you like.')).toBeInTheDocument();
        // No warning about roster versus count, because they agree.
        expect(screen.queryByText(/The roster lists/)).not.toBeInTheDocument();
    });

    it('passes the voyage id through when opened from Cast Off', async () => {
        load.mockResolvedValue(null);
        render(
            <FloatPlanSheet
                voyage={
                    {
                        id: 'v-1',
                        voyage_name: 'Out to Musgrave',
                        departure_time: new Date(DEPARTURE).toISOString(),
                    } as never
                }
                onClose={vi.fn()}
            />,
        );
        await waitFor(() => expect(load).toHaveBeenCalledWith('v-1'));
    });

    it('still deletes a seeded row and still adds a blank person', async () => {
        await renderSeeded();

        fireEvent.click(screen.getByRole('button', { name: 'Remove person 2' }));
        expect(nameInputs().map((input) => input.value)).toEqual(['Capt. Shane Stratton', 'Lee Chen']);

        fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
        const after = nameInputs();
        expect(after).toHaveLength(3);
        expect(after[2].value).toBe('');
        fireEvent.change(after[2], { target: { value: 'Aunt Beryl' } });
        expect(nameInputs()[2].value).toBe('Aunt Beryl');
    });

    it('the people-aboard count follows a crew-seeded roster until the skipper touches the stepper', async () => {
        await renderSeeded();
        expect(peopleAboard()).toBe('3');

        fireEvent.click(screen.getByRole('button', { name: 'Remove person 2' }));
        expect(peopleAboard()).toBe('2');
        fireEvent.click(screen.getByTestId('float-plan-invite-chip'));
        expect(peopleAboard()).toBe('3');
        fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
        expect(peopleAboard()).toBe('4');

        // Once the stepper is touched it is the skipper's word: the roster stops driving it.
        fireEvent.click(screen.getByRole('button', { name: 'Add one person aboard' }));
        expect(peopleAboard()).toBe('5');
        fireEvent.click(screen.getByRole('button', { name: 'Remove person 4' }));
        expect(peopleAboard()).toBe('5');
    });

    it('the vessel profile’s own people come first — names, ranks and ages, with the count to match', async () => {
        // Shane 2026-09-09: the rows under "Crew Aboard" "auto xfer across to the float plan".
        mocks.vessel.crewCount = 2;
        mocks.vessel.crewRoster = [
            { name: 'Shane Stratton', age: 58, rank: 'Skipper' },
            { name: 'Aunt Beryl', age: 71, rank: 'Guest' },
            { name: 'Left behind', rank: 'Crew' }, // beyond the crew count — not aboard
        ];
        load.mockResolvedValue({ aboard: [SKIPPER, MARTA, LEE], invited: [TOM] });
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('float-plan-invite-chip')).toBeInTheDocument());
        expect(nameInputs().map((input) => input.value)).toEqual(['Shane Stratton', 'Aunt Beryl']);
        expect((screen.getByLabelText('Person 1 role') as HTMLSelectElement).value).toBe('Skipper');
        expect((screen.getByLabelText('Person 2 role') as HTMLSelectElement).value).toBe('Guest');
        expect((screen.getByLabelText('Person 2 age') as HTMLInputElement).value).toBe('71');
        expect(peopleAboard()).toBe('2');
        expect(screen.getByText('From your vessel profile — edit, add or remove as you like.')).toBeInTheDocument();
        // The crew list is not layered on top of the skipper's own list; only its invitees are offered.
        expect(nameInputs().map((input) => input.value)).not.toContain('Lee Chen');
        expect(screen.queryByTestId('float-plan-roster-refresh')).toBeNull();
    });

    it('offers a pending invitee as a chip that adds a row and disappears', async () => {
        await renderSeeded();

        const chip = screen.getByTestId('float-plan-invite-chip');
        expect(chip).toHaveTextContent('Add Tom');
        expect(chip).toHaveTextContent('invited, not yet accepted');
        // Not aboard until the skipper says so.
        expect(nameInputs().map((input) => input.value)).not.toContain('Tom');

        fireEvent.click(chip);

        expect(screen.queryByTestId('float-plan-invite-chip')).not.toBeInTheDocument();
        expect(nameInputs().map((input) => input.value)).toEqual([
            'Capt. Shane Stratton',
            'Marta "M" Kowalski',
            'Lee Chen',
            'Tom',
        ]);
        expect((screen.getByLabelText('Person 4 role') as HTMLSelectElement).value).toBe('Guest');
    });

    it('leaves a saved plan roster alone and does not ask the crew list', async () => {
        load.mockResolvedValue({ aboard: [SKIPPER, MARTA], invited: [] });
        render(
            <FloatPlanSheet
                preset={{
                    ...PRESET,
                    personsRoster: [
                        { name: 'Shane Stratton', role: 'Skipper', age: 52 },
                        { name: 'Bec', role: 'Crew', medical: 'seasick' },
                    ],
                }}
                onClose={vi.fn()}
            />,
        );

        // Let any pending effect settle before asserting nothing changed.
        await act(async () => {
            await Promise.resolve();
        });
        expect(load).not.toHaveBeenCalled();
        expect(nameInputs().map((input) => input.value)).toEqual(['Shane Stratton', 'Bec']);
        expect((screen.getByLabelText('Person 1 age') as HTMLInputElement).value).toBe('52');
        expect((screen.getByLabelText('Person 2 medical notes') as HTMLInputElement).value).toBe('seasick');
        expect(peopleAboard()).toBe('5');
        expect(screen.queryByText(/From your crew list/)).not.toBeInTheDocument();
    });

    it('stays empty and editable when the load returns null', async () => {
        load.mockResolvedValue(null);
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);

        await waitFor(() => expect(load).toHaveBeenCalledOnce());
        await act(async () => {
            await Promise.resolve();
        });
        expect(nameInputs()).toHaveLength(0);
        expect(peopleAboard()).toBe('5');
        expect(screen.queryByText(/From your crew list/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('float-plan-invite-chip')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
        fireEvent.change(nameInputs()[0], { target: { value: 'Solo' } });
        expect(nameInputs()[0].value).toBe('Solo');
    });

    it('does not override a stepper the skipper touched before the load landed', async () => {
        let resolve: (value: { aboard: FloatPlanRosterSeed[]; invited: FloatPlanRosterSeed[] }) => void = () => {};
        load.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Add one person aboard' }));
        expect(peopleAboard()).toBe('6');

        await act(async () => {
            resolve({ aboard: [SKIPPER, MARTA], invited: [] });
            await Promise.resolve();
        });

        await waitFor(() => expect(nameInputs()).toHaveLength(2));
        expect(peopleAboard()).toBe('6');
    });

    it('drops the prefill when the skipper started typing before the load landed', async () => {
        let resolve: (value: { aboard: FloatPlanRosterSeed[]; invited: FloatPlanRosterSeed[] }) => void = () => {};
        load.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
        fireEvent.change(nameInputs()[0], { target: { value: 'Typed first' } });

        await act(async () => {
            resolve({ aboard: [SKIPPER, MARTA], invited: [] });
            await Promise.resolve();
        });

        expect(nameInputs().map((input) => input.value)).toEqual(['Typed first']);
        expect(screen.queryByText(/From your crew list/)).not.toBeInTheDocument();
    });

    it('refresh replaces crew rows, keeps typed and invite-added rows, and folds an accepted invitee in once', async () => {
        await renderSeeded();

        fireEvent.click(screen.getByTestId('float-plan-invite-chip')); // Tom, not yet accepted
        fireEvent.click(screen.getByRole('button', { name: '+ Add person' }));
        fireEvent.change(nameInputs()[4], { target: { value: 'Aunt Beryl' } });
        expect(nameInputs()).toHaveLength(5);

        // Since the sheet opened: Marta left the crew, Lee is still aboard, Tom
        // accepted, and a new invite went to Priya.
        const PRIYA: FloatPlanRosterSeed = { name: 'Priya', role: 'Deckhand', source: 'invite', crewUserId: 'u-p' };
        load.mockResolvedValue({
            aboard: [SKIPPER, LEE, { ...TOM, source: 'crew' }],
            invited: [PRIYA],
        });
        fireEvent.click(screen.getByTestId('float-plan-roster-refresh'));

        await waitFor(() =>
            expect(nameInputs().map((input) => input.value)).toEqual([
                'Capt. Shane Stratton',
                'Lee Chen',
                'Tom',
                'Aunt Beryl',
            ]),
        );
        expect(load).toHaveBeenCalledTimes(2);
        const chips = screen.getAllByTestId('float-plan-invite-chip');
        expect(chips).toHaveLength(1);
        expect(within(chips[0]).getByText('Add Priya')).toBeInTheDocument();
    });

    it('refresh keeps the age and medical notes typed against a crew row', async () => {
        await renderSeeded();

        fireEvent.change(screen.getByLabelText('Person 1 age'), { target: { value: '62' } });
        fireEvent.change(screen.getByLabelText('Person 2 medical notes'), { target: { value: 'on warfarin' } });

        // Marta's byline changed on the crew list since the sheet opened.
        load.mockResolvedValue({ aboard: [SKIPPER, { ...MARTA, name: 'Marta Kowalski' }, LEE], invited: [] });
        fireEvent.click(screen.getByTestId('float-plan-roster-refresh'));

        await waitFor(() => expect((nameInputs()[1] as HTMLInputElement).value).toBe('Marta Kowalski'));
        expect((screen.getByLabelText('Person 1 age') as HTMLInputElement).value).toBe('62');
        expect((screen.getByLabelText('Person 2 medical notes') as HTMLInputElement).value).toBe('on warfarin');
        expect((screen.getByLabelText('Person 3 medical notes') as HTMLInputElement).value).toBe('');
    });

    it('hides the refresh button for a signed-out punter', async () => {
        setAuthIdentityScope(null);
        load.mockResolvedValue(null);
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        await waitFor(() => expect(load).toHaveBeenCalledOnce());
        expect(screen.queryByTestId('float-plan-roster-refresh')).not.toBeInTheDocument();
    });
});

/**
 * The crew's read-only float plan card (crewing view, 2026-10-03). The float
 * plan stays the skipper's: one boat, one holder, one overdue time. Crew see
 * what a Mayday needs and who is aboard, never the SAR block that goes "only
 * in the float plan, to one chosen person". Fictional boats and people only.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CrewFloatPlanCard } from '../components/crewManagement/CrewFloatPlanCard';
import type { CrewVesselView } from '../services/crew/crewVesselView';

const VIEW: CrewVesselView = {
    ownerId: 'skipper-1',
    vessel: {
        name: 'Wandering Albatross',
        type: 'sail',
        model: 'Fictional 44',
        hullColor: 'Navy',
        registration: 'TEST-123',
        mmsi: '503000999',
        callSign: 'VZZ1234',
        hailingPort: 'Example Harbour',
        liferaftCapacity: 6,
        liferaftServiceDate: '2026-05-01',
        flaresExpiry: '2027-02-01',
    },
    vesselUnits: null,
    roster: [],
    manifest: [
        { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
        { isSkipper: false, isSelf: true, role: 'deckhand', name: 'Tom Okafor' },
    ],
    fetchedAt: '2026-10-02T21:30:00.000Z',
    source: 'rpc',
};

describe('CrewFloatPlanCard', () => {
    it('shows the identification a Mayday needs, the safety basics, and who holds the plan', () => {
        render(<CrewFloatPlanCard boatName="Wandering Albatross" view={VIEW} passage={null} />);
        const card = screen.getByTestId('crew-float-plan-card');
        expect(within(card).getByRole('heading', { name: 'Float plan — Wandering Albatross' })).toBeInTheDocument();
        for (const value of ['Sail · Fictional 44', 'Navy', 'TEST-123', '503000999', 'VZZ1234', 'Example Harbour']) {
            expect(within(card).getByText(value)).toBeInTheDocument();
        }
        expect(within(card).getByText(/6 people · serviced 2026-05-01/)).toBeInTheDocument();
        expect(within(card).getByText('2027-02-01')).toBeInTheDocument();
        expect(
            within(card).getByText(
                "Capt Ana Reyes sends Wandering Albatross's float plan at Cast Off — ask them who holds it.",
            ),
        ).toBeInTheDocument();
    });

    it('has nothing to send, copy or print', () => {
        render(<CrewFloatPlanCard boatName="Wandering Albatross" view={VIEW} passage={null} />);
        const card = screen.getByTestId('crew-float-plan-card');
        expect(within(card).queryAllByRole('button')).toEqual([]);
        expect(card.textContent).not.toMatch(/Send|Copy|PDF|Share/);
    });

    it("lists the skipper's profile roster and the app crew not on it — you included — in rank order", () => {
        const { rerender } = render(<CrewFloatPlanCard boatName="Wandering Albatross" view={VIEW} passage={null} />);
        let people = within(screen.getByRole('list', { name: 'People aboard' })).getAllByRole('listitem');
        expect(people.map((item) => item.textContent)).toEqual(['Capt Ana ReyesSkipper', 'Tom Okafor (you)Deckhand']);

        rerender(
            <CrewFloatPlanCard
                boatName="Wandering Albatross"
                view={{
                    ...VIEW,
                    roster: [
                        { name: 'Ana Reyes', rank: 'Skipper' },
                        { name: 'Sam Example', rank: 'Guest' },
                    ],
                }}
                passage={null}
            />,
        );
        people = within(screen.getByRole('list', { name: 'People aboard' })).getAllByRole('listitem');
        // Shane 2026-10-04: the POB "needs to include the invitee as well as the others on board".
        // Shane 2026-10-07: by rank, so the Guest is after the Deckhand.
        expect(people.map((item) => item.textContent)).toEqual([
            'Ana ReyesSkipper',
            'Tom Okafor (you)Deckhand',
            'Sam ExampleGuest',
        ]);
        expect(screen.getByText('People aboard: 3')).toBeInTheDocument();
    });

    it('shows the selected shared passage', () => {
        render(
            <CrewFloatPlanCard
                boatName="Wandering Albatross"
                view={VIEW}
                passage={{
                    departure_port: 'Example Harbour',
                    destination_port: 'Far Island',
                    departure_time: '2026-10-10T00:00:00.000Z',
                    eta: '2026-10-11T06:00:00.000Z',
                }}
            />,
        );
        const card = screen.getByTestId('crew-float-plan-card');
        expect(within(card).getByText('Example Harbour → Far Island')).toBeInTheDocument();
        expect(within(card).getByText('Departs')).toBeInTheDocument();
        expect(within(card).getByText('ETA')).toBeInTheDocument();
    });

    it('never renders a private field even if one reached it', () => {
        const leaky = {
            ...VIEW,
            vessel: { ...VIEW.vessel, epirbHexId: 'ABCDEF0123456', shoreContact1: 'Jo 0400 000 000' },
        } as unknown as CrewVesselView;
        render(<CrewFloatPlanCard boatName="Wandering Albatross" view={leaky} passage={null} />);
        const text = screen.getByTestId('crew-float-plan-card').textContent ?? '';
        expect(text).not.toContain('ABCDEF0123456');
        expect(text).not.toContain('0400 000 000');
    });

    it('without a view yet, still names the boat and who holds the plan', () => {
        render(<CrewFloatPlanCard boatName="Wandering Albatross" view={null} passage={null} />);
        expect(
            screen.getByText("The skipper sends Wandering Albatross's float plan at Cast Off — ask them who holds it."),
        ).toBeInTheDocument();
    });

    describe('your own details (Shane 2026-10-04)', () => {
        const SELF = { name: 'Thomas Okafor', phone: '0491 570 156', age: 34 };
        const WITH_ROSTER: CrewVesselView = {
            ...VIEW,
            vessel: { ...VIEW.vessel, crewCount: 2 },
            roster: [
                { name: 'Ana Reyes', rank: 'Skipper' },
                { name: 'Sam Example', rank: 'Guest' },
            ],
            manifest: [...VIEW.manifest, { isSkipper: false, isSelf: false, role: 'navigator', name: 'Lena Park' }],
        };

        it('shows your own name, phone and age; everyone else is a name and a role; the count is everyone', () => {
            render(<CrewFloatPlanCard boatName="Wandering Albatross" view={WITH_ROSTER} passage={null} self={SELF} />);
            const list = screen.getByRole('list', { name: 'People aboard' });
            expect(
                within(list)
                    .getAllByRole('listitem')
                    .map((item) => item.textContent),
            ).toEqual([
                'Ana ReyesSkipper',
                'Lena ParkNavigator',
                'Thomas Okafor (you)0491 570 156 · age 34Deckhand',
                'Sam ExampleGuest',
            ]);
            // Four people, though the skipper's profile still says two.
            expect(screen.getByText('People aboard: 4')).toBeInTheDocument();
        });

        it('says where your details go and who sees them', () => {
            render(<CrewFloatPlanCard boatName="Wandering Albatross" view={WITH_ROSTER} passage={null} self={SELF} />);
            // Not "only your skipper": the plan goes to whoever they send it to, and
            // the one shared row is read by every skipper you crew for.
            expect(
                screen.getByText(
                    "Your name, mobile and age from Settings → Vessel Profile go on Wandering Albatross's float plan. In the app only the skippers you crew for see them; the float plan itself goes to whoever they send it to.",
                ),
            ).toBeInTheDocument();
        });

        it('asks for what is missing from Settings', () => {
            render(
                <CrewFloatPlanCard
                    boatName="Wandering Albatross"
                    view={WITH_ROSTER}
                    passage={null}
                    self={{ name: null, phone: null, age: null }}
                />,
            );
            // Names the fields as Settings labels them: on your own profile you are the Skipper.
            expect(
                screen.getByText(
                    /Add your name, mobile and age there: on your own profile you're the Skipper, so your name and age go in the Skipper row under Crew, and your mobile in Skipper mobile\./,
                ),
            ).toBeInTheDocument();
            // No name of your own: the app's name for you stands.
            expect(screen.getByText('Tom Okafor (you)')).toBeInTheDocument();
        });

        it('asks only for what is missing', () => {
            render(
                <CrewFloatPlanCard
                    boatName="Wandering Albatross"
                    view={WITH_ROSTER}
                    passage={null}
                    self={{ ...SELF, age: null }}
                    sharing
                />,
            );
            expect(screen.getByText(/Add your age there:/)).toBeInTheDocument();
        });

        it('says nothing about sharing while the server cannot take them yet', () => {
            render(
                <CrewFloatPlanCard
                    boatName="Wandering Albatross"
                    view={WITH_ROSTER}
                    passage={null}
                    self={SELF}
                    sharing={false}
                />,
            );
            expect(screen.queryByText(/skippers you crew for see them/)).toBeNull();
            // Your own row still shows your own details: they are yours.
            expect(screen.getByText('0491 570 156 · age 34')).toBeInTheDocument();
        });
    });
});

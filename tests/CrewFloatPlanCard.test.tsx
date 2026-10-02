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

    it("lists the skipper's profile roster first, else the app crew (the sheet's precedence)", () => {
        const { rerender } = render(<CrewFloatPlanCard boatName="Wandering Albatross" view={VIEW} passage={null} />);
        let people = within(screen.getByRole('list', { name: 'People aboard' })).getAllByRole('listitem');
        expect(people.map((item) => item.textContent)).toEqual(['Capt Ana ReyesSkipper', 'Tom OkaforDeckhand']);

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
        expect(people.map((item) => item.textContent)).toEqual(['Ana ReyesSkipper', 'Sam ExampleGuest']);
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
});

/**
 * The invitee's device lists everyone aboard (Shane 2026-10-06: "on the
 * invitees device, only the captain which is me and the invitee show up. it
 * does not show the other person ... we need all 3 people on both devices").
 *
 * The shape measured in production, with fictional people (the repository is
 * public): the skipper's vessel profile names two (Skipper, First mate); the
 * one accepted invitee is a co-skipper and not on that list. The RPC returns
 * both lists; the "Crew aboard" panel must merge them as the float plan card
 * does, names and roles only.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CrewingVesselPanel } from '../components/crewManagement/CrewingVesselPanel';
import { CrewFloatPlanCard } from '../components/crewManagement/CrewFloatPlanCard';
import type { CrewVesselView } from '../services/crew/crewVesselView';
import type { CrewVessel } from '../services/vessel/sharedBinders';

const VIEW: CrewVesselView = {
    ownerId: 'skipper-1',
    vessel: { name: 'Wandering Albatross', type: 'sail' },
    vesselUnits: null,
    roster: [
        { name: 'Ana Reyes', rank: 'Skipper' },
        { name: 'Priya Nair', rank: 'First mate' },
    ],
    manifest: [
        { isSkipper: true, isSelf: false, role: 'skipper', name: 'Capt Ana Reyes' },
        { isSkipper: false, isSelf: true, role: 'co-skipper', name: 'Tom O' },
    ],
    fetchedAt: '2026-10-06T01:00:00.000Z',
    source: 'rpc',
};

const BOAT: CrewVessel = {
    ownerId: 'skipper-1',
    vesselName: 'Wandering Albatross',
    role: 'co-skipper',
    lastAcceptedAt: '2026-10-05T00:00:00.000Z',
};

/** The invitee's own Settings: on their own profile they are the Skipper. */
const SELF = { name: 'Tom Okafor', phone: '0491 570 110', age: 41 };

function panel(view: CrewVesselView | null, self: typeof SELF | null = SELF) {
    return render(
        <CrewingVesselPanel
            vessel={BOAT}
            vessels={[BOAT]}
            rows={[]}
            view={view}
            self={self}
            stale={false}
            loading={false}
            onSwitch={vi.fn()}
        />,
    );
}

function aboardRows(): string[] {
    const list = screen.getByRole('list', { name: 'Crew aboard Wandering Albatross' });
    return within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent ?? '');
}

describe('Crew aboard, on the invitee’s device', () => {
    it("lists the skipper's own people as well as the app crew: captain, first mate and you", () => {
        panel(VIEW);
        expect(aboardRows()).toEqual(['Ana ReyesSkipper', 'Priya NairFirst mate', 'Tom Okafor (you)Co-skipper']);
    });

    it('names and roles only: never your phone or age, nor anyone else’s', () => {
        panel(VIEW);
        const list = screen.getByRole('list', { name: 'Crew aboard Wandering Albatross' });
        expect(list.textContent).not.toContain('0491');
        expect(list.textContent).not.toMatch(/\b41\b/);
    });

    it('agrees with the float plan card: the same three, People aboard: 3', () => {
        panel(VIEW);
        render(<CrewFloatPlanCard boatName="Wandering Albatross" view={VIEW} passage={null} self={SELF} />);
        const card = within(screen.getByRole('list', { name: 'People aboard' }))
            .getAllByRole('listitem')
            .map((item) => [
                item.querySelector('span')?.firstChild?.textContent ?? '',
                item.lastElementChild?.textContent ?? '',
            ]);
        expect(card).toEqual([
            ['Ana Reyes', 'Skipper'],
            ['Priya Nair', 'First mate'],
            ['Tom Okafor', 'Co-skipper'],
        ]);
        expect(aboardRows()).toEqual(
            card.map(([name, role]) => `${name}${name === 'Tom Okafor' ? ' (you)' : ''}${role}`),
        );
        expect(screen.getByText('People aboard: 3')).toBeInTheDocument();
    });

    it('is one person when the skipper also typed the invitee into his own list', () => {
        panel({ ...VIEW, roster: [...VIEW.roster, { name: 'Tom', rank: 'Crew' }] });
        // The rank the skipper chose stands, as on his float plan.
        expect(aboardRows()).toEqual(['Ana ReyesSkipper', 'Priya NairFirst mate', 'Tom Okafor (you)Crew']);
    });

    it('without your Settings details, you are named as the app names you', () => {
        panel(VIEW, null);
        expect(aboardRows()).toEqual(['Ana ReyesSkipper', 'Priya NairFirst mate', 'Tom O (you)Co-skipper']);
    });

    it('degraded mode (no roster) still lists the app crew, the skipper first', () => {
        panel(
            {
                ...VIEW,
                roster: [],
                source: 'fallback',
                manifest: [
                    { isSkipper: true, isSelf: false, role: 'skipper', name: '' },
                    { isSkipper: false, isSelf: false, role: 'crew', name: 'Lena "Lee" Park' },
                    { isSkipper: false, isSelf: true, role: 'co-skipper', name: '' },
                ],
            },
            null,
        );
        expect(aboardRows()).toEqual(['SkipperSkipper', 'Lena "Lee" ParkCrew', 'YouCo-skipper']);
    });

    it('says the list is not available while there is no view', () => {
        panel(null);
        expect(screen.getByRole('status')).toHaveTextContent(
            "The crew list for Wandering Albatross isn't available yet.",
        );
    });
});

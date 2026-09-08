import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOAT_PLAN_ROLES, rosterSeedsFromVesselProfile } from '../services/floatPlanCrew';

/**
 * Shane 2026-09-09: "in the vessel profile section, where we have the crew
 * aboard question. can we have the same amount of area to add a punters name
 * and age and rank. so if there are two persons aboard, there should be two
 * places to add names, directly underneath. then those names should auto xfer
 * across to the float plan."
 */
describe('rosterSeedsFromVesselProfile', () => {
    it('turns the profile rows into Float Plan seeds, named ones only, capped at the crew count', () => {
        const seeds = rosterSeedsFromVesselProfile({
            crewCount: 2,
            crewRoster: [
                { name: ' Shane Stratton ', age: 58, rank: 'Skipper' },
                { name: '', rank: 'Crew' },
                { name: 'Not aboard', rank: 'Guest' },
            ],
        });
        expect(seeds).toEqual([{ name: 'Shane Stratton', role: 'Skipper', source: 'profile', age: 58 }]);
    });

    it('defaults the first rank to Skipper and the rest to Crew, and drops a nonsense age', () => {
        const seeds = rosterSeedsFromVesselProfile({
            crewCount: 3,
            crewRoster: [{ name: 'A' }, { name: 'B', age: -4 }, { name: 'C', age: 12.4, rank: 'Child' }],
        });
        expect(seeds.map((s) => s.role)).toEqual(['Skipper', 'Crew', 'Child']);
        expect(seeds.map((s) => s.age)).toEqual([null, null, 12]);
    });

    it('nothing without a profile or without names', () => {
        expect(rosterSeedsFromVesselProfile(null)).toEqual([]);
        expect(rosterSeedsFromVesselProfile({ crewCount: 2 })).toEqual([]);
        expect(rosterSeedsFromVesselProfile({ crewCount: 2, crewRoster: [{ name: '  ' }] })).toEqual([]);
    });

    it('the roles are the one list the Float Plan uses', () => {
        expect(FLOAT_PLAN_ROLES).toEqual([
            'Skipper',
            'First mate',
            'Navigator',
            'Engineer',
            'Cook',
            'Deckhand',
            'Crew',
            'Guest',
            'Child',
        ]);
    });
});

describe('Vessel tab — one row per person under Crew Aboard', () => {
    const tab = readFileSync('components/settings/VesselTab.tsx', 'utf8');
    it('renders crewCount rows of name / age / rank and saves them on the profile', () => {
        expect(tab).toContain('Array.from({ length: vesselCrewAboard(vessel) }');
        expect(tab).toContain('data-testid="vessel-crew-roster"');
        expect(tab).toContain('aria-label={`Person ${index + 1} name`}');
        expect(tab).toContain('aria-label={`Person ${index + 1} age`}');
        expect(tab).toContain('aria-label={`Person ${index + 1} rank`}');
        expect(tab).toContain('FLOAT_PLAN_ROLES.map((role) =>');
        expect(tab).toContain('const patch = { crewRoster: next } as Partial<VesselProfile>;');
        expect(tab).toContain('These names carry across to the Float Plan.');
    });
});

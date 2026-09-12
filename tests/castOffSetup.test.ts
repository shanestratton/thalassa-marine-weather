import { describe, expect, it } from 'vitest';
import { castOffRouteChoices, createCastOffSetup, isUnsavedCastOffSetup } from '../services/castOffSetup';
import type { Voyage } from '../services/VoyageService';
import type { SavedTrace } from '../services/routeTracer';

function row(id: string, overrides: Partial<Voyage> = {}): Voyage {
    return {
        id,
        user_id: 'owner-a',
        vessel_id: null,
        voyage_name: id,
        departure_port: 'Newport',
        destination_port: 'Lady Musgrave',
        departure_time: null,
        eta: null,
        crew_count: 2,
        status: 'planning',
        weather_master_id: null,
        notes: null,
        created_at: '2026-09-10T00:00:00.000Z',
        updated_at: '2026-09-10T00:00:00.000Z',
        ...overrides,
    };
}

function trace(id: string, overrides: Partial<SavedTrace> = {}): SavedTrace {
    return {
        id,
        name: 'Newport - Lady Musgrave',
        createdAt: '2026-09-10T00:00:00.000Z',
        points: [
            { lat: -27.2, lon: 153.1 },
            { lat: -23.9, lon: 152.4 },
        ],
        ...overrides,
    } as SavedTrace;
}

describe('memory-only Cast Off preparation', () => {
    it('builds independent temporary setups without writing storage', () => {
        const storageBefore = { ...localStorage };
        const details = { voyage_name: 'A fresh passage', departure_port: null, destination_port: null, crew_count: 3 };
        const first = createCastOffSetup(details, 'owner-a');
        const second = createCastOffSetup(details, 'owner-a');
        expect(first).toMatchObject({ ...details, user_id: 'owner-a', status: 'planning' });
        expect(isUnsavedCastOffSetup(first)).toBe(true);
        expect(first.id).not.toBe(second.id);
        expect(isUnsavedCastOffSetup(row('real-voyage-id'))).toBe(false);
        expect({ ...localStorage }).toEqual(storageBefore);
    });

    it('hides unlinked legacy setups without changing or deleting any records', () => {
        const records = [
            row('abandoned-one'),
            row('abandoned-two'),
            row('active', { status: 'active', saved_route_id: 'route-a', manifest_locked_at: '2026-09-10T01:00:00Z' }),
            row('completed', { status: 'completed', saved_route_id: 'route-b' }),
            row('aborted', { status: 'aborted', saved_route_id: 'route-c' }),
            row('saved-plan', { saved_route_id: 'route-d' }),
        ];
        const before = structuredClone(records);
        const choices = castOffRouteChoices(records, [], {});
        expect(choices.map((choice) => choice.id)).toEqual(['saved-plan']);
        expect(records).toEqual(before);
    });

    it('keeps canonical saved routes after their previous voyage completed', () => {
        const saved = trace('saved-route', { passageVoyageId: 'completed-voyage' });
        const choices = castOffRouteChoices(
            [row('completed-voyage', { status: 'completed', saved_route_id: saved.id })],
            [saved],
            { crewCount: 4 },
        );
        expect(choices).toHaveLength(1);
        expect(choices[0]).toMatchObject({ saved_route_id: 'saved-route', crew_count: 4 });
        expect(isUnsavedCastOffSetup(choices[0])).toBe(true);
    });

    it('recognises a legacy planning row through its exact saved-trace backlink', () => {
        const unlinked = row('old-planning-row');
        const choices = castOffRouteChoices([unlinked], [trace('canonical', { passageVoyageId: unlinked.id })], {});
        expect(choices).toEqual([{ ...unlinked, saved_route_id: 'canonical' }]);
        expect(unlinked.saved_route_id).toBeUndefined();
    });

    it('offers one row per exact route, keeping the most recent planning row and distinct passages', () => {
        const choices = castOffRouteChoices(
            [
                row('old', { saved_route_id: 'leg-one' }),
                row('new', { saved_route_id: 'leg-one', updated_at: '2026-09-10T01:00:00.000Z' }),
                row('whole-trip', { saved_route_id: 'leg-one', voyage_name: 'Whitsundays (Passage)' }),
                row('distinct-geometry', { saved_route_id: 'another-route', voyage_name: 'new' }),
            ],
            [trace('leg-one')],
            {},
        );
        expect(choices.map((choice) => choice.id)).toEqual(['new', 'whole-trip', 'distinct-geometry']);
    });
});

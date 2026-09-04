/**
 * A multi-leg trip is not one row.
 *
 * Shane 2026-09-04: "i have a trip from newport -> coral sea, coral sea ->
 * mackay, and mackay -> whitsundays, however the trip says newport -> coral
 * sea??? it should be newport -> whitsundays."
 *
 * The voyage record holds LEG ONE's ports. The rest of the trip lives in
 * sailed legs and in chained draft voyages — which the leg picker already knew
 * how to reassemble and every label in the app did not.
 */
import { describe, expect, it } from 'vitest';
import { chainDraftsOntoActive, tripEndpoints, tripRouteLabel } from '../services/tripEndpoints';

const voyage = (over: Record<string, unknown> = {}) =>
    ({
        id: 'v1',
        departure_port: 'Newport',
        destination_port: 'Coral Sea',
        created_at: '2026-09-01T00:00:00Z',
        ...over,
    }) as never;

const leg = (n: number, from: string, to: string | null, planned: string | null = null) =>
    ({
        id: `l${n}`,
        voyage_id: 'v1',
        leg_number: n,
        departure_port: from,
        arrival_port: to,
        planned_destination: planned,
    }) as never;

describe('the whole trip, not the first hop', () => {
    it("Shane's trip reads Newport → Whitsundays", () => {
        const legs = [leg(1, 'Newport', 'Coral Sea'), leg(2, 'Coral Sea', 'Mackay'), leg(3, 'Mackay', 'Whitsundays')];
        expect(tripRouteLabel(voyage(), legs)).toBe('Newport → Whitsundays');
    });

    it('falls back to the voyage when there are no legs at all', () => {
        expect(tripRouteLabel(voyage())).toBe('Newport → Coral Sea');
    });

    it('a leg still at sea shows where it is BOUND, not a blank', () => {
        // arrival_port is null until the boat actually gets there.
        const legs = [leg(1, 'Newport', 'Coral Sea'), leg(2, 'Coral Sea', null, 'Mackay')];
        expect(tripRouteLabel(voyage(), legs)).toBe('Newport → Mackay');
    });

    it('chained DRAFT voyages extend the trip too', () => {
        const drafts = [
            voyage({ id: 'd1', departure_port: 'Coral Sea', destination_port: 'Mackay' }),
            voyage({ id: 'd2', departure_port: 'Mackay', destination_port: 'Whitsundays' }),
        ];
        const { consumed } = chainDraftsOntoActive(voyage(), drafts);
        expect(consumed).toHaveLength(2);
        expect(tripRouteLabel(voyage(), [], consumed)).toBe('Newport → Whitsundays');
    });

    it('an unrelated draft does not get swallowed into the trip', () => {
        const drafts = [voyage({ id: 'd9', departure_port: 'Cairns', destination_port: 'Thursday Island' })];
        const { consumed, remaining } = chainDraftsOntoActive(voyage(), drafts);
        expect(consumed).toHaveLength(0);
        expect(remaining).toHaveLength(1);
        expect(tripRouteLabel(voyage(), [], consumed)).toBe('Newport → Coral Sea');
    });

    it('says nothing rather than half a route', () => {
        expect(tripRouteLabel(null)).toBeNull();
        expect(tripEndpoints(voyage({ destination_port: null }))).toEqual({
            origin: 'Newport',
            destination: null,
        });
        expect(tripRouteLabel(voyage({ destination_port: null }))).toBeNull();
    });
});

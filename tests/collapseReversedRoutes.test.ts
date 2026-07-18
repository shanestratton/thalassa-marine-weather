import { describe, it, expect } from 'vitest';
import { collapseReversedRoutes, type ReversibleRoute } from '../services/shiplog/collapseReversedRoutes';

// Real coordinates from Shane's log so the tolerances are exercised at the
// scale they actually run at, not on toy 0,0 / 1,1 points.
const NEWPORT = { lat: -27.2, lon: 153.1 };
const MORETON = { lat: -27.4, lon: 153.4 };
const OFFSHORE = { lat: -23.9, lon: 153.9 };

const mk = (
    voyageId: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    totalDistanceNM: number,
): ReversibleRoute => ({
    voyageId,
    totalDistanceNM,
    firstLat: from.lat,
    firstLon: from.lon,
    lastLat: to.lat,
    lastLon: to.lon,
});

describe('collapseReversedRoutes', () => {
    it('folds a there-and-back pair into ONE choice, flagged reversible', () => {
        const out = collapseReversedRoutes(
            [mk('out', NEWPORT, OFFSHORE, 245.4), mk('back', OFFSHORE, NEWPORT, 245.4)],
            null,
        );
        expect(out).toHaveLength(1);
        expect(out[0].reversible).toBe(true);
    });

    it('keeps the direction that STARTS nearest the boat — the way it is about to sail', () => {
        const pair = [mk('out', NEWPORT, OFFSHORE, 245.4), mk('back', OFFSHORE, NEWPORT, 245.4)];

        // Sitting at Newport → offer the outbound leg.
        expect(collapseReversedRoutes(pair, NEWPORT)[0].summary.voyageId).toBe('out');
        // Sitting offshore → offer the return.
        expect(collapseReversedRoutes(pair, OFFSHORE)[0].summary.voyageId).toBe('back');
    });

    it('does NOT collapse two different passages that merely share endpoints', () => {
        // An inshore run and an offshore run, same harbours, different lengths.
        const out = collapseReversedRoutes(
            [mk('inshore', NEWPORT, MORETON, 18.3), mk('offshore', MORETON, NEWPORT, 31.0)],
            null,
        );
        expect(out).toHaveLength(2);
        expect(out.every((r) => !r.reversible)).toBe(true);
    });

    it('leaves an unpaired route alone and unflagged', () => {
        const out = collapseReversedRoutes([mk('solo', NEWPORT, MORETON, 18.3)], null);
        expect(out).toHaveLength(1);
        expect(out[0].reversible).toBe(false);
    });

    it('never drops a route that has no usable endpoints', () => {
        const noEnds: ReversibleRoute = {
            voyageId: 'noEnds',
            totalDistanceNM: 12,
            firstLat: null,
            firstLon: null,
            lastLat: null,
            lastLon: null,
        };
        const out = collapseReversedRoutes([noEnds, mk('solo', NEWPORT, MORETON, 18.3)], null);
        expect(out.map((r) => r.summary.voyageId)).toEqual(['noEnds', 'solo']);
    });

    it('collapses each pair independently and preserves input order', () => {
        const out = collapseReversedRoutes(
            [
                mk('a-out', NEWPORT, OFFSHORE, 245.4),
                mk('b-out', NEWPORT, MORETON, 18.3),
                mk('a-back', OFFSHORE, NEWPORT, 245.4),
                mk('b-back', MORETON, NEWPORT, 18.3),
            ],
            null,
        );
        expect(out.map((r) => r.summary.voyageId)).toEqual(['a-out', 'b-out']);
        expect(out.every((r) => r.reversible)).toBe(true);
    });

    it('treats a three-leg triangle as three separate routes, not a pair', () => {
        // Newport → Moreton → Offshore → Newport: no leg reverses another.
        const out = collapseReversedRoutes(
            [mk('l1', NEWPORT, MORETON, 18.3), mk('l2', MORETON, OFFSHORE, 220.0), mk('l3', OFFSHORE, NEWPORT, 245.4)],
            null,
        );
        expect(out).toHaveLength(3);
    });
});

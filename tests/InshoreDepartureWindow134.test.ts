import { describe, expect, it } from 'vitest';
import { inshoreDepartureContext } from '../services/routing/inshoreDepartureWindow';
import type { VesselProfile } from '../types';
import type { ThalassaRouteDisclosure } from '../types/autorouting';
import type { TideCurve } from '../services/TideHeightService';
const start = Date.parse('2026-10-20T00:00:00Z');
const coordinates: [number, number][] = [
    [0, 0],
    [0.1, 0],
];
const engine: ThalassaRouteDisclosure = {
    stateMask: ['danger'],
    backstop: 'verified',
    distanceNM: 6,
    elapsedMs: 1,
    cellsUsed: ['SYNTHETIC'],
    shallowRuns: [{ startSeg: 0, endSeg: 0, lengthM: 300, minDepthM: 1.4, midLat: 0, midLon: 0.05 }],
};
const vessel = { type: 'sail', length: 38, draft: 2 / 0.3048, cruisingSpeed: 6 } as VesselProfile;
const curve = (height: number): TideCurve => ({
    heights: [],
    datum: 'LAT',
    provenance: 'EXTREMES_INTERP',
    rangeMs: [start - 86400_000, start + 10 * 86400_000],
    heightAt: () => height,
});
describe('short-hop departure times reuse the existing 128 tide leave window', () => {
    it('uses each exact locked line and returns clear, blocked or unknown from real leave-window maths', async () => {
        for (const [height, expected] of [
            [2, 'clear'],
            [0, 'blocked'],
            [null, 'unknown'],
        ] as const) {
            const context = await inshoreDepartureContext(
                coordinates,
                engine,
                vessel,
                new Date(start).toISOString(),
                async () => (height === null ? null : curve(height)),
            );
            expect(await context.tideForRoute(context.route, start)).toBe(expected);
            expect(
                await context.tideForRoute(
                    {
                        ...context.route,
                        routeCoordinates: [
                            [0, 0],
                            [0.2, 0],
                        ],
                    },
                    start,
                ),
            ).toBe('unknown');
        }
    });
    it('will not derive a tide clearance from missing chart masks or an unverified land check', async () => {
        for (const proof of [
            { ...engine, stateMask: null },
            { ...engine, backstop: 'unavailable' as const },
        ])
            await expect(
                inshoreDepartureContext(coordinates, proof, vessel, new Date(start).toISOString(), async () =>
                    curve(2),
                ),
            ).rejects.toThrow('verified chart route');
    });
});

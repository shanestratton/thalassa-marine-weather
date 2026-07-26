import { describe, expect, it } from 'vitest';

import { inshoreRouteToGeoJSON, type InshoreRouteResult } from '../services/InshoreRouter';
import {
    readPersistedShallowRuns,
    shallowRunsToDepartureSpots,
    tideAnchorForShallowRuns,
} from '../services/routing/inshoreTideSpots';

describe('inshoreTideSpots', () => {
    it('preserves charted shallow runs when an inshore route is persisted', () => {
        const shallowRuns = [
            {
                startSeg: 2,
                endSeg: 4,
                lengthM: 630,
                minDepthM: 1.7,
                midLat: -27.4,
                midLon: 153.2,
                minAtLat: -27.401,
                minAtLon: 153.203,
            },
        ];
        const result: InshoreRouteResult = {
            polyline: [
                [153.2, -27.4],
                [153.21, -27.41],
            ],
            shallowRuns,
            distanceNM: 1.1,
            cellsUsed: ['AU123'],
            elapsedMs: 20,
        };

        const feature = inshoreRouteToGeoJSON(result, { lat: -27.4, lon: 153.2 }, { lat: -27.41, lon: 153.21 });

        expect(feature.properties?.shallowRuns).toEqual(shallowRuns);
    });

    it('validates persisted data and maps the exact shallow point to its ETA leg', () => {
        const runs = readPersistedShallowRuns([
            {
                startSeg: 0,
                endSeg: 1,
                lengthM: 210,
                minDepthM: 1.8,
                midLat: -27,
                midLon: 153.005,
                // The midpoint belongs to the first leg, but the known
                // shallowest sample lies on the third. The exact point wins.
                minAtLat: -27,
                minAtLon: 153.025,
            },
            {
                startSeg: 'bad',
                endSeg: 3,
                lengthM: 20,
                minDepthM: 1,
                midLat: -27,
                midLon: 153,
            },
            {
                startSeg: 1,
                endSeg: 2,
                lengthM: 100,
                minDepthM: null,
                midLat: -27,
                midLon: 153.015,
            },
        ]);
        const polyline: [number, number][] = [
            [153, -27],
            [153.01, -27],
            [153.02, -27],
            [153.03, -27],
        ];

        expect(runs).toHaveLength(2); // malformed entry rejected; null depth retained for honesty
        expect(shallowRunsToDepartureSpots(polyline, runs)).toEqual([{ legIndex: 2, minDepthM: 1.8 }]);
    });

    it('falls back to a clamped legacy segment midpoint and de-duplicates equivalent gate data', () => {
        const runs = readPersistedShallowRuns([
            {
                startSeg: 9,
                endSeg: 12,
                lengthM: 100,
                minDepthM: 2,
                midLat: -27,
                midLon: 153,
            },
            {
                startSeg: 10,
                endSeg: 12,
                lengthM: 100,
                minDepthM: 2,
                midLat: -27,
                midLon: 153,
            },
        ]);
        const polyline: [number, number][] = [
            [153, -27],
            [153.01, -27],
            [153.02, -27],
        ];

        expect(shallowRunsToDepartureSpots(polyline, runs)).toEqual([{ legIndex: 1, minDepthM: 2 }]);
    });

    it('uses the longest charted shallow run as the web tide reference, not an unrelated destination', () => {
        const runs = readPersistedShallowRuns([
            {
                startSeg: 0,
                endSeg: 1,
                lengthM: 120,
                minDepthM: 1.8,
                midLat: -27.1,
                midLon: 153.1,
            },
            {
                startSeg: 3,
                endSeg: 5,
                lengthM: 680,
                minDepthM: 2.1,
                midLat: -27.6,
                midLon: 153.6,
            },
            {
                startSeg: 7,
                endSeg: 8,
                lengthM: 900,
                minDepthM: null,
                midLat: -28,
                midLon: 154,
            },
        ]);

        expect(tideAnchorForShallowRuns(runs)).toEqual({ lat: -27.6, lon: 153.6 });
    });
});

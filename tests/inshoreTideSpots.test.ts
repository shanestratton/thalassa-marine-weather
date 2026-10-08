import { describe, expect, it } from 'vitest';

import { inshoreRouteToGeoJSON, type InshoreRouteResult } from '../services/InshoreRouter';
import {
    readPersistedShallowRuns,
    shallowRunsToDepartureSpots,
    tideAnchorForShallowRuns,
} from '../services/routing/inshoreTideSpots';
import { sweepDepartures } from '../services/routing/DepartureSweepInshore';
import { tideFieldFromCurve } from '../services/routing/env/EnvFields';
import type { TideCurve } from '../services/TideHeightService';

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

/**
 * Package 125-05b review fix-up (2026-10-09): a pin's red dry tail
 * (ShallowRunInfo.dryTail) is no departure gate. It is red whatever the tide,
 * and its route note says when the boat floats over it; as a gate, a beach no
 * tide floats a keel over blocked EVERY departure of the whole route in the
 * Departure sweep — the "shit caning the whole route" Shane asked to stop
 * (2026-10-08). A fictional Wadden-style harbour at 53.4° N, 5.3° E.
 */
describe('inshoreTideSpots — a pin’s dry tail is no departure gate (125-05b)', () => {
    const polyline: [number, number][] = [
        [5.2, 53.4],
        [5.25, 53.4],
        [5.29, 53.4],
        [5.3, 53.4],
        [5.304, 53.4],
    ];
    const gate = {
        startSeg: 1,
        endSeg: 1,
        lengthM: 400,
        minDepthM: 1.9,
        midLat: 53.4,
        midLon: 5.27,
    };
    // The tail across sand drying 0.4 m to the pin, as the engine saves it.
    const tail = {
        startSeg: 3,
        endSeg: 3,
        lengthM: 270,
        minDepthM: -0.4,
        midLat: 53.4,
        midLon: 5.302,
        dryTail: true,
    };

    it('reads the tail back from a saved plan and gates only the real shallow stretch', () => {
        const runs = readPersistedShallowRuns([gate, tail]);
        expect(runs[1]).toMatchObject({ dryTail: true, minDepthM: -0.4 });
        // Was: [{ legIndex: 1, minDepthM: 1.9 }, { legIndex: 3, minDepthM: -0.4 }].
        expect(shallowRunsToDepartureSpots(polyline, runs)).toEqual([{ legIndex: 1, minDepthM: 1.9 }]);
        // The tide is read where the real gate is, never at the pin's beach.
        expect(tideAnchorForShallowRuns(runs)).toEqual({ lat: 53.4, lon: 5.27 });
    });

    it('a route whose only red is a tail no tide floats: no gate, so the sweep blocks nothing', () => {
        const T0 = Date.UTC(2026, 9, 9, 0, 0, 0);
        const HOUR = 3_600_000;
        // A 0.2–2.5 m tide: 2.5 − 0.4 = 2.1 m < 2.9 m, so no tide floats the tail.
        const curve = {
            heights: [],
            provenance: 'STATION_HEIGHTS',
            rangeMs: [T0, T0 + 48 * HOUR],
            heightAt: (t: number) =>
                t < T0 || t > T0 + 48 * HOUR ? null : 1.35 - 1.15 * Math.cos((2 * Math.PI * (t - T0)) / (12.42 * HOUR)),
        } as unknown as TideCurve;
        const spots = shallowRunsToDepartureSpots(polyline, readPersistedShallowRuns([tail]));
        expect(spots).toEqual([]);
        const sweep = sweepDepartures({
            polyline,
            speed: { stwMs: () => 2.5 },
            tide: tideFieldFromCurve(curve),
            shallowSpots: spots,
            draftM: 2.4,
            startMs: T0,
        });
        expect(sweep.options).toHaveLength(25);
        // Was: 25/25 'blocked', best null — no departure at all.
        expect(sweep.options.every((o) => o.status !== 'blocked')).toBe(true);
        expect(sweep.best).not.toBeNull();
    });
});

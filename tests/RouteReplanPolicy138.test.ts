import { describe, it, expect } from 'vitest';
import {
    replanFixUsable,
    remainingReplanVias,
    replanSuggestionReasons,
    replanWindCovered,
} from '../services/routing/routeReplanPolicy';
import type { VoyagePlan } from '../types';
import type { IsochroneResult } from '../services/isochrone/types';
import type { WindGrid } from '../services/weather/windGridEncoding';
const epoch = Date.parse('2026-10-16T12:00:00Z');
const plan = (): VoyagePlan => ({
    origin: 'Fictional start',
    destination: 'Fictional end',
    departureDate: new Date(epoch).toISOString(),
    destinationCoordinates: { lat: 0, lon: 2 },
    waypoints: [],
    distanceApprox: '120 NM',
    durationApprox: '20 hours',
    overview: '',
});
const result = (): IsochroneResult => ({
    route: [0, 6].map((timeHours, i) => ({
        lat: 0,
        lon: [0.1, 0.12][i],
        timeHours,
        bearing: 90,
        speed: 0.2,
        tws: 0,
        twa: 0,
        parentIndex: null,
        distance: i * 1.2,
    })),
    routeCoordinates: [
        [0.1, 0],
        [0.12, 0],
    ],
    totalDistanceNM: 1.2,
    totalDurationHours: 6,
    arrivalTime: new Date(epoch + 21600000).toISOString(),
    isochrones: [],
    shallowFlags: [false, false],
});
const grid = (): WindGrid => ({
    u: [0, 1, 6].map(() => new Float32Array(4)),
    v: [0, 1, 6].map(() => new Float32Array(4)),
    speed: [0, 1, 6].map(() => new Float32Array(4)),
    width: 2,
    height: 2,
    lats: [-1, 1],
    lons: [0, 1],
    south: -1,
    north: 1,
    west: 0,
    east: 1,
    totalHours: 3,
    refTime: new Date(epoch).toISOString(),
    stepHours: [0, 1, 6],
});
describe('underway re-plan policy', () => {
    it('accepts a finite zero-coordinate fresh fix and refuses stale relay timestamps', () => {
        expect(replanFixUsable({ lat: 0, lon: 0, timestamp: epoch }, epoch)).toBe(true);
        expect(replanFixUsable({ lat: 0, lon: 0, timestamp: epoch, relay: { reportedAt: epoch - 60001 } }, epoch)).toBe(
            false,
        );
        expect(replanFixUsable({ lat: 0, lon: 0, timestamp: epoch + 5001 }, epoch)).toBe(false);
        expect(replanFixUsable(null, epoch)).toBe(false);
    });
    it('retains every remaining accepted via and only drops a demonstrably passed point', () => {
        const value = plan();
        value.waypoints = [{ name: 'Accepted pin', coordinates: { lat: 0, lon: 1 } }];
        const route = [0, 1, 2].map((lon) => ({ lat: 0, lon }));
        expect(remainingReplanVias(value, route, { lat: 0, lon: 0.5 })?.remaining).toEqual([
            { lat: 0, lon: 1, name: 'Accepted pin' },
        ]);
        expect(remainingReplanVias(value, route, { lat: 0, lon: 1.5 })?.remaining).toEqual([]);
    });
    it('refuses an ambiguous repeated visit or unmatched waypoint, rather than dropping it', () => {
        const value = plan();
        value.waypoints = [{ name: 'Repeated pin', coordinates: { lat: 0, lon: 0 } }];
        expect(
            remainingReplanVias(
                value,
                [0, 1, 0, 2].map((lon) => ({ lat: 0, lon })),
                { lat: 0, lon: 0.2 },
            ),
        ).toBeNull();
        value.waypoints = [{ name: 'Unknown pin' }];
        expect(
            remainingReplanVias(
                value,
                [0, 1, 2].map((lon) => ({ lat: 0, lon })),
                { lat: 0, lon: 0.2 },
            ),
        ).toBeNull();
    });
    it('refuses a saved manual curve whose original constraints are not represented', () => {
        const value = plan();
        value.routeGeoJSON = {
            type: 'Feature',
            properties: { _source: 'saved-logbook-route' },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [0, 0],
                    [1, 1],
                    [2, 0],
                ],
            },
        };
        expect(
            remainingReplanVias(
                value,
                [
                    { lat: 0, lon: 0 },
                    { lat: 1, lon: 1 },
                    { lat: 0, lon: 2 },
                ],
                { lat: 0, lon: 0 },
            ),
        ).toBeNull();
        expect(
            remainingReplanVias(
                value,
                [0, 1, 2].map((lon) => ({ lat: 0, lon })),
                { lat: 0, lon: 0.5 },
            )?.remaining,
        ).toEqual([]);
    });
    it('keeps suggest-only triggers on actual run identity, a30-minute slip or the existing XTE limit', () => {
        expect(
            replanSuggestionReasons({
                previousRun: null,
                currentRun: 'generation-a',
                baselineEtaMs: epoch,
                currentEtaMs: epoch + 1799999,
                xteNm: 0,
                xteLimitNm: 0.25,
            }),
        ).toEqual([]);
        expect(
            replanSuggestionReasons({
                previousRun: 'generation-a',
                currentRun: 'generation-b',
                baselineEtaMs: epoch,
                currentEtaMs: epoch + 1800000,
                xteNm: 0.25,
                xteLimitNm: 0.25,
            }),
        ).toHaveLength(3);
    });
    it('retains true calm wind, but catches an hourly unknown on a slow short leg', () => {
        expect(replanWindCovered(result(), grid(), epoch)).toBe(true);
        const value = grid();
        value.u[1].fill(NaN);
        expect(replanWindCovered(result(), value, epoch)).toBe(false);
    });
    it('checks fractional actual forecast knots, not merely integer hours', () => {
        const value = grid();
        value.refTime = new Date(epoch - 1800000).toISOString();
        value.stepHours = [0.5, 1, 6.5];
        value.u[1].fill(NaN);
        expect(replanWindCovered(result(), value, epoch)).toBe(false);
    });
    it('refuses clock/geometry mismatch and expired horizon instead of clamping', () => {
        const value = result();
        value.routeCoordinates[1] = [0.13, 0];
        expect(replanWindCovered(value, grid(), epoch)).toBe(false);
        expect(replanWindCovered(result(), grid(), epoch + 3600000)).toBe(false);
    });
    it('fails the whole bounded check when its resampling cap is exceeded', () => {
        const value = result();
        value.route[1].timeHours = 10000;
        expect(replanWindCovered(value, grid(), epoch)).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { estimateRouteFuel, routeEstimateLines, sailingStatsForNodes } from '../services/isochrone/routeStats';
import { computeIsochrones } from '../services/IsochroneRouter';
import type { IsochroneNode } from '../services/isochrone/types';
const node = (
    timeHours: number,
    propulsion: IsochroneNode['propulsion'],
    twa = 90,
    tackSide: IsochroneNode['tackSide'] = null,
): IsochroneNode => ({
    lat: 0,
    lon: timeHours,
    timeHours,
    propulsion,
    twa,
    tackSide,
    speed: 6,
    bearing: 90,
    tws: 12,
    parentIndex: null,
    distance: timeHours * 6,
});
describe('modeled sailing and motor attribution', () => {
    it('counts incoming-leg durations and tacks, excluding motor and downwind gybes', () => {
        const stats = sailingStatsForNodes([
            node(0, 'unknown'),
            node(1, 'sail', 40, 1),
            node(3, 'sail', 40, -1),
            node(4, 'sail', 90, 1),
            node(6, 'sail', 170, -1),
            node(7, 'motor'),
        ]);
        expect(stats).toMatchObject({
            beatingHours: 3,
            reachingHours: 1,
            runningHours: 2,
            motorHours: 1,
            unknownHours: 0,
            tacks: 1,
            totalHours: 7,
        });
    });
    it('never guesses mode from wind, speed or missing legacy metadata', () => {
        const stats = sailingStatsForNodes([node(0, 'sail'), node(2, undefined, 0), node(4, 'motor')]);
        expect(stats).toMatchObject({ motorHours: null, knownMotorHours: 2, unknownHours: 2, tacks: null });
        expect(routeEstimateLines(stats).join(' ')).toMatch(/Motor unknown/);
    });
    it('engine retains real motor hours after smoothing removes intermediate mode changes', async () => {
        const polar = {
            windSpeeds: [5, 15],
            angles: [0, 90, 180],
            matrix: [
                [0, 0],
                [8, 8],
                [8, 8],
            ],
        };
        const result = await computeIsochrones(
            { lat: 0, lon: 0 },
            { lat: 0, lon: 3 },
            '2026-10-17T00:00:00Z',
            polar,
            { getWind: (_lat, _lon, hours) => ({ speed: hours < 3 ? 1 : 15, direction: 0 }) },
            {
                timeStepHours: 1,
                maxHours: 48,
                minBearingDeg: 0,
                maxBearingDeg: 0,
                bearingCount: 12,
                motoringSpeed: 5,
                useDepthPenalty: false,
            },
        );
        expect(result).not.toBeNull();
        expect(result!.route.length).toBeLessThanOrEqual(3);
        expect(result!.motorHours).toBe(3);
        expect(result!.sailingStats!.reachingHours).toBeGreaterThan(0);
        expect(result!.sailingStats!.totalHours).toBe(result!.totalDurationHours);
    });
    it('unknown wind does not become measured motor hours; explicit power policy remains motor', async () => {
        const polar = { windSpeeds: [5], angles: [0, 90, 180], matrix: [[0], [8], [8]] };
        const config = {
            timeStepHours: 1,
            maxHours: 24,
            minBearingDeg: 0,
            maxBearingDeg: 0,
            bearingCount: 12,
            motoringSpeed: 5,
            useDepthPenalty: false,
        };
        const args = [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.5 },
            '2026-10-17T00:00:00Z',
            polar,
            { getWind: () => null },
        ] as const;
        const unknown = await computeIsochrones(...args, config);
        const power = await computeIsochrones(...args, { ...config, powerVessel: true });
        expect(unknown!.motorHours).toBeNull();
        expect(power!.motorHours).toBe(power!.totalDurationHours);
    });
    it('the actual expansion kernel rejects a sea state above the hard wave cap', async () => {
        const polar = { windSpeeds: [5], angles: [0, 90, 180], matrix: [[0], [8], [8]] };
        const result = await computeIsochrones(
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.5 },
            '2026-10-17T00:00:00Z',
            polar,
            { getWind: () => ({ speed: 12, direction: 0 }) },
            { timeStepHours: 1, maxHours: 4, useDepthPenalty: false, comfortParams: { maxWaveM: 2 } },
            null,
            null,
            null,
            { getWave: () => ({ heightM: 3, periodS: 8, directionFromDeg: 90 }) },
        );
        expect(result).toBeNull();
    });
});
describe('fuel quantity and reserve estimates', () => {
    it('uses L/h and converts stored US gallons exactly before reserving tank percentage', () => {
        const fuel = estimateRouteFuel(4, 20, { fuelBurn: 5, fuelCapacity: 10, fuelReservePct: 25 });
        expect(fuel.litres).toBe(20);
        expect(fuel.tankLitres).toBeCloseTo(37.85411784);
        expect(fuel.usableLitres).toBeCloseTo(28.39058838);
        expect(fuel.fitsCapacity).toBe(true);
    });
    it('names the all-motor assumption for inshore/Auto paths with no propulsion model', () => {
        const fuel = estimateRouteFuel(null, 8, { fuelBurn: 5, fuelCapacity: 10, fuelReservePct: 25 });
        expect(fuel.basis).toBe('all-motor-assumption');
        expect(fuel.fitsCapacity).toBe(false);
        expect(routeEstimateLines(undefined, fuel).join(' ')).toMatch(/if motoring all 8.0 h/);
        expect(routeEstimateLines(undefined, fuel).join(' ')).toMatch(/exceeds usable capacity/);
    });
    it('keeps absent burn/capacity unknown and zero reserve valid', () => {
        expect(estimateRouteFuel(4, 20, { fuelBurn: 0 }).litres).toBeNull();
        expect(estimateRouteFuel(4, 20, {}).fitsCapacity).toBeNull();
        expect(estimateRouteFuel(4, 20, { fuelReservePct: 0 }).reservePercent).toBe(0);
    });
});

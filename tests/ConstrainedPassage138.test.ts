import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types/settings';
import type { WindGrid } from '../services/weather/windGridEncoding';
import type { IsochroneNode } from '../services/isochrone/types';
import { cumulativeLegs } from '../services/isochrone/geodesy';

const mocks = vi.hoisted(() => ({
    inshore: vi.fn(),
    backstop: vi.fn(),
    validate: vi.fn(),
    polar: vi.fn(),
    ocean: vi.fn(),
}));
vi.mock('../services/InshoreRouter', () => ({ tryInshoreRoute: mocks.inshore }));
vi.mock('../services/routing/landBackstop', () => ({ inshoreRouteCrossesLand: mocks.backstop }));
vi.mock('../services/routingPolar', () => ({ resolveRoutingPolar: mocks.polar }));
vi.mock('../services/routing/comfortRoute', () => ({ computeComfortIsochrones: mocks.ocean }));
vi.mock('../services/BathymetryCache', () => ({ preloadBathymetry: vi.fn(async () => null) }));
vi.mock('../services/isochrone/landAvoidance', () => ({ validateRouteSegments: mocks.validate }));
vi.mock('../services/routing/isochroneEnvironment', () => ({
    loadIsochroneEnvironment: vi.fn(async () => ({
        notes: [],
        waveField: null,
        exclusionField: null,
        currentField: null,
    })),
    isochroneEnvironmentAt: vi.fn((env) => env),
}));
import { computeConstrainedPassage } from '../services/routing/constrainedPassage';

const start = Date.parse('2026-10-17T12:00:00Z');
function grid(): WindGrid {
    const frames = () => Array.from({ length: 2 }, () => new Float32Array(4).fill(5));
    return {
        u: frames(),
        v: frames(),
        speed: frames(),
        width: 2,
        height: 2,
        lats: [-5, 5],
        lons: [-5, 5],
        north: 5,
        south: -5,
        west: -5,
        east: 5,
        totalHours: 2,
        refTime: new Date(start).toISOString(),
        stepHours: [0, 168],
    };
}
const settings = { vessel: null, comfortParams: {}, satelliteMode: false } as unknown as UserSettings;
function input() {
    return {
        origin: { lat: 0, lon: 0 },
        vias: [{ lat: 0, lon: 0.1, name: 'Required mark' }],
        destination: { lat: 0, lon: 0.2 },
        departureTime: new Date(start).toISOString(),
        speed: 6,
        settings,
        model: 'ecmwf',
        privateWind: grid(),
        deadlineMs: Date.now() + 5000,
        stillCurrent: () => true,
        inshoreEvidence: () => ({ masksVerified: true, caveats: ['Inshore fixture caveat'] }),
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.polar.mockResolvedValue({
        label: 'Fixture polar',
        polar: {
            angles: [0, 90],
            windSpeeds: [5, 15],
            matrix: [
                [0, 0],
                [5, 6],
            ],
        },
    });
    mocks.inshore.mockImplementation(async (a, b) => ({
        polyline: [
            [a.lon, a.lat],
            [b.lon, b.lat],
        ],
        cautionMask: [false],
        cellsUsed: ['PUBLIC_FIXTURE'],
        chartVerdicts: [],
    }));
    mocks.backstop.mockResolvedValue({ status: 'verified', crossesLand: false });
    mocks.validate.mockImplementation(async (route: IsochroneNode[], options) => {
        options.onVerificationOutcome({ status: 'verified' });
        return route;
    });
});
describe('actual constrained passage orchestration', () => {
    it('keeps short required hops in the charted engine and rebases their actual departure clocks', async () => {
        const request = input(),
            result = await computeConstrainedPassage(request);
        expect(mocks.inshore).toHaveBeenCalledTimes(2);
        expect(mocks.inshore.mock.calls[1][5].departureMs).toBe(
            new Date(start + result.result.route[1].timeHours * 3600000).getTime(),
        );
        expect(result.result.routeCoordinates).toEqual([
            [0, 0],
            [0.1, 0],
            [0.2, 0],
        ]);
        expect(result.turns.some((point) => point.id === 'VIA1' && point.lon === 0.1)).toBe(true);
        expect(result.cells).toEqual(['PUBLIC_FIXTURE']);
        expect(result.result.environmentNotes).toContain('Inshore fixture caveat');
        expect(mocks.polar).toHaveBeenCalledWith({ settings, vessel: null });
        expect(mocks.validate.mock.calls[0][1]).toMatchObject({ publishReport: false, departureTimeMs: start });
        expect(mocks.ocean).not.toHaveBeenCalled();
    });
    it('refuses the whole route when one short hop has no charts or incomplete masks', async () => {
        mocks.inshore.mockResolvedValueOnce(null);
        await expect(computeConstrainedPassage(input())).rejects.toThrow('under 15 NM');
        expect(mocks.validate).not.toHaveBeenCalled();
        const next = { ...input(), inshoreEvidence: () => ({ masksVerified: false, caveats: [] }) };
        await expect(computeConstrainedPassage(next)).rejects.toThrow('complete inshore masks');
    });
    it('refuses chart changes that erase a required pin and unknown forecast cells', async () => {
        mocks.validate.mockImplementationOnce(async (route: IsochroneNode[], options) => {
            options.onVerificationOutcome({ status: 'verified' });
            return [route[0], route.at(-1)!];
        });
        await expect(computeConstrainedPassage(input())).rejects.toThrow('changed a required point');
        const next = input();
        next.privateWind.u[0].fill(NaN);
        await expect(computeConstrainedPassage(next)).rejects.toThrow('weather or chart verification');
    });
    it('cannot return a leg after its account or routing policy becomes stale', async () => {
        let current = true;
        mocks.inshore.mockImplementationOnce(async (a, b) => {
            current = false;
            return {
                polyline: [
                    [a.lon, a.lat],
                    [b.lon, b.lat],
                ],
                cellsUsed: [],
            };
        });
        await expect(computeConstrainedPassage({ ...input(), stillCurrent: () => current })).rejects.toThrow(
            'required waypoint leg',
        );
        expect(mocks.validate).not.toHaveBeenCalled();
    });
    it('passes actual offset time and half-line barriers into offshore legs', async () => {
        const request = {
            ...input(),
            vias: [{ lat: 0, lon: 2, leaveSide: 'port' as const, standOffM: 50 }],
            destination: { lat: 0, lon: 4 },
        };
        mocks.ocean.mockImplementation(async (from, to, departure, _polar, wind, config) => {
            expect(config.segmentAllowed({ lat: 0.1, lon: 0 }, { lat: 0.1, lon: 4 })).toBe(false);
            expect(wind.getWind(from.lat, from.lon, 0)).not.toBeNull();
            const distance = cumulativeLegs([from, to], 6),
                route = [from, to].map((p, i) => ({
                    ...p,
                    distance: distance[i].nm,
                    timeHours: distance[i].hours,
                    bearing: 90,
                    speed: 6,
                    tws: 10,
                    twa: 90,
                    parentIndex: null,
                }));
            return {
                route,
                routeCoordinates: route.map((p) => [p.lon, p.lat]),
                shallowFlags: [false, false],
                isochrones: [],
                totalDistanceNM: distance[1].nm,
                totalDurationHours: distance[1].hours,
                arrivalTime: new Date(Date.parse(departure) + distance[1].hours * 3600000).toISOString(),
            };
        });
        const result = await computeConstrainedPassage(request);
        expect(result.result.route[1].lat).toBeLessThan(0);
        expect(mocks.ocean).toHaveBeenCalledTimes(2);
        expect(Date.parse(mocks.ocean.mock.calls[1][2])).toBe(
            new Date(start + result.result.route[1].timeHours * 3600000).getTime(),
        );
    });
});

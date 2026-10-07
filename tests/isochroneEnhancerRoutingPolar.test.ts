/**
 * The voyage form's isochrone step sails the resolved polar (build 123,
 * W1-03 review). Only a source grep guarded this before: a partial revert to
 * `const polar = DEFAULT_CRUISING_POLAR`, or an empty cache signature (every
 * precompute missed and dropped), would have shipped green.
 *
 * Marseille → Bonifacio (~190 NM, past the 100 NM short-route skip) through a
 * mocked engine and precompute cache. Fictional boat, synthetic data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolarData, VesselProfile, VoyagePlan } from '../types';

const RESOLVED = vi.hoisted(() => ({
    polar: {
        windSpeeds: [6, 12, 20],
        angles: [0, 40, 45, 90, 180],
        matrix: [
            [0, 0, 0],
            [0, 0, 0],
            [4.4, 6.2, 6.8],
            [5.6, 7.2, 7.9],
            [3.4, 5.6, 7.0],
        ],
    } as PolarData,
    source: 'database-scaled' as const,
    label: 'Fair Wind 38 (shape scaled to 7.4 kn)',
    reason: 'the yacht database shape, scaled so a fair reaching breeze gives her 7.4 kn',
    signature: '5ca1ed38',
}));

const mocks = vi.hoisted(() => ({
    resolveRoutingPolar: vi.fn(),
    getPrecomputedRoute: vi.fn(),
    computeIsochrones: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../services/routingPolar', () => ({ resolveRoutingPolar: mocks.resolveRoutingPolar }));
vi.mock('../services/IsochronePrecomputeCache', () => ({ getPrecomputedRoute: mocks.getPrecomputedRoute }));
vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: mocks.computeIsochrones,
    detectTurnWaypoints: vi.fn(() => []),
}));
vi.mock('../stores/WindStore', () => ({
    WindStore: { getState: vi.fn(() => ({ grid: { north: 60, south: 20, east: 30, west: -10 } })), setGrid: vi.fn() },
}));
vi.mock('../services/weather/WindFieldAdapter', () => ({ createWindFieldFromGrid: vi.fn(() => ({})) }));
vi.mock('../services/BathymetryCache', () => ({ preloadBathymetry: vi.fn(async () => null) }));
vi.mock('../services/cycloneAvoidance', () => ({ buildCycloneExclusionField: vi.fn(async () => null) }));
vi.mock('../services/weather/waveField', () => ({
    fetchWaveField: vi.fn(async () => {
        throw new Error('offline (test)');
    }),
}));
vi.mock('../services/OceanCurrentService', () => ({
    OceanCurrentService: {
        fetchCurrents: vi.fn(async () => {
            throw new Error('offline (test)');
        }),
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: vi.fn(() => ({ settings: {} })) },
}));
vi.mock('../services/isochrone/landAvoidance', () => ({ validateRouteSegments: vi.fn(async (route) => route) }));
vi.mock('../services/enc/EncHazardReportService', () => ({ publishRouteNotValidated: vi.fn() }));

import { enhanceVoyagePlanWithIsochrone } from '../services/isochroneEnhancer';

const VESSEL: VesselProfile = {
    name: 'Fair Wind',
    type: 'sail',
    length: 38,
    beam: 12.8,
    draft: 6.2,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 0,
};
const PLAN = {
    origin: 'Marseille',
    destination: 'Bonifacio',
    originCoordinates: { lat: 43.3, lon: 5.37 },
    destinationCoordinates: { lat: 41.39, lon: 9.16 },
} as unknown as VoyagePlan;
const DEPART = '2026-11-01T06:00:00Z';

function candidate() {
    const pts = [
        { lat: 43.3, lon: 5.37 },
        { lat: 42.3, lon: 7.4 },
        { lat: 41.39, lon: 9.16 },
    ];
    return {
        route: pts.map((p, i) => ({ ...p, timeHours: i * 14, distance: i * 95, tws: 15, twa: 90, bearing: 120 })),
        routeCoordinates: pts.map((p) => [p.lon, p.lat] as [number, number]),
        isochrones: [],
        totalDistanceNM: 190,
        totalDurationHours: 28,
    };
}

describe('enhanceVoyagePlanWithIsochrone routes on the resolved polar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveRoutingPolar.mockResolvedValue(RESOLVED);
        mocks.getPrecomputedRoute.mockReturnValue(null);
        mocks.computeIsochrones.mockImplementation(async () => candidate());
    });

    it('a cache miss: resolves for her vessel, asks the cache by signature, and the engine sails that polar', async () => {
        const out = await enhanceVoyagePlanWithIsochrone(PLAN, VESSEL, DEPART);
        expect(out).not.toBeNull();
        expect(mocks.resolveRoutingPolar).toHaveBeenCalledWith({ vessel: VESSEL });
        expect(mocks.getPrecomputedRoute).toHaveBeenCalledWith(43.3, 5.37, 41.39, 9.16, RESOLVED.signature);
        expect(mocks.computeIsochrones).toHaveBeenCalledTimes(1);
        expect(mocks.computeIsochrones.mock.calls[0][3]).toBe(RESOLVED.polar);
        expect(out!.routeGeoJSON?.properties).toMatchObject({ source: 'isochrone' });
    });

    it('a cache hit on the same polar: used as is, no fresh compute', async () => {
        mocks.getPrecomputedRoute.mockReturnValue(candidate());
        const out = await enhanceVoyagePlanWithIsochrone(PLAN, VESSEL, DEPART);
        expect(out).not.toBeNull();
        expect(mocks.getPrecomputedRoute.mock.calls[0][4]).toBe(RESOLVED.signature);
        expect(mocks.computeIsochrones).not.toHaveBeenCalled();
    });
});

/**
 * The passage planner sails her resolved polar and says which (build 123,
 * W1-03 review). Until now only a source grep guarded this: the planner
 * suites never reach the isochrone, so `const polar = DEFAULT_CRUISING_POLAR`
 * or a dropped setRoutingPolarLabel would have shipped green.
 *
 * Drives a fresh offshore route (Marseille → Bonifacio, ~190 NM, so past the
 * 100 NM short-route bypass) through a mocked isochrone engine, and a cached
 * one through a mocked precompute cache. Fictional boat, synthetic data.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolarData } from '../types';

const RESOLVED = vi.hoisted(() => ({
    polar: {
        windSpeeds: [6, 12, 20],
        angles: [0, 33, 38, 90, 180],
        matrix: [
            [0, 0, 0],
            [0, 0, 0],
            [3.6, 5.4, 6.0],
            [5.3, 7.4, 8.3],
            [3.0, 5.5, 7.2],
        ],
    } as PolarData,
    source: 'imported' as const,
    label: 'Fair Wind 2025.pol (imported)',
    reason: 'the polar you imported',
    signature: 'f00dcafe',
}));

const mocks = vi.hoisted(() => ({
    resolveRoutingPolar: vi.fn(),
    getPrecomputedRoute: vi.fn(),
    computeIsochrones: vi.fn(),
    validateRouteSegments: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('mapbox-gl', () => ({
    default: {
        LngLatBounds: class {
            extend() {
                return this;
            }
        },
    },
}));
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
    getSystemUnits: () => ({
        speed: 'kts',
        length: 'm',
        waveHeight: 'm',
        tideHeight: 'm',
        temp: 'C',
        distance: 'nm',
        visibility: 'nm',
        volume: 'l',
    }),
}));
vi.mock('../services/WeatherRoutingService', () => ({
    computeRoute: vi.fn(() => ({ totalDistance: 190, estimatedDuration: 30, averageSpeed: 6.3 })),
}));
vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: mocks.computeIsochrones,
    isochroneToGeoJSON: vi.fn(),
    detectTurnWaypoints: vi.fn(() => []),
}));
vi.mock('../services/BathymetryCache', () => ({ preloadBathymetry: vi.fn(async () => null) }));
vi.mock('../services/weather/WindFieldAdapter', () => ({ createWindFieldFromGrid: vi.fn(() => ({})) }));
vi.mock('../services/routingPolar', () => ({ resolveRoutingPolar: mocks.resolveRoutingPolar }));
vi.mock('../services/IsochronePrecomputeCache', () => ({ getPrecomputedRoute: mocks.getPrecomputedRoute }));
// A world-wide grid: covers the route, so no route-grid fetch.
vi.mock('../stores/WindStore', () => ({
    WindStore: {
        getState: vi.fn(() => ({ grid: { north: 90, south: -90, east: 180, west: -180 } })),
        setGrid: vi.fn(),
    },
}));
vi.mock('../stores/PassageStore', () => ({
    PassageStore: { clear: vi.fn(), setFromRoute: vi.fn() },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: vi.fn(() => ({ settings: { vessel: null } })) },
}));
vi.mock('../services/weather/WindDataController', () => ({
    WindDataController: { activate: vi.fn() },
}));
vi.mock('../services/ComfortZoneEngine', () => ({
    generateComfortZoneOverlay: vi.fn(),
    hasActiveComfortLimits: vi.fn(() => false),
}));
// No ENC here: the inshore router declines and the offshore planner runs.
vi.mock('../services/InshoreRouter', () => ({ tryInshoreRoute: vi.fn(async () => null) }));
vi.mock('../services/isochrone/landAvoidance', () => ({ validateRouteSegments: mocks.validateRouteSegments }));
vi.mock('../services/enc/EncHazardReportService', () => ({ publishRouteNotValidated: vi.fn() }));
// No ECMWF grid: the confidence braid stands down.
vi.mock('../services/weather/OpenMeteoWindFetcher', () => ({ fetchModelWindGrid: vi.fn(async () => null) }));

import { usePassagePlanner } from '../components/map/usePassagePlanner';
import { clearPassageRequest, stagePassageRequest } from '../services/passageHandoff';

const MARSEILLE = { lat: 43.3, lon: 5.37, name: 'Marseille' };
const BONIFACIO = { lat: 41.39, lon: 9.16, name: 'Bonifacio' };

/** A two-leg candidate the mocked engine (or cache) returns. */
function candidate() {
    const pts = [
        { lat: 43.0, lon: 5.6 },
        { lat: 42.3, lon: 7.4 },
        { lat: 41.6, lon: 8.9 },
    ];
    const route = pts.map((p, i) => ({
        ...p,
        timeHours: i * 12,
        bearing: 120,
        speed: 6,
        tws: 15,
        twa: 90,
        distance: i * 80,
        parentIndex: i === 0 ? null : 0,
    }));
    return {
        route,
        routeCoordinates: pts.map((p) => [p.lon, p.lat] as [number, number]),
        shallowFlags: pts.map(() => false),
        isochrones: [],
        totalDistanceNM: 160,
        totalDurationHours: 24,
        arrivalTime: '2026-11-02T06:00:00Z',
    };
}

/** A map whose sources accept data and whose other calls answer nothing. */
const fakeMap = (): unknown =>
    new Proxy(
        { getSource: vi.fn(() => ({ setData: vi.fn() })), getLayer: vi.fn(() => undefined) } as Record<
            string | symbol,
            unknown
        >,
        {
            get: (target, key) => {
                if (!(key in target)) target[key] = vi.fn();
                return target[key];
            },
        },
    );

let completes: Record<string, unknown>[] = [];
const onComplete = (e: Event) => completes.push((e as CustomEvent<Record<string, unknown>>).detail);

async function plan() {
    stagePassageRequest({ departure: MARSEILLE, arrival: BONIFACIO });
    const mapRef = { current: fakeMap() } as never;
    const rendered = renderHook(() => usePassagePlanner(mapRef, false));
    await act(async () => {
        await rendered.result.current.computePassage();
    });
    await waitFor(() => expect(completes.length).toBeGreaterThan(0), { timeout: 4000 });
    return rendered;
}

describe('the passage planner routes on the resolved polar and names it', () => {
    beforeEach(() => {
        clearPassageRequest();
        vi.clearAllMocks();
        completes = [];
        window.addEventListener('thalassa:isochrone-complete', onComplete);
        // Offline: the sea-buoy depth search fails fast and each gate falls
        // back 25 NM along the passage. (GebcoDepthService is not mocked: the
        // two gate searches import it at once, and vitest hands the second
        // concurrent dynamic import of a vi.mock'd module the real one.)
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline (test)');
            }),
        );
        mocks.resolveRoutingPolar.mockResolvedValue(RESOLVED);
        mocks.getPrecomputedRoute.mockReturnValue(null);
        mocks.computeIsochrones.mockImplementation(async () => candidate());
        mocks.validateRouteSegments.mockImplementation(
            async (route: unknown, opts: { onVerificationOutcome?: (o: { status: 'verified' }) => void }) => {
                opts.onVerificationOutcome?.({ status: 'verified' });
                return route;
            },
        );
    });
    afterEach(() => {
        window.removeEventListener('thalassa:isochrone-complete', onComplete);
        clearPassageRequest();
        vi.unstubAllGlobals();
    });

    it('a fresh route: the engine sails the resolved polar, the cache is asked by its signature, the banner gets its label', async () => {
        const { result } = await plan();
        expect(completes[0]).toMatchObject({ success: true, verified: true });

        expect(mocks.resolveRoutingPolar).toHaveBeenCalledTimes(1);
        expect(mocks.getPrecomputedRoute).toHaveBeenCalledTimes(1);
        expect(mocks.getPrecomputedRoute.mock.calls[0][4]).toBe(RESOLVED.signature);

        expect(mocks.computeIsochrones).toHaveBeenCalledTimes(1);
        expect(mocks.computeIsochrones.mock.calls[0][3]).toBe(RESOLVED.polar);

        expect(result.current.routingPolarLabel).toBe('Fair Wind 2025.pol (imported)');
        expect(result.current.routeAnalysis?.estimatedDuration).toBeGreaterThan(0);
    });

    it('a cached route sailed on the same polar: used, labelled, and no fresh compute', async () => {
        mocks.getPrecomputedRoute.mockReturnValue(candidate());
        const { result } = await plan();
        expect(completes[0]).toMatchObject({ success: true, cached: true });
        expect(mocks.getPrecomputedRoute.mock.calls[0][4]).toBe(RESOLVED.signature);
        expect(mocks.computeIsochrones).not.toHaveBeenCalled();
        expect(result.current.routingPolarLabel).toBe('Fair Wind 2025.pol (imported)');
    });

    it('Clear removes the label with the route', async () => {
        const { result } = await plan();
        expect(result.current.routingPolarLabel).toBe('Fair Wind 2025.pol (imported)');
        act(() => result.current.clearRoute());
        expect(result.current.routingPolarLabel).toBeNull();
    });
});

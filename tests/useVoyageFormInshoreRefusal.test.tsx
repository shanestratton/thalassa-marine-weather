/**
 * A final inshore refusal draws no route in the RoutePlanner voyage form
 * (decision 11 fix-up, 2026-10-01). On 'no-tide-clears' — water no tide
 * clears for the keel and no way round (owner decision 11: "draw no route and
 * say why") — or 'air-draft-blocked', the form used to fall back to the GEBCO
 * bathymetric router, which knows nothing of either: Newport → Rivergate was
 * drawn through the Boat Passage and the refusal was never shown. Now no
 * bathymetric, isochrone or corridor route is drawn in its place, and the
 * plan carries the refusal whole, said again under its summary
 * (savedInshoreRouteCaveats).
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';

const mocks = vi.hoisted(() => ({
    settings: {
        vessel: undefined,
        vesselUnits: 'metric',
        units: 'metric',
        isPro: true,
        mapboxToken: '',
        currentNrtEnabled: false,
        comfortParams: undefined,
    },
    weather: {
        weatherData: null as null,
        voyagePlan: null as VoyagePlan | null,
        saveVoyagePlan: vi.fn(),
    },
    computeVoyagePlan: vi.fn(),
    reverseGeocode: vi.fn(),
    gps: vi.fn(),
    deepAnalysis: vi.fn(),
    precomputeIsochrone: vi.fn(),
    getDraftVoyages: vi.fn(),
    updateVoyage: vi.fn(),
    parseLocation: vi.fn(),
    preloadBathymetry: vi.fn(),
    fetchCurrents: vi.fn(),
    buildCycloneExclusionField: vi.fn(),
    fetchWaveField: vi.fn(),
    planDepartureWindow: vi.fn(),
    resolveRoutingPolar: vi.fn(),
    bathymetricEnhance: vi.fn(),
    isochroneEnhance: vi.fn(),
    weatherEnhance: vi.fn(),
    depthEnhance: vi.fn(),
    multiModelQuery: vi.fn(),
    tryInshore: vi.fn(),
    crossesLand: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: mocks.settings }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => mocks.weather,
}));

vi.mock('../services/voyageCompute', () => ({
    computeVoyagePlan: mocks.computeVoyagePlan,
}));

vi.mock('../services/weatherService', () => ({
    reverseGeocode: mocks.reverseGeocode,
}));

vi.mock('../services/GpsService', () => ({
    GpsService: { getCurrentPosition: mocks.gps },
}));

vi.mock('../services/geminiService', () => ({
    fetchDeepVoyageAnalysis: mocks.deepAnalysis,
}));

vi.mock('../services/IsochronePrecomputeCache', () => ({
    precomputeIsochrone: mocks.precomputeIsochrone,
}));

vi.mock('../services/VoyageService', () => ({
    getDraftVoyages: mocks.getDraftVoyages,
    updateVoyage: mocks.updateVoyage,
}));

vi.mock('../services/weather/api/geocoding', () => ({
    parseLocation: mocks.parseLocation,
}));

vi.mock('../stores/WindStore', () => ({
    WindStore: {
        getState: () => ({ grid: { test: true } }),
        setGrid: vi.fn(),
    },
}));

vi.mock('../services/weather/WindFieldAdapter', () => ({
    createWindFieldFromGrid: () => ({ test: true }),
}));

// The one routing-polar resolver (W1-03): the departure window plans on it.
vi.mock('../services/routingPolar', () => ({
    resolveRoutingPolar: mocks.resolveRoutingPolar,
}));

vi.mock('../services/BathymetryCache', () => ({
    preloadBathymetry: mocks.preloadBathymetry,
}));

vi.mock('../services/OceanCurrentService', () => ({
    OceanCurrentService: { fetchCurrents: mocks.fetchCurrents },
}));

vi.mock('../services/weather/CurrentFieldAdapter', () => ({
    createCurrentFieldFromVectors: () => null,
}));

vi.mock('../services/cycloneAvoidance', () => ({
    buildCycloneExclusionField: mocks.buildCycloneExclusionField,
}));

vi.mock('../services/weather/waveField', () => ({
    fetchWaveField: mocks.fetchWaveField,
}));

vi.mock('../services/weather/WaveFieldAdapter', () => ({
    createWaveFieldFromSamples: () => null,
}));

vi.mock('../services/departureWindow', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/departureWindow')>();
    return { ...original, planDepartureWindow: mocks.planDepartureWindow };
});

vi.mock('../services/bathymetricRouter', () => ({
    enhanceVoyagePlanWithBathymetry: mocks.bathymetricEnhance,
}));

vi.mock('../services/isochroneEnhancer', () => ({
    enhanceVoyagePlanWithIsochrone: mocks.isochroneEnhance,
}));

vi.mock('../services/weatherRouter', () => ({
    enhanceVoyagePlanWithWeather: mocks.weatherEnhance,
}));

vi.mock('../services/WeatherRoutingService', () => ({
    computeRoute: () => ({ segments: [] }),
    enhanceRouteWithDepth: mocks.depthEnhance,
}));

vi.mock('../services/weather/MultiModelWeatherService', () => ({
    recommendModels: () => [],
    queryMultiModel: mocks.multiModelQuery,
}));

vi.mock('../services/InshoreRouter', () => ({
    tryInshoreRoute: mocks.tryInshore,
    inshoreRouteToGeoJSON: vi.fn(),
}));

vi.mock('../services/routing/landBackstop', () => ({
    inshoreRouteCrossesLand: mocks.crossesLand,
}));

import { useVoyageForm } from '../hooks/useVoyageForm';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';

const REFUSAL =
    'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
    'the highest tide in the next 14 days is 2.5 m and you need 2.9 m.';

const plan = (): VoyagePlan => ({
    origin: 'Newport',
    destination: 'Rivergate',
    departureDate: '2026-10-02',
    distanceApprox: '22 NM',
    durationApprox: '4 hours',
    overview: 'test route',
    waypoints: [],
    originCoordinates: { lat: -27.2135, lon: 153.0875 },
    destinationCoordinates: { lat: -27.4268, lon: 153.1267 },
});

/** What the resolver hands the router: a fictional polar with its no-go rows. */
const RESOLVED_POLAR = {
    windSpeeds: [6, 12, 20],
    angles: [0, 40, 45, 90, 180],
    matrix: [
        [0, 0, 0],
        [0, 0, 0],
        [4.1, 5.6, 6.2],
        [5.2, 6.9, 7.4],
        [3.6, 5.3, 6.6],
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    mocks.weather.voyagePlan = null;
    mocks.computeVoyagePlan.mockResolvedValue(plan());
    mocks.reverseGeocode.mockResolvedValue('Friendly place');
    mocks.gps.mockResolvedValue(null);
    mocks.preloadBathymetry.mockResolvedValue(null);
    mocks.fetchCurrents.mockResolvedValue({ vectors: [] });
    mocks.buildCycloneExclusionField.mockResolvedValue(null);
    mocks.fetchWaveField.mockResolvedValue([]);
    mocks.bathymetricEnhance.mockImplementation(async (value: VoyagePlan) => ({
        ...value,
        routeGeoJSON: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
    }));
    mocks.isochroneEnhance.mockResolvedValue(null);
    mocks.weatherEnhance.mockImplementation(async (value: VoyagePlan) => value);
    mocks.depthEnhance.mockResolvedValue({ minDepth: null, shallowSegments: 0, segments: [] });
    mocks.multiModelQuery.mockResolvedValue(null);
    mocks.resolveRoutingPolar.mockResolvedValue({
        polar: RESOLVED_POLAR,
        source: 'database-scaled',
        label: 'Beneteau Oceanis 38.1 (shape scaled to 6 kn)',
        reason: 'the yacht database shape, scaled to her cruising speed',
        signature: '5ca1ed00',
    });
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

/** Calculate, let the enhancement run, and hand back every plan saved. */
async function calculate(): Promise<VoyagePlan[]> {
    vi.useFakeTimers();
    const rendered = renderHook(() => useVoyageForm(vi.fn()));
    act(() => {
        rendered.result.current.setOrigin('Newport');
        rendered.result.current.setDestination('Rivergate');
    });
    await act(async () => {
        await rendered.result.current.handleCalculate();
    });
    for (let i = 0; i < 20; i++) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });
    }
    rendered.unmount();
    return mocks.weather.saveVoyagePlan.mock.calls.map((c) => c[0] as VoyagePlan);
}

describe('a final inshore refusal draws no route in the voyage form', () => {
    for (const code of ['no-tide-clears', 'air-draft-blocked'] as const) {
        it(`${code}: no bathymetric, isochrone or corridor route, and the refusal said whole`, async () => {
            mocks.tryInshore.mockResolvedValue({ error: REFUSAL, code });
            const saved = await calculate();
            expect(mocks.tryInshore).toHaveBeenCalled();
            expect(mocks.bathymetricEnhance).not.toHaveBeenCalled();
            expect(mocks.isochroneEnhance).not.toHaveBeenCalled();
            expect(mocks.weatherEnhance).not.toHaveBeenCalled();
            const last = saved[saved.length - 1];
            expect(last.routeGeoJSON).toBeUndefined();
            expect(last.__inshoreRouting).toMatchObject({ status: 'failed', error: REFUSAL, errorCode: code });
            expect(savedInshoreRouteCaveats(last)).toEqual([REFUSAL]);
        });
    }

    it('any other inshore failure still falls back to the bathymetric route (unchanged)', async () => {
        mocks.tryInshore.mockResolvedValue({ error: 'Origin is on land', code: 'origin-on-land' });
        await calculate();
        expect(mocks.bathymetricEnhance).toHaveBeenCalledOnce();
    });
});

/**
 * Charted land the engine itself measured (review fix-up, 2026-10-02): the
 * engine refuses only a run over 500 m, and a small charted island the ETOPO
 * pixels miss (Daydream Island, straight across, on the real Whitsunday
 * cells) passed the satellite check too. Auto refused it; the voyage form now
 * does as well — in Auto's words, before the satellite check — and falls back
 * to offshore planning.
 */
describe('the voyage form refuses charted land the engine measured, as Auto does', () => {
    const route = (hardLand?: { totalM: number; awayM: number; awayAt?: [number, number] }) => ({
        polyline: [
            [148.7241, -20.2704],
            [148.8192, -20.2566],
        ],
        distanceNM: 5.4,
        elapsedMs: 10,
        cellsUsed: ['AU421148'],
        ...(hardLand ? { hardLand } : {}),
    });

    it('falls back with where, and never asks the satellite check', async () => {
        mocks.tryInshore.mockResolvedValue(route({ totalM: 380, awayM: 380, awayAt: [148.8142, -20.2557] }));
        const saved = await calculate();
        expect(mocks.crossesLand).not.toHaveBeenCalled();
        expect(mocks.bathymetricEnhance).toHaveBeenCalledOnce();
        const refused = saved.find((p) => p.__inshoreRouting?.status === 'failed');
        expect(refused?.__inshoreRouting).toMatchObject({
            status: 'failed',
            errorCode: 'charted-land',
            error: 'The only way Thalassa found crosses charted land near 20.256° S, 148.814° E. The route fell back to offshore planning.',
            cellsUsed: ['AU421148'],
        });
        expect(saved.some((p) => p.__inshoreRouting?.status === 'success')).toBe(false);
    });

    it("land at a pin's own edge only: the satellite check runs and the route stands", async () => {
        mocks.tryInshore.mockResolvedValue(route({ totalM: 40, awayM: 0 }));
        mocks.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: false,
            runs: [],
            samplesChecked: 2,
            samplesRequested: 2,
        });
        const saved = await calculate();
        expect(mocks.crossesLand).toHaveBeenCalledOnce();
        expect(mocks.bathymetricEnhance).not.toHaveBeenCalled();
        expect(saved.some((p) => p.__inshoreRouting?.status === 'success')).toBe(true);
    });

    // 2026-10-02: a check that timed out online was called "offline" by Auto.
    it('a satellite check that could not finish: not accepted as checked, saying what happened', async () => {
        mocks.tryInshore.mockResolvedValue(route({ totalM: 0, awayM: 0 }));
        mocks.crossesLand.mockResolvedValue({
            status: 'unavailable',
            crossesLand: false,
            runs: [],
            samplesChecked: 0,
            samplesRequested: 2,
            unavailable: { kind: 'quota', status: 429 },
        });
        const saved = await calculate();
        const refused = saved.find((p) => p.__inshoreRouting?.status === 'failed');
        expect(refused?.__inshoreRouting).toMatchObject({
            errorCode: 'land-backstop-unavailable',
            error: "The satellite land check couldn't be done just now: today's allowance of satellite checks for this account is used up — the inshore route was not accepted as checked.",
        });
        expect(saved.some((p) => p.__inshoreRouting?.status === 'success')).toBe(false);
    });
});

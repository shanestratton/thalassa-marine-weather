import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepartureScenario, DepartureWindowOptions } from '../services/departureWindow';
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
    bathymetricEnhance: vi.fn(),
    isochroneEnhance: vi.fn(),
    weatherEnhance: vi.fn(),
    depthEnhance: vi.fn(),
    multiModelQuery: vi.fn(),
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

vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: { exportToPolarData: () => ({ test: true }) },
}));

vi.mock('../services/defaultPolar', () => ({
    DEFAULT_CRUISING_POLAR: { test: true },
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

import { useVoyageForm } from '../hooks/useVoyageForm';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function plan(name: string, withCoordinates = false): VoyagePlan {
    return {
        origin: `${name} origin`,
        destination: `${name} destination`,
        departureDate: '2026-07-24',
        distanceApprox: '72 NM',
        durationApprox: '12 hours',
        overview: `${name} test route`,
        waypoints: [],
        ...(withCoordinates
            ? {
                  originCoordinates: { lat: -27.4, lon: 153.1 },
                  destinationCoordinates: { lat: -26.4, lon: 153.2 },
              }
            : {}),
    };
}

async function primeRouteForm(result: { current: ReturnType<typeof useVoyageForm> }) {
    act(() => {
        result.current.setOrigin('Account A origin');
        result.current.setDestination('Account A destination');
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    mocks.weather.voyagePlan = null;
    mocks.computeVoyagePlan.mockResolvedValue(plan('default'));
    mocks.reverseGeocode.mockResolvedValue('Friendly place');
    mocks.gps.mockResolvedValue(null);
    mocks.preloadBathymetry.mockResolvedValue(null);
    mocks.fetchCurrents.mockResolvedValue({ vectors: [] });
    mocks.buildCycloneExclusionField.mockResolvedValue(null);
    mocks.fetchWaveField.mockResolvedValue([]);
    mocks.bathymetricEnhance.mockImplementation(async (value: VoyagePlan) => value);
    mocks.isochroneEnhance.mockResolvedValue(null);
    mocks.weatherEnhance.mockImplementation(async (value: VoyagePlan) => value);
    mocks.depthEnhance.mockResolvedValue({ minDepth: null, shallowSegments: 0, segments: [] });
    mocks.multiModelQuery.mockResolvedValue(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('useVoyageForm identity ownership', () => {
    it('drops a delayed calculation from A and synchronously blanks A form state for B', async () => {
        const pending = deferred<VoyagePlan>();
        mocks.computeVoyagePlan.mockReturnValueOnce(pending.promise);
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);

        let calculation!: Promise<void>;
        act(() => {
            calculation = rendered.result.current.handleCalculate();
        });
        await vi.waitFor(() => expect(mocks.computeVoyagePlan).toHaveBeenCalledOnce());

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(rendered.result.current).toMatchObject({
            origin: '',
            destination: '',
            loading: false,
            error: null,
            deepReport: null,
            planningWindow: false,
            showWindowSheet: false,
        });

        pending.resolve(plan('private A'));
        await act(async () => {
            await calculation;
        });
        expect(mocks.weather.saveVoyagePlan).not.toHaveBeenCalled();
        rendered.unmount();
    });

    it('treats logout and login of the same account as a new generation', async () => {
        const firstLogin = getAuthIdentityScope();
        const pending = deferred<VoyagePlan>();
        mocks.computeVoyagePlan.mockReturnValueOnce(pending.promise);
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);
        let calculation!: Promise<void>;
        act(() => {
            calculation = rendered.result.current.handleCalculate();
        });
        await vi.waitFor(() => expect(mocks.computeVoyagePlan).toHaveBeenCalledOnce());

        act(() => {
            setAuthIdentityScope(null);
            setAuthIdentityScope('account-a');
        });
        expect(getAuthIdentityScope().generation).toBeGreaterThan(firstLogin.generation);
        expect(rendered.result.current.origin).toBe('');

        pending.resolve(plan('old login'));
        await act(async () => {
            await calculation;
        });
        expect(mocks.weather.saveVoyagePlan).not.toHaveBeenCalled();
        rendered.unmount();
    });

    it('makes callbacks retained from A inert instead of applying A closure inputs to B', async () => {
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);
        const staleCalculate = rendered.result.current.handleCalculate;
        const staleDateChange = rendered.result.current.handleDateChange;

        act(() => {
            setAuthIdentityScope('account-b');
        });
        act(() => {
            rendered.result.current.setOrigin('Account B origin');
            rendered.result.current.setDestination('Account B destination');
        });
        await act(async () => {
            await staleCalculate();
            await staleDateChange('2026-09-01');
        });

        expect(mocks.computeVoyagePlan).not.toHaveBeenCalled();
        expect(mocks.getDraftVoyages).not.toHaveBeenCalled();
        expect(rendered.result.current.departureDate).not.toBe('2026-09-01');
        rendered.unmount();
    });

    it('keeps the module-owned enhancement alive across planner unmount but cancels it on A→B', async () => {
        vi.useFakeTimers();
        const first = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(first.result);
        await act(async () => {
            await first.result.current.handleCalculate();
        });
        expect(mocks.weather.saveVoyagePlan).toHaveBeenCalledTimes(1);
        first.unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
        });
        expect(mocks.bathymetricEnhance).toHaveBeenCalledOnce();
        expect(mocks.weather.saveVoyagePlan.mock.calls.length).toBeGreaterThan(1);

        vi.clearAllMocks();
        mocks.computeVoyagePlan.mockResolvedValue(plan('second'));
        mocks.bathymetricEnhance.mockImplementation(async (value: VoyagePlan) => value);
        mocks.isochroneEnhance.mockResolvedValue(null);
        mocks.weatherEnhance.mockImplementation(async (value: VoyagePlan) => value);
        const second = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(second.result);
        await act(async () => {
            await second.result.current.handleCalculate();
        });
        second.unmount();
        act(() => {
            setAuthIdentityScope('account-b');
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
        });
        expect(mocks.bathymetricEnhance).not.toHaveBeenCalled();
    });

    it('passes the calculate-time auth generation into isochrone precompute', async () => {
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);
        const calculationScope = getAuthIdentityScope();
        mocks.computeVoyagePlan.mockResolvedValueOnce(plan('scoped', true));

        await act(async () => {
            await rendered.result.current.handleCalculate();
            await Promise.resolve();
        });

        expect(mocks.precomputeIsochrone).toHaveBeenCalledWith(
            { lat: -27.4, lon: 153.1 },
            { lat: -26.4, lon: 153.2 },
            '2026-07-24',
            calculationScope,
        );
        rendered.unmount();
    });

    it('rejects stale departure-window progress and final scenarios', async () => {
        const final = deferred<DepartureScenario[]>();
        let ownedOptions: DepartureWindowOptions | undefined;
        mocks.parseLocation
            .mockResolvedValueOnce({ lat: -27.4, lon: 153.1 })
            .mockResolvedValueOnce({ lat: -26.4, lon: 153.2 });
        mocks.planDepartureWindow.mockImplementation(
            async (...args: Parameters<typeof import('../services/departureWindow').planDepartureWindow>) => {
                ownedOptions = args[11];
                return final.promise;
            },
        );
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);

        let planning!: Promise<void>;
        act(() => {
            planning = rendered.result.current.handlePlanWindow();
        });
        await vi.waitFor(() => expect(mocks.planDepartureWindow).toHaveBeenCalledOnce());
        const staleScenario = {
            departureTime: '2026-07-25T00:00:00.000Z',
            arrivalTime: '2026-07-25T12:00:00.000Z',
        } as DepartureScenario;

        act(() => {
            ownedOptions?.onProgress?.({ completed: 1, total: 2, scenarios: [staleScenario] });
        });
        expect(rendered.result.current.windowScenarios).toEqual([staleScenario]);

        act(() => {
            setAuthIdentityScope('account-b');
            ownedOptions?.onProgress?.({ completed: 2, total: 2, scenarios: [staleScenario] });
        });
        expect(rendered.result.current.windowScenarios).toEqual([]);
        expect(rendered.result.current.showWindowSheet).toBe(false);

        final.resolve([staleScenario]);
        await act(async () => {
            await planning;
        });
        expect(rendered.result.current.windowScenarios).toEqual([]);
        rendered.unmount();
    });

    it('rejects delayed date persistence, deep analysis, GPS and map geocoding after transition', async () => {
        const drafts =
            deferred<Array<{ id: string; voyage_name: string; departure_time: string | null; eta: string | null }>>();
        mocks.getDraftVoyages.mockReturnValueOnce(drafts.promise);
        const deep = deferred<never>();
        mocks.deepAnalysis.mockReturnValueOnce(deep.promise);
        const gps = deferred<{
            latitude: number;
            longitude: number;
            accuracy: number;
            altitude: null;
            heading: null;
            speed: number;
            timestamp: number;
        } | null>();
        mocks.gps.mockReturnValueOnce(gps.promise);
        const reverse = deferred<string | null>();
        mocks.reverseGeocode.mockReturnValueOnce(reverse.promise);

        mocks.weather.voyagePlan = plan('analysis');
        const rendered = renderHook(() => useVoyageForm(vi.fn()));
        await primeRouteForm(rendered.result);
        const dateWork = rendered.result.current.handleDateChange('2026-08-01');
        const deepWork = rendered.result.current.handleDeepAnalysis();
        const gpsWork = rendered.result.current.handleOriginLocation({
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        } as never);
        act(() => rendered.result.current.openMap('destination'));
        const mapWork = rendered.result.current.handleMapSelect(-27.1, 153.4, 'WP -27.1');

        await vi.waitFor(() => expect(mocks.getDraftVoyages).toHaveBeenCalledOnce());
        act(() => {
            setAuthIdentityScope('account-b');
        });

        drafts.resolve([
            {
                id: 'private-a',
                voyage_name: 'Account A origin → Account A destination',
                departure_time: '2026-07-24T00:00:00.000Z',
                eta: '2026-07-24T12:00:00.000Z',
            },
        ]);
        deep.resolve({ summary: 'private A' } as never);
        gps.resolve({
            latitude: -27.2,
            longitude: 153.3,
            accuracy: 5,
            altitude: null,
            heading: null,
            speed: 0,
            timestamp: Date.now(),
        });
        reverse.resolve('Private A map selection');
        await act(async () => {
            await Promise.all([dateWork, deepWork, gpsWork, mapWork]);
        });

        expect(mocks.updateVoyage).not.toHaveBeenCalled();
        expect(mocks.weather.saveVoyagePlan).not.toHaveBeenCalled();
        expect(rendered.result.current.origin).toBe('');
        expect(rendered.result.current.destination).toBe('');
        expect(rendered.result.current.deepReport).toBeNull();
        expect(rendered.result.current.analyzingDeep).toBe(false);
        expect(rendered.result.current.isMapOpen).toBe(false);
        rendered.unmount();
    });
});

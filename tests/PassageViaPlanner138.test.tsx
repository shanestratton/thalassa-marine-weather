import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    calculate: vi.fn(),
    direct: vi.fn(),
    stored: vi.fn(),
    clear: vi.fn(),
    boat: 'fixture-boat',
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
vi.mock('../services/routing/constrainedPassage', () => ({ computeConstrainedPassage: mocks.calculate }));
vi.mock('../services/WeatherRoutingService', () => ({
    computeRoute: mocks.direct,
    computeRouteFromPolyline: () => ({
        totalDistance: 12,
        estimatedDuration: 2,
        averageSpeed: 6,
        segments: [],
        maxWindSpeed: 10,
        maxWaveHeight: 0,
    }),
}));
vi.mock('../services/IsochroneRouter', () => ({ isochroneToGeoJSON: vi.fn(), detectTurnWaypoints: vi.fn() }));
vi.mock('../stores/WindStore', () => ({
    WindStore: { getState: () => ({ grid: null, model: 'ecmwf' }), setGrid: vi.fn() },
}));
vi.mock('../stores/PassageStore', () => ({ PassageStore: { clear: mocks.clear, setFromRoute: mocks.stored } }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: null }, activeVesselId: mocks.boat }) },
}));
vi.mock('../services/weather/WindDataController', () => ({ WindDataController: { activate: vi.fn() } }));
vi.mock('../services/ComfortZoneEngine', () => ({
    generateComfortZoneOverlay: vi.fn(),
    hasActiveComfortLimits: () => false,
}));
vi.mock('../components/map/useOffshoreComparison', () => ({
    useOffshoreComparison: () => ({ reset: vi.fn(), view: {} }),
}));
import { usePassagePlanner } from '../components/map/usePassagePlanner';
import { clearPassageRequest, stagePassageRequest } from '../services/passageHandoff';
const origin = { lat: 0, lon: 0, name: 'Origin' },
    via = { lat: 0, lon: 0.1, name: 'Required mark' },
    destination = { lat: 0, lon: 0.2, name: 'Destination' };
const start = '2026-10-17T12:00:00.000Z';
function candidate() {
    const route = [origin, via, destination].map((p, i) => ({
        ...p,
        timeHours: i,
        distance: i * 6,
        bearing: 90,
        speed: 6,
        tws: 10,
        twa: 90,
        parentIndex: null,
    }));
    return {
        result: {
            route,
            routeCoordinates: route.map((p) => [p.lon, p.lat]),
            shallowFlags: [false, false, false],
            isochrones: [],
            totalDistanceNM: 12,
            totalDurationHours: 2,
            arrivalTime: '2026-10-17T14:00:00.000Z',
        },
        points: [origin, via, destination],
        turns: [],
        cells: [],
        polarLabel: 'Fixture polar',
        constraints: [via],
    };
}
function mount() {
    stagePassageRequest({ departure: origin, via: [via], arrival: destination, departureTime: start });
    const routeSource = { setData: vi.fn() },
        waypointSource = { setData: vi.fn() };
    const map = {
        getSource: (id: string) =>
            id === 'route-line' ? routeSource : id === 'waypoints' ? waypointSource : undefined,
        getLayer: vi.fn(),
        removeLayer: vi.fn(),
        removeSource: vi.fn(),
    };
    const hook = renderHook(() => usePassagePlanner({ current: map } as never, false));
    return { ...hook, routeSource };
}
beforeEach(() => {
    vi.clearAllMocks();
    clearPassageRequest();
    mocks.boat = 'fixture-boat';
    mocks.calculate.mockResolvedValue(candidate());
});
afterEach(() => clearPassageRequest());
describe('the actual planner retains its explicit via request', () => {
    it('uses the ordered calculator before either direct shortcut and commits only its final checked line', async () => {
        const hook = mount();
        await act(async () => hook.result.current.computePassage());
        expect(mocks.calculate).toHaveBeenCalledWith(
            expect.objectContaining({ origin, destination, vias: [via], departureTime: start, model: 'ecmwf' }),
        );
        expect(mocks.direct).not.toHaveBeenCalled();
        expect(hook.result.current.routeVerification.status).toBe('verified');
        expect(hook.result.current.isoResultRef.current?.routeCoordinates).toEqual([
            [0, 0],
            [0.1, 0],
            [0.2, 0],
        ]);
        expect(mocks.stored).toHaveBeenCalledOnce();
        expect(
            hook.routeSource.setData.mock.calls
                .at(-1)?.[0]
                .features.every((f: GeoJSON.Feature) => f.properties?.verification === 'verified'),
        ).toBe(true);
    });
    it('leaves an unverified complete preview on any leg refusal, with no direct fallback or saved route', async () => {
        mocks.calculate.mockRejectedValueOnce(Error('A required leg has no chart evidence'));
        const hook = mount();
        await act(async () => hook.result.current.computePassage());
        expect(hook.result.current.routeAnalysis).toBeNull();
        expect(hook.result.current.routeVerification.status).toBe('unverified');
        expect(hook.routeSource.setData.mock.calls.at(-1)?.[0].features[0].geometry.coordinates).toEqual([
            [0, 0],
            [0.1, 0],
            [0.2, 0],
        ]);
        expect(mocks.stored).not.toHaveBeenCalled();
        expect(mocks.direct).not.toHaveBeenCalled();
    });
    it('cannot commit an old completed cohort after the active boat changes', async () => {
        mocks.calculate.mockImplementationOnce(async (request) => {
            mocks.boat = 'different-fixture-boat';
            expect(request.stillCurrent()).toBe(false);
            return candidate();
        });
        const hook = mount();
        await act(async () => hook.result.current.computePassage());
        expect(mocks.stored).not.toHaveBeenCalled();
        expect(hook.result.current.isoResultRef.current).toBeNull();
        expect(hook.result.current.routeVerification.status).not.toBe('verified');
    });
});

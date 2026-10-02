/**
 * The passage planner refuses an inshore route over charted land the way
 * Auto does (review fix-up, 2026-10-02).
 *
 * On the real Whitsunday cells a straight line across Daydream Island (0.3 ×
 * 1.1 km, charted at 1:90,000) passed the satellite land check: the ETOPO
 * pixels read water on the island. The engine's own 25 m charted-land audit
 * saw it, but the engine refuses only a run over 500 m, and the planner never
 * looked at that audit — so a crossing of a small charted island was drawn
 * as a route. Auto refuses any charted land away from a pin's own edge; the
 * planner now does too, before the satellite check, in Auto's words. And a
 * satellite refusal's title follows what the charts say there.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tryInshore: vi.fn(),
    crossesLand: vi.fn(),
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
vi.mock('../services/WeatherRoutingService', () => ({ computeRoute: vi.fn() }));
vi.mock('../services/IsochroneRouter', () => ({
    computeIsochrones: vi.fn(),
    isochroneToGeoJSON: vi.fn(),
    detectTurnWaypoints: vi.fn(),
}));
vi.mock('../services/isochrone/geodesy', () => ({ cumulativeLegs: vi.fn(() => []) }));
vi.mock('../services/BathymetryCache', () => ({ preloadBathymetry: vi.fn() }));
vi.mock('../services/weather/WindFieldAdapter', () => ({ createWindFieldFromGrid: vi.fn() }));
vi.mock('../services/defaultPolar', () => ({ DEFAULT_CRUISING_POLAR: {} }));
vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: { exportToPolarData: vi.fn(() => null) },
}));
vi.mock('../stores/WindStore', () => ({
    WindStore: { getState: vi.fn(() => ({ grid: null })), setGrid: vi.fn() },
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
vi.mock('../services/units', () => ({
    vesselDraftMetres: vi.fn(() => 2.4),
    vesselAirDraftMetres: vi.fn(() => 18.29),
}));
vi.mock('../services/InshoreRouter', () => ({ tryInshoreRoute: mocks.tryInshore }));
vi.mock('../services/routing/landBackstop', () => ({ inshoreRouteCrossesLand: mocks.crossesLand }));

import { usePassagePlanner, type PassageNotice } from '../components/map/usePassagePlanner';
import { clearPassageRequest, stagePassageRequest } from '../services/passageHandoff';

// Coral Sea Marina → Daydream Island, Shane's pins (2026-10-02).
const FROM = { lat: -20.27043, lon: 148.72405, name: 'Coral Sea Marina' };
const TO = { lat: -20.25657, lon: 148.8192, name: 'Daydream Island' };

const route = (extra: Record<string, unknown> = {}) => ({
    polyline: [
        [FROM.lon, FROM.lat],
        [148.8142, -20.2557],
        [TO.lon, TO.lat],
    ] as [number, number][],
    cautionMask: [false, false],
    distanceNM: 5.4,
    elapsedMs: 10,
    cellsUsed: ['AU421148'],
    ...extra,
});

/** A map that answers every call with nothing. */
const fakeMap = (): unknown =>
    new Proxy(
        {},
        {
            get: (target: Record<string | symbol, unknown>, key) => {
                if (!(key in target)) target[key] = vi.fn();
                return target[key];
            },
        },
    );

let notices: (PassageNotice | null)[] = [];
const onNotice = (e: Event) => notices.push((e as CustomEvent<PassageNotice | null>).detail);

async function plan() {
    stagePassageRequest({ departure: FROM, arrival: TO });
    const mapRef = { current: fakeMap() } as never;
    const rendered = renderHook(() => usePassagePlanner(mapRef, false));
    await act(async () => {
        await rendered.result.current.computePassage();
    });
    return rendered;
}

const warnings = () => notices.filter((n): n is PassageNotice => n?.severity === 'warn');

describe('the passage planner refuses charted land, as Auto does', () => {
    beforeEach(() => {
        clearPassageRequest();
        vi.clearAllMocks();
        notices = [];
        window.addEventListener('thalassa:passage-notice', onNotice);
    });
    afterEach(() => {
        window.removeEventListener('thalassa:passage-notice', onNotice);
        clearPassageRequest();
    });

    it('a route over a small charted island the satellite check would pass: refused, saying where', async () => {
        // The satellite check would clear it (its ETOPO pixels read water).
        mocks.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: false,
            runs: [],
            samplesChecked: 3,
            samplesRequested: 3,
        });
        mocks.tryInshore.mockResolvedValue(
            route({ hardLand: { totalM: 380, awayM: 380, awayAt: [148.8142, -20.2557] } }),
        );
        const { result } = await plan();
        expect(warnings()).toEqual([
            {
                severity: 'warn',
                title: 'Inshore route rejected — crosses charted land',
                message:
                    'The only way Thalassa found crosses charted land near 20.256° S, 148.814° E. Falling back to offshore planning.',
            },
        ]);
        expect(mocks.crossesLand).not.toHaveBeenCalled();
        expect(result.current.routeAnalysis).toBeNull();
    });

    it("land at a pin's own edge only: the satellite check decides, and a clear route is drawn", async () => {
        mocks.crossesLand.mockResolvedValue({
            status: 'verified',
            crossesLand: false,
            runs: [],
            samplesChecked: 3,
            samplesRequested: 3,
        });
        mocks.tryInshore.mockResolvedValue(route({ hardLand: { totalM: 40, awayM: 0 } }));
        const { result } = await plan();
        expect(mocks.crossesLand).toHaveBeenCalledOnce();
        expect(mocks.crossesLand.mock.calls[0][1]).toHaveProperty('chartWater');
        expect(warnings().some((n) => /rejected/.test(n.title))).toBe(false);
        expect(result.current.routeAnalysis?.totalDistance).toBe(5.4);
    });

    it("a satellite refusal's title follows what the charts say there", async () => {
        mocks.tryInshore.mockResolvedValue(route({ hardLand: { totalM: 0, awayM: 0 } }));
        const land = (charts: 'land' | 'uncharted') => ({
            status: 'verified',
            crossesLand: true,
            runs: [{ startIdx: 4, samples: 1, lat: -20.2489, lon: 148.8306, charts }],
            samplesChecked: 9,
            samplesRequested: 9,
        });

        mocks.crossesLand.mockResolvedValue(land('land'));
        await plan();
        expect(warnings()).toEqual([
            {
                severity: 'warn',
                title: 'Inshore route rejected — crosses charted land',
                message:
                    'Satellite relief shows land near 20.249° S, 148.831° E, and the installed charts show land or drying ground there too. Unverified reference packs cannot clear this warning. Falling back to offshore planning.',
            },
        ]);

        notices = [];
        mocks.crossesLand.mockResolvedValue(land('uncharted'));
        await plan();
        expect(warnings()[0]?.title).toBe('Inshore route rejected — possible chart gap');
        expect(warnings()[0]?.message).toMatch(/none of the charts used for this route is detailed enough/);
    });
});

/**
 * Plan Your Day's loader (services/dayPlanner/todayLoader.ts, build 124 slice 2).
 *
 * Every source is a fake: the point block, the Queensland atlas (the real
 * Whitsundays tile), OpenStreetMap reference cells, the OSM coastline, the
 * skipper's saved routes, WorldTides, cyclones, and the per-stop route wind
 * and sea. The loader's job is I/O only, so these tests are about what it
 * ASKS for, what it hands the pure engine, and that it stops dead when the
 * sheet closes or the account changes. Nouméa and Fiji sit beside the
 * Whitsundays: the app is global.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/anchorages/CruisingReferenceService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/anchorages/CruisingReferenceService')>()),
    loadReferenceTile: vi.fn(async () => ({ points: [], stale: false })),
}));
vi.mock('../services/TideHeightService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/TideHeightService')>()),
    fetchTideCurve: vi.fn(async () => null),
}));

import { loadReferenceTile } from '../services/anchorages/CruisingReferenceService';
import type { CruisingPoint, ReferenceTile } from '../services/anchorages/cruisingReference';
import { fetchTideCurve, type TideCurve } from '../services/TideHeightService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';
import { ATMOS_VARS, type AtmosVar, type SpreadBlock } from '../services/weather/ModelSpreadService';
import { COMPARE_MODELS } from '../services/weather/forecastModels';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import { FORECAST_TTL_MS, type RouteForecast } from '../services/routeForecastSampler';
import type { RouteSea } from '../services/routeSeaSampler';
import type { RouteSpread } from '../services/routeForecastSpread';
import { pointAlongRoute, routeLengthNm } from '../services/routeProgress';
import type { PassageSpeedModel } from '../services/passagePlan';
import { PASSAGE_MODEL_CHOICES, passageModelChoice } from '../components/passage/PassageModelModal';
import { reachRadiusNm, type AtlasFeature, type LatLon } from '../services/dayPlanner/places';
import { chipDates, dayWindow, planDay, resolveDayPlanLimits } from '../services/dayPlanner/today';
import {
    LEG_DEADLINE_MS,
    PART_DEADLINE_MS,
    TODAY_LOADER_DEPS,
    cycloneNotice,
    isPlanCancelled,
    loadLandingWindow,
    loadStopLegs,
    loadToday,
    placesRadiusNm,
    routeWindModels,
    todayInput,
    type TodayBase,
    type TodayLoaderDeps,
} from '../services/dayPlanner/todayLoader';
import { officialWarningsSource } from '../utils/officialWarningsSource';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';

const H = 3_600_000;
/** 06:30 on Thursday 8 October 2026 at Airlie Beach. */
const NOW = Date.UTC(2026, 9, 7, 20, 30);
const MARINA = { lat: -20.265, lon: 148.719 };
const NOUMEA = { lat: -22.2758, lon: 166.4406 };
const CID_ID = 'osm-node3020491514';
const NARA_ID = 'osm-node2838871153';

const QLD_TILE = JSON.parse(readFileSync('public/anchorages/qld/t-22e148.geojson', 'utf8')) as {
    features: AtlasFeature[];
};

const WIND = routeWindModels(PASSAGE_MODEL_CHOICES, passageModelChoice('ecmwf'));
const SAIL: PassageSpeedModel = {
    mode: 'polar',
    cruiseKts: 6,
    isSail: true,
    polar: DEFAULT_CRUISING_POLAR,
    closeHauledDeg: 40,
};

// ── Fixtures ───────────────────────────────────────────────────

/** The south-east trade at one point: seven members 13–17 kn from about 135°. */
function trade(from = Math.floor(NOW / H) * H, hours = 96): SpreadBlock<AtmosVar> {
    const times = Array.from({ length: hours }, (_, h) => from + h * H);
    return {
        times,
        models: COMPARE_MODELS.map((m, i) => {
            const values = Object.fromEntries(ATMOS_VARS.map((v) => [v, times.map(() => null)])) as Record<
                AtmosVar,
                (number | null)[]
            >;
            values.wind_speed_10m = times.map(() => 13 + (i % 5));
            values.wind_direction_10m = times.map(() => 130 + i * 2);
            values.wind_gusts_10m = times.map(() => (m.missing?.includes('gust') ? null : 18 + (i % 5)));
            values.weather_code = times.map(() => 2);
            return { id: m.id, label: m.label, provider: m.provider, hex: m.hex, values };
        }),
    };
}

function routeForecast(model: string, coords: readonly LatLon[], kts: number, fetchedAt = NOW): RouteForecast {
    const total = routeLengthNm(coords);
    const n = Math.max(2, Math.ceil(total / 4) + 1);
    const from = Math.floor(NOW / H) * H;
    const times = Array.from({ length: 72 }, (_, h) => from + h * H);
    return {
        model,
        fetchedAt,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords as LatLon[], alongNm)!;
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                timesMs: [...times],
                speedKts: times.map(() => kts),
                dirDeg: times.map(() => 135),
                gustKts: times.map(() => kts + 5),
                precipMm: times.map(() => 0),
                precipProb: times.map(() => 0),
            };
        }),
    };
}

function routeSpread(coords: readonly LatLon[], answered = WIND.ids, fetchedAt = NOW): RouteSpread {
    const members: Record<string, RouteForecast> = {};
    answered.forEach((model, i) => (members[model] = routeForecast(model, coords, 14 + i * 0.5, fetchedAt)));
    return {
        asked: [...WIND.ids],
        members,
        missing: WIND.ids.filter((m) => !answered.includes(m)),
        fetchedAt,
    };
}

function routeSea(coords: readonly LatLon[]): RouteSea {
    const total = routeLengthNm(coords);
    const n = Math.max(4, Math.ceil(total / 4) + 1);
    const from = Math.floor(NOW / H) * H;
    const times = Array.from({ length: 72 }, (_, h) => from + h * H);
    return {
        fetchedAt: NOW,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords as LatLon[], alongNm)!;
            const inshore = i === 0 || i === n - 1;
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                snapKm: inshore ? 9 : 3,
                inshore,
                timesMs: [...times],
                waveM: times.map(() => (inshore ? null : 0.5)),
                wavePeriodS: times.map(() => 5),
                waveFromDeg: times.map(() => 130),
                currentKts: times.map(() => 0.2),
                currentSetDeg: times.map(() => 300),
            };
        }),
    };
}

function osmPoint(node: number, name: string, at: LatLon, retrievedAtMs = NOW - H): CruisingPoint {
    return {
        id: `osm-node${node}`,
        kind: 'anchorage',
        name,
        lat: at.lat,
        lon: at.lon,
        colours: [],
        band: null,
        mooringClass: null,
        access: '',
        notes: '',
        source: 'OpenStreetMap',
        sourceUrl: `https://www.openstreetmap.org/node/${node}`,
        retrievedAt: new Date(retrievedAtMs).toISOString(),
        approximate: false,
        restrictionNotes: [],
    };
}

const TIDES = [
    { time: new Date(Date.UTC(2026, 9, 8, 0, 52)).toISOString(), type: 'High' as const, height: 3.1 },
    { time: new Date(Date.UTC(2026, 9, 8, 7, 3)).toISOString(), type: 'Low' as const, height: 0.9 },
];

function cyclone(name: string, at: LatLon): ActiveCyclone {
    const position = { lat: at.lat, lon: at.lon, time: new Date(NOW).toISOString(), windKts: 60, pressureMb: 980 };
    return {
        sid: name,
        name,
        basin: 'SP',
        category: 0,
        categoryLabel: 'TS',
        currentPosition: position,
        track: [position],
        forecastTrack: [],
        maxWindKts: 60,
        minPressureMb: 980,
        nature: 'TS',
    };
}

type Fakes = { [K in keyof TodayLoaderDeps]: ReturnType<typeof vi.fn> & TodayLoaderDeps[K] };

function fakes(over: Partial<TodayLoaderDeps> = {}): Fakes {
    const base: TodayLoaderDeps = {
        now: () => NOW,
        online: () => true,
        querySpread: async () => ({ atmos: trade(), marine: null }),
        loadAtlas: async () => QLD_TILE.features,
        loadReferenceTile: async () => ({ points: [], stale: false }),
        loadCoastline: async () => null,
        savedRoutes: () => [],
        loadTides: async () => ({
            tides: TIDES,
            tideHourly: [],
            tideGUIDetails: { stationName: 'Shute Harbour', isSecondary: false },
        }),
        loadCyclones: async () => [],
        loadRouteSpread: async (coords) => routeSpread(coords),
        loadRouteForecast: async (coords, model) => routeForecast(model, coords, 15),
        loadRouteSea: async (coords) => routeSea(coords),
        loadTideCurve: async () => null,
    };
    const merged = { ...base, ...over };
    return Object.fromEntries(Object.entries(merged).map(([k, f]) => [k, vi.fn(f as never)])) as unknown as Fakes;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
});
afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

// ── The base load ──────────────────────────────────────────────

describe('loadToday: everything about the place, as it arrives', () => {
    it('shows the place, its zone and the light at once, then fills in the weather, places and tides', async () => {
        const deps = fakes();
        const updates: TodayBase[] = [];
        const done = loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps, onUpdate: (b) => updates.push(b) },
        );
        // Synchronously, before any answer: light is worked out on the phone.
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            zone: 'Australia/Brisbane',
            nowMs: NOW,
            weather: 'loading',
            places: null,
            placesStatus: 'loading',
            tidesStatus: 'loading',
        });
        expect(updates[0].start.name).toBe('20.27°S 148.72°E');

        const base = await done;
        expect(base.weather).toBe('ok');
        expect(base.atmos?.models).toHaveLength(COMPARE_MODELS.length);
        expect(base.weatherAtMs).toBe(NOW);
        expect(base.placesStatus).toBe('ok');
        expect(base.places?.candidates.map((c) => c.id)).toContain(CID_ID);
        // Named from the nearest mapped point within half a mile (marinas
        // included); the marina it lies beside feeds the detail's marina line.
        expect(base.start.name).toBe('Airlie Bay');
        expect(base.marina?.name).toBe('Whitsunday Sailing Club');
        expect(base.tides).toEqual(TIDES);
        expect(base.tideStation).toBe('Shute Harbour');
        expect(base.tidesStatus).toBe('ok');
        expect(base.cyclone).toBeNull();
        expect(updates.at(-1)).toEqual(base);
    });

    it('reports the offline atlas at once, while OpenStreetMap and the coastline are still answering', async () => {
        const cell = deferred<{ points: CruisingPoint[]; stale: boolean }>();
        const coast = deferred<null>();
        const deps = fakes({ loadReferenceTile: () => cell.promise, loadCoastline: () => coast.promise });
        const updates: TodayBase[] = [];
        const done = loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps, onUpdate: (b) => updates.push(b) },
        );
        await flush();
        const early = updates.at(-1)!;
        // The stops and the marina's name, before Overpass has said a word.
        expect(early.placesStatus).toBe('loading');
        expect(early.places?.candidates.map((c) => c.id)).toContain(CID_ID);
        expect(early.start.name).toBe('Airlie Bay');
        expect(early.marina?.name).toBe('Whitsunday Sailing Club');
        cell.resolve({ points: [], stale: false });
        coast.resolve(null);
        const base = await done;
        expect(base.placesStatus).toBe('ok');
        expect(base.places?.candidates.map((c) => c.id)).toContain(CID_ID);
    });

    it('with no atlas (worldwide), nothing is reported as places until OpenStreetMap answers', async () => {
        const cell = deferred<{ points: CruisingPoint[]; stale: boolean }>();
        const deps = fakes({ loadAtlas: async () => [], loadReferenceTile: () => cell.promise });
        const updates: TodayBase[] = [];
        const done = loadToday(
            { start: NOUMEA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps, onUpdate: (b) => updates.push(b) },
        );
        await flush();
        expect(updates.every((b) => b.places === null && b.placesStatus === 'loading')).toBe(true);
        cell.resolve({ points: [osmPoint(301, 'Baie fictive', { lat: -22.3, lon: 166.45 })], stale: false });
        expect((await done).places?.candidates.map((c) => c.name)).toEqual(['Baie fictive']);
    });

    it('asks each source once, over the reach any stay could need in the three days shown', async () => {
        const deps = fakes();
        const base = await loadToday({ start: MARINA, cruiseKts: 6 }, { signal: new AbortController().signal, deps });
        expect(base.radiusNm).toBe(30);
        expect(deps.querySpread).toHaveBeenCalledTimes(1);
        expect(deps.querySpread).toHaveBeenCalledWith(MARINA.lat, MARINA.lon);
        expect(deps.loadAtlas).toHaveBeenCalledWith(MARINA.lat, MARINA.lon, 30);
        expect(deps.loadReferenceTile.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(deps.loadReferenceTile.mock.calls.length).toBeLessThanOrEqual(4);
        expect(deps.loadCoastline).toHaveBeenCalledTimes(1);
        expect(deps.loadTides).toHaveBeenCalledWith(MARINA.lat, MARINA.lon);
        expect(deps.loadCyclones).toHaveBeenCalledTimes(1);
        expect(deps.savedRoutes).toHaveBeenCalledWith(getAuthIdentityScope());
        // No route forecasts until the engine names its stops.
        expect(deps.loadRouteSpread).not.toHaveBeenCalled();
        expect(deps.loadRouteSea).not.toHaveBeenCalled();
    });

    it("joins the skipper's own saved route to a stop, so its length is real", async () => {
        const cid = QLD_TILE.features.find((f) => f.properties.id === CID_ID)!.geometry.coordinates;
        const route = {
            name: 'Airlie → Cid',
            points: [MARINA, { lat: -20.29, lon: 148.83 }, { lat: cid[1], lon: cid[0] }],
        };
        const deps = fakes({ savedRoutes: () => [route] });
        const base = await loadToday({ start: MARINA, cruiseKts: 6 }, { signal: new AbortController().signal, deps });
        const stop = base.places!.candidates.find((c) => c.id === CID_ID)!;
        expect(stop.distance.basis).toBe('saved');
        expect(stop.distance.route?.name).toBe('Airlie → Cid');
    });

    it('works anywhere: Nouméa, OpenStreetMap only, its own zone, named by the picker, with a cyclone named', async () => {
        const storm = cyclone('Ula', { lat: -18.0, lon: 170.0 });
        const deps = fakes({
            loadAtlas: async () => [],
            loadReferenceTile: async () => ({
                points: [
                    osmPoint(101, 'Baie de Maa', { lat: -22.2201, lon: 166.3398 }),
                    osmPoint(102, 'Îlot Maître', { lat: -22.3335, lon: 166.4122 }),
                ],
                stale: false,
            }),
            loadCoastline: async () => [],
            loadCyclones: async () => [storm, cyclone('Far', { lat: 10, lon: -150 })],
            loadTides: async () => null,
        });
        const base = await loadToday(
            { start: NOUMEA, cruiseKts: 5, label: 'Port Moselle' },
            { signal: new AbortController().signal, deps },
        );
        expect(base.zone).toBe('Pacific/Noumea');
        expect(base.start.name).toBe('Port Moselle');
        expect(base.places?.candidates.map((c) => c.name).sort()).toEqual(['Baie de Maa', 'Îlot Maître']);
        expect(base.places?.region).toBeNull();
        expect(base.places?.coastlineKnown).toBe(true);
        expect(base.places?.candidates.every((c) => c.fetchLandNM?.length === 36)).toBe(true);
        expect(base.marina).toBeNull();
        expect(base.tides).toBeNull();
        expect(base.tidesStatus).toBe('none');
        expect(base.cyclone).toMatchObject({
            name: 'Ula',
            issuer: officialWarningsSource(NOUMEA.lat, NOUMEA.lon).shortName,
        });
        expect(base.cyclone!.distanceNm).toBeGreaterThan(200);
        expect(base.cyclone!.distanceNm).toBeLessThan(600);
    });

    it('offline: no forecast or cyclone request, but cached places and tides are still read', async () => {
        const mapped = NOW - 21 * 24 * H;
        const deps = fakes({
            online: () => false,
            loadAtlas: async () => [],
            loadReferenceTile: async () => ({
                points: [osmPoint(201, 'Cached Bay', { lat: -20.2, lon: 148.8 }, mapped)],
                stale: true,
            }),
        });
        const updates: TodayBase[] = [];
        const base = await loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps, onUpdate: (b) => updates.push(b) },
        );
        expect(updates[0].weather).toBe('offline');
        expect(base.weather).toBe('offline');
        expect(base.atmos).toBeNull();
        expect(deps.querySpread).not.toHaveBeenCalled();
        expect(deps.loadCyclones).not.toHaveBeenCalled();
        expect(deps.loadReferenceTile).toHaveBeenCalled();
        expect(deps.loadTides).toHaveBeenCalled();
        expect(base.places?.candidates.map((c) => c.name)).toEqual(['Cached Bay']);
        expect(base.places?.mapDataFromMs).toBe(mapped);
        expect(base.tidesStatus).toBe('ok');
    });

    it('a forecast that fails reads "failed", not "offline" and not a good day', async () => {
        for (const querySpread of [
            async () => {
                throw new Error('429');
            },
            async () => ({ atmos: null, marine: null, unreachable: ['atmos' as const, 'marine' as const] }),
        ]) {
            const base = await loadToday(
                { start: MARINA, cruiseKts: 6 },
                { signal: new AbortController().signal, deps: fakes({ querySpread }) },
            );
            expect(base.weather).toBe('failed');
            expect(base.atmos).toBeNull();
            expect(base.weatherAtMs).toBeNull();
        }
    });

    it('when no place source answers, places are unknown — never "no anchorages mapped"', async () => {
        const failing = fakes({
            loadAtlas: async () => {
                throw new Error('offline');
            },
            loadReferenceTile: async () => {
                throw new Error('Worldwide reference providers unavailable');
            },
        });
        const failed = await loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps: failing },
        );
        expect(failed.placesStatus).toBe('failed');
        expect(failed.places).toBeNull();

        let n = 0;
        const partial = fakes({
            loadReferenceTile: async () => {
                if (n++ === 0) throw new Error('timeout');
                return { points: [], stale: false };
            },
        });
        const some = await loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps: partial },
        );
        expect(some.placesStatus).toBe('partial');
        expect(some.places?.candidates.length).toBeGreaterThan(0);
    });

    it('a source that never answers is cut off at the deadline; the rest still arrive', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deps = fakes({ loadTides: () => new Promise(() => {}), loadCoastline: () => new Promise(() => {}) });
        let settled: TodayBase | null = null;
        void loadToday({ start: MARINA, cruiseKts: 6 }, { signal: new AbortController().signal, deps }).then(
            (b) => (settled = b),
        );
        await flush();
        expect(settled).toBeNull();
        await vi.advanceTimersByTimeAsync(PART_DEADLINE_MS + 1);
        await flush();
        expect(settled).not.toBeNull();
        expect(settled!.tidesStatus).toBe('none');
        expect(settled!.weather).toBe('ok');
        // The coastline never came: OpenStreetMap shelter unknown, distances stretched ×1.3.
        expect(settled!.places?.coastlineKnown).toBe(false);
    });

    it('stops dead when the account changes: rejects, and never reports after the switch', async () => {
        const spread = deferred<{ atmos: SpreadBlock<AtmosVar>; marine: null }>();
        const deps = fakes({ querySpread: () => spread.promise });
        const updates: TodayBase[] = [];
        const done = loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: new AbortController().signal, deps, onUpdate: (b) => updates.push(b) },
        );
        await flush();
        const before = updates.length;
        setAuthIdentityScope('account-b');
        spread.resolve({ atmos: trade(), marine: null });
        const error = await done.catch((e) => e);
        expect(isPlanCancelled(error)).toBe(true);
        await flush();
        expect(updates.length).toBe(before);
    });

    it('stops dead when the sheet closes', async () => {
        const spread = deferred<{ atmos: SpreadBlock<AtmosVar>; marine: null }>();
        const deps = fakes({ querySpread: () => spread.promise });
        const updates: TodayBase[] = [];
        const controller = new AbortController();
        const done = loadToday(
            { start: MARINA, cruiseKts: 6 },
            { signal: controller.signal, deps, onUpdate: (b) => updates.push(b) },
        );
        await flush();
        const before = updates.length;
        controller.abort();
        spread.resolve({ atmos: trade(), marine: null });
        expect(isPlanCancelled(await done.catch((e) => e))).toBe(true);
        await flush();
        expect(updates.length).toBe(before);
        // The reference cells were given the signal, so they can stop too.
        const signals = deps.loadReferenceTile.mock.calls.map((c) => c[1] as AbortSignal);
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every((s) => s.aborted)).toBe(true);
    });

    it('asks nothing when the sheet is already closed', async () => {
        const controller = new AbortController();
        controller.abort();
        const deps = fakes();
        expect(
            isPlanCancelled(
                await loadToday({ start: MARINA, cruiseKts: 6 }, { signal: controller.signal, deps }).catch((e) => e),
            ),
        ).toBe(true);
        expect(deps.querySpread).not.toHaveBeenCalled();
        expect(deps.loadAtlas).not.toHaveBeenCalled();
    });

    it('refuses a start that is not a place', async () => {
        await expect(
            loadToday(
                { start: { lat: Number.NaN, lon: 1 }, cruiseKts: 6 },
                { signal: new AbortController().signal, deps: fakes() },
            ),
        ).rejects.toThrow(/position/);
    });
});

// ── The default sources ────────────────────────────────────────

describe('the real sources it is wired to', () => {
    it('asks the reference cells for restriction metadata, with the sheet’s signal', async () => {
        const tile = { key: 'k', west: 148, south: -21, east: 149, north: -20 } as ReferenceTile;
        const signal = new AbortController().signal;
        await TODAY_LOADER_DEPS.loadReferenceTile(tile, signal);
        expect(loadReferenceTile).toHaveBeenCalledWith(tile, signal, { requireRestrictionMetadata: true });
    });

    it('asks the tide curve for three days, as the landing window wants', async () => {
        await TODAY_LOADER_DEPS.loadTideCurve(-20.3, 149, 1, 2);
        expect(fetchTideCurve).toHaveBeenCalledWith(-20.3, 149, 1, 2, { days: 3 });
    });

    it('asks the route spread for the same five models as the passage HUD, so their caches are shared', () => {
        expect(WIND.ids).toEqual(PASSAGE_MODEL_CHOICES.map((c) => c.openMeteoModel));
        expect(WIND.preferred).toBe(passageModelChoice('ecmwf').openMeteoModel);
        expect(WIND.labels[WIND.preferred]).toBe(passageModelChoice('ecmwf').label);
    });
});

// ── The radius ─────────────────────────────────────────────────

describe('placesRadiusNm', () => {
    it('is the longest overnight reach over the three days shown, so switching day or stay never refetches', () => {
        const zone = 'Australia/Brisbane';
        const r = placesRadiusNm(MARINA, zone, NOW, 2);
        const expected = Math.max(
            ...chipDates(NOW, zone, 3).map((date) =>
                reachRadiusNm(2, dayWindow({ date, ...MARINA, zone, nowMs: NOW }).usableH, 'overnight'),
            ),
        );
        expect(r).toBeCloseTo(expected, 6);
        expect(r).toBeGreaterThan(
            reachRadiusNm(2, dayWindow({ date: '2026-10-08', ...MARINA, zone, nowMs: NOW }).usableH, 2),
        );
        expect(placesRadiusNm(MARINA, zone, NOW, 6)).toBe(30);
        expect(placesRadiusNm(MARINA, zone, NOW, 0)).toBe(3);
    });
});

// ── Cyclones ───────────────────────────────────────────────────

describe('cycloneNotice', () => {
    it('measures the real distance, the short way round the antimeridian', () => {
        const fiji = { lat: -17.6, lon: 178.0 };
        // Two degrees east across 180° is near; eight degrees west is far.
        const notice = cycloneNotice(
            [cyclone('West', { lat: -17.6, lon: 170.0 }), cyclone('East', { lat: -17.6, lon: -179.0 })],
            fiji,
        );
        expect(notice?.name).toBe('East');
        expect(notice!.distanceNm).toBeLessThan(200);
        expect(notice!.bearingDeg).toBeGreaterThan(60);
        expect(notice!.bearingDeg).toBeLessThan(120);
    });

    it('says nothing beyond 600 NM, or for a storm with no position', () => {
        expect(cycloneNotice([cyclone('Far', { lat: 0, lon: 160 })], MARINA)).toBeNull();
        expect(cycloneNotice([cyclone('Lost', { lat: Number.NaN, lon: 150 })], MARINA)).toBeNull();
        expect(cycloneNotice([], MARINA)).toBeNull();
    });
});

// ── Route legs ─────────────────────────────────────────────────

const LEG_A = { id: 'a', coords: [MARINA, { lat: -20.2451, lon: 148.9484 }] };
const LEG_B = { id: 'b', coords: [MARINA, { lat: -20.137, lon: 148.912 }] };

describe('loadStopLegs: one leg each way is one leg loaded', () => {
    it('asks one spread and one sea per stop, and heads it with the chart’s own model', async () => {
        const deps = fakes();
        const heard: string[] = [];
        const legs = await loadStopLegs([LEG_A, LEG_B], WIND, {
            signal: new AbortController().signal,
            deps,
            onLegs: (id) => heard.push(id),
        });
        expect(deps.loadRouteSpread).toHaveBeenCalledTimes(2);
        expect(deps.loadRouteSpread).toHaveBeenCalledWith(LEG_A.coords, WIND.ids);
        expect(deps.loadRouteSea).toHaveBeenCalledTimes(2);
        expect(deps.loadRouteForecast).not.toHaveBeenCalled();
        expect(heard.sort()).toEqual(['a', 'b']);
        const a = legs.get('a')!;
        expect(a.headline?.model).toBe(WIND.preferred);
        expect(a.headlineModel).toBe(WIND.labels[WIND.preferred]);
        expect(a.substituted).toBe(false);
        expect(a.spread?.asked).toEqual(WIND.ids);
        expect(a.sea).not.toBeNull();
        expect(a.failed).toBeFalsy();
    });

    it("when the chart's model did not answer, takes the first that did, and names it", async () => {
        const answered = WIND.ids.filter((m) => m !== WIND.preferred);
        const deps = fakes({ loadRouteSpread: async (coords) => routeSpread(coords, answered) });
        const a = (await loadStopLegs([LEG_A], WIND, { signal: new AbortController().signal, deps })).get('a')!;
        expect(a.substituted).toBe(true);
        expect(a.headline?.model).toBe(answered[0]);
        expect(a.headlineModel).toBe(WIND.labels[answered[0]]);
        expect(deps.loadRouteForecast).not.toHaveBeenCalled();
    });

    it('when the spread fails, falls back to the chart’s model alone (the spread is extra)', async () => {
        const deps = fakes({ loadRouteSpread: async () => null });
        const a = (await loadStopLegs([LEG_A], WIND, { signal: new AbortController().signal, deps })).get('a')!;
        expect(deps.loadRouteForecast).toHaveBeenCalledWith(LEG_A.coords, WIND.preferred);
        expect(a.headline?.model).toBe(WIND.preferred);
        expect(a.spread).toBeNull();
        expect(a.substituted).toBe(false);
    });

    it('a stale spread does not stand in for a fresh headline', async () => {
        const old = NOW - FORECAST_TTL_MS - 60_000;
        const deps = fakes({ loadRouteSpread: async (coords) => routeSpread(coords, WIND.ids, old) });
        const a = (await loadStopLegs([LEG_A], WIND, { signal: new AbortController().signal, deps })).get('a')!;
        expect(deps.loadRouteForecast).toHaveBeenCalledTimes(1);
        expect(a.headline?.fetchedAt).toBe(NOW);
        // …and the older range is not shown under the fresher headline.
        expect(a.spread).toBeNull();
    });

    it('when nothing answers, the leg says so', async () => {
        const deps = fakes({
            loadRouteSpread: async () => null,
            loadRouteForecast: async () => null,
            loadRouteSea: async () => null,
        });
        const a = (await loadStopLegs([LEG_A], WIND, { signal: new AbortController().signal, deps })).get('a')!;
        expect(a.failed).toBe(true);
        expect(a.headline).toBeNull();
        expect(a.headlineModel).toBe(WIND.labels[WIND.preferred]);
    });

    it('a leg that never answers is cut off at its deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deps = fakes({ loadRouteSpread: () => new Promise(() => {}), loadRouteSea: () => new Promise(() => {}) });
        let legs: Map<string, unknown> | null = null;
        void loadStopLegs([LEG_A], WIND, { signal: new AbortController().signal, deps }).then((l) => (legs = l));
        await vi.advanceTimersByTimeAsync(LEG_DEADLINE_MS + 1);
        await flush();
        expect(legs).not.toBeNull();
        expect(deps.loadRouteForecast).toHaveBeenCalledTimes(1);
    });

    it('stops dead when the account changes', async () => {
        const spread = deferred<RouteSpread | null>();
        const deps = fakes({ loadRouteSpread: () => spread.promise });
        const heard: string[] = [];
        const done = loadStopLegs([LEG_A], WIND, {
            signal: new AbortController().signal,
            deps,
            onLegs: (id) => heard.push(id),
        });
        await flush();
        setAuthIdentityScope('account-b');
        spread.resolve(routeSpread(LEG_A.coords));
        expect(isPlanCancelled(await done.catch((e) => e))).toBe(true);
        await flush();
        expect(heard).toEqual([]);
    });
});

// ── The landing window ─────────────────────────────────────────

describe('loadLandingWindow', () => {
    const window = dayWindow({ date: '2026-10-08', ...MARINA, zone: 'Australia/Brisbane', nowMs: NOW });
    /** Semi-diurnal, 1.0–3.0 m, high water at 10:52 local (00:52 UTC). */
    const HW = Date.UTC(2026, 9, 8, 0, 52);
    const PERIOD = 12.42 * H;
    const curve: TideCurve = {
        heights: [],
        provenance: 'EXTREMES_INTERP',
        heightAt: (ms) => 2 + Math.cos(((ms - HW) / PERIOD) * 2 * Math.PI),
        rangeMs: [NOW - 48 * H, NOW + 72 * H],
    };

    it('is the mid-to-high stretch that the stay falls in', async () => {
        const deps = fakes({ loadTideCurve: async () => curve });
        const stay = { arriveMs: HW - H, stayEndMs: HW + H };
        const landing = await loadLandingWindow({ lat: -20.27, lon: 149.05 }, window, stay, {
            signal: new AbortController().signal,
            deps,
        });
        expect(landing).not.toBe('no-curve');
        const w = landing as { fromMs: number; toMs: number };
        // A quarter period either side of high water, give or take the sampling step.
        expect(Math.abs(w.fromMs - (HW - PERIOD / 4))).toBeLessThanOrEqual(15 * 60_000);
        expect(Math.abs(w.toMs - (HW + PERIOD / 4))).toBeLessThanOrEqual(15 * 60_000);
        expect(deps.loadTideCurve).toHaveBeenCalledTimes(1);
    });

    it('picks the evening stretch for an evening stay', async () => {
        const deps = fakes({ loadTideCurve: async () => curve });
        const evening = HW + PERIOD;
        const landing = (await loadLandingWindow(
            { lat: -20.27, lon: 149.05 },
            window,
            { arriveMs: evening - 0.5 * H, stayEndMs: evening + 0.5 * H },
            { signal: new AbortController().signal, deps },
        )) as { fromMs: number; toMs: number };
        expect(landing.fromMs).toBeLessThan(evening);
        expect(landing.toMs).toBeGreaterThan(evening);
    });

    it('says "no curve" when no tide prediction answers', async () => {
        const deps = fakes();
        expect(
            await loadLandingWindow({ lat: -20.27, lon: 149.05 }, window, null, {
                signal: new AbortController().signal,
                deps,
            }),
        ).toBe('no-curve');
    });
});

// ── From the loader to the engine ──────────────────────────────

describe("Shane's case through the loader and the engine", () => {
    it('loads, plans, loads the legs it names, and plans again with leave, there and home times', async () => {
        const deps = fakes();
        const signal = new AbortController().signal;
        const base = await loadToday({ start: MARINA, cruiseKts: SAIL.cruiseKts }, { signal, deps });
        const args = {
            stay: '2h' as const,
            limits: resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true),
            speed: SAIL,
            usingDefaultVessel: true,
        };
        const first = planDay(todayInput(base, args));
        expect(first.needsLegs.length).toBeGreaterThan(0);
        expect(first.notices.top?.kind).toBe('default-boat');
        const legs = await loadStopLegs(first.needsLegs, WIND, { signal, deps });
        const view = planDay(todayInput(base, { ...args, legs }));
        expect(view.date).toBe('2026-10-08');
        expect(view.top.map((r) => r.id)).toContain(CID_ID);
        expect(view.notToday.find((r) => r.id === NARA_ID)?.reason).toBe('closed 6–15 Oct (Queensland Parks)');
        for (const row of view.top) expect(row.line2).toMatch(/^Leave \d\d:\d\d · there \d\d:\d\d · home \d\d:\d\d$/);
        expect(view.facts.text).toMatch(/· HW 10:52 · LW 17:03$/);
    });

    it('todayInput passes no tides while they load, and no places when they failed', () => {
        const loading: TodayBase = {
            start: { ...MARINA, name: 'x' },
            zone: 'Australia/Brisbane',
            nowMs: NOW,
            radiusNm: 30,
            weather: 'loading',
            atmos: null,
            weatherAtMs: null,
            places: null,
            placesStatus: 'failed',
            tides: null,
            tideStation: null,
            tidesStatus: 'loading',
            cyclone: null,
            marina: null,
        };
        const input = todayInput(loading, {
            stay: '2h',
            limits: resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true),
            speed: SAIL,
            usingDefaultVessel: true,
            date: '2026-10-09',
            boatFixAgeMs: 7 * H,
        });
        expect(input).toMatchObject({
            nowMs: NOW,
            zone: 'Australia/Brisbane',
            start: { ...MARINA, name: 'x' },
            date: '2026-10-09',
            weather: 'loading',
            places: null,
            tides: null,
            placesStatus: 'failed',
            boatFixAgeMs: 7 * H,
        });
    });
});

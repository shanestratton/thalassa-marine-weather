/**
 * Synthetic sources for Plan Your Day's sheet (build 124, "Today on the
 * water"): the seven-model point block, route wind and sea along a leg, tides
 * and a whole set of fake loader sources. Browser-safe (no node imports), so
 * a dev-server fixture can use it as well as vitest. Fictional data only; the
 * places come from whatever atlas the caller passes (the real Whitsundays
 * tile in the tests, which is public).
 */
import type { CruisingPoint } from '../../services/anchorages/cruisingReference';
import type { AtlasFeature, LatLon } from '../../services/dayPlanner/places';
import type { TodayLoaderDeps } from '../../services/dayPlanner/todayLoader';
import type { RouteForecast } from '../../services/routeForecastSampler';
import type { RouteSea } from '../../services/routeSeaSampler';
import type { RouteSpread } from '../../services/routeForecastSpread';
import { pointAlongRoute, routeLengthNm } from '../../services/routeProgress';
import { ATMOS_VARS, type AtmosVar, type SpreadBlock } from '../../services/weather/ModelSpreadService';
import { COMPARE_MODELS } from '../../services/weather/forecastModels';
import type { Tide } from '../../types/weather';

export const H = 3_600_000;
/** 06:30 on Thursday 8 October 2026 at Airlie Beach (Australia/Brisbane). */
export const NOW = Date.UTC(2026, 9, 7, 20, 30);
export const MARINA = { lat: -20.265, lon: 148.719 };
export const NOUMEA = { lat: -22.2758, lon: 166.4406 };

/** The passage HUD's five route models, by Open-Meteo id. */
export const ROUTE_MODELS = [
    'ecmwf_ifs025',
    'dwd_icon',
    'ecmwf_aifs025_single',
    'ukmo_global_deterministic_10km',
    'jma_gsm',
];

export interface MemberWind {
    kts: number | null;
    dir: number | null;
    gust?: number | null;
    code?: number | null;
}

/** A seven-model point block, hourly from `from`; `wind(model, t)` per member. */
export function pointBlock(
    from: number,
    wind: (model: number, t: number) => MemberWind,
    hours = 96,
): SpreadBlock<AtmosVar> {
    const times = Array.from({ length: hours }, (_, h) => from + h * H);
    return {
        times,
        models: COMPARE_MODELS.map((m, i) => {
            const values = Object.fromEntries(ATMOS_VARS.map((v) => [v, times.map(() => null)])) as Record<
                AtmosVar,
                (number | null)[]
            >;
            const at = times.map((t) => wind(i, t));
            values.wind_speed_10m = at.map((x) => x.kts);
            values.wind_direction_10m = at.map((x) => x.dir);
            // AIFS and JMA publish no gust, as in life.
            values.wind_gusts_10m = at.map((x) =>
                m.missing?.includes('gust') ? null : x.gust === undefined ? (x.kts ?? 0) + 5 : x.gust,
            );
            values.weather_code = at.map((x) => x.code ?? 2);
            return { id: m.id, label: m.label, provider: m.provider, hex: m.hex, values };
        }),
    };
}

/** The south-east trade: seven members 13–17 kn from about 135°. */
export const tradeBlock = (from = Math.floor(NOW / H) * H) =>
    pointBlock(from, (m) => ({ kts: 13 + (m % 5), dir: 130 + m * 2 }));

/** A blow: seven members 28–32 kn from the south-east, all day. */
export const blowBlock = (from = Math.floor(NOW / H) * H) =>
    pointBlock(from, (m) => ({ kts: 28 + (m % 5), dir: 135, gust: 38 }));

export function routeForecast(
    model: string,
    coords: readonly LatLon[],
    kts: number,
    from = Math.floor(NOW / H) * H,
    fetchedAt = NOW,
): RouteForecast {
    const total = routeLengthNm(coords as LatLon[]);
    const n = Math.max(2, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: 96 }, (_, h) => from + h * H);
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

export function routeSpread(coords: readonly LatLon[], kts = 14, from?: number, fetchedAt = NOW): RouteSpread {
    const members: Record<string, RouteForecast> = {};
    ROUTE_MODELS.forEach((model, i) => (members[model] = routeForecast(model, coords, kts + i * 0.5, from, fetchedAt)));
    return { asked: [...ROUTE_MODELS], members, missing: [], fetchedAt };
}

export function routeSea(coords: readonly LatLon[], waveM = 0.5, from = Math.floor(NOW / H) * H): RouteSea {
    const total = routeLengthNm(coords as LatLon[]);
    const n = Math.max(4, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: 96 }, (_, h) => from + h * H);
    return {
        fetchedAt: NOW,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords as LatLon[], alongNm)!;
            // Both ends are inside the reef or at a berth: no reading there.
            const inshore = i === 0 || i === n - 1;
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                snapKm: inshore ? 9 : 3,
                inshore,
                timesMs: [...times],
                waveM: times.map(() => (inshore ? null : waveM)),
                wavePeriodS: times.map(() => 5),
                waveFromDeg: times.map(() => 130),
                currentKts: times.map(() => 0.2),
                currentSetDeg: times.map(() => 300),
            };
        }),
    };
}

export const TIDES: Tide[] = [
    { time: new Date(Date.UTC(2026, 9, 8, 0, 52)).toISOString(), type: 'High', height: 3.1 },
    { time: new Date(Date.UTC(2026, 9, 8, 7, 3)).toISOString(), type: 'Low', height: 0.9 },
    { time: new Date(Date.UTC(2026, 9, 8, 13, 10)).toISOString(), type: 'High', height: 3.0 },
];

/** An OpenStreetMap anchorage node (fictional ids). */
export function osmAnchorage(node: number, name: string, at: LatLon, retrievedAtMs = NOW - H): CruisingPoint {
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

export type DayPlanScenario = 'normal' | 'over' | 'offline' | 'failed';

/**
 * Every source the loader reads, answered at once from synthetic data. The
 * Queensland atlas is whatever the caller passes (the tests read the real
 * Whitsundays tile; a fixture page can fetch it from public/).
 */
export function fakeTodayDeps(
    options: {
        scenario?: DayPlanScenario;
        atlas?: readonly AtlasFeature[];
        osm?: readonly CruisingPoint[];
        tides?: Tide[] | null;
        nowMs?: number;
    } = {},
): TodayLoaderDeps {
    const scenario = options.scenario ?? 'normal';
    const now = options.nowMs ?? NOW;
    const from = Math.floor(now / H) * H;
    const kts = scenario === 'over' ? 30 : 14;
    return {
        now: () => now,
        online: () => scenario !== 'offline',
        querySpread: async () =>
            scenario === 'failed'
                ? { atmos: null, marine: null }
                : { atmos: scenario === 'over' ? blowBlock(from) : tradeBlock(from), marine: null },
        loadAtlas: async () => options.atlas ?? [],
        loadReferenceTile: async () => ({ points: [...(options.osm ?? [])], stale: false }),
        loadCoastline: async () => null,
        savedRoutes: () => [],
        loadTides: async () =>
            options.tides === null
                ? null
                : {
                      tides: options.tides ?? TIDES,
                      tideHourly: [],
                      tideGUIDetails: { stationName: 'Harbour Gauge', isSecondary: false },
                  },
        loadCyclones: async () => [],
        loadRouteSpread: async (coords) => routeSpread(coords, kts, from, now),
        loadRouteForecast: async (coords, model) => routeForecast(model, coords, kts, from, now),
        loadRouteSea: async (coords) => routeSea(coords, 0.5, from),
        loadTideCurve: async () => null,
    };
}

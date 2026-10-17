import { WindStore } from '../stores/WindStore';
import { useSettingsStore } from '../stores/settingsStore';
import { withDeadline } from '../utils/deadline';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import { satelliteModeActive } from './networkPolicy';
import { AVAILABLE_MODELS } from './weather/MultiModelWeatherService';
import { forecastDataCredit, getForecastModelInfo, isConcreteModel } from './weather/forecastModels';
import { loadSelectedImportedGrib } from './weather/localGribImport';
import { sampleImportedGrib, sampleWindGrid } from './weather/importedGribSample';
import { fetchOpenMeteoPoints } from './weather/openMeteoProxy';
import type { WeatherModel } from '../types';
import {
    emptyRouteWeather,
    HOUR,
    ROUTE_WEATHER_QUERY_LIMIT,
    routeWeatherQueryPoint,
    routeWeatherRows,
    type RouteClock,
    type RouteWeatherReport,
    type RouteWeatherSample,
} from './routeMeteogram';

export interface RouteHourlyPayload {
    hourly?: Record<string, unknown[]>;
    hourly_units?: Record<string, string>;
}
const finite = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
/** Exact UTC brackets only. A missing hour is a gap, never a nearest-endpoint forecast. */
export function sampleRouteHourly(payload: RouteHourlyPayload | undefined, atMs: number): RouteWeatherSample {
    const out = emptyRouteWeather(),
        h = payload?.hourly,
        units = payload?.hourly_units;
    const times = h?.time;
    if (
        !times?.length ||
        times.length > 408 ||
        !Number.isFinite(atMs) ||
        !times.every((t, i) => typeof t === 'number' && Number.isFinite(t) && (i === 0 || t > (times[i - 1] as number)))
    )
        return out;
    const seconds = atMs / 1000;
    if (seconds < (times[0] as number) || seconds > (times.at(-1) as number)) return out;
    let a = 0;
    while (a + 1 < times.length && (times[a + 1] as number) <= seconds) a++;
    const exact = seconds === times[a],
        b = exact ? a : a + 1;
    if (b >= times.length || (!exact && (times[b] as number) - (times[a] as number) > 3600)) return out;
    const f = exact ? 0 : (seconds - (times[a] as number)) / ((times[b] as number) - (times[a] as number));
    const linear = (key: string, unit: string, lo: number, hi: number) => {
        if (units?.[key] !== unit) return null;
        const left = finite(h?.[key]?.[a], lo, hi),
            right = finite(h?.[key]?.[b], lo, hi);
        return left === null || right === null ? null : left + (right - left) * f;
    };
    const wind = (i: number) => {
        if (units?.wind_speed_10m !== 'kn' || units.wind_direction_10m !== '°') return null;
        const speed = finite(h?.wind_speed_10m?.[i], 0, 250),
            direction = finite(h?.wind_direction_10m?.[i], 0, 360);
        if (speed === null || (speed > 0 && direction === null)) return null;
        const angle = ((direction ?? 0) * Math.PI) / 180;
        return { u: -speed * Math.sin(angle), v: -speed * Math.cos(angle) };
    };
    const left = wind(a),
        right = wind(b);
    if (left && right) {
        const u = left.u + (right.u - left.u) * f,
            v = left.v + (right.v - left.v) * f;
        out.windKts = Math.hypot(u, v);
        out.windDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
    }
    out.gustKts = linear('wind_gusts_10m', 'kn', 0, 250);
    out.pressureHpa = linear('pressure_msl', 'hPa', 800, 1100);
    return out;
}

/** Explicit action only. Results and precise geometry are never persisted. */
export async function loadRouteMeteogram(
    input: {
        clock: RouteClock;
        identity: string;
        performance: Parameters<typeof routeWeatherRows>[2];
        /** Absent: reuse aboard. Present: separate, explicitly selected online source. */
        downloadModel?: WeatherModel;
    },
    options: { signal: AbortSignal; isCurrent: () => boolean },
): Promise<RouteWeatherReport | null> {
    const scope = getAuthIdentityScope(),
        controller = new AbortController(),
        snapshot = WindStore.getState();
    const online = input.downloadModel !== undefined;
    const cancel = () => controller.abort();
    const current = () =>
        !controller.signal.aborted &&
        isAuthIdentityScopeCurrent(scope) &&
        options.isCurrent() &&
        (online
            ? !satelliteModeActive()
            : (() => {
                  const now = WindStore.getState();
                  return (
                      now.grid === snapshot.grid &&
                      now.model === snapshot.model &&
                      now.field === snapshot.field &&
                      now.localGribPath === snapshot.localGribPath &&
                      now.isGlobalMode === snapshot.isGlobalMode
                  );
              })());
    const guard = () => {
        if (!current()) throw new DOMException('Route weather stopped', 'AbortError');
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    const offAuth = subscribeAuthIdentityScope(cancel);
    const offSettings = useSettingsStore.subscribe(() => {
        if (online && satelliteModeActive()) cancel();
    });
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Route weather stopped', 'AbortError'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
    });
    const work = async (): Promise<RouteWeatherReport> => {
        guard();
        let samples: RouteWeatherSample[] = [],
            source = 'No covered weather aboard',
            credit = '',
            sourceRun: string | null = null,
            note: string | null = null;
        if (online) {
            const model = input.downloadModel;
            if (!isConcreteModel(model)) throw new Error('Choose one named forecast model first.');
            const info = getForecastModelInfo(model)!;
            const cells = new Map<string, { lat: number; lon: number }>();
            for (const p of input.clock.positions) {
                const q = routeWeatherQueryPoint(p);
                cells.set(`${q.lat},${q.lon}`, q);
            }
            if (cells.size > ROUTE_WEATHER_QUERY_LIMIT)
                throw new Error(
                    'This route crosses more than 48 public forecast cells. Use a downloaded GRIB or weather aboard.',
                );
            guard();
            const points = [...cells.values()];
            const days = Math.max(2, Math.min(16, Math.ceil((input.clock.arrivalMs - Date.now()) / (24 * HOUR)) + 1));
            const payloads = await fetchOpenMeteoPoints<RouteHourlyPayload>(
                'forecast',
                points,
                {
                    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl',
                    models: model,
                    wind_speed_unit: 'kn',
                    timeformat: 'unixtime',
                    timezone: 'UTC',
                    forecast_days: days,
                },
                2,
                controller.signal,
            );
            guard();
            const indexed = new Map([...cells.keys()].map((key, i) => [key, payloads[i]]));
            samples = input.clock.positions.map((p) => {
                const q = routeWeatherQueryPoint(p);
                return sampleRouteHourly(indexed.get(`${q.lat},${q.lon}`), p.atMs);
            });
            source = info.label;
            credit = forecastDataCredit([info.provider], 'Data via Open-Meteo') ?? '';
            note =
                'Forecasts sampled in public 0.25° cells. Model run time was not supplied; received time is shown. Gaps stay unknown.';
        } else {
            const imported = await loadSelectedImportedGrib(current);
            guard();
            if (imported) {
                samples = input.clock.positions.map((p) => {
                    const sample = sampleImportedGrib(imported.file, p.lat, p.lon, p.atMs);
                    return {
                        windKts: sample.wind?.speedKts ?? null,
                        windDeg: sample.wind?.directionFromDeg ?? null,
                        gustKts: null,
                        pressureHpa: sample.pressureHpa,
                    };
                });
                const meta = imported.file.source;
                source = 'Imported GRIB';
                sourceRun = imported.file.refTime;
                credit = `GRIB centre ${meta.centre}, subcentre ${meta.subcentre}, process ${meta.process}, table ${meta.parameterTable}. User-supplied source metadata.`;
            } else if (snapshot.grid && !snapshot.grid.importedGrib && snapshot.field === 'wind') {
                samples = input.clock.positions.map((p) => {
                    const sample = sampleWindGrid(snapshot.grid!, p.lat, p.lon, p.atMs);
                    return {
                        ...emptyRouteWeather(),
                        windKts: sample?.speedKts ?? null,
                        windDeg: sample?.directionFromDeg ?? null,
                    };
                });
                const model = AVAILABLE_MODELS.find((m) => m.id === snapshot.model);
                source = `Loaded ${model?.name ?? snapshot.model} wind grid`;
                sourceRun =
                    snapshot.grid.refTime && Number.isFinite(Date.parse(snapshot.grid.refTime))
                        ? snapshot.grid.refTime
                        : null;
                credit =
                    forecastDataCredit(
                        [model?.provider ?? snapshot.model],
                        snapshot.model === 'gfs' ? 'Forecast data' : 'Data via Open-Meteo',
                    ) ?? '';
            } else
                note =
                    'No covered local wind is loaded. Import a GRIB or explicitly download a forecast on a normal connection.';
        }
        guard();
        const clock = input.clock;
        return {
            ownerScope: scope,
            totalDistanceNM: clock.totalDistanceNM,
            departureMs: clock.departureMs,
            arrivalMs: clock.arrivalMs,
            speedKts: clock.speedKts,
            limited: clock.limited,
            identity: input.identity,
            rows: routeWeatherRows(clock, samples, input.performance),
            source,
            sourceRun,
            credit,
            polarLabel: input.performance?.vessel.type === 'sail' ? input.performance.polar.label : null,
            loadedAtMs: Date.now(),
            note,
        };
    };
    try {
        return await withDeadline(Promise.race([work(), stopped]), 20_000, 'Route weather');
    } catch (error) {
        if (!current() || (error instanceof DOMException && error.name === 'AbortError')) return null;
        throw error;
    } finally {
        controller.abort();
        offAuth();
        offSettings();
        options.signal.removeEventListener('abort', cancel);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
}

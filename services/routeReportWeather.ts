/**
 * routeReportWeather — per-waypoint forecast at the ETA you'd reach it.
 *
 * "Weather at each waypoint, at the time we'd be there if we left now" (Shane
 * 2026-07-16). Cumulative great-circle distance ÷ cruising speed gives each
 * waypoint an ETA; one batched Open-Meteo call (all points at once, the proven
 * ConsensusMatrixEngine pattern) returns the hourly wind/gust, sampled at each
 * point's own arrival hour. The waypoint report is wind-first; the shared
 * maximum-conditions helper below also samples marine wave height.
 *
 * Degrades gracefully: no API key / offline / beyond-forecast → the ETAs still
 * come back, just with null weather, so the report always shows the timings.
 */

import { fetchOpenMeteoPoints } from './weather/openMeteoProxy';
import { withDeadline } from '../utils/deadline';
import { createLogger } from '../utils/createLogger';
import { calculateDistance } from '../utils/navigationCalculations';

const log = createLogger('routeReportWeather');

export interface WaypointWeather {
    /** 0-based waypoint index. */
    index: number;
    /** Arrival time (ms) if departing at departureMs and holding speed. */
    etaMs: number;
    /** Hours from departure to this waypoint. */
    hoursFromDep: number;
    /** Cumulative great-circle distance from the start (NM). */
    distanceNM: number;
    windKts: number | null;
    /** Direction the wind blows FROM, degrees true. */
    windDeg: number | null;
    gustKts: number | null;
    /** True when the ETA falls outside the forecast horizon (weather null). */
    beyondForecast: boolean;
}

/**
 * Forecast maxima sampled along a saved route at the ETA for each point.
 * `forecastPoints` is deliberately exposed so UI can distinguish an actual
 * calm forecast from an unavailable/too-distant one.
 */
export interface RouteMaxConditions {
    maxWindKts: number | null;
    maxWaveM: number | null;
    sampledPoints: number;
    forecastPoints: number;
    beyondForecast: boolean;
}

interface LatLon {
    lat: number;
    lon: number;
}

const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** ETA schedule (cumulative distance + arrival time) for the waypoints. */
function schedule(pins: LatLon[], departureMs: number, speedKts: number) {
    const spd = speedKts > 0 ? speedKts : 6;
    let cum = 0;
    return pins.map((p, i) => {
        if (i > 0) cum += calculateDistance(pins[i - 1].lat, pins[i - 1].lon, p.lat, p.lon);
        const hoursFromDep = cum / spd;
        return { index: i, distanceNM: cum, hoursFromDep, etaMs: departureMs + hoursFromDep * 3_600_000 };
    });
}

const nearestHourlyIndex = (times: number[] | undefined, etaMs: number): { index: number; beyond: boolean } | null => {
    if (!times?.length) return null;
    const etaSec = etaMs / 1000;
    let index = 0;
    let delta = Infinity;
    for (let candidate = 0; candidate < times.length; candidate++) {
        const nextDelta = Math.abs(times[candidate] - etaSec);
        if (nextDelta < delta) {
            delta = nextDelta;
            index = candidate;
        }
    }
    // >90 min from an hourly point means the route reaches beyond the
    // provider horizon. Never use the final in-range hour as a pretend
    // forecast for a later arrival.
    return { index, beyond: delta > 5_400 };
};

/** Keep request cost bounded while retaining the true full-route timing. */
function sampledSchedule(pins: LatLon[], departureMs: number, speedKts: number, maximum = 18) {
    const full = schedule(pins, departureMs, speedKts);
    if (full.length <= maximum) return full;
    const indexes = new Set<number>();
    for (let sample = 0; sample < maximum; sample++) {
        indexes.add(Math.round((sample * (full.length - 1)) / (maximum - 1)));
    }
    return Array.from(indexes)
        .sort((left, right) => left - right)
        .map((index) => full[index]);
}

/**
 * Per-waypoint weather at ETA. `speedKts` is the vessel's cruising speed.
 * Never rejects — returns ETA-only rows (null weather) on any failure.
 */
export async function fetchRouteWaypointWeather(
    pins: LatLon[],
    departureMs: number,
    speedKts: number,
): Promise<WaypointWeather[]> {
    if (pins.length === 0) return [];
    const rows = schedule(pins, departureMs, speedKts);
    const etaOnly = (r: (typeof rows)[number]): WaypointWeather => ({
        index: r.index,
        etaMs: r.etaMs,
        hoursFromDep: r.hoursFromDep,
        distanceNM: r.distanceNM,
        windKts: null,
        windDeg: null,
        gustKts: null,
        beyondForecast: false,
    });

    // forecast_days must reach the last ETA — measured from NOW, because the
    // departure may be days out (departure date/time planning, 2026-07-16).
    // Open-Meteo's forecast starts today; unixtime matching finds each ETA's
    // hour inside it. Customer plan caps at 16 days; ETAs beyond the horizon
    // come back beyondForecast=true.
    const lastEtaMs = rows[rows.length - 1]?.etaMs ?? departureMs;
    const days = Math.min(16, Math.max(2, Math.ceil((lastEtaMs - Date.now()) / 86_400_000) + 1));
    try {
        const results = await withDeadline(
            fetchOpenMeteoPoints<{
                hourly?: {
                    time?: number[];
                    wind_speed_10m?: number[];
                    wind_direction_10m?: number[];
                    wind_gusts_10m?: number[];
                };
            }>('forecast', pins, {
                hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
                wind_speed_unit: 'kn',
                timeformat: 'unixtime',
                forecast_days: days,
            }),
            20_000,
            'route weather',
        );
        return rows.map((r) => {
            const hourly = results[r.index]?.hourly;
            const times = hourly?.time;
            const nearest = nearestHourlyIndex(times, r.etaMs);
            if (!nearest) return etaOnly(r);
            return {
                index: r.index,
                etaMs: r.etaMs,
                hoursFromDep: r.hoursFromDep,
                distanceNM: r.distanceNM,
                windKts: nearest.beyond ? null : num(hourly?.wind_speed_10m?.[nearest.index]),
                windDeg: nearest.beyond ? null : num(hourly?.wind_direction_10m?.[nearest.index]),
                gustKts: nearest.beyond ? null : num(hourly?.wind_gusts_10m?.[nearest.index]),
                beyondForecast: nearest.beyond,
            };
        });
    } catch (err) {
        log.warn(`route weather fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return rows.map(etaOnly);
    }
}

/**
 * Maximum wind and wave heights along the *saved* route at the time the
 * vessel reaches each sampled point. The full polyline drives the schedule;
 * only the provider queries are decimated, so a curved passage does not get a
 * straight-line ETA just to save network calls.
 */
export async function fetchRouteMaxConditions(
    pins: LatLon[],
    departureMs: number,
    speedKts: number,
): Promise<RouteMaxConditions> {
    if (pins.length < 2 || !Number.isFinite(departureMs)) {
        return { maxWindKts: null, maxWaveM: null, sampledPoints: 0, forecastPoints: 0, beyondForecast: false };
    }

    const rows = sampledSchedule(pins, departureMs, speedKts);
    const sampledPins = rows.map((row) => pins[row.index]);
    const lastEtaMs = rows[rows.length - 1]?.etaMs ?? departureMs;
    const forecastDays = Math.min(16, Math.max(2, Math.ceil((lastEtaMs - Date.now()) / 86_400_000) + 1));

    type WindResponse = {
        hourly?: {
            time?: number[];
            wind_speed_10m?: number[];
        };
    };
    type WaveResponse = {
        hourly?: {
            time?: number[];
            wave_height?: number[];
        };
    };

    try {
        const [windRows, waveRows] = await Promise.all([
            fetchOpenMeteoPoints<WindResponse>('forecast', sampledPins, {
                hourly: 'wind_speed_10m',
                wind_speed_unit: 'kn',
                timeformat: 'unixtime',
                forecast_days: forecastDays,
            }),
            // The wind report remains useful when the marine provider is
            // temporarily unavailable; don't discard it with the waves.
            fetchOpenMeteoPoints<WaveResponse>('marine', sampledPins, {
                hourly: 'wave_height',
                timeformat: 'unixtime',
                forecast_days: forecastDays,
            }).catch(() => null),
        ]);

        let maxWindKts: number | null = null;
        let maxWaveM: number | null = null;
        let forecastPoints = 0;
        let beyondForecast = false;

        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const wind = windRows[index]?.hourly;
            const windNearest = nearestHourlyIndex(wind?.time, row.etaMs);
            const wave = waveRows?.[index]?.hourly;
            const waveNearest = nearestHourlyIndex(wave?.time, row.etaMs);
            const noForecast = (!windNearest || windNearest.beyond) && (!waveNearest || waveNearest.beyond);
            if (noForecast) {
                beyondForecast ||= Boolean(windNearest?.beyond || waveNearest?.beyond);
                continue;
            }

            let rowHasForecast = false;
            if (windNearest && !windNearest.beyond) {
                const windValue = num(wind?.wind_speed_10m?.[windNearest.index]);
                if (windValue != null) {
                    maxWindKts = maxWindKts == null ? windValue : Math.max(maxWindKts, windValue);
                    rowHasForecast = true;
                }
            } else if (windNearest?.beyond) {
                beyondForecast = true;
            }
            if (waveNearest && !waveNearest.beyond) {
                const waveValue = num(wave?.wave_height?.[waveNearest.index]);
                if (waveValue != null) {
                    maxWaveM = maxWaveM == null ? waveValue : Math.max(maxWaveM, waveValue);
                    rowHasForecast = true;
                }
            } else if (waveNearest?.beyond) {
                beyondForecast = true;
            }
            if (rowHasForecast) forecastPoints += 1;
        }

        return { maxWindKts, maxWaveM, sampledPoints: rows.length, forecastPoints, beyondForecast };
    } catch (err) {
        log.warn(`route maximum conditions fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
            maxWindKts: null,
            maxWaveM: null,
            sampledPoints: rows.length,
            forecastPoints: 0,
            beyondForecast: false,
        };
    }
}

/** Compass point (16-wind) for a FROM-direction in degrees. */
export function windCompass(deg: number): string {
    const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

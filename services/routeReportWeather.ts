/**
 * routeReportWeather — per-waypoint forecast at the ETA you'd reach it.
 *
 * "Weather at each waypoint, at the time we'd be there if we left now" (Shane
 * 2026-07-16). Cumulative great-circle distance ÷ cruising speed gives each
 * waypoint an ETA; one batched Open-Meteo call (all points at once, the proven
 * ConsensusMatrixEngine pattern) returns the hourly wind/gust, sampled at each
 * point's own arrival hour. Wind-only for now — the core marine call.
 *
 * Degrades gracefully: no API key / offline / beyond-forecast → the ETAs still
 * come back, just with null weather, so the report always shows the timings.
 */

import { getOpenMeteoKey } from './weather/keys';
import { withDeadline } from '../utils/deadline';
import { createLogger } from '../utils/createLogger';

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

interface LatLon {
    lat: number;
    lon: number;
}

function haversineNM(a: LatLon, b: LatLon): number {
    const R = 3440.065; // Earth radius in NM
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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
        if (i > 0) cum += haversineNM(pins[i - 1], p);
        const hoursFromDep = cum / spd;
        return { index: i, distanceNM: cum, hoursFromDep, etaMs: departureMs + hoursFromDep * 3_600_000 };
    });
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

    const key = getOpenMeteoKey();
    if (!key) {
        log.warn('no Open-Meteo key — ETAs only, no weather');
        return rows.map(etaOnly);
    }

    // forecast_days must reach the last ETA — measured from NOW, because the
    // departure may be days out (departure date/time planning, 2026-07-16).
    // Open-Meteo's forecast starts today; unixtime matching finds each ETA's
    // hour inside it. Customer plan caps at 16 days; ETAs beyond the horizon
    // come back beyondForecast=true.
    const lastEtaMs = rows[rows.length - 1]?.etaMs ?? departureMs;
    const days = Math.min(16, Math.max(2, Math.ceil((lastEtaMs - Date.now()) / 86_400_000) + 1));
    const lats = pins.map((p) => p.lat.toFixed(4)).join(',');
    const lons = pins.map((p) => p.lon.toFixed(4)).join(',');
    const url =
        `https://customer-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
        `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
        `&wind_speed_unit=kn&timeformat=unixtime&forecast_days=${days}&apikey=${key}`;

    try {
        // CapacitorHttp ignores AbortSignal on native, so bound it in JS.
        const resp = await withDeadline(fetch(url), 20_000, 'route weather');
        if (!resp.ok) {
            log.warn(`Open-Meteo ${resp.status} — ETAs only`);
            return rows.map(etaOnly);
        }
        const data: unknown = await resp.json();
        const results = (Array.isArray(data) ? data : [data]) as Array<{
            hourly?: {
                time?: number[];
                wind_speed_10m?: number[];
                wind_direction_10m?: number[];
                wind_gusts_10m?: number[];
            };
        }>;
        return rows.map((r) => {
            const hourly = results[r.index]?.hourly;
            const times = hourly?.time;
            if (!times || times.length === 0) return etaOnly(r);
            const etaSec = r.etaMs / 1000;
            let bi = 0;
            let bd = Infinity;
            for (let t = 0; t < times.length; t++) {
                const d = Math.abs(times[t] - etaSec);
                if (d < bd) {
                    bd = d;
                    bi = t;
                }
            }
            // >90 min from the nearest forecast hour ⇒ past the horizon.
            const beyond = bd > 5_400;
            return {
                index: r.index,
                etaMs: r.etaMs,
                hoursFromDep: r.hoursFromDep,
                distanceNM: r.distanceNM,
                windKts: beyond ? null : num(hourly?.wind_speed_10m?.[bi]),
                windDeg: beyond ? null : num(hourly?.wind_direction_10m?.[bi]),
                gustKts: beyond ? null : num(hourly?.wind_gusts_10m?.[bi]),
                beyondForecast: beyond,
            };
        });
    } catch (err) {
        log.warn(`route weather fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return rows.map(etaOnly);
    }
}

/** Compass point (16-wind) for a FROM-direction in degrees. */
export function windCompass(deg: number): string {
    const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

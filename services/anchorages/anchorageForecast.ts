/**
 * anchorageForecast — the stay-window forecast the verdict engine eats.
 *
 * One representative point per ranking run (the centre of the candidate
 * set): anchorages within a 50 NM circle share a synoptic wind to the
 * precision this verdict claims, and one forecast call instead of N keeps
 * the ranking instant and the proxy polite. The per-anchorage difference —
 * what the fetch tables encode — is the whole point of the engine; the
 * forecast is the shared sky above them.
 *
 * Window: "tonight" = now → the next useful 09:00 local (see stayWindowMs)
 * — the hours a boat actually swings at anchor, including the pre-dawn
 * shift that does the damage.
 *
 * Swell comes from the marine API and is OPTIONAL by design: offline or on
 * land it returns null fields and the verdict reports "roll unassessed"
 * rather than pretending calm (engine contract).
 */
import { fetchOpenMeteoProxy } from '../weather/openMeteoProxy';
import type { VerdictHour } from './anchorageVerdict';

const KMH_TO_KTS = 0.539957;

interface HourlyBlock {
    time?: string[];
    [k: string]: unknown;
}

const nums = (b: HourlyBlock | undefined, key: string): (number | null)[] =>
    Array.isArray(b?.[key]) ? (b[key] as (number | null)[]) : [];

/**
 * now → the next 09:00 local that is at least 4 h away. Mid-afternoon that
 * is tomorrow morning (the full night); at 03:00 it is dawn THIS morning —
 * a skipper re-ranking at 3 am wants the rest of this night, not the next
 * one; and at 07:00 it rolls to tomorrow (you are planning tonight).
 */
export function stayWindowMs(nowMs: number): { fromMs: number; toMs: number } {
    const to = new Date(nowMs);
    to.setHours(9, 0, 0, 0);
    while (to.getTime() < nowMs + 4 * 3_600_000) to.setDate(to.getDate() + 1);
    return { fromMs: nowMs, toMs: to.getTime() };
}

/**
 * Fetch the stay-window hourly forecast for one point. Wind is required
 * (null result when it fails); swell fields stay undefined when the marine
 * call fails or the point reads as land.
 */
export async function fetchStayWindow(lat: number, lon: number, nowMs = Date.now()): Promise<VerdictHour[] | null> {
    const { fromMs, toMs } = stayWindowMs(nowMs);
    const latStr = lat.toFixed(3);
    const lonStr = lon.toFixed(3);

    const [forecast, marine] = await Promise.allSettled([
        fetchOpenMeteoProxy<{ hourly?: HourlyBlock }>('forecast', {
            latitude: latStr,
            longitude: lonStr,
            hourly: 'wind_speed_10m,wind_direction_10m',
            forecast_days: 3,
            timeformat: 'unixtime',
        }),
        fetchOpenMeteoProxy<{ hourly?: HourlyBlock }>('marine', {
            latitude: latStr,
            longitude: lonStr,
            hourly: 'swell_wave_height,swell_wave_direction,swell_wave_period',
            forecast_days: 3,
            timeformat: 'unixtime',
        }),
    ]);

    const wx = forecast.status === 'fulfilled' ? forecast.value?.hourly : undefined;
    const times = Array.isArray(wx?.time) ? (wx.time as unknown as number[]) : [];
    if (times.length === 0) return null;
    const spd = nums(wx, 'wind_speed_10m');
    const dir = nums(wx, 'wind_direction_10m');

    const sea = marine.status === 'fulfilled' ? marine.value?.hourly : undefined;
    const seaTimes = Array.isArray(sea?.time) ? (sea.time as unknown as number[]) : [];
    const swellH = nums(sea, 'swell_wave_height');
    const swellD = nums(sea, 'swell_wave_direction');
    const swellP = nums(sea, 'swell_wave_period');
    const seaIdx = new Map<number, number>();
    seaTimes.forEach((t, i) => seaIdx.set(t, i));

    const hours: VerdictHour[] = [];
    for (let i = 0; i < times.length; i++) {
        const tMs = times[i] * 1000;
        if (tMs < fromMs - 1_800_000 || tMs > toMs) continue;
        const kts = spd[i];
        const d = dir[i];
        if (kts == null || d == null) continue;
        const h: VerdictHour = { t: tMs, windDirDeg: d, windKts: kts * KMH_TO_KTS };
        const si = seaIdx.get(times[i]);
        if (si != null && swellH[si] != null && swellD[si] != null) {
            h.swellM = swellH[si] as number;
            h.swellDirDeg = swellD[si] as number;
            h.swellPeriodS = (swellP[si] as number | null) ?? undefined;
        }
        hours.push(h);
    }
    return hours.length > 0 ? hours : null;
}

// ── Session cache: several pins tapped in a row share one window fetch ──
const WINDOW_TTL_MS = 5 * 60_000;
let windowCache: { key: string; at: number; promise: Promise<VerdictHour[] | null> } | null = null;

/** fetchStayWindow, memoised ~5 min on a ~6 NM centre grid. */
export function getStayWindowCached(lat: number, lon: number): Promise<VerdictHour[] | null> {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const now = Date.now();
    if (windowCache && windowCache.key === key && now - windowCache.at < WINDOW_TTL_MS) return windowCache.promise;
    const promise = fetchStayWindow(lat, lon).catch(() => null);
    windowCache = { key, at: now, promise };
    return promise;
}

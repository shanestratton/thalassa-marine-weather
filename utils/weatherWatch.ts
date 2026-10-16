/** The small app/Edge contract. No provider URLs, user ids or licensed chart facts in messages. */
export const WEATHER_WATCH_VERSION = 1;
export type WeatherWatchFeature = 'morning' | 'rain' | 'storm' | 'gust';
export interface WeatherWatchNotice {
    feature: WeatherWatchFeature;
    boatId: string;
    revision: string;
    expiresAt: number;
}
/** Fixed handoff/expiry contract for phone and APNs delivery; never follows an incoming URL. */
export function parseWeatherWatchNotice(value: unknown, now: number): WeatherWatchNotice | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>,
        uuid = (v: unknown): v is string =>
            typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
    if (
        data.weather_watch !== 1 ||
        !['morning', 'rain', 'storm', 'gust'].includes(String(data.feature)) ||
        !uuid(data.boat_id) ||
        !uuid(data.revision) ||
        typeof data.expires !== 'string'
    )
        return null;
    const expiresAt = Date.parse(data.expires);
    return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 3_600_000
        ? { feature: data.feature as WeatherWatchFeature, boatId: data.boat_id, revision: data.revision, expiresAt }
        : null;
}
export interface WeatherWatchSample {
    key: string;
    kind: 'boat' | 'spot' | 'route';
    label: string;
    lat: number;
    lon: number;
    /** Boat fix clock or explicit sample-authorization clock; never restamped on read. */
    sourceAt: number;
    expiresAt: number;
}
export interface WeatherWatchPreferences {
    morning: boolean;
    rain: boolean;
    storm: boolean;
    gust: boolean;
    hour: number;
    zone: string;
    gustKts: number | null;
    samples: WeatherWatchSample[];
}
export const defaultWeatherWatch = (): WeatherWatchPreferences => ({
    morning: false,
    rain: false,
    storm: false,
    gust: false,
    hour: 7,
    zone: 'UTC',
    gustKts: null,
    samples: [],
});
export interface WeatherWatchCapability {
    functionVersion: number;
    deliveryVersion: number;
    scheduled: boolean;
    /** Independently verified account/provider permission, not merely key presence. */
    entitlementUntil: number | null;
    succeededAt: number | null;
}
export const weatherWatchReady = (
    feature: WeatherWatchFeature,
    cap: WeatherWatchCapability | null,
    now: number,
): boolean =>
    !!cap &&
    cap.functionVersion === WEATHER_WATCH_VERSION &&
    cap.deliveryVersion === WEATHER_WATCH_VERSION &&
    cap.scheduled === true &&
    cap.entitlementUntil !== null &&
    cap.entitlementUntil > now &&
    cap.succeededAt !== null &&
    // Service heartbeat metadata allows one second of client/server clock skew;
    // original sensor/model clocks elsewhere are not relaxed or restamped.
    cap.succeededAt <= now + 1000 &&
    now - cap.succeededAt <= (feature === 'rain' ? 15 * 60_000 : 2 * 3_600_000);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, n: number): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= n && !/\p{Cc}/u.test(v);
export function parseWeatherWatchPreferences(value: unknown, now: number): WeatherWatchPreferences | null {
    if (
        !object(value) ||
        Object.keys(value).sort().join(',') !== 'gust,gustKts,hour,morning,rain,samples,storm,zone' ||
        !['morning', 'rain', 'storm', 'gust'].every((key) => typeof value[key] === 'boolean') ||
        !Number.isInteger(value.hour) ||
        !finite(value.hour) ||
        value.hour < 0 ||
        value.hour > 23 ||
        !text(value.zone, 80) ||
        (value.zone !== 'UTC' && !value.zone.includes('/')) ||
        !Array.isArray(value.samples) ||
        value.samples.length > 16 ||
        !(value.gustKts === null || (finite(value.gustKts) && value.gustKts >= 1 && value.gustKts <= 200)) ||
        (value.gust && value.gustKts === null)
    )
        return null;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value.zone });
    } catch {
        return null;
    }
    const keys = new Set<string>();
    for (const sample of value.samples) {
        if (
            !object(sample) ||
            Object.keys(sample).sort().join(',') !== 'expiresAt,key,kind,label,lat,lon,sourceAt' ||
            !text(sample.key, 64) ||
            !/^[a-zA-Z0-9:_-]+$/.test(sample.key) ||
            keys.has(sample.key) ||
            !['boat', 'spot', 'route'].includes(String(sample.kind)) ||
            !text(sample.label, 64) ||
            !finite(sample.lat) ||
            Math.abs(sample.lat) > 90 ||
            !finite(sample.lon) ||
            Math.abs(sample.lon) > 180 ||
            !Number.isSafeInteger(sample.sourceAt) ||
            !finite(sample.sourceAt) ||
            sample.sourceAt <= 0 ||
            sample.sourceAt > now ||
            !Number.isSafeInteger(sample.expiresAt) ||
            !finite(sample.expiresAt) ||
            sample.expiresAt <= sample.sourceAt ||
            sample.expiresAt - sample.sourceAt >
                (sample.kind === 'boat' ? 15 * 60_000 : sample.kind === 'route' ? 48 * 3_600_000 : 30 * 86_400_000)
        )
            return null;
        keys.add(sample.key);
    }
    if (value.samples.filter((sample) => sample.kind === 'boat').length > 1) return null;
    return value as unknown as WeatherWatchPreferences;
}
export function weatherWatchLocalSlot(now: number, zone: string): { day: string; hour: number; minute: number } | null {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const get = (key: string) => parts.find((part) => part.type === key)?.value ?? '';
        return {
            day: `${get('year')}-${get('month')}-${get('day')}`,
            hour: Number(get('hour')),
            minute: Number(get('minute')),
        };
    } catch {
        return null;
    }
}
export interface RainArrival {
    from: number;
    sourceAt: number;
    expiresAt: number;
}
export function validRainPayload(value: unknown, lat: number, lon: number, now: number): boolean {
    if (
        !object(value) ||
        !finite(value.latitude) ||
        !finite(value.longitude) ||
        Math.abs(value.latitude - lat) > 0.001 ||
        Math.abs(value.longitude) > 180 ||
        Math.abs(value.latitude) > 90 ||
        Math.abs(((value.longitude - lon + 540) % 360) - 180) > 0.001 ||
        !Array.isArray(value.forecast) ||
        !value.forecast.length ||
        value.forecast.length > 300
    )
        return false;
    let end = 0,
        coversNow = false;
    for (const row of value.forecast) {
        if (
            !object(row) ||
            !finite(row.timestampBegin) ||
            !Number.isSafeInteger(row.timestampBegin) ||
            !finite(row.timestampEnd) ||
            !Number.isSafeInteger(row.timestampEnd) ||
            !finite(row.precipRate) ||
            row.precipRate < 0 ||
            row.precipRate > 1000 ||
            !['rain', 'mixed', 'snow', 'no_precipitation'].includes(String(row.precipType))
        )
            return false;
        const from = row.timestampBegin * 1000,
            to = row.timestampEnd * 1000;
        if (
            to <= from ||
            to - from > 600_000 ||
            from < now - 30 * 60_000 ||
            to > now + 4 * 3_600_000 + 600_000 ||
            (end && from !== end)
        )
            return false;
        end = to;
        coversNow ||= from <= now && to > now;
    }
    return coversNow;
}
/** Require a current dry interval followed by two contiguous wet intervals. Unknowns break continuity. */
export function rainArrival(value: unknown, retrievedAt: number, now: number): RainArrival | null {
    if (
        !object(value) ||
        !finite(retrievedAt) ||
        retrievedAt > now ||
        now - retrievedAt > 10 * 60_000 ||
        !Array.isArray(value.forecast) ||
        value.forecast.length > 300
    )
        return null;
    let end = 0,
        dry = false,
        wet = 0,
        onset = 0,
        sourceAt = 0;
    for (const raw of value.forecast) {
        if (
            !object(raw) ||
            !Number.isSafeInteger(raw.timestampBegin) ||
            !finite(raw.timestampBegin) ||
            !Number.isSafeInteger(raw.timestampEnd) ||
            !finite(raw.timestampEnd) ||
            !finite(raw.precipRate) ||
            raw.precipRate < 0 ||
            raw.precipRate > 1000
        )
            return null;
        const from = raw.timestampBegin * 1000,
            to = raw.timestampEnd * 1000;
        if (to <= from || to - from > 10 * 60_000 || (end && from !== end)) return null;
        end = to;
        if (to <= now) continue;
        if (!sourceAt) {
            if (from > now || now - from > 10 * 60_000) return null;
            sourceAt = from;
        }
        if (!['rain', 'mixed', 'snow', 'no_precipitation'].includes(String(raw.precipType))) return null;
        if (raw.precipRate < 0.3 || raw.precipType === 'snow' || raw.precipType === 'no_precipitation') {
            dry = true;
            wet = 0;
        } else if (dry) {
            if (!wet) onset = from;
            if (++wet >= 2 && onset >= now && onset - now <= 30 * 60_000)
                return { from: onset, sourceAt, expiresAt: Math.min(onset + 10 * 60_000, now + 30 * 60_000) };
        } else return null; // Already wet: cannot call it "arriving".
    }
    return null;
}

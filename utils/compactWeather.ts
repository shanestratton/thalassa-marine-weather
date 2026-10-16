/** Small, versioned forecast transport shared by the Edge producer and app.
 * Exact source times and explicit nulls survive compression. No offset from
 * the phone's clock is used to reconstruct a forecast's validity time. */
type Reading = number | null;
export interface CompactCurrent {
    temperature: Reading;
    feelsLike: Reading;
    humidity: Reading;
    pressure: Reading;
    windSpeed: Reading;
    windDirection: Reading;
    windGust: Reading;
    condition: string;
    cloudCover: Reading;
    visibility: Reading;
    uvIndex: Reading;
    precipitation: Reading;
    dewPoint: Reading;
    isDay: boolean | null;
}
export interface CompactHour {
    time: string;
    temperature: Reading;
    windSpeed: Reading;
    windDirection: Reading;
    windGust: Reading;
    precipitation: Reading;
    precipProbability: Reading;
    condition: string;
    pressure: Reading;
    cloudCover: Reading;
    humidity: Reading;
    uvIndex?: Reading;
    visibility?: Reading;
}
export interface CompactDay {
    date: string;
    tempMax: Reading;
    tempMin: Reading;
    windSpeedMax: Reading;
    windGustMax: Reading;
    condition: string;
    precipSum: Reading;
    precipProbability: Reading;
    sunrise: string;
    sunset: string;
    uvIndexMax: Reading;
}
export interface CompactSource {
    provider: 'rainbow+openmeteo' | 'weatherkit';
    timestamp: string;
    coordinates: { lat: number; lon: number };
    timezone: string;
    isPremium: boolean;
    current: CompactCurrent;
    hourly: CompactHour[];
    daily: CompactDay[];
    nowcast?: { minutes: { time: string; intensity: number; precipType?: string }[]; summary: string };
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const CURRENT_KEYS = {
    temperature: 't',
    feelsLike: 'f',
    humidity: 'h',
    pressure: 'p',
    windSpeed: 'w',
    windDirection: 'd',
    windGust: 'g',
    cloudCover: 'c',
    visibility: 'v',
    uvIndex: 'u',
    precipitation: 'r',
    dewPoint: 'dp',
} as const;
const HOUR_KEYS = {
    temperature: 't',
    windSpeed: 'w',
    windDirection: 'd',
    windGust: 'g',
    precipitation: 'r',
    precipProbability: 'pp',
    pressure: 'p',
    cloudCover: 'c',
    humidity: 'h',
    uvIndex: 'u',
    visibility: 'v',
} as const;
const DAY_KEYS = {
    tempMax: 'hi',
    tempMin: 'lo',
    windSpeedMax: 'w',
    windGustMax: 'g',
    precipSum: 'r',
    precipProbability: 'pp',
    uvIndexMax: 'u',
} as const;
function packNumbers(source: object, keys: Record<string, string>): Obj {
    const row = source as Obj;
    return Object.fromEntries(
        Object.entries(keys).map(([field, short]) => {
            const value = row[field];
            return [short, typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null];
        }),
    );
}
function unpackNumbers(row: Obj, keys: Record<string, string>): Obj {
    const entries = Object.entries(keys).map(([field, short]) => {
        const value = row[short];
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
            throw Error('Invalid compact reading');
        return [field, value];
    });
    return Object.fromEntries(entries);
}
const epoch = (time: string): number => {
    const n = Date.parse(time);
    if (!Number.isFinite(n) || !/^\d{4}-\d\d-\d\dT/.test(time) || !/Z$|[+-]\d\d:\d\d$/.test(time))
        throw Error('Invalid source time');
    return Math.floor(n / 1000);
};
const iso = (v: unknown): string => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 253402300799)
        throw Error('Invalid compact time');
    return new Date(v * 1000).toISOString();
};
const condition = (v: unknown): string => {
    if (typeof v !== 'string' || v.length > 128) throw Error('Invalid compact condition');
    return v;
};
const sunTime = (value: string): string => (value ? iso(epoch(value)) : '');
const validDate = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;

export function minifyWeather(source: CompactSource, now = Date.now()): Obj {
    const start = Math.floor(now / 3_600_000) * 3_600_000;
    return {
        v: 2,
        p: source.provider === 'weatherkit' ? 'wk' : 'rb',
        ts: epoch(source.timestamp),
        lat: source.coordinates.lat,
        lon: source.coordinates.lon,
        tz: source.timezone,
        premium: source.isPremium,
        c: {
            ...packNumbers(source.current, CURRENT_KEYS),
            code: condition(source.current.condition),
            day: source.current.isDay,
        },
        h: source.hourly
            .map((h) => ({ h, at: epoch(h.time) }))
            .filter(({ at }) => at * 1000 >= start)
            .slice(0, 24)
            .map(({ h, at }) => ({
                at,
                ...packNumbers(h, HOUR_KEYS),
                code: condition(h.condition),
            })),
        d: source.daily.slice(0, 5).map((d) => ({
            date: d.date,
            ...packNumbers(d, DAY_KEYS),
            code: condition(d.condition),
            rise: sunTime(d.sunrise),
            set: sunTime(d.sunset),
        })),
        ...(source.nowcast
            ? {
                  n: {
                      summary: source.nowcast.summary.slice(0, 160),
                      m: source.nowcast.minutes
                          .filter((_, i) => i % 10 === 0)
                          .slice(0, 6)
                          .map((m) => ({
                              at: epoch(m.time),
                              r: Number.isFinite(m.intensity) ? Math.round(m.intensity * 10) / 10 : null,
                          })),
                  },
              }
            : {}),
    };
}

/** Legacy compact v1 omitted valid times and could turn missing wind into0.
 * Reject it; Satellite Mode never retries a full-size WAN response. */
export function expandMinifiedWeather(raw: unknown, lat: number, lon: number, now = Date.now()): CompactSource | null {
    try {
        if (
            !object(raw) ||
            raw.v !== 2 ||
            !['wk', 'rb'].includes(String(raw.p)) ||
            typeof raw.lat !== 'number' ||
            typeof raw.lon !== 'number' ||
            !Number.isFinite(raw.lat) ||
            !Number.isFinite(raw.lon) ||
            Math.abs(raw.lat - lat) > 0.00011 ||
            Math.abs(raw.lon - lon) > 0.00011 ||
            Math.abs(raw.lat) > 90 ||
            Math.abs(raw.lon) > 180 ||
            typeof raw.tz !== 'string' ||
            raw.tz.length > 80 ||
            typeof raw.premium !== 'boolean' ||
            !object(raw.c) ||
            !Array.isArray(raw.h) ||
            raw.h.length < 1 ||
            raw.h.length > 24 ||
            !Array.isArray(raw.d) ||
            raw.d.length < 1 ||
            raw.d.length > 5
        )
            return null;
        const timestamp = iso(raw.ts);
        if (now - Date.parse(timestamp) > 90 * 60_000 || Date.parse(timestamp) - now > 5 * 60_000) return null;
        if (raw.c.day !== null && typeof raw.c.day !== 'boolean') return null;
        const current = {
            ...unpackNumbers(raw.c, CURRENT_KEYS),
            condition: condition(raw.c.code),
            isDay: raw.c.day,
        } as unknown as CompactCurrent;
        const hourly = raw.h.map((h) => {
            if (!object(h)) throw Error('Invalid compact hour');
            return {
                ...unpackNumbers(h, HOUR_KEYS),
                time: iso(h.at),
                condition: condition(h.code),
            } as unknown as CompactHour;
        });
        if (
            !hourly.every(
                (h, i) =>
                    Date.parse(h.time) % 3_600_000 === 0 &&
                    (!i || Date.parse(h.time) - Date.parse(hourly[i - 1].time) === 3_600_000),
            )
        )
            return null;
        const firstHour = Date.parse(hourly[0].time);
        const nowHour = Math.floor(now / 3_600_000) * 3_600_000;
        if (firstHour < nowHour - 3_600_000 || firstHour > nowHour + 3_600_000) return null;
        const daily = raw.d.map((d) => {
            if (
                !object(d) ||
                !validDate(d.date) ||
                typeof d.rise !== 'string' ||
                d.rise.length > 40 ||
                typeof d.set !== 'string' ||
                d.set.length > 40
            )
                throw Error('Invalid compact day');
            return {
                ...unpackNumbers(d, DAY_KEYS),
                date: d.date,
                condition: condition(d.code),
                sunrise: sunTime(d.rise),
                sunset: sunTime(d.set),
            } as unknown as CompactDay;
        });
        if (!daily.every((d, i) => !i || Date.parse(d.date) - Date.parse(daily[i - 1].date) === 86_400_000))
            return null;
        let nowcast: CompactSource['nowcast'];
        if (raw.n !== undefined) {
            if (
                !object(raw.n) ||
                typeof raw.n.summary !== 'string' ||
                raw.n.summary.length > 160 ||
                !Array.isArray(raw.n.m) ||
                raw.n.m.length > 6
            )
                return null;
            const minutes = raw.n.m.map((m) => {
                if (!object(m) || typeof m.r !== 'number' || !Number.isFinite(m.r) || m.r < 0)
                    throw Error('Invalid nowcast');
                return { time: iso(m.at), intensity: m.r };
            });
            nowcast = { summary: raw.n.summary, minutes };
        }
        return {
            provider: raw.p === 'wk' ? 'weatherkit' : 'rainbow+openmeteo',
            timestamp,
            coordinates: { lat: raw.lat, lon: raw.lon },
            timezone: raw.tz,
            isPremium: raw.premium,
            current,
            hourly,
            daily,
            ...(nowcast ? { nowcast } : {}),
        };
    } catch {
        return null;
    }
}

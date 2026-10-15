/**
 * meteogramModel — the pure half of the point meteogram (131-02): one spot's
 * next seven days, lined up hour by hour for the four stacked panels the
 * Meteogram draws (wind and gusts, waves and period, rain, pressure).
 *
 * EPOCH HOURS. Every series sits on one grid of UTC epoch hours
 * (floor(ms / 1 h)), never matched by array index or by a time string: the
 * report's hours and the model comparison's come from different requests,
 * and the report itself mixes zoned stamps ('…T17:00:00Z', WeatherKit) with
 * bare ones ('…T17:00', Open-Meteo, at the report's one fixed offset).
 *
 * NO INTERPOLATION. A missing hour stays missing: lines break across it
 * (runs()), and where a series stops for good the panel marks the rest of
 * the week as beyond the forecast (forecastEnd()) instead of drawing on.
 *
 * Times are the place's clock by default and the phone's on the toggle;
 * night is wherever the sun is below the horizon at the spot.
 */
import type { HourlyForecast } from '../../types';
import type { AtmosVar, SpreadBlock } from '../../services/weather/ModelSpreadService';
import { sunAltitudeDeg, wallClock } from '../../utils/celestial';
import { tendencyLabel } from '../../utils/barometerTendency';

export const HOUR_MS = 3_600_000;
/** Seven days, from the start of the hour now is in. */
export const METEOGRAM_HOURS = 168;
/** The fall that matters at sea, 3 hPa in 3 h (utils/barometerTendency). */
export const FAST_FALL_HPA = 3;
/** An hour needs this many models before it has a spread to draw. */
export const SPREAD_MIN_MODELS = 2;
/** The sun's centre at sunrise and sunset, refraction and its radius allowed for. */
const SUNSET_ALTITUDE_DEG = -0.833;

export type HourValues = (number | null)[];
export type SeriesKey = 'wind' | 'gust' | 'wave' | 'period' | 'rain' | 'rainChance' | 'pressure';

const PICK: Record<SeriesKey, (h: HourlyForecast) => unknown> = {
    wind: (h) => h.windSpeed,
    gust: (h) => h.windGust,
    wave: (h) => h.waveHeight,
    // The total sea's mean period, whatever the field's name (W1-07).
    period: (h) => h.swellPeriod,
    rain: (h) => h.precipitation,
    rainChance: (h) => h.precipChance,
    pressure: (h) => h.pressure,
};
const KEYS = Object.keys(PICK) as SeriesKey[];

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const epochHour = (ms: number): number => Math.floor(ms / HOUR_MS);

/** How a timestamp with no zone reads: at the report's fixed offset, or on the phone's clock without one. */
export interface BareClock {
    utcOffsetSeconds?: number;
}

const BARE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** Epoch ms of a forecast hour's stamp; NaN when it is not a time. */
export function forecastTimeMs(time: string | null | undefined, clock: BareClock = {}): number {
    const text = typeof time === 'string' ? time.trim() : '';
    const bare = BARE_TIME.exec(text);
    if (!bare) return text ? Date.parse(text) : NaN;
    const [y, mo, d, h, mi] = bare.slice(1).map(Number);
    const offset = clock.utcOffsetSeconds;
    if (offset != null && Number.isFinite(offset)) return Date.UTC(y, mo - 1, d, h, mi) - offset * 1000;
    // Neither: the phone's clock, as new Date() reads it everywhere else.
    return new Date(y, mo - 1, d, h, mi).getTime();
}

/** A zone's offset from UTC at an instant, in seconds, east positive. */
export function zoneOffsetSeconds(ms: number, timeZone?: string): number {
    const w = wallClock(ms, timeZone);
    return Math.round((Date.UTC(w[0], w[1] - 1, w[2], w[3], w[4], w[5]) - Math.floor(ms / 1000) * 1000) / 1000);
}

/**
 * How the report's bare stamps read: always at the ONE offset the report
 * names, never on the zone's daylight-saving rules. Open-Meteo writes its
 * whole time array at the utc_offset_seconds in force when it answered, so
 * across a clock change the stamps run on, one an hour, with no hour doubled
 * or skipped (checked live 2026-10-15: Marseille across 25 Oct, 72 stamps,
 * each its unixtime twin plus 7200 s; tests/meteogramModel.test.ts keeps the
 * capture). Read on the zone's rules, every hour after the change landed an
 * hour off (131-02 review). The rest of the app reads them the same way
 * (WeatherWindowService.toUtcIso, the StormGlass hybrid merge); the place's
 * zone is for SHOWING the times. The StormGlass transformer hands the offset
 * over in HOURS, so a small one is taken as hours. A report with no offset
 * carries zoned stamps only (WeatherKit), or is read as the rest of the app
 * reads it.
 */
export function bareClock(utcOffset?: number): BareClock {
    if (utcOffset == null || !Number.isFinite(utcOffset)) return {};
    return { utcOffsetSeconds: Math.abs(utcOffset) <= 14 ? utcOffset * 3600 : utcOffset };
}

export interface MeteogramGrid {
    /** The first hour drawn, epoch ms on an hour boundary. */
    startMs: number;
    hours: number;
    series: Record<SeriesKey, HourValues>;
}

/**
 * The report's hours on the meteogram's epoch-hour grid. An hour the report
 * does not carry, or carries without a number, stays null; when two samples
 * fall in one hour the first one's numbers stand.
 */
export function alignHourly(
    hourly: HourlyForecast[] | null | undefined,
    startMs: number,
    hours = METEOGRAM_HOURS,
    clock: BareClock = {},
): MeteogramGrid {
    const first = epochHour(startMs);
    const series = Object.fromEntries(KEYS.map((k) => [k, new Array<number | null>(hours).fill(null)])) as Record<
        SeriesKey,
        HourValues
    >;
    for (const h of hourly ?? []) {
        const i = epochHour(forecastTimeMs(h?.time, clock)) - first;
        if (!(i >= 0 && i < hours)) continue;
        for (const k of KEYS) if (series[k][i] === null) series[k][i] = finite(PICK[k](h));
    }
    return { startMs: first * HOUR_MS, hours, series };
}

/** The unbroken stretches of a series, first and last hour inclusive. */
export function runs(values: HourValues): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    values.forEach((v, i) => {
        if (v === null) return;
        const last = out[out.length - 1];
        if (last && last.to === i - 1) last.to = i;
        else out.push({ from: i, to: i });
    });
    return out;
}

/**
 * The hour the forecast runs out: one past the last hour any of these series
 * has a number for. Null when it reaches the end of the week, 0 when there
 * is nothing at all. A gap with numbers after it is a gap, not the end.
 */
export function forecastEnd(hours: number, ...series: HourValues[]): number | null {
    let last = -1;
    for (const s of series) {
        for (let i = Math.min(s.length, hours) - 1; i > last; i--) {
            if (s[i] !== null) {
                last = i;
                break;
            }
        }
    }
    return last + 1 >= hours ? null : last + 1;
}

/** The first hour a series is at or over a limit, or null. */
export function firstAtOrOver(values: HourValues, limit: number): number | null {
    const i = values.findIndex((v) => v !== null && v >= limit);
    return i < 0 ? null : i;
}

export interface SpreadBand {
    /** The lowest and highest model wind each hour (knots); null under SPREAD_MIN_MODELS. */
    lo: HourValues;
    hi: HourValues;
    /** The models with an hour in the week, and their providers once each, for the credit. */
    models: string[];
    providers: string[];
}

/**
 * The models' wind spread from the ten-day comparison's answer
 * (queryModelSpread, knots), on the same epoch hours as the report.
 */
export function spreadBand(
    block: SpreadBlock<AtmosVar> | null | undefined,
    startMs: number,
    hours = METEOGRAM_HOURS,
): SpreadBand | null {
    if (!block?.times?.length) return null;
    const first = epochHour(startMs);
    const perHour: number[][] = Array.from({ length: hours }, () => []);
    const models: string[] = [];
    const providers: string[] = [];
    for (const m of block.models) {
        let used = false;
        block.times.forEach((t, j) => {
            const i = epochHour(t) - first;
            const v = finite(m.values.wind_speed_10m?.[j]);
            if (i < 0 || i >= hours || v === null) return;
            perHour[i].push(v);
            used = true;
        });
        if (!used) continue;
        models.push(m.label);
        if (!providers.includes(m.provider)) providers.push(m.provider);
    }
    if (models.length < SPREAD_MIN_MODELS) return null;
    const enough = (vs: number[]) => vs.length >= SPREAD_MIN_MODELS;
    return {
        lo: perHour.map((vs) => (enough(vs) ? Math.min(...vs) : null)),
        hi: perHour.map((vs) => (enough(vs) ? Math.max(...vs) : null)),
        models,
        providers,
    };
}

/** Each hour's change over the three hours before it, hPa; null without both ends. */
export function threeHourChange(pressure: HourValues): HourValues {
    return pressure.map((p, i) => {
        const before = i >= 3 ? pressure[i - 3] : null;
        return p !== null && before !== null ? p - before : null;
    });
}

/** Segment k (hour k to k + 1) is falling, inside a three-hour fall of FAST_FALL_HPA or more. */
export function fastFallSegments(pressure: HourValues): boolean[] {
    const change = threeHourChange(pressure);
    return pressure.map((p, k) => {
        const next = pressure[k + 1];
        if (p === null || next == null || next >= p) return false;
        return [k + 1, k + 2, k + 3].some((j) => (change[j] ?? 0) <= -FAST_FALL_HPA);
    });
}

/** The steepest three-hour fall in the week: the hour it ends and its size (negative hPa). */
export function steepestFall(pressure: HourValues): { hour: number; hpa: number } | null {
    const change = threeHourChange(pressure);
    let hour = -1;
    for (let i = 0; i < change.length; i++) {
        const c = change[i];
        if (c !== null && c < 0 && (hour < 0 || c < change[hour]!)) hour = i;
    }
    return hour < 0 ? null : { hour, hpa: change[hour]! };
}

/** The forecast's next three hours in the barometer's words ('Falling slowly'), or null. */
export function tendencyNow(pressure: HourValues): string | null {
    const [p0, , , p3] = pressure;
    return p0 != null && p3 != null ? tendencyLabel(p3 - p0) : null;
}

// ── Drawing, in plot units: x is the hour (0 to 168), y runs 0 (top) to 100 ──

const tenth = (n: number) => Math.round(n * 10) / 10;

/** A value's plot y on a scale from lo to hi, with a little room above and below. */
export const yScale =
    (lo: number, hi: number) =>
    (v: number): number =>
        tenth(96 - ((v - lo) / (hi - lo || 1)) * 88);

/** A scale's top in raw units: the peak and a little more, rounded up to a step in display units. */
export const niceTop = (raw: number, factor: number, step: number): number =>
    Math.max(step, Math.ceil((raw * factor * 1.05) / step) * step) / factor;

/** One stroke per unbroken stretch, a lone hour a short tick: nothing joins across a gap. */
export function linePath(values: HourValues, y: (v: number) => number): string {
    return runs(values)
        .map(({ from, to }) => {
            if (from === to) return `M${from - 0.4} ${y(values[from]!)}H${from + 0.4}`;
            let d = '';
            for (let i = from; i <= to; i++) d += `${i === from ? 'M' : 'L'}${i} ${y(values[i]!)}`;
            return d;
        })
        .join('');
}

/** The band between two series, over the hours both have. */
export function bandPath(lo: HourValues, hi: HourValues, y: (v: number) => number): string {
    const both = lo.map((v, i) => (v !== null && hi[i] !== null ? v : null));
    return runs(both)
        .map(({ from, to }) => {
            let d = '';
            for (let i = from; i <= to; i++) d += `${i === from ? 'M' : 'L'}${i} ${y(hi[i]!)}`;
            for (let i = to; i >= from; i--) d += `L${i} ${y(lo[i]!)}`;
            return `${d}Z`;
        })
        .join('');
}

/** A bar for each hour with any amount, never thinner than a sliver. */
export function barsPath(values: HourValues, y: (v: number) => number): string {
    return values
        .map((v, i) => (v !== null && v > 0 ? `M${i + 0.15} 96V${Math.min(95, y(v))}H${i + 0.85}V96Z` : ''))
        .join('');
}

/** The stretches of the pressure line inside a fast fall (fastFallSegments), as their own path. */
export function fastFallPath(pressure: HourValues, y: (v: number) => number): string {
    const fast = fastFallSegments(pressure);
    let d = '';
    pressure.forEach((v, k) => {
        const next = pressure[k + 1];
        if (!fast[k] || v === null || next == null) return;
        const joined = k > 0 && fast[k - 1] && pressure[k - 1] !== null;
        d += `${joined ? '' : `M${k} ${y(v)}`}L${k + 1} ${y(next)}`;
    });
    return d;
}

/**
 * Night at the spot, as hour offsets from startMs: [from, to), wherever the
 * sun is below the rise/set line. Sampled every quarter hour and the edges
 * placed where the altitude crosses the line, so a week of polar day has no
 * night and a week of polar night is one.
 */
export function nightSpans(
    startMs: number,
    hours: number,
    lat: number,
    lon: number,
    altitude: (at: Date, lat: number, lon: number) => number = sunAltitudeDeg,
): { from: number; to: number }[] {
    const STEP = 0.25;
    const out: { from: number; to: number }[] = [];
    const above = (t: number) => altitude(new Date(startMs + t * HOUR_MS), lat, lon) - SUNSET_ALTITUDE_DEG;
    let prevT = 0;
    let prev = above(0);
    let open: number | null = prev < 0 ? 0 : null;
    for (let k = 1; k * STEP <= hours; k++) {
        const t = k * STEP;
        const a = above(t);
        if (a < 0 !== prev < 0) {
            // The crossing, placed linearly between the two samples.
            const at = prevT + (STEP * prev) / (prev - a);
            if (a < 0) open = at;
            else {
                out.push({ from: open ?? 0, to: at });
                open = null;
            }
        }
        prevT = t;
        prev = a;
    }
    if (open !== null) out.push({ from: open, to: hours });
    return out.filter((s) => s.to > s.from);
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A cached en-GB formatter on a clock: an IANA zone, or the phone's without one. */
export function clockFormat(clock: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${clock ?? ''}|${JSON.stringify(options)}`;
    let f = formats.get(key);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('en-GB', clock ? { ...options, timeZone: clock } : options);
        } catch {
            f = new Intl.DateTimeFormat('en-GB', options);
        }
        formats.set(key, f);
    }
    return f;
}

/** 'Thu 14:00' on a clock. */
export const formatHour = (ms: number, clock?: string): string =>
    clockFormat(clock, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

/** The clock's short name at an instant ('GMT+10', 'CEST'); '' when the platform has none. */
export function zoneName(ms: number, clock?: string): string {
    try {
        const part = clockFormat(clock, { timeZoneName: 'short' })
            .formatToParts(ms)
            .find((p) => p.type === 'timeZoneName');
        return part?.value ?? '';
    } catch {
        return '';
    }
}

export interface DayLabel {
    /** The day's stretch of the week, [from, to) in hours, and its middle. */
    from: number;
    to: number;
    at: number;
    /** 'Thu 22', and the weekday alone ('Thu') for a row too tight for it. */
    text: string;
    short: string;
}

export interface DayMarks {
    /** Hour offsets of each midnight inside the week. */
    midnights: number[];
    /** One per day wide enough to carry a name; fitDayLabels picks the ones drawn. */
    labels: DayLabel[];
}

/** The week's midnights and day names on a clock (an IANA zone, or the phone's). */
export function dayMarks(startMs: number, hours: number, clock?: string): DayMarks {
    const midnights: number[] = [];
    let prevDay = wallClock(startMs, clock).slice(0, 3).join('-');
    for (let i = 1; i <= hours; i++) {
        const ms = startMs + i * HOUR_MS;
        const w = wallClock(ms, clock);
        const day = w.slice(0, 3).join('-');
        if (day === prevDay) continue;
        prevDay = day;
        // Back from this hour to the day's first instant: half-hour zones
        // (India, Newfoundland) start their days between epoch hours.
        const at = i - ((w[3] * 60 + w[4]) * 60 + w[5]) / 3600;
        if (at > 0 && at < hours) midnights.push(at);
    }
    const name = clockFormat(clock, { weekday: 'short', day: 'numeric' });
    const weekday = clockFormat(clock, { weekday: 'short' });
    const edges = [0, ...midnights, hours];
    const labels: DayLabel[] = [];
    for (let k = 0; k < edges.length - 1; k++) {
        const [from, to] = [edges[k], edges[k + 1]];
        // A stretch under six hours is a sliver of a day: no room for its name.
        if (to - from < 6) continue;
        const at = (from + to) / 2;
        const ms = startMs + at * HOUR_MS;
        labels.push({ from, to, at, text: name.format(ms), short: weekday.format(ms) });
    }
    return { midnights, labels };
}

/** The least room between two day names, px. */
export const DAY_GAP_PX = 6;

export interface PlacedDay {
    text: string;
    /** The name's left edge, as a share of the row's width. */
    left: number;
}

/**
 * The day names a row widthPx wide can carry without one touching the next,
 * measured in the face it draws them in (widthOf). At 375 px the week is
 * about 311 px, 44 px a day: 'Wed 21' in a wide face is wider than that, and
 * a part day at either end put its name half a day from its neighbour's
 * (131-02 review). Each name sits centred on its own stretch, kept inside
 * the row; whole days are placed before the part days at the ends, so a part
 * day gives way to its neighbour, and a name pushed off its own day by the
 * row's edge is left out. The full names when every whole day keeps its name
 * in them, else the weekdays alone; never a mix.
 */
export function fitDayLabels(
    labels: DayLabel[],
    hours: number,
    widthPx: number,
    widthOf: (text: string) => number,
    gapPx = DAY_GAP_PX,
): PlacedDay[] {
    if (!(widthPx > 0)) return [];
    const px = widthPx / hours;
    // A clock change makes a whole day 23 or 25 hours long.
    const whole = (day: DayLabel) => day.to - day.from >= 23;
    const order = [...labels].sort((a, b) => b.to - b.from - (a.to - a.from) || a.at - b.at);
    const place = (form: 'text' | 'short') => {
        const kept: { text: string; l: number; r: number; whole: boolean }[] = [];
        for (const day of order) {
            const text = day[form];
            const w = widthOf(text);
            const l = Math.min(Math.max(0, day.at * px - w / 2), widthPx - w);
            const r = l + w;
            const mid = (l + r) / 2;
            if (l < 0 || mid < day.from * px || mid > day.to * px) continue;
            if (kept.some((k) => l < k.r + gapPx && r > k.l - gapPx)) continue;
            kept.push({ text, l, r, whole: whole(day) });
        }
        return kept;
    };
    let shown = place('text');
    if (shown.filter((k) => k.whole).length < labels.filter(whole).length) shown = place('short');
    return shown.sort((a, b) => a.l - b.l).map(({ text, l }) => ({ text, left: l / widthPx }));
}

/**
 * today — Plan Your Day's engine (build 124, "Today on the water").
 *
 * Shane, 2026-10-08: "ok, can you revamp the plan your day thing, it does
 * nothing of use at the moment claude. make it work please ;)". The old
 * planner routed every stop through the inshore router and, from Coral Sea
 * Marina, refused every one of them. This one never routes, never saves,
 * never expires and never blocks. It answers four questions at a glance:
 *
 *   1. GO OR STAY. The morning, afternoon and evening, each Inside / Near /
 *      Over the skipper's OWN limits, from seven models at one point, with
 *      whether they agree.
 *   2. WHEN. Hourly departures for the best stops, walked along the leg in the
 *      forecast wind with her polar (passagePlan), ranked exactly as the
 *      passage HUD ranks departures (departureScore, compactWindow).
 *   3. WHERE. The two or three best stops within a day's sail, with leave,
 *      there and home times; every other place listed with a plain reason.
 *   4. HOME BY. Civil first and last light on the PLACE's clock.
 *
 * PURE. Everything arrives as data from todayLoader.ts; nothing here fetches,
 * stores or reads the clock. planDay() is called once without route legs,
 * names the stops it wants legs for (needsLegs), and is called again with
 * them: switching day or stay is a recompute, never a request.
 *
 * HONESTY RULES, each with a test (tests/dayPlanToday.test.ts):
 *   - A missing gust never passes: no gust from any member caps at Near.
 *   - The end of the forecast, or a speed only ASSUMED, is Unknown, never Inside.
 *   - Fewer than two models in an hour is "No forecast", never a verdict.
 *   - Thunder is counted from the models' weather codes and named; the app
 *     never says "no storms".
 *   - Times, parts of the day and dates are the location's (its IANA zone),
 *     never the phone's.
 *   - A rough day hides nothing: every place is still listed and ranked,
 *     with its reason (Cast Off is advisory: cautions, not blocks).
 *   - Depth and tide over the route are NOT read here and never folded into a
 *     verdict; the marina approach gets its own line in the detail.
 *
 * Every time and distance it produces is an ESTIMATE and is shown as one.
 *
 * SAY WHY (build 127, 127-PYD-1): a reason is kept once, without the "over
 * your limits: " prefix, and that prefix is added only where words need it
 * (VoiceOver, Not today, the stop page's verdict); a ✕ or ? row shows its
 * reason where its times were, and thunder is named in the headline.
 */
import {
    scoreAnchorage,
    type AnchorageGrade,
    type AnchorageVerdict,
    type VerdictHour,
} from '../anchorages/anchorageVerdict';
import { planPassage, type PassageSpeedModel, type SpeedHow } from '../passagePlan';
import type { ResolvedRoutingPolar } from '../routingPolar';
import {
    compactWindow,
    departureScore,
    departureScoreTerms,
    type ScoredDeparture,
} from '../passageDepartureSuggestion';
import { sampleRouteForecast, type RouteForecast } from '../routeForecastSampler';
import { sampleRouteSpread, type RouteSpread, type SpreadLevel } from '../routeForecastSpread';
import { sampleRouteSea, type RouteSea } from '../routeSeaSampler';
import { buildRouteIndex, stationOnIndex, type RouteIndex } from '../routeProgress';
import { vesselWindowThresholds } from '../vesselWindowThresholds';
import type { AtmosVar, SpreadBlock } from '../weather/ModelSpreadService';
import {
    AGREEMENT_WORDS,
    classifySpread,
    median,
    verdictAt,
    windAgreementByDay,
    type AgreementLevel,
} from '../weather/dayAgreement';
import { getFirstLight, getLastLight, localNoon } from '../../utils/celestial';
import { PLOT_DAY_MAX_POINTS, type PlotDayAction } from '../deepLink';
import type { ComfortParams } from '../../types/settings';
import type { VesselProfile } from '../../types/vessel';
import type { Tide } from '../../types/weather';
import { mirrorRouteForecast, mirrorRouteSea, mirrorRouteSpread } from './mirror';
import {
    reachRadiusNm,
    splitClosed,
    type DistanceEstimate,
    type GatheredPlaces,
    type LatLon,
    type PlaceCandidate,
} from './places';
import { dayPlanLocalDate, nextLocalMorning, parseDayPlanInput } from './presentation';

const MIN = 60_000;
const HOUR = 3_600_000;

/** Home with at least this much light left is fine; inside it, Near. */
export const LIGHT_MARGIN_MS = 30 * MIN;
/** The earliest a plan opened now can leave: half an hour to get going. */
export const LEAVE_LEAD_MS = 30 * MIN;
/** Under the midnight sun the day is planned 06:00–20:00 local: 14 h. */
export const POLAR_DAY_START_H = 6;
export const POLAR_CAP_H = 14;
/** Hourly departures compared per stop, at most. */
export const MAX_DEPARTURES = 14;
/** A leg longer than this is not a day out. */
export const LEG_MAX_MS = 12 * HOUR;
/** Stops given their own route forecasts, and the most shown at once. */
export const SWEEP_STOPS = 3;
/** Today is too late when less than the stay plus this is left before last light. */
export const TOO_LATE_SPARE_H = 2;
/** An overnight stay runs to this local hour the next day. */
export const OVERNIGHT_UNTIL_H = 9;
/** A Comfort setting is the "poor" line; "good" is this share of it. */
export const COMFORT_GOOD_SHARE = 0.8;
export const FT_PER_M = 3.2808;
/** WMO thunderstorm codes: 95, and 96/99 with hail. */
export const THUNDER_CODES: ReadonlySet<number> = new Set([95, 96, 99]);
/** A boat fix older than this asks "still there?". */
export const OLD_FIX_MS = 6 * HOUR;
/** Cyclones this close get the top notice. */
export const CYCLONE_NOTICE_NM = 600;

// ── Stay ───────────────────────────────────────────────────────

export type StayOption = '1h' | '2h' | '4h' | 'overnight';
export const STAY_OPTIONS: readonly StayOption[] = ['1h', '2h', '4h', 'overnight'];
export const DEFAULT_STAY: StayOption = '2h';
const STAY_H: Record<Exclude<StayOption, 'overnight'>, number> = { '1h': 1, '2h': 2, '4h': 4 };

/** Hours ashore; null for an overnight stay. */
export function stayHours(stay: StayOption): number | null {
    return stay === 'overnight' ? null : STAY_H[stay];
}

/** The stay menu's words: "2 h ashore", "Overnight". */
export function stayMenuLabel(stay: StayOption): string {
    return stay === 'overnight' ? 'Overnight' : `${STAY_H[stay]} h ashore`;
}

/** The stay chip: "Stay 2 h ▾", "Overnight ▾". */
export function stayChipLabel(stay: StayOption): string {
    return stay === 'overnight' ? 'Overnight ▾' : `Stay ${STAY_H[stay]} h ▾`;
}

const stayPhrase = (stay: StayOption) => (stay === 'overnight' ? 'an overnight stay' : stayMenuLabel(stay));

// ── Limits ─────────────────────────────────────────────────────

export type LimitSource = 'comfort' | 'vessel' | 'default';
export interface MetricLimit {
    good: number;
    poor: number;
    source: LimitSource;
}
/** Wind and gust in knots, sea in metres. */
export interface DayPlanLimits {
    wind: MetricLimit;
    gust: MetricLimit;
    wave: MetricLimit;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The skipper's own limits, metric by metric: Comfort settings first (that
 * value is "poor", 0.8 of it "good"), else the boat's thresholds
 * (vesselWindowThresholds), whose sea is in FEET and is converted here. No
 * hard caps: the old planner's fixed 20 kn / 25 kn / 1.5 m are gone.
 */
export function resolveDayPlanLimits(
    comfort: ComfortParams | null | undefined,
    vessel: VesselProfile | null | undefined,
    usingDefaultVessel: boolean,
): DayPlanLimits {
    const boat = !!vessel && !usingDefaultVessel;
    const t = vesselWindowThresholds(vessel ?? null, null);
    const windFromBoat = boat && (positive(vessel?.maxWindSpeed) || positive(vessel?.length));
    const waveFromBoat = boat && positive(vessel?.maxWaveHeight);
    const pick = (
        set: number | undefined,
        fallback: { good: number; poor: number },
        fromBoat: boolean,
        round: (v: number) => number,
    ): MetricLimit =>
        positive(set)
            ? { good: round(COMFORT_GOOD_SHARE * set), poor: set, source: 'comfort' }
            : { good: fallback.good, poor: fallback.poor, source: fromBoat ? 'vessel' : 'default' };
    return {
        wind: pick(comfort?.maxWindKts, t.wind, windFromBoat, round1),
        gust: pick(comfort?.maxGustKts, t.gust, windFromBoat, round1),
        wave: pick(
            comfort?.maxWaveM,
            { good: round1(t.wave.good / FT_PER_M), poor: round1(t.wave.poor / FT_PER_M) },
            waveFromBoat,
            round2,
        ),
    };
}

const SOURCE_WORDS: Record<LimitSource, string> = {
    comfort: 'your Comfort settings',
    vessel: 'your boat',
    default: 'a typical cruiser',
};

/** Whose limits stand where she has set none: "your boat", or null when every one is her own. */
export function unsetLimitSource(limits: DayPlanLimits): string | null {
    const other = [limits.wind, limits.gust, limits.wave].find((m) => m.source !== 'comfort');
    return other ? SOURCE_WORDS[other.source] : null;
}

/** "Wind 13/20 kn · gusts 18/25 kn · sea 0.8/1.5 m (from your boat)". */
export function limitsLine(limits: DayPlanLimits): string {
    const n = (v: number) => String(round1(v));
    const sources = [...new Set([limits.wind.source, limits.gust.source, limits.wave.source])];
    return (
        `Wind ${n(limits.wind.good)}/${n(limits.wind.poor)} kn · gusts ${n(limits.gust.good)}/${n(limits.gust.poor)} kn` +
        ` · sea ${n(limits.wave.good)}/${n(limits.wave.poor)} m (from ${sources.map((s) => SOURCE_WORDS[s]).join(' and ')})`
    );
}

// ── The location's clock ───────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat | null>();
function format(zone: string, key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
    const id = `${zone}|${key}`;
    let f = formats.get(id);
    if (f === undefined) {
        try {
            f = new Intl.DateTimeFormat(key.startsWith('au:') ? 'en-AU' : 'en-GB', { ...options, timeZone: zone });
        } catch {
            f = null;
        }
        if (formats.size > 64) formats.clear();
        formats.set(id, f);
    }
    return f;
}

/** "07:30" on the place's clock. */
export function hhmm(ms: number, zone: string): string {
    if (!Number.isFinite(ms)) return '--:--';
    return format(zone, 'hhmm', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })?.format(ms) ?? '--:--';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The place's calendar date, YYYY-MM-DD. */
export function localDate(ms: number, zone: string): string {
    return dayPlanLocalDate(ms, zone);
}

/** A calendar date plus `days`, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d + days));
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** Today and the next `count − 1` days, on the place's calendar. */
export function chipDates(nowMs: number, zone: string, count = 3): string[] {
    const today = localDate(nowMs, zone);
    return Array.from({ length: count }, (_, i) => addDays(today, i));
}

/** The instant of a wall-clock time on the place's calendar date. */
export function wallTime(date: string, hour: number, minute: number, zone: string): number {
    const ms = parseDayPlanInput(`${date}T${pad(hour)}:${pad(minute)}`, zone);
    if (Number.isFinite(ms)) return ms;
    // A daylight-saving gap or fold at that wall time: count from local noon.
    return localNoon(date, zone).getTime() + (hour - 12) * HOUR + minute * MIN;
}

const atNoon = (date: string, zone: string) => wallTime(date, 12, 0, zone);
export function weekdayShort(date: string, zone: string): string {
    return format(zone, 'wd', { weekday: 'short' })?.format(atNoon(date, zone)) ?? date;
}
export function weekdayLong(date: string, zone: string): string {
    return format(zone, 'wdl', { weekday: 'long' })?.format(atNoon(date, zone)) ?? date;
}
/** "Friday 9 October". */
export function longDate(date: string, zone: string): string {
    return format(zone, 'long', { weekday: 'long', day: 'numeric', month: 'long' })?.format(atNoon(date, zone)) ?? date;
}
/** "12 Sep" for an instant. */
export function dayMonth(ms: number, zone: string): string {
    return format(zone, 'dm', { day: 'numeric', month: 'short' })?.format(ms) ?? '';
}
/** "Thu 8 Oct" for a date. */
export function shortDate(date: string, zone: string): string {
    return format(zone, 'sd', { weekday: 'short', day: 'numeric', month: 'short' })?.format(atNoon(date, zone)) ?? date;
}
/** "AEST": the zone's short name at that instant. */
export function zoneAbbrev(ms: number, zone: string): string {
    return (
        format(zone, 'au:tz', { timeZoneName: 'short' })
            ?.formatToParts(ms)
            .find((p) => p.type === 'timeZoneName')?.value ?? zone
    );
}

/** The minute past the place's own hour (zones run on :30 and :45 offsets). */
function localMinute(ms: number, zone: string): number {
    const part = format(zone, 'min', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        ?.formatToParts(ms)
        .find((p) => p.type === 'minute');
    return part ? Number(part.value) : new Date(ms).getUTCMinutes();
}

/** The next whole hour on the place's clock (itself when already on one). */
export function ceilLocalHour(ms: number, zone: string): number {
    const seconds = ((ms % MIN) + MIN) % MIN;
    const minute = localMinute(ms, zone);
    if (minute === 0 && seconds === 0) return ms;
    return ms - seconds - minute * MIN + HOUR;
}

const ceilQuarter = (ms: number) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;

/** "2 h 10", "3 h", "40 min". */
export function durationLabel(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / MIN));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h} h` : `${h} h ${pad(m)}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const octant = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;
export const compass8 = (deg: number): string => COMPASS[octant(deg)];
const compassWords = (deg: number): string => COMPASS_WORDS[octant(deg)];

// ── Light ──────────────────────────────────────────────────────

export type DayLight = 'normal' | 'no-true-night' | 'stays-dark';

export interface DayWindow {
    date: string;
    zone: string;
    isToday: boolean;
    light: DayLight;
    /** Civil first and last light; under the midnight sun, the 14 h planning day. */
    firstLightMs: number | null;
    lastLightMs: number | null;
    /**
     * Today: the later of now + 30 min and first light; another day, first
     * light. The Plan page's departure is NOT a floor: it may be left from
     * another passage (or an earlier Plot on chart), and it silently hid the
     * morning and declared "too late" at breakfast.
     */
    earliestLeaveMs: number | null;
    /** Hours from the earliest leave to half an hour before last light. */
    usableH: number;
}

export interface DayWindowArgs {
    date: string;
    lat: number;
    lon: number;
    zone: string;
    nowMs: number;
}

export function dayWindow(args: DayWindowArgs): DayWindow {
    const { date, lat, lon, zone, nowMs } = args;
    const isToday = localDate(nowMs, zone) === date;
    const noon = localNoon(date, zone);
    const first = getFirstLight(noon, lat, lon, zone, 'civil');
    const last = getLastLight(noon, lat, lon, zone, 'civil');
    let light: DayLight = 'stays-dark';
    let firstLightMs: number | null = null;
    let lastLightMs: number | null = null;
    if (first.state === 'no-true-night' || last.state === 'no-true-night') {
        light = 'no-true-night';
        firstLightMs = wallTime(date, POLAR_DAY_START_H, 0, zone);
        lastLightMs = firstLightMs + POLAR_CAP_H * HOUR;
    } else if (first.state === 'normal' && last.state === 'normal' && first.at && last.at) {
        light = 'normal';
        firstLightMs = first.at.getTime();
        lastLightMs = last.at.getTime();
    }
    let earliestLeaveMs: number | null = null;
    if (firstLightMs !== null)
        earliestLeaveMs = isToday ? Math.max(firstLightMs, ceilQuarter(nowMs + LEAVE_LEAD_MS)) : firstLightMs;
    const usableH =
        earliestLeaveMs === null || lastLightMs === null
            ? 0
            : Math.max(0, (lastLightMs - LIGHT_MARGIN_MS - earliestLeaveMs) / HOUR);
    return { date, zone, isToday, light, firstLightMs, lastLightMs, earliestLeaveMs, usableH };
}

/** Today is over for a day out: less than the stay plus two hours left before last light. */
export function tooLateFor(window: DayWindow, stay: StayOption): boolean {
    if (!window.isToday || window.earliestLeaveMs === null || window.lastLightMs === null) return false;
    const needH = (stayHours(stay) ?? 0) + TOO_LATE_SPARE_H;
    return (window.lastLightMs - window.earliestLeaveMs) / HOUR < needH;
}

export type LightLevel = 'fine' | 'near' | 'over';

/** Home (or, overnight, arrival) at least 30 min before last light is fine; in the last 30 min, Near; after it, Over. */
export function lightLevel(atMs: number | null, lastLightMs: number | null): LightLevel {
    if (atMs === null || lastLightMs === null || !Number.isFinite(atMs)) return 'over';
    if (atMs <= lastLightMs - LIGHT_MARGIN_MS) return 'fine';
    return atMs <= lastLightMs ? 'near' : 'over';
}

// ── The point block ────────────────────────────────────────────

export interface PointMember {
    id: string;
    kts: number | null;
    dirDeg: number | null;
    gustKts: number | null;
    code: number | null;
}

export interface PointHour {
    t: number;
    /** Every model in block order, with nulls. */
    members: PointMember[];
    /** Members with a wind speed. */
    count: number;
    medianKts: number | null;
    minKts: number | null;
    maxKts: number | null;
    /** Circular mean of the members' directions. */
    dirDeg: number | null;
    /** The strongest gust among members that publish one. */
    gustMaxKts: number | null;
    /** Models with a thunderstorm code this hour. */
    thunder: number;
    /** The members' speed spread is "split" (dayAgreement's thresholds). */
    split: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The mean direction the short way round; null when there is none. */
export function circularMeanDeg(values: readonly number[]): number | null {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const v of values) {
        if (!finite(v)) continue;
        x += Math.sin((v * Math.PI) / 180);
        y += Math.cos((v * Math.PI) / 180);
        n++;
    }
    if (n === 0 || Math.hypot(x, y) < 1e-9 * n) return null;
    return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/** Per hour, across the seven models: median wind, mean direction, max gust, thunder. */
export function pointHours(atmos: SpreadBlock<AtmosVar> | null): PointHour[] {
    if (!atmos?.times?.length) return [];
    return atmos.times.map((t, i) => {
        const members: PointMember[] = atmos.models.map((m) => {
            const v = (key: AtmosVar) => {
                const x = m.values[key]?.[i];
                return finite(x) ? x : null;
            };
            return {
                id: m.id,
                kts: v('wind_speed_10m'),
                dirDeg: v('wind_direction_10m'),
                gustKts: v('wind_gusts_10m'),
                code: v('weather_code'),
            };
        });
        const speeds = members.flatMap((m) => (m.kts === null ? [] : [m.kts]));
        const gusts = members.flatMap((m) => (m.gustKts === null ? [] : [m.gustKts]));
        const med = speeds.length ? median(speeds) : null;
        const min = speeds.length ? Math.min(...speeds) : null;
        const max = speeds.length ? Math.max(...speeds) : null;
        return {
            t,
            members,
            count: speeds.length,
            medianKts: med,
            minKts: min,
            maxKts: max,
            dirDeg: circularMeanDeg(members.flatMap((m) => (m.kts !== null && m.dirDeg !== null ? [m.dirDeg] : []))),
            gustMaxKts: gusts.length ? Math.max(...gusts) : null,
            thunder: members.filter((m) => m.code !== null && THUNDER_CODES.has(m.code)).length,
            split: speeds.length >= 2 && med !== null && classifySpread('wind', max! - min!, med) === 'split',
        };
    });
}

// ── The parts of the day ───────────────────────────────────────

export type PartName = 'morning' | 'afternoon' | 'evening';
/** 'none' = No forecast; 'dark' = no daylight in that part (high latitudes). */
export type PartLevel = 'inside' | 'near' | 'over' | 'none' | 'past' | 'dark';

export interface PartVerdict {
    part: PartName;
    startMs: number;
    endMs: number;
    level: PartLevel;
    /** Hours judged. */
    hours: number;
    dirDeg: number | null;
    /** The range of the hourly medians. */
    loKts: number | null;
    hiKts: number | null;
    gustKts: number | null;
    /** Some hour had no gust from any model: never Inside. */
    noGust: boolean;
    split: boolean;
    /** The most models with thunder in any hour. */
    thunder: number;
    /** The most models answering in any hour. */
    models: number;
    /** The members' full range over the part. */
    memberLoKts: number | null;
    memberHiKts: number | null;
}

export const PART_TITLE: Record<PartName, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };

type HourLevel = 'inside' | 'near' | 'over' | 'none';

function hourLevel(h: PointHour, limits: DayPlanLimits): HourLevel {
    if (
        (h.medianKts !== null && h.medianKts >= limits.wind.poor) ||
        (h.gustMaxKts !== null && h.gustMaxKts >= limits.gust.poor)
    )
        return 'over';
    if (h.count < 2) return 'none';
    if (
        h.gustMaxKts === null ||
        h.medianKts! >= limits.wind.good ||
        h.maxKts! >= limits.wind.poor ||
        h.thunder >= 2 ||
        h.split
    )
        return 'near';
    return 'inside';
}

const LEVEL_ORDER: HourLevel[] = ['over', 'none', 'near', 'inside'];

/**
 * Morning (first light–12:00), Afternoon (12:00–16:00) and Evening
 * (16:00–last light), each judged on its hours against the limits. Over
 * outranks everything; a missing model hour makes it No forecast; a missing
 * gust, a split hour or thunder in two models holds it at Near.
 */
export function dayParts(
    window: DayWindow,
    hours: readonly PointHour[],
    limits: DayPlanLimits,
    nowMs: number,
): PartVerdict[] {
    const { date, zone } = window;
    const first = window.firstLightMs;
    const last = window.lastLightMs;
    const noon = wallTime(date, 12, 0, zone);
    const four = wallTime(date, 16, 0, zone);
    const bounds: [PartName, number, number][] = [
        ['morning', first ?? noon, noon],
        ['afternoon', noon, four],
        ['evening', four, last ?? four],
    ];
    return bounds.map(([part, rawStart, rawEnd]) => {
        const startMs = first === null ? rawStart : Math.max(rawStart, first);
        const endMs = last === null ? rawEnd : Math.min(rawEnd, last);
        const verdict: PartVerdict = {
            part,
            startMs,
            endMs,
            level: 'none',
            hours: 0,
            dirDeg: null,
            loKts: null,
            hiKts: null,
            gustKts: null,
            noGust: false,
            split: false,
            thunder: 0,
            models: 0,
            memberLoKts: null,
            memberHiKts: null,
        };
        if (first === null || last === null || endMs <= startMs) return { ...verdict, level: 'dark' };
        if (window.isToday && endMs <= nowMs) return { ...verdict, level: 'past' };
        const from = window.isToday ? Math.max(startMs, nowMs) : startMs;
        const inPart = hours.filter((h) => h.t + HOUR > from && h.t < endMs);
        if (!inPart.length) return verdict;
        const levels = inPart.map((h) => hourLevel(h, limits));
        const medians = inPart.flatMap((h) => (h.medianKts === null ? [] : [h.medianKts]));
        const gusts = inPart.flatMap((h) => (h.gustMaxKts === null ? [] : [h.gustMaxKts]));
        const lows = inPart.flatMap((h) => (h.minKts === null ? [] : [h.minKts]));
        const highs = inPart.flatMap((h) => (h.maxKts === null ? [] : [h.maxKts]));
        return {
            ...verdict,
            level: LEVEL_ORDER.find((l) => levels.includes(l)) ?? 'none',
            hours: inPart.length,
            dirDeg: circularMeanDeg(inPart.flatMap((h) => (h.dirDeg === null ? [] : [h.dirDeg]))),
            loKts: medians.length ? Math.min(...medians) : null,
            hiKts: medians.length ? Math.max(...medians) : null,
            gustKts: gusts.length ? Math.max(...gusts) : null,
            noGust: inPart.some((h) => h.gustMaxKts === null),
            split: inPart.some((h) => h.split),
            thunder: Math.max(...inPart.map((h) => h.thunder)),
            models: Math.max(...inPart.map((h) => h.count)),
            memberLoKts: lows.length ? Math.min(...lows) : null,
            memberHiKts: highs.length ? Math.max(...highs) : null,
        };
    });
}

/** When the inside run that starts at `fromMs` ends: the first hour that is not Inside, else last light. */
export function insideUntilMs(
    hours: readonly PointHour[],
    limits: DayPlanLimits,
    fromMs: number,
    lastLightMs: number,
): number {
    for (const h of hours) {
        if (h.t + HOUR <= fromMs || h.t >= lastLightMs) continue;
        if (hourLevel(h, limits) !== 'inside') return Math.max(h.t, fromMs);
    }
    return lastLightMs;
}

/**
 * The hour at the point most over her limits between `fromMs` and `toMs`
 * (by how far over, wind or gust), or null when none is. The day's strip is
 * judged on these hours, so a stop is never Inside while the strip says Over
 * for the time she would be under way.
 */
function overHourBetween(
    hours: readonly PointHour[],
    limits: DayPlanLimits,
    fromMs: number,
    toMs: number,
): PointHour | null {
    let worst: PointHour | null = null;
    let worstBy = -Infinity;
    for (const h of hours) {
        if (h.t + HOUR <= fromMs || h.t >= toMs || hourLevel(h, limits) !== 'over') continue;
        const by = Math.max((h.medianKts ?? 0) / limits.wind.poor, (h.gustMaxKts ?? 0) / limits.gust.poor);
        if (by > worstBy) {
            worst = h;
            worstBy = by;
        }
    }
    return worst;
}

/** "SE 29 kn in the area", or its gusts: the point block, not the route. */
function areaOverReason(h: PointHour, limits: DayPlanLimits): string {
    if (h.medianKts !== null && h.medianKts >= limits.wind.poor)
        return `${h.dirDeg === null ? '' : `${compass8(h.dirDeg)} `}${Math.round(h.medianKts)} kn in the area`;
    return `gusts ${Math.round(h.gustMaxKts ?? 0)} kn in the area`;
}

const PART_WORD: Record<PartLevel, string> = {
    inside: 'Inside',
    near: 'Near',
    over: 'Over',
    none: 'No forecast',
    past: 'Past',
    dark: 'Dark',
};
const PART_GLYPH: Record<PartLevel, string> = { inside: '✓', near: '≈', over: '✕', none: '?', past: '–', dark: '–' };
// The day's three parts are judged on WIND and gusts at one point; the sea
// is read only along the way to each stop, so a part never claims it.
const PART_ARIA: Record<PartLevel, string> = {
    inside: 'inside your wind limits',
    near: 'near your wind limits',
    over: 'over your wind limits',
    none: 'no forecast',
    past: 'already past',
    dark: 'no daylight',
};

/** "SE 12–15" (or "SE 12"); no direction in light, variable air. */
export function windSpan(dirDeg: number | null, lo: number | null, hi: number | null): string {
    if (lo === null || hi === null) return '';
    const a = Math.round(lo);
    const b = Math.round(hi);
    const speed = a === b ? `${a}` : `${a}–${b}`;
    return dirDeg === null ? speed : `${compass8(dirDeg)} ${speed}`;
}

/**
 * One verdict cell: "Morning" / ✓ "SE 12–15" / "Inside", and its spoken form.
 * Thunder in two or more models shows in the cell itself ("Thunder" for the
 * word it holds at Near, and ⚡ for its ≈), in whichever part it falls. The
 * headline names it too since 127-PYD-1, in place of the clause it causes
 * (dayHeadline): appended, it ran to four and five lines at 320 px.
 */
export function partCell(
    part: PartVerdict,
    blockModels = 0,
): {
    label: string;
    glyph: string;
    wind: string;
    word: string;
    ariaLabel: string;
} {
    const label = PART_TITLE[part.part];
    const wind = part.level === 'past' || part.level === 'dark' ? '' : windSpan(part.dirDeg, part.loKts, part.hiKts);
    const spoken: string[] = [];
    if (wind) {
        const lo = Math.round(part.loKts!);
        const hi = Math.round(part.hiKts!);
        spoken.push(
            `${part.dirDeg === null ? '' : `${compassWords(part.dirDeg)} `}${lo === hi ? lo : `${lo} to ${hi}`} knots`,
        );
        spoken.push(part.gustKts === null ? 'no gust forecast' : `gusts ${Math.round(part.gustKts)}`);
    }
    spoken.push(PART_ARIA[part.level]);
    const thunder = part.thunder >= 2 && part.level !== 'past' && part.level !== 'dark';
    if (thunder) spoken.push(`thunder in ${part.thunder}${blockModels ? ` of ${blockModels}` : ''} models`);
    const bolt = thunder && part.level === 'near';
    return {
        label,
        glyph: bolt ? '⚡' : PART_GLYPH[part.level],
        wind,
        word: bolt ? 'Thunder' : PART_WORD[part.level],
        ariaLabel: `${label}: ${spoken.join(', ')}`,
    };
}

// ── Day chips ──────────────────────────────────────────────────

export interface DayChip {
    date: string;
    /** "Today" or "Fri". */
    label: string;
    /** "Friday 9 October, near your wind limits at best, Models agree". */
    ariaLabel: string;
    agreement: AgreementLevel | null;
    /** That day's best part (127-PYD-1): the chip wears her limits' glyph, not the models' agreement. */
    best: PartLevel;
    /** PART_GLYPH[best] when it is Inside, Near or Over; '' otherwise. */
    glyph: string;
}

const PART_RANK: Record<PartLevel, number> = { inside: 0, near: 1, none: 2, over: 3, past: 9, dark: 9 };
const bestPart = (parts: readonly PartVerdict[]) =>
    [...parts].sort((a, b) => PART_RANK[a.level] - PART_RANK[b.level])[0] as PartVerdict | undefined;

export function dayChips(args: {
    atmos: SpreadBlock<AtmosVar> | null;
    zone: string;
    nowMs: number;
    dates: readonly string[];
    /** Each date's parts, in the order of `dates`. */
    parts?: readonly (readonly PartVerdict[])[];
}): DayChip[] {
    const { zone, nowMs } = args;
    const verdicts = windAgreementByDay(args.atmos, zone);
    const today = localDate(nowMs, zone);
    return args.dates.map((date, i) => {
        const v = verdictAt(verdicts, atNoon(date, zone));
        const agreement = v?.level ?? null;
        const isToday = date === today;
        const best = bestPart(args.parts?.[i] ?? [])?.level ?? 'none';
        const glyph = best === 'inside' || best === 'near' || best === 'over' ? PART_GLYPH[best] : '';
        return {
            date,
            label: isToday ? 'Today' : weekdayShort(date, zone),
            ariaLabel: `${isToday ? 'Today, ' : ''}${longDate(date, zone)}, ${glyph ? `${PART_ARIA[best]} at best, ` : ''}${agreement ? AGREEMENT_WORDS[agreement] : 'model agreement not known'}`,
            agreement,
            best,
            glyph,
        };
    });
}

// ── The headline ───────────────────────────────────────────────

export interface Headline {
    text: string;
    /** "Sat looks lighter ›": selects that chip. */
    link?: { label: string; date: string };
}

/**
 * The longest headline before 127, the window's ("Afternoon's your window: …
 * Evening gets near your limits.", 98 characters; the thunder day the fit
 * specs measure). Thunder keeps within it: the window's clause replaces the
 * one it causes, a Near day's drops its "about" where it must, and the
 * models' spread is said only where it fits.
 */
const HEADLINE_ROOM = 98;

function partPhrase(part: PartName, isToday: boolean, dayName: string): string {
    return isToday ? `this ${part}` : `${dayName} ${part}`;
}

export interface DayHeadlineArgs {
    parts: readonly PartVerdict[];
    isToday: boolean;
    /** "today" or "Friday". */
    dayName: string;
    agreement: AgreementLevel | null;
    lighterDay?: { date: string; label: string } | null;
    hours: readonly PointHour[];
    limits: DayPlanLimits;
    window: DayWindow;
    /** The models in the point block, for "thunder in 3 of 7 models". */
    models?: number;
}

/** §4's templates, deterministic, in priority order. */
export function dayHeadline(args: DayHeadlineArgs): Headline {
    const { parts, isToday, dayName, window } = args;
    const active = parts.filter((p) => p.level !== 'past' && p.level !== 'dark');
    if (!active.length) return { text: `No daylight left ${isToday ? 'today' : `on ${dayName}`}.` };
    if (active.every((p) => p.level === 'none'))
        return { text: `No forecast for ${dayName}: places shown, weather not checked.` };

    const best = bestPart(active)!;
    let text: string;
    let link: Headline['link'];
    let spread = false;
    // "in 3 of 7 models.": thunder in two or more models (127-PYD-1).
    const of = (count: number) => `in ${count} of ${args.models || best.models} models.`;
    if (active.every((p) => p.level === 'over')) {
        const lo = Math.min(...active.flatMap((p) => (p.loKts === null ? [] : [p.loKts])));
        const hi = Math.max(...active.flatMap((p) => (p.hiKts === null ? [] : [p.hiKts])));
        const windiest = active.reduce((a, b) => ((b.hiKts ?? -1) > (a.hiKts ?? -1) ? b : a));
        const gusts = active.flatMap((p) => (p.gustKts === null ? [] : [p.gustKts]));
        text =
            `Stay put ${dayName}: ${windSpan(windiest.dirDeg, lo, hi)} kn, ` +
            `${gusts.length ? `gusts ${Math.round(Math.max(...gusts))}` : 'no gust forecast'}, over your limits all day.`;
        if (args.lighterDay) link = { label: `${args.lighterDay.label} looks lighter ›`, date: args.lighterDay.date };
    } else if (best.split) {
        const dir = best.dirDeg === null ? '' : `${compass8(best.dirDeg)} `;
        text =
            `Models split ${partPhrase(best.part, isToday, dayName)}: ${dir}${Math.round(best.memberLoKts ?? 0)} to ` +
            `${Math.round(best.memberHiKts ?? 0)} kn. Plan for the strong end.`;
    } else if (active.every((p) => p.level === 'inside')) {
        // "wind": the parts never read the sea (only the route to a stop does).
        text = `Inside your wind limits all day.${args.agreement ? ` ${AGREEMENT_WORDS[args.agreement]}.` : ''}`;
    } else if (best.level === 'inside') {
        const from = window.isToday ? Math.max(best.startMs, window.earliestLeaveMs ?? best.startMs) : best.startMs;
        const until = insideUntilMs(args.hours, args.limits, from, window.lastLightMs ?? best.endMs);
        text = `${PART_TITLE[best.part]}'s your window: inside your wind limits until about ${hhmm(until, window.zone)}.`;
        const later = active.find((p) => p.startMs > best.startMs && (p.level === 'near' || p.level === 'over'));
        // Thunder that holds the next part at Near takes the place of "… gets near your limits.", in the
        // same 98 characters: "…until about 12:00, then thunder in 3 of 7 models." Thunder is never inside
        // the window (an hour with it in two models is Near), so "then" holds whether it or the wind closed
        // it; "Thunder from about 13:00 …" made 108 characters and a fourth line at 390 and 320 px.
        if (later?.level === 'near' && later.thunder >= 2)
            text = `${text.slice(0, -1)}, then thunder ${of(later.thunder)}`;
        else if (later) text += ` ${PART_TITLE[later.part]} gets ${later.level} your limits.`;
        spread = true;
    } else {
        const gust = best.gustKts === null ? 'no gust forecast' : `gusts ${Math.round(best.gustKts)}`;
        const span = windSpan(best.dirDeg, best.loKts, best.hiKts);
        text = `Near your limits at best: ${span ? `${span} kn, ` : ''}${gust}.`;
        const count = Math.max(...active.map((p) => p.thunder));
        const from = window.earliestLeaveMs ?? best.startMs;
        const th =
            count >= 2 &&
            args.hours.find((h) => h.thunder >= 2 && h.t + HOUR > from && h.t < (window.lastLightMs ?? Infinity));
        if (th) {
            // Without its "about" where it would run past the room ("SW 18–24 kn, no gust forecast.").
            const clause = ` Thunder from about ${hhmm(Math.max(th.t, from), window.zone)} ${of(count)}`;
            text += text.length + clause.length > HEADLINE_ROOM ? clause.replace(' about', '') : clause;
        }
        spread = true;
    }
    // Some spread among the models is said in words now the day chips wear her limits' glyph (a
    // split has its own template; an all-Inside day says agreement already), never past the room.
    if (spread && args.agreement === 'some' && text.length + 13 <= HEADLINE_ROOM) text += ` ${AGREEMENT_WORDS.some}.`;
    return link ? { text, link } : { text };
}

// ── Facts: light and tide ──────────────────────────────────────

/** "☀ 05:31–18:36 · HW 10:52 · LW 17:03", from the next extremes in daylight. */
export function factsLine(args: { window: DayWindow; tides: readonly Tide[] | null; nowMs: number }): {
    text: string;
    ariaLabel: string;
} {
    const { window, tides, nowMs } = args;
    const zone = window.zone;
    let light: string;
    let lightAria: string;
    const first = window.firstLightMs;
    const last = window.lastLightMs;
    if (window.light === 'no-true-night') {
        light = '☀ Light all day: plan capped at 14 h';
        lightAria = 'Light all day, plan capped at 14 hours';
    } else if (first === null || last === null) {
        light = '☀ No daylight today';
        lightAria = 'No daylight today';
    } else {
        light = `☀ ${hhmm(first, zone)}–${hhmm(last, zone)}`;
        lightAria = `Light ${hhmm(first, zone)} to ${hhmm(last, zone)}`;
    }
    if (!tides?.length)
        return { text: `${light} · No tide prediction here`, ariaLabel: `${lightAria}, no tide prediction here` };
    const from = Math.max(first ?? -Infinity, window.isToday ? nowMs : -Infinity);
    const extremes = tides
        .map((t) => ({ at: Date.parse(t.time), type: t.type }))
        .filter((t) => Number.isFinite(t.at) && t.at >= from && (last === null || t.at <= last))
        .sort((a, b) => a.at - b.at)
        .slice(0, 2);
    const text = [light, ...extremes.map((t) => `${t.type === 'High' ? 'HW' : 'LW'} ${hhmm(t.at, zone)}`)].join(' · ');
    const ariaLabel = [
        lightAria,
        ...extremes.map((t) => `${t.type === 'High' ? 'high water' : 'low water'} ${hhmm(t.at, zone)}`),
    ].join(', ');
    return { text, ariaLabel };
}

/**
 * The landing window at a reviewed stop whose note says "mid to high tide":
 * the stretches where the curve stands at or above the mean of the low and
 * high water either side. Approximate by construction; the caller labels it so.
 */
export function landingWindows(
    heightAt: (ms: number) => number | null,
    fromMs: number,
    toMs: number,
    stepMs = 10 * MIN,
): { fromMs: number; toMs: number }[] {
    if (!(toMs > fromMs) || !(stepMs > 0)) return [];
    const pad = 8 * HOUR;
    const samples: { t: number; h: number }[] = [];
    for (let t = fromMs - pad; t <= toMs + pad; t += stepMs) {
        const h = heightAt(t);
        if (finite(h)) samples.push({ t, h });
    }
    const turns: { t: number; h: number }[] = [];
    for (let i = 1; i + 1 < samples.length; i++) {
        const [a, b, c] = [samples[i - 1].h, samples[i].h, samples[i + 1].h];
        if ((b >= a && b > c) || (b <= a && b < c)) turns.push(samples[i]);
    }
    const runs: { fromMs: number; toMs: number }[] = [];
    let open: number | null = null;
    let lastIn = 0;
    for (const s of samples) {
        if (s.t < fromMs || s.t > toMs) continue;
        const before = [...turns].reverse().find((x) => x.t <= s.t);
        const after = turns.find((x) => x.t > s.t);
        const inside = !!before && !!after && s.h >= (before.h + after.h) / 2;
        if (inside) {
            if (open === null) open = s.t;
            lastIn = s.t;
        } else if (open !== null) {
            runs.push({ fromMs: open, toMs: lastIn });
            open = null;
        }
    }
    if (open !== null) runs.push({ fromMs: open, toMs: lastIn });
    return runs;
}

// ── Places: the cheap pre-rank ─────────────────────────────────

export type StopLevel = 'inside' | 'near' | 'unknown' | 'over';

export interface PreRankedStop {
    candidate: PlaceCandidate;
    /** One way, NM (the distance estimate). */
    estNm: number;
    outH: number;
    /** At cruising speed from the earliest leave: an estimate for ranking only. */
    arriveMs: number;
    stayEndMs: number;
    homeMs: number | null;
    /** Shelter over the stay window in the AREA wind; null = not known. */
    stay: AnchorageVerdict | null;
}

export interface NotTodayRow {
    id: string;
    name: string;
    reason: string;
    straightNm: number;
}

const GRADE_RANK: Record<AnchorageGrade, number> = { bombproof: 0, good: 1, tenable: 2, poor: 4, 'no-anchoring': 5 };
const gradeRank = (v: AnchorageVerdict | null) => (v ? GRADE_RANK[v.grade] : 3);

/** "Very sheltered" … "Exposed"; the grade words stay out of the UI. */
export function shelterWord(verdict: AnchorageVerdict | null, tableKnown: boolean): string {
    if (!verdict || !tableKnown) return 'Shelter not known';
    switch (verdict.grade) {
        case 'bombproof':
            return 'Very sheltered';
        case 'good':
            return 'Sheltered';
        case 'tenable':
            return 'Some chop';
        case 'poor':
            return 'Exposed';
        default:
            return 'No anchoring';
    }
}

/** A wind at least this strong, from a direction a reviewed stop's access note names, holds it at "Some chop". */
const ACCESS_WIND_MIN_KTS = 10;

/**
 * A reviewed stop whose own access note names a wind ("south-easterly winds
 * can make access difficult", Chance Bay) is held at "Some chop" in that
 * wind, however sheltered the land around it reads: its baked table has
 * land 0.1–0.4 NM off from 090° to 160°, so a south-east trade made it "Very
 * sheltered", and the one note that says otherwise was the reviewed fact.
 */
function parksHeld(candidate: PlaceCandidate, hours: readonly VerdictHour[], verdict: AnchorageVerdict) {
    const winds = candidate.reviewed?.accessWinds;
    if (!winds?.length || (verdict.grade !== 'bombproof' && verdict.grade !== 'good')) return verdict;
    const hit = hours.find(
        (h) => h.windKts >= ACCESS_WIND_MIN_KTS && (winds as readonly string[]).includes(compass8(h.windDirDeg)),
    );
    if (!hit) return verdict;
    return {
        ...verdict,
        grade: 'tenable' as const,
        score: Math.min(verdict.score, 70),
        reasons: [
            `${capital(compassWords(hit.windDirDeg))}erlies can make access difficult (${candidate.reviewed!.parks})`,
            ...verdict.reasons,
        ],
    };
}

/** Land-only shelter for a stay window, from area hours (pre-rank) or route samples (the sweep). */
function scoreStay(
    candidate: PlaceCandidate,
    hours: VerdictHour[],
    perModelWinds: { windDirDeg: number; windKts: number }[][],
    zone: string,
): AnchorageVerdict | null {
    const table = candidate.fetchLandNM;
    if (!table || !hours.length) return null;
    const verdict = scoreAnchorage({
        // Reefs are not shelter: the land table stands in for both.
        anchorage: {
            id: candidate.id,
            name: candidate.name,
            kind: 'anchorage',
            lat: candidate.lat,
            lon: candidate.lon,
            fetchLandNM: table,
            fetchReefNM: table,
        },
        hours,
        perModelWinds: perModelWinds.length >= 2 ? perModelWinds : undefined,
        timeZone: zone,
    });
    return parksHeld(candidate, hours, verdict);
}

function areaStay(
    candidate: PlaceCandidate,
    hours: readonly PointHour[],
    fromMs: number,
    toMs: number,
    zone: string,
): AnchorageVerdict | null {
    const during = hours.filter((h) => h.t + HOUR > fromMs && h.t <= toMs && h.medianKts !== null && h.dirDeg !== null);
    if (!during.length) return null;
    const perModel: { windDirDeg: number; windKts: number }[][] = [];
    const models = during[0].members.length;
    for (let m = 0; m < models; m++) {
        const series = during.map((h) => h.members[m]);
        if (series.every((x) => x && x.kts !== null && x.dirDeg !== null))
            perModel.push(series.map((x) => ({ windDirDeg: x.dirDeg!, windKts: x.kts! })));
    }
    return scoreStay(
        candidate,
        during.map((h) => ({ t: h.t, windDirDeg: h.dirDeg!, windKts: h.medianKts! })),
        perModel,
        zone,
    );
}

/** The plain reason a stop that does not fit the light reads in Not today. */
function lightMissReason(
    stay: StayOption,
    estNm: number,
    arriveMs: number,
    homeMs: number | null,
    window: DayWindow,
): string {
    const last = window.lastLightMs!;
    const zone = window.zone;
    if (stay === 'overnight') {
        if (arriveMs <= last) return 'there in the last of the light';
        if (arriveMs <= last + HOUR) return `there after dark (${hhmm(last, zone)}) at your speed`;
        return `about ${Math.round(estNm)} NM — too far to be there by ${hhmm(last - LIGHT_MARGIN_MS, zone)}`;
    }
    if (homeMs !== null && homeMs <= last) return 'home in the last of the light';
    if (homeMs !== null && homeMs <= last + HOUR) return `home after dark (${hhmm(last, zone)}) at your speed`;
    return `about ${Math.round(estNm)} NM each way — too far for ${stayMenuLabel(stay)}`;
}

/**
 * Every open candidate, cheaply: arrival at cruising speed, the stay scored
 * in the AREA wind (land-only shelter), and whether it fits the light.
 * Ranked by shelter grade, reviewed stops first within a grade, then score,
 * then distance. The first three get their own route forecasts.
 */
export function preRank(args: {
    candidates: readonly PlaceCandidate[];
    window: DayWindow;
    stay: StayOption;
    cruiseKts: number;
    hours: readonly PointHour[];
}): { ranked: PreRankedStop[]; notToday: NotTodayRow[] } {
    const { window, stay, cruiseKts, hours } = args;
    const ranked: PreRankedStop[] = [];
    const notToday: NotTodayRow[] = [];
    const earliest = window.earliestLeaveMs;
    const last = window.lastLightMs;
    for (const candidate of args.candidates) {
        const row = { id: candidate.id, name: candidate.name, straightNm: candidate.straightNm };
        if (earliest === null || last === null) {
            notToday.push({ ...row, reason: 'no daylight' });
            continue;
        }
        const estNm = candidate.distance.nm;
        const outH = cruiseKts > 0 ? estNm / cruiseKts : Infinity;
        const arriveMs = earliest + outH * HOUR;
        const stayH = stayHours(stay);
        const stayEndMs =
            stayH === null ? nextLocalMorning(arriveMs, window.zone, OVERNIGHT_UNTIL_H) : arriveMs + stayH * HOUR;
        const homeMs = stayH === null ? null : stayEndMs + outH * HOUR;
        const fits =
            Number.isFinite(arriveMs) &&
            (stayH === null ? arriveMs <= last - LIGHT_MARGIN_MS : 2 * outH + stayH <= window.usableH);
        if (!fits) {
            notToday.push({ ...row, reason: lightMissReason(stay, estNm, arriveMs, homeMs, window) });
            continue;
        }
        ranked.push({
            candidate,
            estNm,
            outH,
            arriveMs,
            stayEndMs,
            homeMs,
            stay: areaStay(candidate, hours, arriveMs, stayEndMs, window.zone),
        });
    }
    // Within a shelter grade the reviewed stops come first: a south-east trade
    // makes twenty Whitsunday bays "bombproof 100", and by distance alone the
    // best stops for a day out were bays a mile or two from Airlie.
    ranked.sort(
        (a, b) =>
            gradeRank(a.stay) - gradeRank(b.stay) ||
            (a.candidate.reviewed ? 0 : 1) - (b.candidate.reviewed ? 0 : 1) ||
            (b.stay?.score ?? -1) - (a.stay?.score ?? -1) ||
            a.estNm - b.estNm ||
            a.candidate.id.localeCompare(b.candidate.id),
    );
    return { ranked, notToday };
}

/**
 * A stop beyond the best three, on the area wind alone: is there an hourly
 * departure (as the sweep would try them) whose time under way, at cruising
 * speed, has no hour at the point over her limits? Null when there is (or
 * there is no forecast to say); else the plain reason, from the first try.
 */
export function areaVerdict(
    pre: PreRankedStop,
    window: DayWindow,
    stay: StayOption,
    hours: readonly PointHour[],
    limits: DayPlanLimits,
): string | null {
    const earliest = window.earliestLeaveMs;
    const last = window.lastLightMs;
    if (earliest === null || last === null || !hours.length || !Number.isFinite(pre.outH)) return null;
    const outMs = pre.outH * HOUR;
    const stayH = stayHours(stay);
    const first = ceilLocalHour(earliest, window.zone);
    let firstOver: PointHour | null = null;
    for (let k = 0; k < MAX_DEPARTURES; k++) {
        const leave = first + k * HOUR;
        const arrive = leave + outMs;
        const end = stayH === null ? arrive : arrive + stayH * HOUR + outMs;
        if (k > 0 && (stayH === null ? arrive > last - LIGHT_MARGIN_MS : end > last)) break;
        const over =
            overHourBetween(hours, limits, leave, arrive) ??
            (stayH === null ? null : overHourBetween(hours, limits, arrive + stayH * HOUR, end));
        if (!over) return null;
        firstOver ??= over;
    }
    return firstOver ? areaOverReason(firstOver, limits) : null;
}

// ── One stop: the departure sweep ──────────────────────────────

/** A stop's one-way leg forecasts, from todayLoader. The home leg is mirrored here. */
export interface StopLegs {
    /** The headline model's series for start → stop. */
    headline: RouteForecast | null;
    /** Its name as shown, "ECMWF". */
    headlineModel: string;
    /** The chart's model did not answer; this is the first that did. */
    substituted?: boolean;
    spread: RouteSpread | null;
    sea: RouteSea | null;
    /** The route request failed outright. */
    failed?: boolean;
}

export type HowWord = 'sailing' | 'beating' | 'motoring' | 'at cruising speed';
const HOW_WORD: Record<SpeedHow, HowWord> = {
    sail: 'sailing',
    tack: 'beating',
    motor: 'motoring',
    cruise: 'at cruising speed',
    assumed: 'at cruising speed',
};

export interface LegSummary {
    durationMs: number | null;
    /** The majority of the walk's rows. */
    how: HowWord;
    /** The headline model's wind over the leg. */
    loKts: number | null;
    hiKts: number | null;
    dirDeg: number | null;
    gustKts: number | null;
    /** The worst spread level along the leg, and the fewest members answering. */
    spreadLevel: SpreadLevel;
    members: number;
    of: number;
    waveLoM: number | null;
    waveHiM: number | null;
    /** Part of the leg had no wave reading (snapped too far inshore, or none). */
    seaGap: boolean;
}

export interface DepartureEval extends ScoredDeparture {
    arriveMs: number | null;
    stayEndMs: number | null;
    /** Day trip only. */
    homeMs: number | null;
    level: StopLevel;
    /** The plain reason, when it is not Inside, kept without "over your limits: " (127-PYD-1). */
    reason: string | null;
    /** The row's form of a long reason: "⚡ Thunder on the way home", "Chop for the stay (SE 21 kn)". */
    short: string | null;
    out: LegSummary;
    home: LegSummary | null;
    /** Shelter over the stay, in the route forecast at the stop (with swell when known). */
    stay: AnchorageVerdict | null;
    light: LightLevel;
    /** The most point-block models with thunder while under way. */
    thunder: number;
    /** The stop's own station had no wave reading. */
    stopSeaInshore: boolean;
}

export interface StopPlan {
    id: string;
    pre: PreRankedStop;
    departures: DepartureEval[];
    best: DepartureEval | null;
    /** The best departure's window (≤ 3 h, hourly), in time order. */
    window: DepartureEval[];
    level: StopLevel;
    headlineModel: string;
    substituted: boolean;
    weatherLoaded: boolean;
    /** The wave forecast along the leg loaded (it may still read nothing inshore). */
    seaLoaded: boolean;
}

const STOP_RANK: Record<StopLevel, number> = { inside: 0, near: 1, unknown: 2, over: 3 };
const SPREAD_RANK: SpreadLevel[] = ['none', 'agree', 'some', 'split'];

interface LegWalk {
    rows: { t: number; along: number; how: SpeedHow }[];
    durationMs: number | null;
}

function walkLeg(
    index: RouteIndex,
    startMs: number,
    forecast: RouteForecast | null,
    speed: PassageSpeedModel,
    factor: number,
): LegWalk {
    const plan = planPassage({
        index,
        startAlongNm: 0,
        backNm: 0,
        startMs,
        forecast,
        model: speed,
        maxMs: LEG_MAX_MS,
    });
    return {
        // An estimated (straight-line) distance stretches the clock, not the line.
        rows: plan.offsetsMs.map((o, i) => ({ t: startMs + o * factor, along: plan.alongNm[i], how: plan.how[i] })),
        durationMs: plan.arrivalMs === null ? null : plan.arrivalMs * factor,
    };
}

interface LegStats extends LegSummary {
    maxWind: number;
    maxWindDir: number | null;
    maxHeadwind: number;
    maxGust: number;
    maxWave: number;
    gustComplete: boolean;
    waveComplete: boolean;
    memberMax: number;
    unknown: boolean;
}

function legStats(
    walk: LegWalk,
    index: RouteIndex,
    forecast: RouteForecast | null,
    spread: RouteSpread | null,
    sea: RouteSea | null,
): LegStats {
    const s: LegStats = {
        durationMs: walk.durationMs,
        how: 'at cruising speed',
        loKts: null,
        hiKts: null,
        dirDeg: null,
        gustKts: null,
        spreadLevel: 'none',
        members: Infinity,
        of: 0,
        waveLoM: null,
        waveHiM: null,
        seaGap: false,
        maxWind: 0,
        maxWindDir: null,
        maxHeadwind: 0,
        maxGust: 0,
        maxWave: 0,
        gustComplete: true,
        waveComplete: true,
        memberMax: 0,
        unknown: walk.durationMs === null,
    };
    const hows = new Map<HowWord, number>();
    const dirs: number[] = [];
    for (const row of walk.rows) {
        const word = HOW_WORD[row.how];
        hows.set(word, (hows.get(word) ?? 0) + 1);
        const wind = sampleRouteForecast(forecast, row.along, row.t);
        if (row.how === 'assumed' || wind.beyond || wind.twsKts === null) s.unknown = true;
        if (wind.twsKts !== null) {
            const tws = wind.twsKts;
            s.loKts = s.loKts === null ? tws : Math.min(s.loKts, tws);
            s.hiKts = s.hiKts === null ? tws : Math.max(s.hiKts, tws);
            if (tws >= s.maxWind) {
                s.maxWind = tws;
                s.maxWindDir = wind.twdDeg;
            }
            if (wind.twdDeg !== null) {
                dirs.push(wind.twdDeg);
                const course = stationOnIndex(index, row.along)?.bearingDeg;
                if (finite(course))
                    s.maxHeadwind = Math.max(s.maxHeadwind, tws * Math.cos(((wind.twdDeg - course) * Math.PI) / 180));
            }
        }
        const members = sampleRouteSpread(spread, row.along, row.t);
        const memberGusts = members.members.flatMap((m) => (m.gustKts === null ? [] : [m.gustKts]));
        // The headline's own gust; else the spread's; never none counted as calm.
        const gust = wind.gustKts ?? members.gustMaxKts ?? (memberGusts.length ? Math.max(...memberGusts) : null);
        if (gust === null) s.gustComplete = false;
        else s.maxGust = Math.max(s.maxGust, gust);
        if (members.maxKts !== null) s.memberMax = Math.max(s.memberMax, members.maxKts);
        if (SPREAD_RANK.indexOf(members.level) > SPREAD_RANK.indexOf(s.spreadLevel)) s.spreadLevel = members.level;
        if (members.of > 0) {
            s.of = members.of;
            s.members = Math.min(s.members, members.members.length);
        }
        const wave = sampleRouteSea(sea, row.along, row.t);
        if (wave.inshore) s.seaGap = true;
        if (wave.waveM !== null && !wave.inshore && !wave.beyond) {
            s.maxWave = Math.max(s.maxWave, wave.waveM);
            s.waveLoM = s.waveLoM === null ? wave.waveM : Math.min(s.waveLoM, wave.waveM);
            s.waveHiM = s.waveHiM === null ? wave.waveM : Math.max(s.waveHiM, wave.waveM);
        } else {
            s.waveComplete = false;
            s.seaGap = true;
        }
    }
    if (!Number.isFinite(s.members)) s.members = 0;
    s.dirDeg = circularMeanDeg(dirs);
    s.gustKts = s.gustComplete || s.maxGust > 0 ? s.maxGust : null;
    const order: HowWord[] = ['sailing', 'beating', 'motoring', 'at cruising speed'];
    s.how = order.reduce((a, b) => ((hows.get(b) ?? 0) > (hows.get(a) ?? 0) ? b : a), order[0]);
    if (!hows.size) s.how = 'at cruising speed';
    return s;
}

function summary(s: LegStats): LegSummary {
    return {
        durationMs: s.durationMs,
        how: s.how,
        loKts: s.loKts,
        hiKts: s.hiKts,
        dirDeg: s.dirDeg,
        gustKts: s.gustKts,
        spreadLevel: s.spreadLevel,
        members: s.members,
        of: s.of,
        waveLoM: s.waveLoM,
        waveHiM: s.waveHiM,
        seaGap: s.seaGap,
    };
}

/** The stay at the stop, hourly, in the route forecast at its end (and its sea, when it has a reading). */
function stopStay(
    candidate: PlaceCandidate,
    alongNm: number,
    fromMs: number,
    toMs: number,
    legs: StopLegs,
    zone: string,
): AnchorageVerdict | null {
    if (!candidate.fetchLandNM) return null;
    const ticks: number[] = [];
    for (let t = fromMs; t < toMs; t += HOUR) ticks.push(t);
    ticks.push(toMs);
    const hours: VerdictHour[] = [];
    const kept: number[] = [];
    for (const t of ticks) {
        const w = sampleRouteForecast(legs.headline, alongNm, t);
        if (w.twsKts === null || w.twdDeg === null) continue;
        const sea = sampleRouteSea(legs.sea, alongNm, t);
        const swell =
            !sea.inshore && sea.waveM !== null && sea.waveFromDeg !== null
                ? { swellDirDeg: sea.waveFromDeg, swellM: sea.waveM, swellPeriodS: sea.wavePeriodS ?? undefined }
                : {};
        hours.push({ t, windDirDeg: w.twdDeg, windKts: w.twsKts, ...swell });
        kept.push(t);
    }
    const perModel: { windDirDeg: number; windKts: number }[][] = [];
    for (const model of legs.spread?.asked ?? []) {
        const member = legs.spread?.members[model];
        if (!member) continue;
        const series = kept.map((t) => sampleRouteForecast(member, alongNm, t));
        if (series.every((x) => x.twsKts !== null && x.twdDeg !== null))
            perModel.push(series.map((x) => ({ windDirDeg: x.twdDeg!, windKts: x.twsKts! })));
    }
    return scoreStay(candidate, hours, perModel, zone);
}

/** "Open to the SE …" → "open to the SE …", inside a sentence; "SE 18 kn …" and "1.8 m …" stay as they are. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * A stay reason's row form (127-PYD-1), at most 30 characters so the row keeps
 * its two lines: "Chop for the stay (SE 21 kn)" from "Open to the SE — SE 21
 * kn has 15+ NM of fetch" or "SE 21 kn works across 9.5 NM — expect chop",
 * "Swell for the stay (1.8 m SSE)" from "1.8 m SSE swell finds a way in —
 * expect roll" (scoreAnchorage's words). The whole sentence stays for
 * VoiceOver, Not today and the stop page.
 */
function stayShort(why = ''): string {
    const m = /([A-Z]+ \d+ kn)|^([\d.]+ m [A-Z]+)/.exec(why);
    return m ? `${m[1] ? 'Chop' : 'Swell'} for the stay (${m[1] ?? m[2]})` : 'Exposed for the stay';
}

export interface PlanStopArgs {
    pre: PreRankedStop;
    start: LatLon;
    window: DayWindow;
    stay: StayOption;
    speed: PassageSpeedModel;
    limits: DayPlanLimits;
    legs: StopLegs;
    /** The point block, for thunder while under way. */
    hours: readonly PointHour[];
    blockModels: number;
}

/**
 * Hourly departures from the earliest leave (on the place's hour), at most
 * fourteen, while she can still be home by last light (day trip) or there half
 * an hour before it (overnight). Each is walked out along the one-way leg in
 * the headline model's wind, and home along the same leg turned round.
 */
export function planStop(args: PlanStopArgs): StopPlan {
    const { pre, start, window, stay, speed, limits, legs, hours } = args;
    const c = pre.candidate;
    const zone = window.zone;
    const coords = routeCoords(start, c);
    const index = buildRouteIndex(coords);
    const homeIndex = buildRouteIndex([...coords].reverse());
    const factor = c.distance.factor;
    const homeHeadline = mirrorRouteForecast(legs.headline);
    const homeSpread = mirrorRouteSpread(legs.spread);
    const homeSea = mirrorRouteSea(legs.sea);
    const stayH = stayHours(stay);
    const last = window.lastLightMs;
    const earliest = window.earliestLeaveMs;
    const weatherLoaded = !!legs.headline && !legs.failed;
    const base = {
        id: c.id,
        pre,
        headlineModel: legs.headlineModel,
        substituted: !!legs.substituted,
        weatherLoaded,
        seaLoaded: !!legs.sea,
    };
    if (!index || !homeIndex || earliest === null || last === null)
        return { ...base, departures: [], best: null, window: [], level: 'unknown' };
    // Last light, for "home after dark (18:28)" and "home in the last of the light (18:28)".
    const dark = ` (${hhmm(last, zone)})`;

    const thunderBetween = (from: number, to: number) =>
        Math.max(0, ...hours.filter((h) => h.t + HOUR > from && h.t < to).map((h) => h.thunder));

    const evaluate = (departureMs: number): DepartureEval => {
        const outWalk = walkLeg(index, departureMs, legs.headline, speed, factor);
        const out = legStats(outWalk, index, legs.headline, legs.spread, legs.sea);
        const arriveMs = outWalk.durationMs === null ? null : departureMs + outWalk.durationMs;
        const stayEndMs =
            arriveMs === null
                ? null
                : stayH === null
                  ? nextLocalMorning(arriveMs, zone, OVERNIGHT_UNTIL_H)
                  : arriveMs + stayH * HOUR;
        let home: LegStats | null = null;
        let homeMs: number | null = null;
        if (stayH !== null && stayEndMs !== null) {
            const homeWalk = walkLeg(homeIndex, stayEndMs, homeHeadline, speed, factor);
            home = legStats(homeWalk, homeIndex, homeHeadline, homeSpread, homeSea);
            homeMs = homeWalk.durationMs === null ? null : stayEndMs + homeWalk.durationMs;
        }
        const stayVerdict =
            arriveMs !== null && stayEndMs !== null
                ? stopStay(c, index.totalNm, arriveMs, stayEndMs, legs, zone)
                : null;
        const light = lightLevel(stayH === null ? arriveMs : homeMs, last);
        const thunderOut = thunderBetween(departureMs, arriveMs ?? departureMs + LEG_MAX_MS);
        const thunder = Math.max(
            thunderOut,
            stayEndMs !== null && stayH !== null ? thunderBetween(stayEndMs, homeMs ?? stayEndMs + LEG_MAX_MS) : 0,
        );
        const legsList = home ? [out, home] : [out];
        const maxWind = Math.max(...legsList.map((l) => l.maxWind));
        const windiest = legsList.reduce((a, b) => (b.maxWind > a.maxWind ? b : a));
        const maxGust = Math.max(...legsList.map((l) => l.maxGust));
        const maxWave = Math.max(...legsList.map((l) => l.maxWave));
        const gustComplete = legsList.every((l) => l.gustComplete);
        const waveComplete = legsList.every((l) => l.waveComplete);
        const unknown = !weatherLoaded || legsList.some((l) => l.unknown);
        const split = legsList.some((l) => l.spreadLevel === 'split');
        const memberMax = Math.max(...legsList.map((l) => l.memberMax));
        // No wave reading anywhere on the way (snapped inshore, or the sea did
        // not load): her sea limit was never checked, so never Inside.
        const seaUnread = legsList.every((l) => l.waveLoM === null);
        // The day's strip at the point, for the hours she is under way.
        const areaOver =
            overHourBetween(hours, limits, departureMs, arriveMs ?? departureMs + LEG_MAX_MS) ??
            (stayEndMs !== null && stayH !== null
                ? overHourBetween(hours, limits, stayEndMs, homeMs ?? stayEndMs + LEG_MAX_MS)
                : null);

        // Kept without "over your limits: " (127-PYD-1): the words that need it add it once. `short`
        // is the row's form of a long one, so the row keeps its two lines.
        let reason: string | null = null;
        let short: string | null = null;
        const dir = windiest.maxWindDir === null ? '' : `${compass8(windiest.maxWindDir)} `;
        const there = stayH === null ? 'there' : 'home';
        const way = ' on the way';
        const wind = `${dir}${Math.round(maxWind)} kn${way}`;
        if (maxWind >= limits.wind.poor) reason = wind;
        else if (maxGust >= limits.gust.poor) reason = `gusts ${Math.round(maxGust)} kn${way}`;
        else if (maxWave >= limits.wave.poor) reason = `${maxWave.toFixed(1)} m sea${way}`;
        else if (areaOver) reason = areaOverReason(areaOver, limits);
        else if (thunder >= 2) {
            const leg = thunderOut >= 2 ? way : `${way} home`;
            reason = `thunder in ${thunder} of ${args.blockModels} models${leg}`;
            short = `⚡ Thunder${leg}`;
        } else if (stayVerdict?.grade === 'poor') {
            reason = lowerFirst(stayVerdict.reasons[0] ?? 'exposed for the stay');
            short = stayShort(stayVerdict.reasons[0]);
        } else if (arriveMs === null || (stayH !== null && homeMs === null)) reason = 'more than 12 h each way';
        else if (light === 'over') reason = `${there} after dark${dark}`;
        // Near, and why (the stop page's verdict): the first that holds it there.
        const near =
            maxWind >= limits.wind.good
                ? wind
                : memberMax >= limits.wind.poor
                  ? `one model says ${Math.round(memberMax)} kn${way}`
                  : split
                    ? `models split${way}`
                    : light === 'near'
                      ? `${there} in the last of the light${dark}`
                      : stayVerdict?.grade === 'tenable'
                        ? lowerFirst(stayVerdict.reasons[0] ?? 'some chop for the stay')
                        : !gustComplete
                          ? `no gust forecast${way}`
                          : seaUnread
                            ? `no wave reading${way}`
                            : // No shelter table (no coastline): "Shelter not known" is never Inside.
                              !c.fetchLandNM
                              ? 'shelter not known'
                              : null;
        let level: StopLevel;
        if (reason) level = 'over';
        else if (unknown) {
            level = 'unknown';
            reason = weatherLoaded ? 'past the end of the forecast' : "weather didn't load";
        } else if (near) {
            level = 'near';
            reason = near;
        } else level = 'inside';

        return {
            departureMs,
            maxWindKts: maxWind,
            maxHeadwindKts: Math.max(...legsList.map((l) => l.maxHeadwind)),
            maxGustKts: maxGust,
            maxWaveM: maxWave,
            gustComplete,
            waveComplete,
            arriveMs,
            stayEndMs,
            homeMs,
            level,
            reason,
            short,
            out: summary(out),
            home: home ? summary(home) : null,
            stay: stayVerdict,
            light,
            thunder,
            stopSeaInshore: sampleRouteSea(legs.sea, index.totalNm, arriveMs ?? departureMs).inshore,
        };
    };

    const departures: DepartureEval[] = [];
    const first = ceilLocalHour(earliest, zone);
    for (let k = 0; k < MAX_DEPARTURES; k++) {
        const d = evaluate(first + k * HOUR);
        const end = stayH === null ? d.arriveMs : d.homeMs;
        const past = end === null || (stayH === null ? end > last - LIGHT_MARGIN_MS : end > last);
        if (past && k > 0) break;
        departures.push(d);
        if (past) break;
    }
    const terms = departureScoreTerms(departures);
    const score = (d: DepartureEval) => departureScore(d, terms);
    const best =
        departures.reduce<DepartureEval | null>((a, b) => {
            if (!a) return b;
            const byLevel = STOP_RANK[b.level] - STOP_RANK[a.level];
            if (byLevel !== 0) return byLevel < 0 ? b : a;
            return score(b) < score(a) - 1e-6 ? b : a;
        }, null) ?? null;
    const same = best ? departures.filter((d) => d.level === best.level) : [];
    const leaveWindow = best ? compactWindow(same, same.indexOf(best), score) : [];
    return { ...base, departures, best, window: leaveWindow, level: best?.level ?? 'unknown' };
}

/** The one-way leg the stop is planned on: the saved route, or the straight line. */
export function routeCoords(start: LatLon, candidate: PlaceCandidate): LatLon[] {
    return (
        candidate.distance.route?.points.map((p) => ({ lat: p.lat, lon: p.lon })) ?? [
            { lat: start.lat, lon: start.lon },
            { lat: candidate.lat, lon: candidate.lon },
        ]
    );
}

/**
 * "Plot on chart": the pins for the Manual plotter. A day trip is out and
 * home, start → stop → start; an overnight stay is one way. A saved route
 * that joins the two is used as drawn, turned round for the trip home (the
 * stop is not dropped twice). The points are copies. A route too long for
 * the chart to take there and back (over PLOT_DAY_MAX_POINTS pins) falls
 * back to straight pins rather than being refused on the chart.
 */
export function plotDayAction(start: LatLon, candidate: PlaceCandidate, stay: StayOption): PlotDayAction {
    const pins = (out: LatLon[]) =>
        stay === 'overnight'
            ? out
            : [
                  ...out,
                  ...[...out]
                      .reverse()
                      .slice(1)
                      .map((p) => ({ ...p })),
              ];
    let points = pins(routeCoords(start, candidate).map((p) => ({ lat: p.lat, lon: p.lon })));
    let saved = candidate.distance.basis === 'saved' ? candidate.distance.route?.name : undefined;
    if (points.length > PLOT_DAY_MAX_POINTS) {
        points = pins([
            { lat: start.lat, lon: start.lon },
            { lat: candidate.lat, lon: candidate.lon },
        ]);
        saved = undefined;
    }
    return {
        kind: 'plot-day',
        points,
        name: `${stay === 'overnight' ? 'Overnight' : 'Day out'}: ${candidate.name}`,
        stop: candidate.name,
        ...(saved ? { savedRoute: saved } : {}),
    };
}

/** The headline series: the chart's model when it answered, else the first that did (named). */
export function pickHeadlineMember(
    spread: RouteSpread | null,
    preferred: string,
    order: readonly string[],
): { forecast: RouteForecast; model: string; substituted: boolean } | null {
    if (!spread) return null;
    const own = spread.members[preferred];
    if (own) return { forecast: own, model: preferred, substituted: false };
    for (const model of [...order, ...spread.asked]) {
        const member = spread.members[model];
        if (member) return { forecast: member, model, substituted: true };
    }
    return null;
}

// ── Copy ───────────────────────────────────────────────────────

const STOP_GLYPH: Record<StopLevel, string> = { inside: '✓', near: '≈', over: '✕', unknown: '?' };
const STOP_ARIA: Record<StopLevel, string> = {
    inside: 'inside your limits',
    near: 'near your limits',
    over: 'over your limits',
    unknown: 'not known',
};
/** A reason in Not today and the like: "over your limits: SE 30 kn on the way". */
const overWords = (reason: string) => `${STOP_ARIA.over}: ${reason}`;

/** The stop page's first row (127-PYD-1): "✕ Over your limits: thunder in 3 of 7 models on the way home". */
export function stopVerdict(level: StopLevel, reason: string | null): string {
    return `${STOP_GLYPH[level]} ${capital(STOP_ARIA[level])}${reason ? `: ${reason}` : ''}`;
}

/** "About 14 NM each way (straight line, longer round land)", or a saved route's own length. */
export function distanceLine(distance: DistanceEstimate): string {
    if (distance.basis === 'saved')
        return `${distance.nm.toFixed(1)} NM each way (your saved route '${distance.route?.name ?? ''}')`;
    const why = distance.basis === 'crosses' ? 'straight line, longer round land' : 'estimate';
    return `About ${Math.round(distance.nm)} NM each way (${why})`;
}

const aboutNm = (d: DistanceEstimate) =>
    d.basis === 'saved' ? `${d.nm.toFixed(1)} NM` : `about ${Math.round(d.nm)} NM`;

/**
 * A stop's times, short so they can be big (126-17c; Shane, offered it: "your
 * pick"): "07:00 → 10:28 · back 15:57", or an overnight's "07:00 → 10:28 ·
 * about 22 NM". And the same times as VoiceOver reads them, never "right
 * arrow": "Leave 07:00, arrive 10:28, back home 15:57".
 */
export function stopTimes(
    departureMs: number,
    arriveMs: number,
    homeMs: number | null,
    zone: string,
    overnight: DistanceEstimate | null,
): [shown: string, spoken: string] {
    const leave = hhmm(departureMs, zone);
    const arrive = hhmm(arriveMs, zone);
    const home = homeMs === null ? null : hhmm(homeMs, zone);
    const nm = overnight && aboutNm(overnight);
    // "about 1 nautical mile"; a saved route's tenths ("1.0") keep the plural.
    return [
        `${leave} → ${arrive} · ${nm ?? `back ${home ?? '--:--'}`}`,
        `Leave ${leave}, arrive ${arrive}, ${nm ? nm.replace('NM', nm === 'about 1 NM' ? 'nautical mile' : 'nautical miles') : home ? `back home ${home}` : 'home time not known'}`,
    ];
}

export interface StopRow {
    id: string;
    name: string;
    candidate: PlaceCandidate;
    /** A reviewed stop with its own notes (Queensland Parks' here): the "Local notes" tag. */
    parks: boolean;
    shelter: string;
    /** Null: weather not checked. */
    level: StopLevel | null;
    glyph: string;
    /** "{name} · {shelter}". */
    line1: string;
    /** "07:30 → 09:40 · back 15:10" (stopTimes), or why there are no times. */
    line2: string;
    /** line2 as VoiceOver reads it: "Leave 07:30, arrive 09:40, back home 15:10". */
    line2Spoken: string;
    /**
     * A ✕ or ? row's line 2 in place of its times (127-PYD-1): its reason,
     * capitalised ("Home after dark (18:28)", "SE 30 kn on the way" under the
     * ✕ that already says over), and a long one short ("⚡ Thunder on the way
     * home", "Chop for the stay (SE 21 kn)"), so the row keeps its two lines;
     * VoiceOver and the stop page say it whole. Null on an Inside or Near row,
     * and with no plan.
     */
    line2Reason: string | null;
    /** Over or Unknown only, without "over your limits: ". */
    reason: string | null;
    plan: StopPlan | null;
    /** Its route forecasts are still loading. */
    pending: boolean;
    /** "mapped 12 Sep" for an OpenStreetMap place over 24 h old. */
    mapped: string | null;
    ariaLabel: string;
}

function stopRow(
    pre: PreRankedStop,
    plan: StopPlan | null,
    stay: StayOption,
    zone: string,
    mode: 'swept' | 'pending' | 'unswept' | 'no-weather',
): StopRow {
    const c = pre.candidate;
    const best = plan?.best ?? null;
    const verdict = best?.stay ?? pre.stay;
    const shelter = shelterWord(verdict, !!c.fetchLandNM);
    const level: StopLevel | null = plan ? plan.level : null;
    let line2: string;
    let spoken: string | undefined;
    // Times only from a route forecast that loaded: a failed leg's walk is at
    // cruising speed in no wind, and is not shown as if it were a plan.
    if (plan?.weatherLoaded && best && best.arriveMs !== null)
        [line2, spoken] = stopTimes(
            best.departureMs,
            best.arriveMs,
            best.homeMs,
            zone,
            stay === 'overnight' ? c.distance : null,
        );
    else if (mode === 'pending') line2 = `${capital(aboutNm(c.distance))} · checking the route`;
    else if (mode === 'unswept') line2 = `${capital(aboutNm(c.distance))} · route weather not checked`;
    else line2 = `${capital(aboutNm(c.distance))} · weather not checked`;
    // Without times, the line is said as it reads.
    spoken ??= line2;
    const line1 = `${c.name} · ${shelter}`;
    const reason = best && (best.level === 'over' || best.level === 'unknown') ? best.reason : null;
    const line2Reason = reason && (best?.short ?? capital(reason));
    return {
        id: c.id,
        name: c.name,
        candidate: c,
        parks: !!c.reviewed,
        shelter,
        level,
        glyph: level ? STOP_GLYPH[level] : '?',
        line1,
        line2,
        line2Spoken: spoken,
        line2Reason,
        reason,
        plan,
        pending: mode === 'pending',
        mapped: c.mappedAtMs !== undefined ? `mapped ${dayMonth(c.mappedAtMs, zone)}` : null,
        // Each thing once (127-PYD-1): a reason row's times are not on it, and a row with no plan already says why.
        ariaLabel: `${line1}. ${
            level && reason ? `${STOP_ARIA[level]}: ${reason}` : level ? `${spoken}. ${STOP_ARIA[level]}` : spoken
        }`,
    };
}

// ── Notices ────────────────────────────────────────────────────

export type NoticeKind = 'cyclone' | 'old-fix' | 'default-boat' | 'offline' | 'forecast-failed' | 'map-date';
export interface Notice {
    kind: NoticeKind;
    text: string;
}
export interface CycloneNotice {
    name: string;
    distanceNm: number;
    /** From the start to the storm. */
    bearingDeg: number;
    /** "BOM", the official warnings issuer. */
    issuer: string;
}

const knots = (v: number) => (Number.isInteger(round1(v)) ? String(round1(v)) : round1(v).toFixed(1));

/** One line on Screen 1, highest priority first; the rest go to Sources. */
export function notices(args: {
    cyclone?: CycloneNotice | null;
    boatFixAgeMs?: number | null;
    usingDefaultVessel: boolean;
    cruiseKts: number;
    weather: DayPlanInput['weather'];
    weatherMissing: boolean;
    mapDataFromMs: number | null;
    zone: string;
}): { top: Notice | null; rest: Notice[] } {
    const list: Notice[] = [];
    const cy = args.cyclone;
    if (cy && Number.isFinite(cy.distanceNm) && cy.distanceNm <= CYCLONE_NOTICE_NM)
        list.push({
            kind: 'cyclone',
            text: `Tropical cyclone ${cy.name} ${Math.round(cy.distanceNm)} NM ${compass8(cy.bearingDeg)}: check ${cy.issuer} ↗`,
        });
    if (typeof args.boatFixAgeMs === 'number' && args.boatFixAgeMs > OLD_FIX_MS)
        list.push({
            kind: 'old-fix',
            text: `Boat position ${Math.round(args.boatFixAgeMs / HOUR)} h old: still there? ›`,
        });
    if (args.usingDefaultVessel)
        list.push({ kind: 'default-boat', text: `Typical ${knots(args.cruiseKts)} kn boat: set yours in Vessel ›` });
    if (args.weather === 'offline') list.push({ kind: 'offline', text: 'Offline: light and cached tides only' });
    else if (args.weather === 'failed' || (args.weather === 'ok' && args.weatherMissing))
        list.push({ kind: 'forecast-failed', text: 'Forecast unavailable right now. Light and places only.' });
    if (args.mapDataFromMs !== null)
        list.push({ kind: 'map-date', text: `Map data from ${dayMonth(args.mapDataFromMs, args.zone)}` });
    return { top: list[0] ?? null, rest: list.slice(1) };
}

// ── The day ────────────────────────────────────────────────────

export interface DayPlanInput {
    nowMs: number;
    /** The START's zone (resolveTimeZone), never the phone's. */
    zone: string;
    start: LatLon & { name: string };
    /** A chosen chip; omitted, today (or tomorrow when today is too late). */
    date?: string | null;
    stay: StayOption;
    limits: DayPlanLimits;
    speed: PassageSpeedModel;
    usingDefaultVessel: boolean;
    /** queryModelSpread's atmospheric block; null when it did not load. */
    atmos: SpreadBlock<AtmosVar> | null;
    weather: 'ok' | 'loading' | 'offline' | 'failed';
    /** null while the places load. */
    places: GatheredPlaces | null;
    /** 'loading' while OpenStreetMap is still answering (the atlas may already be in). */
    placesStatus?: PlacesStatus;
    tides: readonly Tide[] | null;
    legs?: ReadonlyMap<string, StopLegs>;
    boatFixAgeMs?: number | null;
    cyclone?: CycloneNotice | null;
}

export type PlacesStatus = 'loading' | 'ok' | 'partial' | 'failed';

export type DayPlanState = 'ok' | 'loading' | 'no-daylight' | 'no-places' | 'nothing-in-reach' | 'stay-put';

export interface DayPlanView {
    date: string;
    isToday: boolean;
    /** "today" or "Friday". */
    dayName: string;
    /** Today was too late, so this is tomorrow. */
    tooLate: boolean;
    window: DayWindow;
    chips: DayChip[];
    parts: PartVerdict[];
    headline: Headline;
    facts: { text: string; ariaLabel: string };
    /** How far a stop can be and fit the day, NM. */
    reachNm: number;
    ranked: PreRankedStop[];
    /** Up to three, ranked; Over ones included (nothing is hidden on a rough day). */
    top: StopRow[];
    /** All places: "Fits {today}": stops whose route weather was checked and is not over her limits. */
    fits: StopRow[];
    /** All places: "Weather not checked": the area wind leaves room, but the
     *  route was not checked (beyond the best three, offline, still loading,
     *  or past the end of the forecast). Never listed as fitting. */
    unchecked: StopRow[];
    /** All places: "Not {today}", one line each with its reason. */
    notToday: NotTodayRow[];
    /** The stops that want route forecasts: the one-way leg each. */
    needsLegs: { id: string; coords: LatLon[] }[];
    notices: { top: Notice | null; rest: Notice[] };
    state: DayPlanState;
}

export function planDay(input: DayPlanInput): DayPlanView {
    const { nowMs, zone, start, stay, limits, speed } = input;
    const dates = chipDates(nowMs, zone, 3);
    const windowFor = (date: string) => dayWindow({ date, lat: start.lat, lon: start.lon, zone, nowMs });
    let date = input.date ?? dates[0];
    let tooLate = false;
    let todayWindow: DayWindow | null = null;
    if (!input.date) {
        todayWindow = windowFor(dates[0]);
        if (tooLateFor(todayWindow, stay)) {
            date = dates[1];
            tooLate = true;
        }
    }
    const window = windowFor(date);
    const atmos = input.atmos;
    const weatherOk = input.weather === 'ok' && !!atmos?.models.length;
    const hours = weatherOk ? pointHours(atmos) : [];
    const parts = dayParts(window, hours, limits, nowMs);
    const byDate = dates.map((d) => (d === date ? parts : dayParts(windowFor(d), hours, limits, nowMs)));
    const chips = dayChips({ atmos: weatherOk ? atmos : null, zone, nowMs, dates, parts: byDate });
    const dayName = window.isToday ? 'today' : weekdayLong(date, zone);
    const chipLabel = (d: string) => chips.find((c) => c.date === d)?.label ?? weekdayShort(d, zone);
    const lighter = weatherOk
        ? dates.find((d, i) => d !== date && byDate[i].some((p) => p.level === 'inside'))
        : undefined;

    // Places: closures first, then the cheap rank, then the sweep for the top three.
    const places = input.places;
    const { open, closed } = places ? splitClosed(places.candidates, date) : { open: [], closed: [] };
    const { ranked, notToday: missedLight } = preRank({
        candidates: open,
        window,
        stay,
        cruiseKts: speed.cruiseKts,
        hours,
    });
    const top = ranked.slice(0, SWEEP_STOPS);
    const needsLegs = weatherOk
        ? top.map((pre) => ({ id: pre.candidate.id, coords: routeCoords(start, pre.candidate) }))
        : [];
    const blockModels = atmos?.models.length ?? 0;
    const planned = top.map((pre) => {
        const legs = weatherOk ? input.legs?.get(pre.candidate.id) : undefined;
        const plan = legs ? planStop({ pre, start, window, stay, speed, limits, legs, hours, blockModels }) : null;
        return { pre, plan, legs };
    });
    // Final rank: the best departure's level, then the stay, then the
    // departure score (gust and wave only where every stop has them), then distance.
    const bests = planned.flatMap(({ plan }) => (plan?.best ? [plan.best] : []));
    const terms = departureScoreTerms(bests);
    planned.sort((a, b) => {
        if (!a.plan || !b.plan) return 0;
        return (
            STOP_RANK[a.plan.level] - STOP_RANK[b.plan.level] ||
            (b.plan.best?.stay?.score ?? -1) - (a.plan.best?.stay?.score ?? -1) ||
            (a.plan.best && b.plan.best
                ? departureScore(a.plan.best, terms) - departureScore(b.plan.best, terms)
                : 0) ||
            a.pre.estNm - b.pre.estNm
        );
    });
    const topRows = planned.map(({ pre, plan, legs }) =>
        stopRow(pre, plan, stay, zone, plan ? 'swept' : !weatherOk ? 'no-weather' : legs ? 'swept' : 'pending'),
    );
    const restRows = ranked
        .slice(SWEEP_STOPS)
        .map((pre) => ({ pre, row: stopRow(pre, null, stay, zone, weatherOk ? 'unswept' : 'no-weather') }));

    // All places. Only a stop whose own route weather was checked FITS; the
    // rest are judged on the area wind at the point (an hourly departure
    // whose time under way has no hour over her limits) and listed as not
    // checked, or not today with the reason. Nothing unknown reads as fitting.
    const notToday: NotTodayRow[] = [];
    const fits: StopRow[] = [];
    const unchecked: StopRow[] = [];
    const notRow = (row: StopRow, reason: string): NotTodayRow => ({
        id: row.id,
        name: row.name,
        reason,
        straightNm: row.candidate.straightNm,
    });
    for (const row of topRows) {
        const failed = row.plan && !row.plan.weatherLoaded;
        if (row.level === 'over' || failed)
            notToday.push(notRow(row, row.level === 'over' ? overWords(row.reason!) : "weather didn't load"));
        else if (row.level === 'inside' || row.level === 'near') fits.push(row);
        else unchecked.push(row);
    }
    for (const { pre, row } of restRows) {
        const over = weatherOk ? areaVerdict(pre, window, stay, hours, limits) : null;
        if (pre.stay?.grade === 'poor')
            notToday.push(notRow(row, overWords(lowerFirst(pre.stay.reasons[0] ?? 'exposed for the stay'))));
        else if (over) notToday.push(notRow(row, overWords(over)));
        else unchecked.push(row);
    }
    notToday.push(...missedLight, ...closed, ...(places?.excluded ?? []));

    // The headline, by priority. While OpenStreetMap is still answering the
    // places are the offline atlas only: "nothing mapped" would be premature.
    const placesSettled = input.placesStatus !== 'loading';
    const reachNm = reachRadiusNm(speed.cruiseKts, window.usableH, stayHours(stay) ?? 'overnight');
    const active = parts.filter((p) => p.level !== 'past' && p.level !== 'dark');
    let state: DayPlanState = 'ok';
    let headline: Headline;
    if (window.light === 'stays-dark') {
        state = 'no-daylight';
        headline = { text: `No daylight here ${window.isToday ? 'today' : `on ${dayName}`}.` };
    } else if (tooLate && todayWindow?.lastLightMs != null) {
        headline = {
            text: `Too late for a day out: last light ${hhmm(todayWindow.lastLightMs, zone)}. Showing tomorrow.`,
        };
    } else if (input.weather === 'loading') {
        state = 'loading';
        headline = { text: `Checking ${blockModels || 7} models for ${start.name}…` };
    } else if (weatherOk && active.length > 0 && active.every((p) => p.level === 'over')) {
        state = 'stay-put';
        headline = dayHeadline({
            parts,
            isToday: window.isToday,
            dayName,
            agreement: chips.find((c) => c.date === date)?.agreement ?? null,
            lighterDay: lighter ? { date: lighter, label: chipLabel(lighter) } : null,
            hours,
            limits,
            window,
            models: blockModels,
        });
    } else if (placesSettled && places && !places.candidates.length && !places.excluded.length) {
        state = 'no-places';
        headline = { text: 'No anchorages mapped near here in OpenStreetMap.' };
    } else if (placesSettled && places && !ranked.length) {
        state = 'nothing-in-reach';
        const next = dates[dates.indexOf(date) + 1];
        headline = {
            text:
                `Nothing mapped within ${Math.round(reachNm)} NM fits ${dayName}'s light with ${stayPhrase(stay)}.` +
                ` Try a shorter stay${next ? ` or ${chipLabel(next)}` : ''}.`,
        };
    } else {
        headline = dayHeadline({
            parts,
            isToday: window.isToday,
            dayName,
            agreement: chips.find((c) => c.date === date)?.agreement ?? null,
            lighterDay: lighter ? { date: lighter, label: chipLabel(lighter) } : null,
            hours,
            limits,
            window,
            models: blockModels,
        });
    }

    // A day over her limits fits nothing: a stop that found a gap in it is
    // listed with that, never under "Fits" beneath "Stay put".
    if (state === 'stay-put')
        for (const row of fits.splice(0)) {
            const best = row.plan?.best;
            notToday.push(
                notRow(
                    row,
                    best
                        ? `over your limits most of the day (a gap: leave ${hhmm(best.departureMs, zone)})`
                        : 'over your limits most of the day',
                ),
            );
        }
    notToday.sort((a, b) => a.straightNm - b.straightNm || a.name.localeCompare(b.name));

    return {
        date,
        isToday: window.isToday,
        dayName,
        tooLate,
        window,
        chips,
        parts,
        headline,
        facts: factsLine({ window, tides: input.tides, nowMs }),
        reachNm,
        ranked,
        top: topRows,
        fits,
        unchecked,
        notToday,
        needsLegs,
        notices: notices({
            cyclone: input.cyclone,
            boatFixAgeMs: input.boatFixAgeMs,
            usingDefaultVessel: input.usingDefaultVessel,
            cruiseKts: speed.cruiseKts,
            weather: input.weather,
            weatherMissing: !weatherOk,
            mapDataFromMs: places?.mapDataFromMs ?? null,
            zone,
        }),
        state,
    };
}

// ── The stop's detail (Screen 2) ───────────────────────────────

export const LEAVING_MARINA = 'Leaving a marina: check its approach depth against the tide before you go.';

/**
 * A reviewed stop's own notes, access first, one row each under the stay
 * they belong to: Cid Harbour's shark warning, Chance Bay's south-easterlies.
 * Never dropped, whatever else the detail can or cannot say.
 */
export function parksNotes(candidate: PlaceCandidate): string[] {
    return [...(candidate.reviewed?.accessNotes ?? []), ...(candidate.reviewed?.uncertaintyNotes ?? [])];
}

export interface StopDetailArgs {
    plan: StopPlan;
    /** The chosen leave chip; the best departure when omitted. */
    departure?: DepartureEval | null;
    stay: StayOption;
    window: DayWindow;
    speed: PassageSpeedModel;
    /** settings.polarData is the skipper's own table. */
    polarIsOwn: boolean;
    /** The routers' polar the times were sailed on (hooks/useRoutingPolar); it decides the words. */
    polar?: Pick<ResolvedRoutingPolar, 'source' | 'learnedCells' | 'learning'> | null;
    /** The start is within half a mile of a marina. */
    leavingMarina: boolean;
    /** Reviewed stops with a landing note: the window, or no curve here. */
    landing?: { fromMs: number; toMs: number } | 'no-curve' | null;
}

export interface StopDetail {
    title: string;
    sub: string;
    rows: string[];
    footnote: string;
    chips: { ms: number; label: string; best: boolean }[];
}

/**
 * How a stop's times were worked out, in words: her own polar's figures, her
 * learned polar, or a shape at her cruising speed — and, while a Smart polar
 * is still filling, how far it has got (build 125, 125-08). With the learner
 * switched off in Preferences, nothing says it is learning.
 */
export function timesBasis(
    speed: PassageSpeedModel,
    polar: Pick<ResolvedRoutingPolar, 'source' | 'learnedCells' | 'learning'> | null | undefined,
    polarIsOwn = false,
): string {
    const cruise = `${speed.cruiseKts.toFixed(1)} kn`;
    if (speed.mode !== 'polar' || !speed.isSail) return `Times at ${cruise} cruising speed`;
    // SmartPolarStore's 7 × 6 export grid (services/routingPolar LEARNED_CELLS).
    const cells = (n: number) => `${n} of 42 cells`;
    const off = polar?.learning === false ? ', learning off' : '';
    const source = polar?.source;
    if (source === 'learned') return `Times from your learned polar (${cells(polar?.learnedCells ?? 0)}${off})`;
    const base =
        source === 'imported' || source === 'manual'
            ? "Times from your polar's own figures"
            : `Times from ${
                  (source ? source === 'database-scaled' : polarIsOwn) ? 'your polar' : 'a typical cruising polar'
              } at ${cruise}`;
    if (polar?.learnedCells === undefined) return base;
    return off
        ? `${base} (Smart polar: ${cells(polar.learnedCells)} learned${off})`
        : `${base} (Smart Polars still learning: ${cells(polar.learnedCells)})`;
}

/** §7's rows, in order, as plain strings. */
export function stopDetail(args: StopDetailArgs): StopDetail {
    const { plan, stay, window, speed } = args;
    const zone = window.zone;
    const c = plan.pre.candidate;
    const d = args.departure ?? plan.best;
    const t = (ms: number | null) => (ms === null ? '--:--' : hhmm(ms, zone));
    const rows: string[] = [];
    const legWind = (leg: LegSummary) => {
        const span = windSpan(leg.dirDeg, leg.loKts, leg.hiKts);
        return span ? `, ${span} kn` : '';
    };
    if (d) {
        // It opens on its verdict (127-PYD-1): a ✕ or ≈ stop never opens onto an ordinary-looking plan,
        // and a row below that would say the same (the stay's reason, the light) leaves it to the verdict.
        if (d.reason) rows.push(stopVerdict(d.level, d.reason));
        const said = capital(d.reason ?? '');
        rows.push(
            `Leave ${t(d.departureMs)} → there ${t(d.arriveMs)} (${d.out.durationMs === null ? 'over 12 h' : durationLabel(d.out.durationMs)}, ${d.out.how}${legWind(d.out)})`,
        );
        const shelter = shelterWord(d.stay, !!c.fetchLandNM);
        const why = d.stay?.reasons[0] && d.stay.reasons[0] !== said ? `: ${d.stay.reasons[0]}` : '';
        rows.push(
            stay === 'overnight'
                ? `At anchor ${t(d.arriveMs)} → ${t(d.stayEndMs)} tomorrow · ${shelter}${why}`
                : `Ashore ${t(d.arriveMs)}–${t(d.stayEndMs)} · ${shelter}${why}`,
        );
        // The note names the landing tide; the window follows it, so the tide is said once (127-PYD-1).
        // The note stays whole: it carries its cautions too (Chance Bay's south-easterlies).
        rows.push(...parksNotes(c));
        if (c.reviewed?.landingTide && args.landing !== undefined)
            rows.push(
                args.landing && args.landing !== 'no-curve'
                    ? `Landing window ≈ ${t(args.landing.fromMs)}–${t(args.landing.toMs)} (approx.)`
                    : 'Landing window: no tide prediction here.',
            );
        if (d.home) {
            const spreadNote =
                d.home.spreadLevel === 'some' || d.home.spreadLevel === 'split'
                    ? `, ${d.home.spreadLevel === 'split' ? 'models split' : 'some spread'}: ${d.home.members} of ${d.home.of} models`
                    : '';
            rows.push(
                `Home ${t(d.stayEndMs)} → ${t(d.homeMs)} (${d.home.durationMs === null ? 'over 12 h' : durationLabel(d.home.durationMs)}, ${d.home.how}${legWind(d.home)}${spreadNote})`,
            );
        }
        const last = window.lastLightMs;
        const end = stay === 'overnight' ? d.arriveMs : d.homeMs;
        const word = stay === 'overnight' ? 'There' : 'Home';
        const light =
            window.light === 'no-true-night'
                ? `Light all day: ${word.toLowerCase()} by ${t(end)}`
                : d.light === 'fine' && end !== null && last !== null
                  ? `Light: ${word.toLowerCase()} ${durationLabel(last - end)} before last light (${t(last)})`
                  : `${word} ${d.light === 'near' ? 'in the last of the light' : 'after dark'} (${t(last)})`;
        if (light !== said) rows.push(light);
        const legs = d.home ? [d.out, d.home] : [d.out];
        const lo = Math.min(...legs.flatMap((l) => (l.waveLoM === null ? [] : [l.waveLoM])));
        const hi = Math.max(...legs.flatMap((l) => (l.waveHiM === null ? [] : [l.waveHiM])));
        rows.push(
            !plan.seaLoaded
                ? "Sea: not checked, the wave forecast didn't load"
                : Number.isFinite(lo) && Number.isFinite(hi)
                  ? `Sea on the way ${lo.toFixed(1) === hi.toFixed(1) ? lo.toFixed(1) : `${lo.toFixed(1)}–${hi.toFixed(1)}`} m (Météo-France)${d.stopSeaInshore ? ` · no reading inside ${c.name.split(' · ')[0]}` : ''}`
                  : 'Sea: no wave model this close inshore',
        );
    }
    if (!d) rows.push(...parksNotes(c));
    rows.push(distanceLine(c.distance));
    if (args.leavingMarina) rows.push(LEAVING_MARINA);
    const how = timesBasis(speed, args.polar, args.polarIsOwn);
    return {
        title: c.name,
        sub: `${shortDate(window.date, zone)} · times in ${zoneAbbrev(window.firstLightMs ?? atNoon(window.date, zone), zone)}`,
        rows,
        footnote: `${how} in ${plan.headlineModel} wind. No current. Depth and tide over the route are not checked. Not a clearance.`,
        chips: plan.window.map((w) => ({ ms: w.departureMs, label: hhmm(w.departureMs, zone), best: w === plan.best })),
    };
}

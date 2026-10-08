import type { ComfortParams } from '../types/settings';
import { PASSAGE_DEPARTURE_MAX_MS } from './passageDeparture';
import { FORECAST_TTL_MS, sampleRouteForecast, type RouteForecast } from './routeForecastSampler';
import { sampleRouteSea, type RouteSea } from './routeSeaSampler';
import { sampleRouteSpread, type RouteSpread, type SpreadLevel } from './routeForecastSpread';
import { stationOnIndex, type RouteIndex } from './routeProgress';

const HOUR = 3_600_000;
const MAX_ROUTE_SAMPLES = 2048;
/** Forecast representativeness only: this does not validate the joining geometry. */
export const SUGGESTION_NEAR_ROUTE_NM = 0.05;
type Limits = Pick<ComfortParams, 'maxWindKts' | 'maxGustKts' | 'maxWaveM'>;

export interface PassageDepartureSuggestionInput {
    index: RouteIndex | null;
    startAlongNm: number | null;
    backNm: number;
    /** Pass null unless a vessel profile supplies this cruising speed. */
    cruiseKts: number | null;
    forecast: RouteForecast | null;
    sea?: RouteSea | null;
    spread?: RouteSpread | null;
    comfort?: Limits;
    nowMs: number;
    modelLabel?: string;
}

export interface PassageDepartureSuggestion {
    /** Best individual evaluated departure inside the displayed window. */
    departureMs: number;
    /** Adjacent evaluated HOURS only, never a continuous-clearance claim. */
    windowStartMs: number;
    windowEndMs: number;
    windowDepartures: number;
    approximateStart: boolean;
    uncheckedJoinNm: number;
    modelLabel: string;
    cruiseKts: number;
    durationMs: number;
    maxWindKts: number;
    maxGustKts: number | null;
    maxWaveM: number | null;
    maxHeadwindKts: number;
    gustComplete: boolean;
    waveComplete: boolean;
    /** Waves are ranked only when every eligible candidate has full wave coverage. */
    windOnly: boolean;
    gustsRanked: boolean;
    spreadLevel: SpreadLevel;
    limits: Limits;
    sampleCount: number;
    comparedDepartures: number;
}

export type PassageDepartureSuggestionResult =
    | { status: 'ready'; suggestion: PassageDepartureSuggestion }
    | {
          status: 'unavailable';
          reason: 'profile' | 'position' | 'off-route' | 'forecast' | 'coverage' | 'limits' | 'route';
          message: string;
      };

export type PassageDepartureSuggestionState = PassageDepartureSuggestionResult | { status: 'loading' };

interface RouteSample {
    alongNm: number;
    elapsedMs: number;
    bearings: number[];
}
/** One evaluated departure, as the HUD and Plan Your Day both rank them. */
export interface ScoredDeparture {
    departureMs: number;
    maxWindKts: number;
    maxGustKts: number;
    maxWaveM: number;
    maxHeadwindKts: number;
    gustComplete: boolean;
    waveComplete: boolean;
}
type Candidate = ScoredDeparture;

/** Which of the gust and wave terms may count: only those every candidate has
 *  in full. Never reward a departure merely because gusts/waves disappear from
 *  its forecast. */
export interface DepartureScoreTerms {
    gusts: boolean;
    waves: boolean;
}

export function departureScoreTerms(candidates: readonly ScoredDeparture[]): DepartureScoreTerms {
    return { gusts: candidates.every((c) => c.gustComplete), waves: candidates.every((c) => c.waveComplete) };
}

/** Lower is calmer: wind, plus a share of headwind, gust and wave. */
export function departureScore(c: ScoredDeparture, terms: DepartureScoreTerms): number {
    return (
        c.maxWindKts +
        0.35 * c.maxHeadwindKts +
        (terms.gusts ? 0.25 * c.maxGustKts : 0) +
        (terms.waves ? 5 * c.maxWaveM : 0)
    );
}

/**
 * The departures either side of the best that score within 10 % of it:
 * hourly, contiguous, and at most three hours from first to last. Gaps and
 * rejected candidates (absent from the list) break it. Returns the window,
 * in time order.
 */
export function compactWindow<T extends { departureMs: number }>(
    candidates: readonly T[],
    bestIndex: number,
    score: (candidate: T) => number,
): T[] {
    const best = candidates[bestIndex];
    let first = bestIndex;
    let last = bestIndex;
    const closeScore = (candidate: T) => score(candidate) <= score(best) * 1.1 + 1e-6;
    while (
        last + 1 < candidates.length &&
        candidates[last + 1].departureMs - candidates[first].departureMs <= 3 * HOUR &&
        candidates[last + 1].departureMs - candidates[last].departureMs === HOUR &&
        closeScore(candidates[last + 1])
    )
        last += 1;
    while (
        first > 0 &&
        candidates[last].departureMs - candidates[first - 1].departureMs <= 3 * HOUR &&
        candidates[first].departureMs - candidates[first - 1].departureMs === HOUR &&
        closeScore(candidates[first - 1])
    )
        first -= 1;
    return candidates.slice(first, last + 1);
}

const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const fresh = (at: number, now: number) => Number.isFinite(at) && at > 0 && at <= now && now - at <= FORECAST_TTL_MS;
const limit = (n: number | undefined) => (nonnegative(n) ? n : undefined);

/** Unlike the display samplers, a recommendation may not hold/fill either neighbor. */
function bracket(values: readonly number[], value: number): number[] | null {
    if (!values.length || value < values[0] || value > values[values.length - 1]) return null;
    let lo = 0;
    let hi = values.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return values[lo] === value ? [lo] : lo > 0 ? [lo - 1, lo] : null;
}

function strictCells<S extends { alongNm: number; timesMs: number[] }>(
    stations: S[],
    alongNm: number,
    atMs: number,
    accepts: (station: S, hour: number) => boolean,
): boolean {
    const places = bracket(
        stations.map((station) => station.alongNm),
        alongNm,
    );
    if (!places) return false;
    return places.every((p) => {
        const station = stations[p];
        const hours = bracket(station.timesMs, atMs);
        return (
            !!hours &&
            (hours.length === 1 || station.timesMs[hours[1]] - station.timesMs[hours[0]] <= HOUR) &&
            hours.every((hour) => accepts(station, hour))
        );
    });
}

const windCovered = (forecast: RouteForecast, along: number, at: number) =>
    strictCells(
        forecast.stations,
        along,
        at,
        (s, h) => nonnegative(s.speedKts[h]) && nonnegative(s.dirDeg[h]) && s.dirDeg[h]! <= 360,
    );
const gustCovered = (forecast: RouteForecast, along: number, at: number) =>
    strictCells(forecast.stations, along, at, (s, h) => nonnegative(s.gustKts[h]));
const waveCovered = (sea: RouteSea, along: number, at: number) =>
    strictCells(sea.stations, along, at, (s, h) => !s.inshore && nonnegative(s.waveM[h]));

function validAxes(stations: { alongNm: number; timesMs: number[] }[]): boolean {
    return (
        stations.length > 0 &&
        stations.every(
            (s, i) =>
                nonnegative(s.alongNm) &&
                (!i || s.alongNm > stations[i - 1].alongNm) &&
                s.timesMs.length > 0 &&
                s.timesMs.every((t, h) => Number.isFinite(t) && (!h || t > s.timesMs[h - 1])),
        )
    );
}

/** Hourly travel locations, every remaining route corner (both headings), and exact arrival. */
function routeSamples(
    index: RouteIndex,
    start: number,
    cruise: number,
    backNm: number,
    forecast: RouteForecast,
    sea: RouteSea | null,
): RouteSample[] | null {
    const duration = ((index.totalNm - start) / cruise) * HOUR;
    const joinMs = (backNm / cruise) * HOUR;
    if (!(duration > 0) || duration + joinMs > 7 * 24 * HOUR || index.cumNm.length > MAX_ROUTE_SAMPLES) return null;
    const distances = new Set<number>([start, index.totalNm]);
    for (let elapsed = HOUR; elapsed < duration; elapsed += HOUR) distances.add(start + (elapsed / HOUR) * cruise);
    for (const along of [
        ...index.cumNm,
        ...forecast.stations.map((s) => s.alongNm),
        ...(sea?.stations.map((s) => s.alongNm) ?? []),
    ]) {
        if (along > start && along < index.totalNm) distances.add(along);
    }
    if (distances.size > MAX_ROUTE_SAMPLES) return null;
    return [...distances]
        .sort((a, b) => a - b)
        .map((alongNm) => {
            const station = stationOnIndex(index, alongNm)!;
            const bearings = [station.bearingDeg];
            const corner = index.cumNm.indexOf(alongNm);
            if (corner > 0 && alongNm > start && Number.isFinite(index.bearingDeg[corner - 1]))
                bearings.push(index.bearingDeg[corner - 1]);
            return { alongNm, elapsedMs: joinMs + ((alongNm - start) / cruise) * HOUR, bearings };
        });
}

/** Pure, bounded comparison of the SAME followed route. No routing, fetching, or current-adjusted ETA. */
export function suggestPassageDeparture(input: PassageDepartureSuggestionInput): PassageDepartureSuggestionResult {
    const unavailable = (
        reason: Extract<PassageDepartureSuggestionResult, { status: 'unavailable' }>['reason'],
        message: string,
    ): PassageDepartureSuggestionResult => ({ status: 'unavailable', reason, message });
    const { index, startAlongNm, backNm, cruiseKts, forecast, nowMs } = input;
    const expectedLastLeg = index?.cumNm.reduce(
        (last, value, i, distances) => (i > 0 && value > distances[i - 1] ? i - 1 : last),
        -1,
    );
    if (cruiseKts == null || !Number.isFinite(cruiseKts) || cruiseKts <= 0)
        return unavailable('profile', 'Set a vessel cruising speed to compare departure times.');
    if (
        !index ||
        !Number.isFinite(index.totalNm) ||
        index.totalNm <= 0 ||
        index.lastRealLeg !== expectedLastLeg ||
        index.lastRealLeg < 0 ||
        index.points.length !== index.cumNm.length ||
        index.points.length > MAX_ROUTE_SAMPLES ||
        index.cumNm[0] !== 0 ||
        index.cumNm[index.cumNm.length - 1] !== index.totalNm ||
        index.cumNm.some((value, i) => !nonnegative(value) || (i > 0 && value < index.cumNm[i - 1])) ||
        index.bearingDeg.length !== index.points.length - 1 ||
        index.bearingDeg.some((bearing, i) => index.cumNm[i + 1] > index.cumNm[i] && !Number.isFinite(bearing)) ||
        index.points.some(
            (p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180,
        )
    )
        return unavailable('route', 'A followed route is needed to compare departures.');
    if (
        startAlongNm == null ||
        !Number.isFinite(startAlongNm) ||
        startAlongNm < 0 ||
        startAlongNm >= index.totalNm ||
        !nonnegative(backNm)
    )
        return unavailable('position', 'A current position on the remaining route is needed.');
    if (backNm > SUGGESTION_NEAR_ROUTE_NM)
        return unavailable(
            'off-route',
            'No suggestion: the joining leg is outside the near-route forecast comparison.',
        );
    if (!Number.isFinite(nowMs) || !forecast || !fresh(forecast.fetchedAt, nowMs) || !validAxes(forecast.stations))
        return unavailable('forecast', 'Fresh route forecast data is needed for a suggestion.');
    const sea = input.sea && fresh(input.sea.fetchedAt, nowMs) && validAxes(input.sea.stations) ? input.sea : null;
    const samples = routeSamples(index, startAlongNm, cruiseKts, backNm, forecast, sea);
    if (!samples?.length) return unavailable('route', 'This passage is beyond the bounded departure comparison.');
    const limits: Limits = {
        maxWindKts: limit(input.comfort?.maxWindKts),
        maxGustKts: limit(input.comfort?.maxGustKts),
        maxWaveM: limit(input.comfort?.maxWaveM),
    };
    const candidates: Candidate[] = [];
    let completeCandidates = 0;
    // Start at the next full hour: a suggested "now" would expire before the skipper could tap it.
    for (
        let departureMs = (Math.floor(nowMs / HOUR) + 1) * HOUR;
        departureMs <= nowMs + PASSAGE_DEPARTURE_MAX_MS;
        departureMs += HOUR
    ) {
        const candidate: Candidate = {
            departureMs,
            maxWindKts: 0,
            maxGustKts: 0,
            maxWaveM: 0,
            maxHeadwindKts: 0,
            gustComplete: true,
            waveComplete: true,
        };
        let complete = true;
        for (const point of samples) {
            const at = departureMs + point.elapsedMs;
            if (!windCovered(forecast, point.alongNm, at)) {
                complete = false;
                break;
            }
            const wind = sampleRouteForecast(forecast, point.alongNm, at);
            if (!nonnegative(wind.twsKts) || wind.twdDeg == null || !Number.isFinite(wind.twdDeg) || wind.beyond) {
                complete = false;
                break;
            }
            candidate.maxWindKts = Math.max(candidate.maxWindKts, wind.twsKts);
            for (const bearing of point.bearings)
                candidate.maxHeadwindKts = Math.max(
                    candidate.maxHeadwindKts,
                    wind.twsKts * Math.cos(((wind.twdDeg - bearing) * Math.PI) / 180),
                );
            if (gustCovered(forecast, point.alongNm, at) && nonnegative(wind.gustKts))
                candidate.maxGustKts = Math.max(candidate.maxGustKts, wind.gustKts);
            else candidate.gustComplete = false;
            const wave = sea && waveCovered(sea, point.alongNm, at) ? sampleRouteSea(sea, point.alongNm, at) : null;
            if (wave && nonnegative(wave.waveM) && !wave.inshore && !wave.beyond)
                candidate.maxWaveM = Math.max(candidate.maxWaveM, wave.waveM);
            else candidate.waveComplete = false;
        }
        if (
            !complete ||
            (limits.maxGustKts != null && !candidate.gustComplete) ||
            (limits.maxWaveM != null && !candidate.waveComplete)
        )
            continue;
        completeCandidates += 1;
        if (
            (limits.maxWindKts != null && candidate.maxWindKts > limits.maxWindKts) ||
            (limits.maxGustKts != null && candidate.maxGustKts > limits.maxGustKts) ||
            (limits.maxWaveM != null && candidate.maxWaveM > limits.maxWaveM)
        )
            continue;
        candidates.push(candidate);
    }
    if (!candidates.length)
        return completeCandidates
            ? unavailable('limits', 'No evaluated departure stays within your configured wind, gust and wave limits.')
            : unavailable(
                  'coverage',
                  'Insufficient forecast coverage for the whole remaining passage and configured limits.',
              );
    // Never reward a departure merely because gusts/waves disappear from its forecast.
    const terms = departureScoreTerms(candidates);
    const rankWaves = terms.waves;
    const rankGusts = terms.gusts;
    const score = (c: Candidate) => departureScore(c, terms);
    const best = candidates.reduce((a, b) => (score(b) < score(a) - 1e-6 ? b : a));
    // A compact window of at most three hours. Gaps and rejected candidates break it.
    const window = compactWindow(candidates, candidates.indexOf(best), score);
    const gustComplete = window.every((candidate) => candidate.gustComplete);
    const waveComplete = window.every((candidate) => candidate.waveComplete);
    let spreadLevel: SpreadLevel = 'none';
    const spread = input.spread;
    if (spread && fresh(spread.fetchedAt, nowMs)) {
        // A consistent, fully covered member set; spread is context, not a reward for dropped members.
        const members = Object.fromEntries(
            Object.entries(spread.members).filter(
                ([, member]) =>
                    fresh(member.fetchedAt, nowMs) &&
                    validAxes(member.stations) &&
                    window.every((candidate) =>
                        samples.every((p) => windCovered(member, p.alongNm, candidate.departureMs + p.elapsedMs)),
                    ),
            ),
        );
        if (Object.keys(members).length >= 2 && Object.keys(members).length === spread.asked.length) {
            const ranks: SpreadLevel[] = ['none', 'agree', 'some', 'split'];
            for (const candidate of window)
                for (const point of samples) {
                    const sampled = sampleRouteSpread(
                        { ...spread, members },
                        point.alongNm,
                        candidate.departureMs + point.elapsedMs,
                    );
                    if (ranks.indexOf(sampled.level) > ranks.indexOf(spreadLevel)) spreadLevel = sampled.level;
                }
        }
    }
    return {
        status: 'ready',
        suggestion: {
            ...best,
            windowStartMs: window[0].departureMs,
            windowEndMs: window[window.length - 1].departureMs,
            windowDepartures: window.length,
            approximateStart: backNm > 0,
            uncheckedJoinNm: backNm,
            modelLabel: input.modelLabel || forecast.model,
            cruiseKts,
            durationMs: samples[samples.length - 1].elapsedMs,
            maxWindKts: Math.max(...window.map((candidate) => candidate.maxWindKts)),
            maxHeadwindKts: Math.max(...window.map((candidate) => candidate.maxHeadwindKts)),
            maxGustKts: gustComplete ? Math.max(...window.map((candidate) => candidate.maxGustKts)) : null,
            maxWaveM: waveComplete ? Math.max(...window.map((candidate) => candidate.maxWaveM)) : null,
            gustComplete,
            waveComplete,
            windOnly: !rankWaves,
            gustsRanked: rankGusts,
            spreadLevel,
            limits,
            sampleCount: samples.length,
            comparedDepartures: candidates.length,
        },
    };
}

import type { AutoroutingTrialRoute } from '../../types/autorouting';
import { AUTOROUTING_TRIAL_MAX_POINTS } from '../../types/autorouting';
import type { TrialRouteReview } from '../autoroutingReview';
import {
    assessPlaceConditionsWindow,
    CONDITIONS_MAX_AGE_MS,
    CONDITIONS_MAX_WINDOW_MS,
    type ReadonlyConditionsForecast,
    type ConditionsPlace,
    type PlaceConditions,
    type TrafficLight,
} from '../anchorages/placeConditions';
import type { DayPlannerActivity, DayPlannerDestination } from './destinations';
import type { CataloguePlanBinding, CataloguePlanSelection, CatalogueRouteConstraint } from './cataloguePlanningTypes';
import { assertCatalogueRouteCheckpoints, catalogueRouteWarnings } from './catalogueRouteConstraints';
import { DAY_PLAN_TIME_ZONE, dayPlanLocalDate, isDayPlanTimeZone } from './presentation';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const DAY_PLAN_MAX_CANDIDATES = 4;
/** Includes the destination forecast. Excess coverage is excluded, never thinned silently. */
export const DAY_PLAN_MAX_FORECAST_CELLS = 24;
export const DAY_PLAN_MAX_DEPARTURE_DAYS = 5;
export const DAY_PLAN_MAX_DURATION_HOURS = 36;
export const DAY_PLAN_DEFAULT_LIMITS = { maxWindKts: 20, maxGustKts: 25, maxWaveM: 1.5 } as const;

export interface DayPlanPoint {
    lat: number;
    lon: number;
}
export interface DayPlanRequest {
    start: DayPlanPoint & { label: string };
    departureMs: number;
    maxSailingHours: number;
    stopHours: number;
    mode: 'return' | 'overnight';
    overnightUntilMs?: number;
    returnByMs?: number;
    activities: DayPlannerActivity[];
    /** Explicit stops override activity preferences only, never safety checks.
     * Omit to discover nearby options; an empty array also means no selection. */
    destinationIds?: readonly string[];
    /** Exact public catalogue choice, mutually exclusive with local destination IDs. */
    catalogueSelection?: CataloguePlanSelection;
    speedKts: number;
    draftM: number;
    maxWindKts?: number;
    maxGustKts?: number;
    maxWaveM?: number;
    /** Compare only the selected departure, one hour later and two hours later. */
    flexibleStart?: boolean;
    /** Departure/home civil time; defaults to Brisbane for existing saved callers. */
    timeZone?: string;
}
export interface DayPlanCandidate {
    destination: DayPlannerDestination;
    place: ConditionsPlace;
    catalogue?: CataloguePlanBinding;
}
export interface DayPlanLeg {
    route: AutoroutingTrialRoute;
    review: TrialRouteReview;
    distanceNM: number;
    departureMs: number;
    arrivalMs: number;
}
export interface DayPlanAssessment {
    light: TrafficLight;
    reasons: string[];
    /** Oldest supplied transit forecast; absent when no timestamp is available. */
    fetchedAt?: number;
}
export interface DayPlanOption {
    id: string;
    candidate: DayPlanCandidate;
    legs: DayPlanLeg[];
    departureMs: number;
    arrivalMs: number;
    finishMs: number;
    stayFromMs: number;
    stayToMs: number;
    sailingHours: number;
    distanceNM: number;
    conditions: PlaceConditions;
    transit: DayPlanAssessment;
    routeCheck: DayPlanAssessment;
    light: TrafficLight;
    warnings: string[];
}
export interface DayPlanProgress {
    completed: number;
    total: number;
    destination: string;
    phase: 'routing' | 'weather' | 'complete';
}
export interface DayPlanResult {
    options: DayPlanOption[];
    excluded: { name: string; reason: string }[];
    calculatedAt: number;
    comparedDepartures?: number[];
    coverage?: {
        id: string;
        name: string;
        type: 'reviewed' | 'mapped-reference' | 'catalogue-reference';
        timeZone: string;
        sourceAttributions: string[];
        limitations: string[];
        radiusNM?: number;
        tiles?: number;
    };
}
export interface DayPlannerDependencies {
    route(
        from: DayPlanPoint,
        to: DayPlanPoint,
        signal: AbortSignal,
        constraint?: CatalogueRouteConstraint,
    ): Promise<{
        route: AutoroutingTrialRoute;
        review: TrialRouteReview;
    }>;
    forecast(points: DayPlanPoint[], signal: AbortSignal): Promise<(ReadonlyConditionsForecast | undefined)[]>;
    now(): number;
}
export interface DayPlanTransitSample extends DayPlanPoint {
    fromMs: number;
    toMs: number;
}

const finiteBetween = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const validPoint = (point: DayPlanPoint) =>
    !!point && finiteBetween(point.lat, -80, 80) && finiteBetween(point.lon, -180, 180);
const radians = (value: number) => (value * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;
const pointOf = ([lon, lat]: [number, number]): DayPlanPoint => ({ lat, lon });
const unique = (messages: string[]) => [...new Set(messages)];
const stopIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Day plan cancelled.', 'AbortError');
};
const overallLight = (lights: TrafficLight[]): TrafficLight =>
    lights.includes('red')
        ? 'red'
        : lights.includes('unknown')
          ? 'unknown'
          : lights.includes('amber')
            ? 'amber'
            : 'green';
const lightRank: Record<TrafficLight, number> = { green: 0, amber: 1, unknown: 2, red: 3 };
const compareOptions = (a: DayPlanOption, b: DayPlanOption): number =>
    lightRank[a.light] - lightRank[b.light] ||
    lightRank[overallLight([a.conditions.light, a.transit.light])] -
        lightRank[overallLight([b.conditions.light, b.transit.light])] ||
    a.sailingHours - b.sailingHours ||
    a.departureMs - b.departureMs ||
    a.candidate.destination.id.localeCompare(b.candidate.destination.id);

/** Great-circle distance; only used as a lower bound before a real route exists. */
export function dayPlanDistanceNM(a: DayPlanPoint, b: DayPlanPoint): number {
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const h =
        Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(radians(b.lon - a.lon) / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function validateDayPlanRouteGeometry(coordinates: AutoroutingTrialRoute['coordinates']): void {
    if (coordinates.length < 2 || coordinates.length > AUTOROUTING_TRIAL_MAX_POINTS)
        throw new Error('Route geometry is missing or exceeds the supported size.');
    if (coordinates.some((point) => !Array.isArray(point) || point.length !== 2 || !validPoint(pointOf(point))))
        throw new Error('Route geometry contains invalid positions.');
    // Discovery may wrap longitude, but local chart checks do not support these
    // segments. Do not turn unsupported geometry into a saveable unknown route.
    if (coordinates.some((point, index) => index > 0 && Math.abs(point[0] - coordinates[index - 1][0]) > 180))
        throw new Error('Routes crossing the antimeridian are not supported by day planner chart checks.');
}

export function dayPlanRouteDistanceNM(coordinates: AutoroutingTrialRoute['coordinates']): number {
    validateDayPlanRouteGeometry(coordinates);
    const total = coordinates
        .slice(1)
        .reduce((sum, point, index) => sum + dayPlanDistanceNM(pointOf(coordinates[index]), pointOf(point)), 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error('Route geometry has no usable sailing distance.');
    return total;
}

export function validateDayPlanRequest(request: DayPlanRequest, now: number): void {
    if (request.timeZone !== undefined && !isDayPlanTimeZone(request.timeZone))
        throw new Error('Choose a valid IANA time zone.');
    if (!Number.isFinite(now) || !validPoint(request.start)) throw new Error('Choose a valid start position.');
    if (!finiteBetween(request.departureMs, now, now + DAY_PLAN_MAX_DEPARTURE_DAYS * DAY_MS))
        throw new Error('Choose a departure between now and five days ahead.');
    if (!finiteBetween(request.speedKts, 0.5, 100) || !finiteBetween(request.draftM, 0.1, 30))
        throw new Error('Enter a valid vessel speed and draft.');
    if (!finiteBetween(request.maxSailingHours, 0.25, 24) || !finiteBetween(request.stopHours, 0.25, 24))
        throw new Error('Choose a sailing budget and stop duration between 15 minutes and 24 hours.');
    if (request.mode !== 'return' && request.mode !== 'overnight') throw new Error('Choose return or overnight mode.');
    if (
        !Array.isArray(request.activities) ||
        request.activities.length > 6 ||
        request.activities.some(
            (activity) => !['snorkel', 'beach', 'walk', 'lunch', 'quiet', 'explore'].includes(activity),
        )
    )
        throw new Error('Choose valid activity preferences.');
    if (
        request.destinationIds !== undefined &&
        (!Array.isArray(request.destinationIds) ||
            request.destinationIds.length > DAY_PLAN_MAX_CANDIDATES ||
            request.destinationIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
            new Set(request.destinationIds).size !== request.destinationIds.length)
    )
        throw new Error('Choose up to four distinct destinations.');
    if (request.catalogueSelection !== undefined) {
        const selection = request.catalogueSelection;
        const validRef = (value: { id: string; version: number } | undefined) =>
            !!value &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) &&
            Number.isInteger(value.version) &&
            value.version > 0 &&
            value.version <= 2147483647;
        if (
            !validRef(selection) ||
            (selection.outbound !== undefined && !validRef(selection.outbound)) ||
            (selection.return !== undefined && !validRef(selection.return)) ||
            request.destinationIds?.length
        )
            throw new Error('Choose one exact catalogue reference or local destinations, not both.');
    }
    for (const [key, upper] of [
        ['maxWindKts', 100],
        ['maxGustKts', 150],
        ['maxWaveM', 20],
    ] as const) {
        if (request[key] !== undefined && !finiteBetween(request[key], 0.1, upper))
            throw new Error('Weather limits must be positive, finite values.');
    }
    if (
        (request.maxGustKts ?? DAY_PLAN_DEFAULT_LIMITS.maxGustKts) <
        (request.maxWindKts ?? DAY_PLAN_DEFAULT_LIMITS.maxWindKts)
    )
        throw new Error('The gust limit cannot be lower than the wind limit.');
    if (
        request.returnByMs !== undefined &&
        !finiteBetween(
            request.returnByMs,
            request.departureMs + 1,
            request.departureMs + DAY_PLAN_MAX_DURATION_HOURS * HOUR_MS,
        )
    )
        throw new Error('The return deadline must follow departure within 36 hours.');
    if (
        request.mode === 'overnight' &&
        !finiteBetween(
            request.overnightUntilMs,
            request.departureMs + 1,
            Math.min(request.departureMs + DAY_PLAN_MAX_DURATION_HOURS * HOUR_MS, now + CONDITIONS_MAX_WINDOW_MS),
        )
    )
        throw new Error('Choose an overnight end after departure and within 36 hours.');
}

/** Missing check coverage is advisory. A completed pass with an explicit danger
 * or tide dependency is ineligible, regardless of other clear segments. */
export function assessDayPlanRoute(
    route: AutoroutingTrialRoute,
    review: TrialRouteReview,
    draftM: number,
): DayPlanAssessment {
    validateDayPlanRouteGeometry(route.coordinates);
    if (review?.phase !== 'complete') throw new Error('Route checks did not complete.');
    if (route.localEdit) throw new Error('Edited route evidence is no longer current.');
    const findings = route.providerCheck?.findings ?? [];
    if (route.providerCheck?.status === 'unsafe' || findings.some((finding) => finding.severity === 'danger'))
        throw new Error('The route provider reported a known danger.');
    const reasons: string[] = [];
    let incomplete = review.legs.length !== route.coordinates.length - 1;
    const tideDependency =
        /\b(tide[- ]dependent|requires? (?:a )?tide|needs? (?:a )?tide|tidal (?:window|height|clearance)|at high tide|high[- ]tide only)\b/i;
    if (
        [...route.warnings, ...findings.map((finding) => finding.message)].some((message) =>
            tideDependency.test(message),
        )
    )
        throw new Error('The route depends on a tide or tidal clearance that this planner cannot verify.');
    if (!route.providerCheck || route.providerCheck.status === 'not-reported')
        reasons.push('Provider check coverage is not reported; no provider clearance is implied.');
    else if (route.providerCheck.status === 'caution') reasons.push('The route provider reported a caution.');
    else reasons.push('Provider check status is not understood; inspect the original report.');
    reasons.push(...findings.map((finding) => finding.message), ...route.warnings);
    for (const leg of review.legs) {
        if (!leg) {
            incomplete = true;
            continue;
        }
        const verdict = leg.verdict;
        if (verdict.grade === 'danger' || verdict.issues.some((issue) => issue.severity === 'danger'))
            throw new Error('Local chart checks found a known danger.');
        if (verdict.needsTide || verdict.issues.some((issue) => tideDependency.test(issue.message)))
            throw new Error('Local chart checks require a tide-dependent clearance.');
        if (Number.isFinite(verdict.minDepthM) && verdict.minDepthM! <= draftM)
            throw new Error('Charted depth does not exceed vessel draft.');
        if (
            leg.incomplete ||
            !finiteBetween(verdict.minDepthM, 0, 12000) ||
            !['clear', 'caution'].includes(verdict.grade)
        )
            incomplete = true;
        if (verdict.grade === 'caution') reasons.push('Local chart checks include cautions.');
        reasons.push(...verdict.issues.map((issue) => issue.message));
    }
    if (incomplete)
        reasons.push('Some local chart or depth coverage is incomplete; inspect the entire proposed route.');
    return { light: incomplete ? 'unknown' : reasons.length ? 'amber' : 'green', reasons: unique(reasons) };
}

function bearing(a: DayPlanPoint, b: DayPlanPoint): number {
    const delta = radians(b.lon - a.lon);
    return degrees(
        Math.atan2(
            Math.sin(delta) * Math.cos(radians(b.lat)),
            Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) -
                Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(delta),
        ),
    );
}

function interpolate(a: DayPlanPoint, b: DayPlanPoint, fraction: number): DayPlanPoint {
    const angle = dayPlanDistanceNM(a, b) / 3440.065;
    if (angle < 1e-12) return { ...a };
    const first = Math.sin((1 - fraction) * angle) / Math.sin(angle);
    const second = Math.sin(fraction * angle) / Math.sin(angle);
    const x =
        first * Math.cos(radians(a.lat)) * Math.cos(radians(a.lon)) +
        second * Math.cos(radians(b.lat)) * Math.cos(radians(b.lon));
    const y =
        first * Math.cos(radians(a.lat)) * Math.sin(radians(a.lon)) +
        second * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon));
    const z = first * Math.sin(radians(a.lat)) + second * Math.sin(radians(b.lat));
    return { lat: degrees(Math.atan2(z, Math.hypot(x, y))), lon: degrees(Math.atan2(y, x)) };
}

/** Sample the original path at <=5 NM / <=30-minute spacing, endpoints and
 * turns >=30 degrees. Dense collinear provider vertices do not cost extra cells.
 * Every sample owns a continuous time interval bounded by neighbouring midpoints. */
export function sampleDayPlanTransit(leg: DayPlanLeg, speedKts: number): DayPlanTransitSample[] {
    const points = leg.route.coordinates.map(pointOf);
    const cumulative = [0];
    for (let i = 1; i < points.length; i++)
        cumulative.push(cumulative[i - 1] + dayPlanDistanceNM(points[i - 1], points[i]));
    const total = cumulative.at(-1)!;
    const spacing = Math.min(5, speedKts * 0.5);
    if (!Number.isFinite(total) || total <= 0 || !finiteBetween(speedKts, 0.5, 100))
        throw new Error('Cannot sample invalid route timing.');
    const count = Math.ceil(total / spacing);
    if (count + 1 >= DAY_PLAN_MAX_FORECAST_CELLS)
        throw new Error('The route exceeds the bounded transit forecast coverage budget.');
    const positions = Array.from({ length: count + 1 }, (_, index) => (total * index) / count);
    for (let i = 1; i < points.length - 1; i++) {
        if (cumulative[i] - cumulative[i - 1] < 0.0054 || cumulative[i + 1] - cumulative[i] < 0.0054) continue;
        const change = Math.abs(
            ((bearing(points[i], points[i + 1]) - bearing(points[i - 1], points[i]) + 540) % 360) - 180,
        );
        if (change >= 30 && !positions.some((distance) => Math.abs(distance - cumulative[i]) < 0.0108))
            positions.push(cumulative[i]);
        if (positions.length >= DAY_PLAN_MAX_FORECAST_CELLS)
            throw new Error('Route turns exceed the bounded transit forecast coverage budget.');
    }
    positions.sort((a, b) => a - b);
    let segment = 1;
    return positions.map((distance, index) => {
        while (segment < cumulative.length - 1 && cumulative[segment] < distance) segment++;
        const span = cumulative[segment] - cumulative[segment - 1];
        const point = interpolate(
            points[segment - 1],
            points[segment],
            span ? (distance - cumulative[segment - 1]) / span : 0,
        );
        const from = index === 0 ? 0 : (positions[index - 1] + distance) / 2;
        const to = index === positions.length - 1 ? total : (distance + positions[index + 1]) / 2;
        return {
            ...point,
            fromMs: leg.departureMs + (from / speedKts) * HOUR_MS,
            toMs: leg.departureMs + (to / speedKts) * HOUR_MS,
        };
    });
}

/** Freshness uses the calculation clock. Each cell requires every hourly bracket
 * for its exact transit interval; known adverse weather wins over missing fields. */
export function assessDayPlanTransit(
    samples: DayPlanTransitSample[],
    forecasts: (ReadonlyConditionsForecast | undefined)[],
    request: DayPlanRequest,
    now: number,
): DayPlanAssessment {
    const hazards = new Set<string>();
    const cautions = new Set<string>();
    const missing = new Set<string>();
    let fetchedAt: number | undefined;
    const limits = {
        maxWindKts: request.maxWindKts ?? DAY_PLAN_DEFAULT_LIMITS.maxWindKts,
        maxGustKts: request.maxGustKts ?? DAY_PLAN_DEFAULT_LIMITS.maxGustKts,
        maxWaveM: request.maxWaveM ?? DAY_PLAN_DEFAULT_LIMITS.maxWaveM,
    };
    if (!samples.length || samples.length !== forecasts.length || !Number.isFinite(now))
        missing.add('Transit forecast cells are missing.');
    samples.forEach((sample, index) => {
        const forecast = forecasts[index];
        if (forecast && Number.isFinite(forecast.fetchedAt))
            fetchedAt = fetchedAt === undefined ? forecast.fetchedAt : Math.min(fetchedAt, forecast.fetchedAt);
        if (
            !forecast ||
            !finiteBetween(forecast.fetchedAt, now - CONDITIONS_MAX_AGE_MS, now + 60_000) ||
            !validPoint(forecast) ||
            dayPlanDistanceNM(sample, forecast) > 5
        ) {
            missing.add('Fresh local transit forecast unavailable for part of the route.');
            return;
        }
        if (
            !Number.isFinite(sample.fromMs) ||
            !Number.isFinite(sample.toMs) ||
            sample.toMs <= sample.fromMs ||
            sample.toMs > now + CONDITIONS_MAX_WINDOW_MS
        ) {
            missing.add('Transit forecast period is invalid or outside the forecast horizon.');
            return;
        }
        const first = Math.floor(sample.fromMs / HOUR_MS) * HOUR_MS;
        const last = Math.ceil(sample.toMs / HOUR_MS) * HOUR_MS;
        const hours = forecast.hours.filter((hour) => hour.t >= first && hour.t <= last).sort((a, b) => a.t - b.t);
        if (hours.length !== (last - first) / HOUR_MS + 1)
            missing.add('Transit wind, gust, weather or wave hours are incomplete.');
        hours.forEach((hour, hourIndex) => {
            const windOK = finiteBetween(hour.wind, 0, 180);
            const gustOK = finiteBetween(hour.gust, 0, 220);
            const waveOK = finiteBetween(hour.waveM, 0, 30);
            const weatherOK = finiteBetween(hour.weatherCode, 0, 99) && Number.isInteger(hour.weatherCode);
            if (
                hour.t !== first + hourIndex * HOUR_MS ||
                !windOK ||
                !gustOK ||
                !waveOK ||
                !weatherOK ||
                hour.gust! < hour.wind!
            )
                missing.add('Transit wind, gust, weather or wave hours are incomplete.');
            if (windOK && hour.wind! >= limits.maxWindKts) hazards.add('Transit wind reaches the selected limit.');
            if (gustOK && hour.gust! >= limits.maxGustKts) hazards.add('Transit gusts reach the selected limit.');
            if (waveOK && hour.waveM! >= limits.maxWaveM) hazards.add('Transit waves reach the selected limit.');
            if ([95, 96, 99].includes(hour.weatherCode!)) hazards.add('Thunderstorms forecast along the transit.');
            if (
                (windOK && hour.wind! >= limits.maxWindKts * 0.8) ||
                (gustOK && hour.gust! >= limits.maxGustKts * 0.8) ||
                (waveOK && hour.waveM! >= limits.maxWaveM * 0.8)
            )
                cautions.add('Transit conditions approach the selected weather limits.');
        });
    });
    return {
        light: hazards.size ? 'red' : missing.size ? 'unknown' : cautions.size ? 'amber' : 'green',
        ...(fetchedAt !== undefined ? { fetchedAt } : {}),
        reasons: [
            ...hazards,
            ...missing,
            ...cautions,
            ...(!hazards.size && !missing.size && !cautions.size
                ? ['Forecast wind, gusts and waves remain below the selected transit limits.']
                : []),
        ],
    };
}

/** Shelter cannot waive a selected wind/gust ceiling. Wave assessment remains
 * shelter-aware at the stop; the open-water wave ceiling applies to transit. */
function applyStayWindLimits(
    conditions: PlaceConditions,
    place: ConditionsPlace,
    forecast: ReadonlyConditionsForecast | undefined,
    request: DayPlanRequest,
    now: number,
): PlaceConditions {
    if (
        !forecast ||
        !finiteBetween(forecast.fetchedAt, now - CONDITIONS_MAX_AGE_MS, now + 60_000) ||
        !validPoint(forecast) ||
        dayPlanDistanceNM(place, forecast) > 5
    )
        return conditions;
    const first = Math.floor(conditions.fromMs / HOUR_MS) * HOUR_MS;
    const last = Math.ceil(conditions.toMs / HOUR_MS) * HOUR_MS;
    const reasons: string[] = [];
    let worstAt = conditions.worstAt;
    for (const hour of forecast.hours) {
        if (hour.t < first || hour.t > last) continue;
        const wind =
            finiteBetween(hour.wind, 0, 180) && hour.wind >= (request.maxWindKts ?? DAY_PLAN_DEFAULT_LIMITS.maxWindKts);
        const gust =
            finiteBetween(hour.gust, 0, 220) && hour.gust >= (request.maxGustKts ?? DAY_PLAN_DEFAULT_LIMITS.maxGustKts);
        if (wind) reasons.push('Wind during the stay reaches the selected limit.');
        if (gust) reasons.push('Gusts during the stay reach the selected limit.');
        if ((wind || gust) && (worstAt === undefined || hour.t < worstAt)) worstAt = hour.t;
    }
    return reasons.length
        ? { ...conditions, light: 'red', worstAt, reasons: unique([...reasons, ...conditions.reasons]) }
        : conditions;
}

function applyDestinationQuality(conditions: PlaceConditions, candidate: DayPlanCandidate): PlaceConditions {
    const shared = !!candidate.catalogue || candidate.destination.catalogueQuality === 'catalogue-reference';
    return (shared || candidate.destination.catalogueQuality === 'mapped-reference') && conditions.light !== 'red'
        ? {
              ...conditions,
              light: 'unknown',
              reasons: unique([
                  shared
                      ? 'Reviewed catalogue reference: review does not establish current access, anchoring permission, shelter or holding.'
                      : 'Unreviewed mapped reference: mapped data does not establish permission, activities, shelter or holding.',
                  ...conditions.reasons,
              ]),
          }
        : conditions;
}

function candidateDistanceLowerBound(request: DayPlanRequest, candidate: DayPlanCandidate): number {
    const leg = (from: DayPlanPoint, to: DayPlanPoint, constraint?: CatalogueRouteConstraint) => {
        const points = [from, ...(constraint?.checkpoints ?? []), to];
        return points.slice(1).reduce((sum, point, index) => sum + dayPlanDistanceNM(points[index], point), 0);
    };
    return (
        leg(request.start, candidate.destination, candidate.catalogue?.outbound) +
        (request.mode === 'return' ? leg(candidate.destination, request.start, candidate.catalogue?.return) : 0)
    );
}

/** One documented stop only. The lower-bound shortlist never supplies geometry,
 * timing, clearance or a fallback when the route service fails. */
export async function buildDayPlan(
    request: DayPlanRequest,
    candidates: DayPlanCandidate[],
    deps: DayPlannerDependencies,
    options: { signal: AbortSignal; onProgress?: (progress: DayPlanProgress) => void },
): Promise<DayPlanResult> {
    const { signal, onProgress } = options;
    stopIfAborted(signal);
    const startedAt = deps.now();
    validateDayPlanRequest(request, startedAt);
    const excluded: DayPlanResult['excluded'] = [];
    const selectedIds = new Set(request.destinationIds ?? []);
    if (request.catalogueSelection) {
        const key = (selection: CataloguePlanSelection) =>
            JSON.stringify([
                selection.id,
                selection.version,
                selection.outbound?.id,
                selection.outbound?.version,
                selection.return?.id,
                selection.return?.version,
            ]);
        if (
            candidates.length !== 1 ||
            !candidates[0].catalogue ||
            candidates[0].catalogue.mode !== request.mode ||
            key(candidates[0].catalogue.selection) !== key(request.catalogueSelection)
        )
            throw new Error('The exact selected catalogue reference is unavailable. Recalculate the plan.');
    }
    if ([...selectedIds].some((id) => candidates.filter((candidate) => candidate.destination.id === id).length !== 1))
        throw new Error('A selected destination is unavailable or ambiguous. Refresh the local choices and try again.');
    const eligible = candidates
        .filter((candidate) => !selectedIds.size || selectedIds.has(candidate.destination.id))
        .filter((candidate) => {
            let reason: string | undefined;
            const destination = candidate.destination;
            if (destination.timeZone !== undefined && !isDayPlanTimeZone(destination.timeZone))
                reason = 'The destination has an invalid IANA time zone.';
            else if (
                !selectedIds.size &&
                !request.catalogueSelection &&
                request.activities.length > 0 &&
                !request.activities.some((activity) => destination.activities.includes(activity))
            )
                reason = 'No matching requested activity.';
            else if (candidate.place.noAnchoring && candidate.place.kind !== 'mooring')
                reason = 'Mapped no-anchoring restriction at the proposed stop.';
            else if (
                !validPoint(destination) ||
                !validPoint(candidate.place) ||
                dayPlanDistanceNM(destination, candidate.place) * 1852 > 20
            )
                reason = 'The documented destination has no matching exact anchorage position.';
            else if (dayPlanDistanceNM(request.start, destination) < 0.0108)
                reason = 'The destination is already at the start position.';
            else if (candidateDistanceLowerBound(request, candidate) / request.speedKts > request.maxSailingHours)
                reason = 'Outside the sailing budget even before route detours.';
            if (reason) excluded.push({ name: destination.name, reason });
            return !reason;
        })
        .sort(
            (a, b) =>
                dayPlanDistanceNM(request.start, a.destination) - dayPlanDistanceNM(request.start, b.destination) ||
                a.destination.id.localeCompare(b.destination.id),
        );
    const shortlist = eligible.slice(0, DAY_PLAN_MAX_CANDIDATES);
    excluded.push(
        ...eligible.slice(DAY_PLAN_MAX_CANDIDATES).map((candidate) => ({
            name: candidate.destination.name,
            reason: 'Not assessed: outside this search’s four-destination budget. Narrow the search to check this stop.',
        })),
    );
    const qualified: DayPlanOption[] = [];
    for (let index = 0; index < shortlist.length; index++) {
        stopIfAborted(signal);
        const candidate = shortlist[index];
        const destination = candidate.destination;
        const progress = (phase: DayPlanProgress['phase']) =>
            onProgress?.({
                completed: index + (phase === 'complete' ? 1 : 0),
                total: shortlist.length,
                destination: destination.name,
                phase,
            });
        try {
            progress('routing');
            const checks: DayPlanAssessment[] = [];
            const getLeg = async (
                from: DayPlanPoint,
                to: DayPlanPoint,
                departureMs: number,
                constraint?: CatalogueRouteConstraint,
            ): Promise<DayPlanLeg> => {
                stopIfAborted(signal);
                const sourceWarnings = catalogueRouteWarnings(candidate.catalogue, constraint);
                const calculated = constraint
                    ? await deps.route(from, to, signal, constraint)
                    : await deps.route(from, to, signal);
                const response = sourceWarnings.length
                    ? {
                          ...calculated,
                          route: {
                              ...calculated.route,
                              warnings: unique([...calculated.route.warnings, ...sourceWarnings]),
                          },
                      }
                    : calculated;
                stopIfAborted(signal);
                const distanceNM = dayPlanRouteDistanceNM(response.route.coordinates);
                if (
                    dayPlanDistanceNM(from, pointOf(response.route.coordinates[0])) * 1852 > 20 ||
                    dayPlanDistanceNM(to, pointOf(response.route.coordinates.at(-1)!)) * 1852 > 20
                )
                    throw new Error('Route endpoints do not match the requested positions within 20 metres.');
                if (constraint) assertCatalogueRouteCheckpoints(response.route.coordinates, constraint);
                checks.push(assessDayPlanRoute(response.route, response.review, request.draftM));
                return {
                    ...response,
                    distanceNM,
                    departureMs,
                    arrivalMs: departureMs + (distanceNM / request.speedKts) * HOUR_MS,
                };
            };
            if (candidate.catalogue?.outbound && candidate.catalogue.outbound.direction !== 'outbound')
                throw new Error('The catalogue outbound route has the wrong direction.');
            if (candidate.catalogue?.return && candidate.catalogue.return.direction !== 'return')
                throw new Error('The catalogue return route has the wrong direction.');
            if (candidate.catalogue?.outbound && request.mode === 'return' && !candidate.catalogue.return)
                throw new Error('This catalogue trip has no separately reviewed return route.');
            const outbound = await getLeg(
                request.start,
                destination,
                request.departureMs,
                candidate.catalogue?.outbound,
            );
            stopIfAborted(signal);
            const stayFromMs = outbound.arrivalMs;
            const stayToMs =
                request.mode === 'overnight' ? request.overnightUntilMs! : stayFromMs + request.stopHours * HOUR_MS;
            if (stayToMs < stayFromMs + request.stopHours * HOUR_MS)
                throw new Error('Arrival leaves less than the requested stop duration before the overnight end.');
            for (const closure of destination.knownClosures ?? []) {
                const zone = destination.timeZone ?? request.timeZone ?? DAY_PLAN_TIME_ZONE;
                if (
                    dayPlanLocalDate(stayFromMs, zone) <= closure.throughDate &&
                    dayPlanLocalDate(stayToMs, zone) >= closure.fromDate
                )
                    throw new Error(`Destination closure: ${closure.reason}`);
            }
            const legs = [outbound];
            if (request.mode === 'return') {
                legs.push(await getLeg(destination, request.start, stayToMs, candidate.catalogue?.return));
                stopIfAborted(signal);
            }
            const distanceNM = legs.reduce((sum, leg) => sum + leg.distanceNM, 0);
            const sailingHours = distanceNM / request.speedKts;
            const finishMs = request.mode === 'return' ? legs[1].arrivalMs : stayToMs;
            if (sailingHours > request.maxSailingHours + 1e-9)
                throw new Error('Actual route sailing time exceeds the sailing budget.');
            if (request.mode === 'return' && request.returnByMs !== undefined && finishMs > request.returnByMs)
                throw new Error('Actual route and stop duration miss the return deadline.');
            if (
                finishMs > request.departureMs + DAY_PLAN_MAX_DURATION_HOURS * HOUR_MS ||
                finishMs > startedAt + CONDITIONS_MAX_WINDOW_MS
            )
                throw new Error('The complete itinerary exceeds the supported planning horizon.');
            const samples = legs.flatMap((leg) => sampleDayPlanTransit(leg, request.speedKts));
            if (samples.length + 1 > DAY_PLAN_MAX_FORECAST_CELLS)
                throw new Error('The complete itinerary exceeds the bounded transit forecast coverage budget.');
            progress('weather');
            stopIfAborted(signal);
            const forecasts = await deps.forecast(
                [candidate.place, ...samples].map(({ lat, lon }) => ({ lat, lon })),
                signal,
            );
            stopIfAborted(signal);
            const checkedAt = deps.now();
            const conditions = applyDestinationQuality(
                applyStayWindLimits(
                    assessPlaceConditionsWindow(
                        candidate.place,
                        forecasts[0],
                        { fromMs: stayFromMs, toMs: stayToMs },
                        checkedAt,
                    ),
                    candidate.place,
                    forecasts[0],
                    request,
                    checkedAt,
                ),
                candidate,
            );
            const transit = assessDayPlanTransit(samples, forecasts.slice(1), request, checkedAt);
            const routeCheck = {
                light: overallLight(checks.map((check) => check.light)),
                reasons: unique(checks.flatMap((check) => check.reasons)),
            };
            const light = overallLight([conditions.light, transit.light, routeCheck.light]);
            if (light === 'red')
                throw new Error(
                    unique([
                        ...(conditions.light === 'red' ? conditions.reasons : []),
                        ...(transit.light === 'red' ? transit.reasons : []),
                    ]).join(' '),
                );
            qualified.push({
                id: `${destination.id}:${request.mode}:${request.departureMs}`,
                candidate,
                legs,
                departureMs: request.departureMs,
                arrivalMs: stayFromMs,
                finishMs,
                stayFromMs,
                stayToMs,
                sailingHours,
                distanceNM,
                conditions,
                transit,
                routeCheck,
                light,
                warnings: unique([
                    ...destination.accessNotes,
                    ...destination.uncertaintyNotes,
                    ...routeCheck.reasons,
                    ...(conditions.light !== 'green' ? conditions.reasons : []),
                    ...(transit.light !== 'green' ? transit.reasons : []),
                    'Planning estimates assume constant vessel speed; currents, tide and manoeuvring time are not modelled.',
                    'A proposed itinerary is not navigation clearance or permission to anchor, land or use a mooring.',
                ]),
            });
        } catch (error) {
            stopIfAborted(signal);
            if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
            excluded.push({
                name: destination.name,
                reason: error instanceof Error ? error.message : 'This destination could not be assessed.',
            });
        }
        stopIfAborted(signal);
        progress('complete');
    }
    qualified.sort(compareOptions);
    stopIfAborted(signal);
    return { options: qualified, excluded, calculatedAt: deps.now() };
}

function frozenSnapshot<T>(value: T): T {
    const snapshot = structuredClone(value);
    const freeze = (part: unknown): void => {
        if (!part || typeof part !== 'object' || Object.isFrozen(part)) return;
        Object.freeze(part);
        Object.values(part).forEach(freeze);
    };
    freeze(snapshot);
    return snapshot;
}

/** An explicitly bounded comparison, never a claim to find the optimal sailing
 * window. Only this invocation shares route/forecast snapshots. Every scenario
 * checks freshness again and retains the original absolute finish deadlines. */
export async function buildFlexibleDayPlan(
    request: DayPlanRequest,
    candidates: DayPlanCandidate[],
    deps: DayPlannerDependencies,
    options: { signal: AbortSignal; onProgress?: (progress: DayPlanProgress) => void },
): Promise<DayPlanResult> {
    if (!request.flexibleStart) return buildDayPlan(request, candidates, deps, options);
    stopIfAborted(options.signal);
    const startedAt = deps.now();
    validateDayPlanRequest(request, startedAt);
    const input = frozenSnapshot(request);
    const places = frozenSnapshot(candidates);
    const routes = new Map<string, ReturnType<DayPlannerDependencies['route']>>();
    const forecasts = new Map<string, ReturnType<DayPlannerDependencies['forecast']>>();
    const memoized: DayPlannerDependencies = {
        now: () => deps.now(),
        async route(from, to, signal, constraint) {
            stopIfAborted(signal);
            const key = JSON.stringify([from.lat, from.lon, to.lat, to.lon, constraint ?? null]);
            let task = routes.get(key);
            if (!task) {
                task = (constraint ? deps.route(from, to, signal, constraint) : deps.route(from, to, signal)).then(
                    frozenSnapshot,
                );
                routes.set(key, task);
            }
            const response = await task;
            stopIfAborted(signal);
            return response;
        },
        async forecast(points, signal) {
            stopIfAborted(signal);
            const key = JSON.stringify(points.map(({ lat, lon }) => [lat, lon]));
            let task = forecasts.get(key);
            if (!task) {
                task = deps.forecast(points, signal).then(frozenSnapshot);
                forecasts.set(key, task);
            }
            const response = await task;
            stopIfAborted(signal);
            return response;
        },
    };
    const alternatives: DayPlanOption[] = [];
    const omitted = new Map<string, string[]>();
    const comparedDepartures: number[] = [];
    for (const offsetHours of [0, 1, 2]) {
        stopIfAborted(options.signal);
        const departureMs = input.departureMs + offsetHours * HOUR_MS;
        if (
            departureMs > startedAt + DAY_PLAN_MAX_DEPARTURE_DAYS * DAY_MS ||
            (input.mode === 'return' && input.returnByMs !== undefined && departureMs >= input.returnByMs) ||
            (input.mode === 'overnight' && departureMs + input.stopHours * HOUR_MS >= input.overnightUntilMs!)
        )
            continue;
        const scenario = await buildDayPlan({ ...input, departureMs }, places, memoized, options);
        stopIfAborted(options.signal);
        comparedDepartures.push(departureMs);
        alternatives.push(...scenario.options);
        for (const entry of scenario.excluded)
            omitted.set(entry.name, unique([...(omitted.get(entry.name) ?? []), entry.reason]));
    }
    // The first comparison's forecasts can age while later scenarios run.
    // Reassess retained evidence at one final clock without another network call.
    const assessedAt = deps.now();
    const retained = new Map<string, DayPlanOption>();
    for (const option of alternatives) {
        stopIfAborted(options.signal);
        const samples = option.legs.flatMap((leg) => sampleDayPlanTransit(leg, input.speedKts));
        const points = [option.candidate.place, ...samples].map(({ lat, lon }) => ({ lat, lon }));
        const evidence = await memoized.forecast(points, options.signal);
        stopIfAborted(options.signal);
        const selectedRequest = { ...input, departureMs: option.departureMs };
        const conditions = applyDestinationQuality(
            applyStayWindLimits(
                assessPlaceConditionsWindow(
                    option.candidate.place,
                    evidence[0],
                    { fromMs: option.stayFromMs, toMs: option.stayToMs },
                    assessedAt,
                ),
                option.candidate.place,
                evidence[0],
                selectedRequest,
                assessedAt,
            ),
            option.candidate,
        );
        const transit = assessDayPlanTransit(samples, evidence.slice(1), selectedRequest, assessedAt);
        const refreshed = {
            ...option,
            conditions,
            transit,
            light: overallLight([conditions.light, transit.light, option.routeCheck.light]),
            warnings: unique([
                ...option.warnings,
                ...(conditions.light !== 'green' ? conditions.reasons : []),
                ...(transit.light !== 'green' ? transit.reasons : []),
            ]),
        };
        const previous = retained.get(option.candidate.destination.id);
        if (!previous || compareOptions(refreshed, previous) < 0)
            retained.set(option.candidate.destination.id, refreshed);
    }
    const ranked = [...retained.values()].sort(compareOptions);
    const chosen = ranked;
    for (const option of chosen) omitted.delete(option.candidate.destination.name);
    stopIfAborted(options.signal);
    return {
        options: chosen,
        excluded: [...omitted].map(([name, reasons]) => ({ name, reason: reasons.join(' ') })),
        calculatedAt: deps.now(),
        comparedDepartures,
    };
}

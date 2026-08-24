/**
 * passageClass — what separates a passage from a day sail.
 *
 * THE RULE (agreed with Shane, 2026-08-24): a passage is any trip with
 * PLANNED NIGHT HOURS UNDERWAY, with a 100 nm distance backstop. Distance
 * alone is a proxy that misclassifies in both directions — it flatters the
 * fast boat and insults the slow one — while the night is what actually
 * changes the seamanship: watches, reefing before dark, fatigue, nav lights,
 * and no "pulling in somewhere" when it goes wrong. A 90 nm overnighter IS a
 * passage; a 100 nm daylight sprint in a fast cat is a big day out. The
 * backstop catches the second case anyway, because a 100 nm day carries
 * passage-grade planning weight even in daylight.
 *
 * NUDGE, NEVER GATE. This module only ever produces a VERDICT — what the app
 * does with it is offer the passage kit, badge the log, or say nothing. A
 * forced flow teaches skippers to misclassify the fifty-time delivery as a
 * day cruise to skip the paperwork, poisoning both the data and the intent.
 *
 * Sun math is SunCalc DIRECTLY (the pattern services/weather/diurnalTemp.ts
 * set), never utils/celestial.getSolarTimes — that wrapper formats to HH:MM
 * display strings. And explicitly NOT PassagePdfService's `hour >= 6 &&
 * hour < 18` device-local test, which reads Townsville routes off a Newport
 * wall clock and calls an equatorial winter dusk "daylight".
 *
 * Night is dusk→dawn (civil twilight), computed AT EACH POINT'S OWN POSITION
 * AND TIME — a route sailed east chases the dark, one sailed west runs from
 * it, and only per-point sun times see the difference.
 */
import SunCalc from 'suncalc';
import { calculateDistance } from './navigationCalculations';

export type TripClass = 'day-cruise' | 'passage';

export interface PassageVerdict {
    kind: TripClass;
    /** Hours of the plan spent between civil dusk and civil dawn. */
    nightHours: number;
    distanceNm: number;
    /** Human-readable grounds, in the order they fired. */
    reasons: string[];
}

/** The distance backstop. 100 nm of anything is passage-grade planning. */
export const PASSAGE_DISTANCE_NM = 100;

/**
 * Planned dark time that makes a trip a passage. One full hour, not one
 * grazed minute of dusk: an evening return that clips the first minutes of
 * twilight is a late day sail, and a classifier that cries "passage" over it
 * gets ignored — the same lesson every over-eager alarm in this app has
 * taught (the ping badge, the deaf-punter wording).
 */
export const PASSAGE_NIGHT_HOURS = 1.0;

/** The app-wide speed floor — matches voyageCompute/WeatherRoutingService. */
const MIN_SPEED_KTS = 6;

/** Sampling step for night-hour integration. 30 min resolves a dusk crossing
 *  to ±15 min, which against a 1.0 h threshold is plenty. */
const SAMPLE_MS = 30 * 60 * 1000;

interface LatLon {
    lat: number;
    lon: number;
}

/** Is this instant between civil dusk and civil dawn at this position? */
export function isNightAt(whenMs: number, lat: number, lon: number): boolean {
    const when = new Date(whenMs);
    const t = SunCalc.getTimes(when, lat, lon);
    // High latitudes: SunCalc yields Invalid Date for phases that never
    // happen. Fall back on the sun's altitude itself — the one signal that
    // always exists. Below -6° (civil twilight's floor) counts as night.
    const duskOk = t.dusk instanceof Date && !Number.isNaN(t.dusk.getTime());
    const dawnOk = t.dawn instanceof Date && !Number.isNaN(t.dawn.getTime());
    if (!duskOk || !dawnOk) {
        const alt = (SunCalc.getPosition(when, lat, lon).altitude * 180) / Math.PI;
        return alt < -6;
    }
    // getTimes returns phases for `when`'s calendar day. Between midnight and
    // dawn we are in the PREVIOUS day's night; after dusk, in this day's.
    if (when < t.dawn) return true;
    if (when > t.dusk) return true;
    return false;
}

/**
 * Classify a PLANNED route before departure.
 *
 * Walks the waypoints exactly the way routeReportWeather.schedule does —
 * cumulative haversine over speed, 6 kn floor — then samples the resulting
 * timeline every 30 minutes, asking at each sample "where is the boat, and
 * is it dark THERE, THEN".
 */
export function classifyPlannedRoute(
    points: readonly LatLon[],
    departureMs: number,
    speedKts?: number,
): PassageVerdict {
    const reasons: string[] = [];
    if (points.length < 2 || !Number.isFinite(departureMs)) {
        return { kind: 'day-cruise', nightHours: 0, distanceNm: 0, reasons };
    }
    const kts = Math.max(speedKts ?? MIN_SPEED_KTS, MIN_SPEED_KTS);

    // Per-waypoint cumulative distance and ETA.
    const cum: number[] = [0];
    for (let i = 1; i < points.length; i++) {
        cum.push(cum[i - 1] + calculateDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon));
    }
    const distanceNm = cum[cum.length - 1];
    const totalHours = distanceNm / kts;
    const arrivalMs = departureMs + totalHours * 3_600_000;

    // Sample the timeline; position interpolated along the route by the
    // distance covered at that instant.
    let nightMs = 0;
    for (let t = departureMs; t <= arrivalMs; t += SAMPLE_MS) {
        const covered = ((t - departureMs) / 3_600_000) * kts;
        const pos = positionAtDistance(points, cum, covered);
        const step = Math.min(SAMPLE_MS, arrivalMs - t) || SAMPLE_MS;
        if (isNightAt(t, pos.lat, pos.lon)) nightMs += step;
    }
    const nightHours = nightMs / 3_600_000;

    if (nightHours >= PASSAGE_NIGHT_HOURS) {
        reasons.push(`${nightHours.toFixed(1)} h planned in darkness`);
    }
    if (distanceNm > PASSAGE_DISTANCE_NM) {
        reasons.push(`${Math.round(distanceNm)} nm exceeds the ${PASSAGE_DISTANCE_NM} nm backstop`);
    }
    return {
        kind: reasons.length > 0 ? 'passage' : 'day-cruise',
        nightHours,
        distanceNm,
        reasons,
    };
}

function positionAtDistance(points: readonly LatLon[], cum: readonly number[], atNm: number): LatLon {
    if (atNm <= 0) return points[0];
    for (let i = 1; i < points.length; i++) {
        if (cum[i] >= atNm) {
            const seg = cum[i] - cum[i - 1] || 1;
            const f = (atNm - cum[i - 1]) / seg;
            return {
                lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * f,
                lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * f,
            };
        }
    }
    return points[points.length - 1];
}

/**
 * Classify a COMPLETED voyage from its summary — the retroactive badge.
 *
 * Deliberately summary-grade: it reads only what VoyageSummary already
 * carries (start/end instants, first/last fixes, total distance), so every
 * existing voyage in the log classifies offline with ZERO schema change. The
 * cost is honesty about precision: night hours are sampled along the
 * straight line between the first and last fix, which is exact for the
 * backstop and the crossed-midnight case, and approximate for a route that
 * doubled back. A trip the coarse test calls a passage genuinely was at sea
 * in the dark — false positives need a boat that outran the sun.
 */
export function classifyCompletedVoyage(summary: {
    startedAt: string | null;
    endedAt: string | null;
    totalDistanceNM: number;
    firstLat: number | null;
    firstLon: number | null;
    lastLat: number | null;
    lastLon: number | null;
}): PassageVerdict {
    const reasons: string[] = [];
    const distanceNm = summary.totalDistanceNM || 0;
    let nightHours = 0;

    const start = summary.startedAt ? Date.parse(summary.startedAt) : NaN;
    const end = summary.endedAt ? Date.parse(summary.endedAt) : NaN;
    const hasSpan = Number.isFinite(start) && Number.isFinite(end) && end > start;
    const hasFixes =
        summary.firstLat != null && summary.firstLon != null && summary.lastLat != null && summary.lastLon != null;

    if (hasSpan && hasFixes) {
        const pts: LatLon[] = [
            { lat: summary.firstLat as number, lon: summary.firstLon as number },
            { lat: summary.lastLat as number, lon: summary.lastLon as number },
        ];
        let nightMs = 0;
        for (let t = start; t <= end; t += SAMPLE_MS) {
            const f = (t - start) / (end - start);
            const lat = pts[0].lat + (pts[1].lat - pts[0].lat) * f;
            const lon = pts[0].lon + (pts[1].lon - pts[0].lon) * f;
            const step = Math.min(SAMPLE_MS, end - t) || SAMPLE_MS;
            if (isNightAt(t, lat, lon)) nightMs += step;
        }
        nightHours = nightMs / 3_600_000;
    }

    if (nightHours >= PASSAGE_NIGHT_HOURS) reasons.push(`${nightHours.toFixed(1)} h underway in darkness`);
    if (distanceNm > PASSAGE_DISTANCE_NM) {
        reasons.push(`${Math.round(distanceNm)} nm exceeds the ${PASSAGE_DISTANCE_NM} nm backstop`);
    }
    return {
        kind: reasons.length > 0 ? 'passage' : 'day-cruise',
        nightHours,
        distanceNm,
        reasons,
    };
}

/**
 * Should the escalation ping fire, mid-trip?
 *
 * The porous-boundary case: a day sail running long. Fires when the boat has
 * genuinely been out a while (not a sunset harbour lap) AND darkness is close
 * or already here at the CURRENT position. One-shot handling is the caller's
 * job; this is just the honest condition.
 */
export function escalationDue(nowMs: number, voyageStartMs: number, lat: number, lon: number): boolean {
    const underwayHours = (nowMs - voyageStartMs) / 3_600_000;
    if (!Number.isFinite(underwayHours) || underwayHours < 2) return false;
    if (isNightAt(nowMs, lat, lon)) return true;
    // Within an hour of dusk: the moment worth reefing for, not after.
    const dusk = SunCalc.getTimes(new Date(nowMs), lat, lon).dusk;
    if (dusk instanceof Date && !Number.isNaN(dusk.getTime())) {
        const untilDusk = dusk.getTime() - nowMs;
        return untilDusk >= 0 && untilDusk <= 60 * 60 * 1000;
    }
    return false;
}

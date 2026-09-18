/**
 * passagePlan — how far along she will be, hour by hour, in the wind she is
 * forecast to meet.
 *
 * Phase 2's ghost ran at ONE flat cruising speed (Shane 2026-09-17: "going
 * along the route as its normal cruising speed"). Phase 3 (2026-09-19, "phase
 * 3 - go"): the ghost slows on the nose, and the ETA moves with the forecast.
 * A wind-dependent speed makes offset → distance non-linear AND sequential —
 * each hour's place depends on the hour before — so it is walked once into a
 * table here, and everything on screen (the axis length, the ghost, TO GO, the
 * "AT x KN" tag, the apparent-wind estimate, the screen-reader sentence) reads
 * that one table. Phase 2's review caught FCST and LIVE disagreeing once; two
 * consumers doing their own arithmetic is how that happens again.
 *
 * THE SPEED MODEL, AND WHY IT IS SCALED. The app holds three polars for the
 * same boat that disagree by about 2x (a 55-footer: 4.2 kn peak from the yacht
 * database's generated table, 6.8 from the generic default, 8.2 in the edge
 * router's bundled curve), while the one speed the skipper has actually set —
 * and asked for by name — is the vessel profile's cruising speed. Swapping it
 * for any unscaled table would silently move the ETA by hours. So the polar
 * supplies only the SHAPE (how much slower close-hauled, in light air, dead
 * downwind); it is scaled so that a fair reaching breeze gives exactly her
 * cruising speed. Flat cruising speed stays one tap away.
 *
 *   - inside her close-hauled angle she TACKS: the polar's close-hauled speed,
 *     made good along the course (v·cos θc / cos α). createPolarSpeedLookup on
 *     its own clamps and HOLDS — dead on the nose it hands back close-hauled
 *     boat speed, the opposite of slowing on the nose;
 *   - under 4 kn of true wind she MOTORS (the isochrone router's own rule), and
 *     also whenever the wind would give her less than MOTOR_BELOW_FRACTION of
 *     her cruising speed — this is a cruising boat with an engine, and the
 *     plan is not a race. Motoring loses way into a headwind (the edge router's
 *     own factor);
 *   - a power vessel does her cruising speed. No client-side power model
 *     exists worth trusting, and the strip says CRUISE;
 *   - NO WIND FORECAST (past the model's end, offline, loading) is not a
 *     speed: she is ASSUMED to do her cruising speed, the plan records from
 *     when, and the scrubber says so. A null wind fed to a polar comes back as
 *     the lowest column's speed, which is an invention.
 *
 * Every number from here is an ESTIMATE and is labelled as one where shown.
 */
import { createPolarSpeedLookup } from './isochrone/polar';
import { sampleRouteForecast, type RouteForecast } from './routeForecastSampler';
import { stationOnIndex, type RouteIndex } from './routeProgress';
import type { PolarData } from '../types';

/** The isochrone router's light-air rule (IsochroneRouter: minWindSpeed). */
export const MOTOR_UNDER_TWS_KTS = 4;
/** She motors when the wind would give her less than this share of cruising speed. */
export const MOTOR_BELOW_FRACTION = 0.6;
/** The reaching breeze the polar's shape is scaled at. */
const REFERENCE_TWS_KTS = 15;
const REFERENCE_TWAS = [60, 90, 120, 150];
/** A polar this far from her cruising speed is telling us about another boat. */
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.5;
/** Sailing faster than this multiple of cruising speed is the table, not the boat. */
const MAX_OVER_CRUISE = 1.3;

export const PLAN_STEP_MS = 15 * 60_000;

export type PassageSpeedMode = 'cruise' | 'polar';
/** How a stretch is being made: by her sails, tacking, under engine, flat, or assumed. */
export type SpeedHow = 'sail' | 'tack' | 'motor' | 'cruise' | 'assumed';

export interface PassageSpeedModel {
    mode: PassageSpeedMode;
    cruiseKts: number;
    /** False for a power vessel: `mode` is then treated as 'cruise'. */
    isSail: boolean;
    polar: PolarData;
    /** Closest she sails to the true wind, degrees. */
    closeHauledDeg: number;
}

export interface LegSpeed {
    /** Speed MADE GOOD along the course, kn — what moves the ghost. */
    kts: number;
    how: SpeedHow;
    /**
     * Her way THROUGH THE WATER, kn. The same as `kts` except when tacking,
     * where she is sailing faster than she is getting anywhere. The apparent
     * wind she feels is this one, on her close-hauled heading — not the speed
     * made good dead along a line she is not steering (review, 2026-09-19: the
     * strip read "AWA EST 0°S" while saying TACK).
     */
    boatKts: number;
}

/**
 * How high she points, as the plan prices it: the skipper's close-hauled angle,
 * kept to something a boat can do, and NEVER higher than the polar's first row
 * — createPolarSpeedLookup clamps below it, so a 40° setting on a table that
 * starts at 45° was being credited the 45° speed at 40°, 8–28% too good upwind.
 */
export function pointingDeg(model: Pick<PassageSpeedModel, 'closeHauledDeg' | 'polar'>): number {
    const firstPriced = model.polar.angles?.[0];
    const floor = typeof firstPriced === 'number' && Number.isFinite(firstPriced) ? firstPriced : 0;
    return Math.max(20, Math.min(80, Math.max(model.closeHauledDeg, floor)));
}

/** The polar's speed in a fair reaching breeze — what "cruising speed" is matched to. */
export function polarReferenceKts(polar: PolarData): number {
    const at = createPolarSpeedLookup(polar, REFERENCE_TWS_KTS);
    const values = REFERENCE_TWAS.map((twa) => at(twa)).filter((v) => Number.isFinite(v) && v > 0);
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Multiply the polar by this and a fair reaching breeze gives her cruising speed. */
export function polarScale(polar: PolarData, cruiseKts: number): number | null {
    const ref = polarReferenceKts(polar);
    if (!(ref > 0.5) || !(cruiseKts > 0)) return null;
    const scale = cruiseKts / ref;
    // Outside this the table is about a different boat; better flat than wrong.
    return scale >= MIN_SCALE && scale <= MAX_SCALE ? scale : null;
}

/** Way lost motoring into a headwind — the edge router's own factor. */
function motoringKts(cruiseKts: number, twsKts: number, offBowDeg: number): number {
    return offBowDeg < 45 ? cruiseKts * Math.max(0.5, 1 - (twsKts / 40) * 0.3) : cruiseKts;
}

/**
 * Her speed MADE GOOD along `courseDeg` in a true wind of `twsKts` FROM
 * `twdDeg`. Null wind is 'assumed' at cruising speed — never a polar lookup.
 */
export function passageSpeed(
    model: PassageSpeedModel,
    twsKts: number | null,
    twdDeg: number | null,
    courseDeg: number,
): LegSpeed {
    const cruise = Math.max(0, model.cruiseKts);
    const flat = (how: SpeedHow): LegSpeed => ({ kts: cruise, how, boatKts: cruise });
    if (model.mode === 'cruise' || !model.isSail) return flat('cruise');
    if (twsKts === null || twdDeg === null || !Number.isFinite(courseDeg)) return flat('assumed');
    const scale = polarScale(model.polar, cruise);
    if (scale === null) return flat('cruise');
    const motor = (offBowDeg: number): LegSpeed => {
        const kts = motoringKts(cruise, twsKts, offBowDeg);
        return { kts, how: 'motor', boatKts: kts };
    };

    // Wind angle off the bow, folded to 0…180.
    const offBow = Math.abs(((((twdDeg - courseDeg) % 360) + 540) % 360) - 180);
    if (twsKts < MOTOR_UNDER_TWS_KTS) return motor(offBow);

    const at = createPolarSpeedLookup(model.polar, twsKts);
    // BOTH ENDS OF THE TABLE ARE HELD by the lookup, and a held number is an
    // invented one (review, 2026-09-19). Below the first column — the yacht
    // database's tables start at 6 kn — it handed back the 6-kn speed in 4 kn of
    // wind: "6.1KN SAIL" in a drift. So boat speed runs down to nothing at no
    // wind, and the 60% rule then sends her to the engine. Above the last
    // column there is no reefing model (phase 4): she is at least never credited
    // MORE than her cruising speed on a column that does not exist.
    const columns = model.polar.windSpeeds;
    const firstTws = columns[0];
    const lastTws = columns[columns.length - 1];
    const lightAir = firstTws > 0 && twsKts < firstTws ? twsKts / firstTws : 1;
    const ceiling = twsKts > lastTws ? cruise : cruise * MAX_OVER_CRUISE;

    const pointing = pointingDeg(model);
    let kts: number;
    let boatKts: number;
    let how: SpeedHow;
    if (offBow < pointing) {
        // Tacking either side of the wind: progress along the course is the
        // close-hauled speed's upwind component over cos(angle off the wind).
        const alpha = (offBow * Math.PI) / 180;
        const theta = (pointing * Math.PI) / 180;
        boatKts = Math.min(at(pointing) * scale * lightAir, ceiling);
        kts = (boatKts * Math.cos(theta)) / Math.cos(alpha);
        how = 'tack';
    } else {
        boatKts = Math.min(at(offBow) * scale * lightAir, ceiling);
        kts = boatKts;
        how = 'sail';
    }
    if (!(kts >= cruise * MOTOR_BELOW_FRACTION)) return motor(offBow);
    return { kts, how, boatKts };
}

// ── The walk ───────────────────────────────────────────────────

export interface PassagePlanInput {
    index: RouteIndex;
    /** Her reckoned distance along the route NOW. */
    startAlongNm: number;
    /** Distance back to the line, sailed first (0 when she is on it). */
    backNm: number;
    /** NOW, epoch ms: the forecast is sampled at startMs + offset. */
    startMs: number;
    forecast: RouteForecast | null;
    model: PassageSpeedModel;
    /** Where the axis stops whether she has arrived or not (seven days). */
    maxMs: number;
    stepMs?: number;
}

export interface PassagePlan {
    /** Ascending offsets from NOW, ms; offsetsMs[0] === 0. */
    offsetsMs: number[];
    /** Distance along the route at each offset, NM. */
    alongNm: number[];
    /** Distance still to sail at each offset (way back to the line included), NM. */
    toGoNm: number[];
    /** Speed made good LEAVING each row, kn. */
    kts: number[];
    /** Her way through the water leaving each row, kn (differs from `kts` only when tacking). */
    boatKts: number[];
    how: SpeedHow[];
    /** Offset at which she reaches the end of the route; null if not within `maxMs`. */
    arrivalMs: number | null;
    /** First offset from which her speed is ASSUMED (no wind forecast); null if never. */
    assumedFromMs: number | null;
    /** Last offset in the table: arrival, or `maxMs`. */
    endMs: number;
    totalNm: number;
}

export function planPassage(input: PassagePlanInput): PassagePlan {
    const { index, forecast, model, startMs } = input;
    const stepMs = Math.max(60_000, input.stepMs ?? PLAN_STEP_MS);
    const maxMs = Math.max(0, input.maxMs);
    const totalNm = index.totalNm;
    const cruise = Math.max(0, model.cruiseKts);

    let along = Math.max(0, Math.min(input.startAlongNm, totalNm));
    let back = Math.max(0, input.backNm);
    let t = 0;
    const plan: PassagePlan = {
        offsetsMs: [],
        alongNm: [],
        toGoNm: [],
        kts: [],
        boatKts: [],
        how: [],
        arrivalMs: null,
        assumedFromMs: null,
        endMs: 0,
        totalNm,
    };
    const push = (leg: LegSpeed) => {
        plan.offsetsMs.push(t);
        plan.alongNm.push(along);
        plan.toGoNm.push(back + (totalNm - along));
        plan.kts.push(leg.kts);
        plan.boatKts.push(leg.boatKts);
        plan.how.push(leg.how);
    };

    // A boat with no speed at all never arrives; one row, and the axis is dead.
    if (!(cruise > 0)) {
        push({ kts: 0, how: 'cruise', boatKts: 0 });
        return plan;
    }

    // Bounded: 7 days of 15-minute rows is 672; the +2 is the arrival row.
    const maxRows = Math.ceil(maxMs / stepMs) + 2;
    for (let row = 0; row < maxRows; row++) {
        let leg: LegSpeed;
        if (back > 0) {
            // Working back to her line: no course to hold a wind angle against.
            leg = { kts: cruise, how: 'cruise', boatKts: cruise };
        } else {
            const at = stationOnIndex(index, along);
            const wind = at ? sampleRouteForecast(forecast, along, startMs + t) : null;
            leg = passageSpeed(model, wind?.twsKts ?? null, wind?.twdDeg ?? null, at?.bearingDeg ?? Number.NaN);
            if (leg.how === 'assumed' && plan.assumedFromMs === null) plan.assumedFromMs = t;
        }
        push(leg);

        const remaining = back + (totalNm - along);
        if (remaining <= 1e-9) {
            plan.arrivalMs = t;
            break;
        }
        if (t >= maxMs) break;
        const dtMs = Math.min(stepMs, maxMs - t);
        const canSail = (leg.kts * dtMs) / 3_600_000;
        if (leg.kts > 0 && canSail >= remaining) {
            // She arrives inside this step: land the last row exactly on it.
            t += (remaining / leg.kts) * 3_600_000;
            along = totalNm;
            back = 0;
            // The arrival row keeps the speed she arrived AT. It used to carry 0,
            // and the strip at the end of the axis read "0.0KN SAIL" with an
            // apparent wind worked for a boat standing still. `arrived` is what
            // says she has stopped; this row is never sailed from.
            push(leg);
            plan.arrivalMs = t;
            break;
        }
        const alongTheLine = Math.max(0, canSail - back);
        back = Math.max(0, back - canSail);
        along = Math.min(totalNm, along + alongTheLine);
        t += dtMs;
    }
    plan.endMs = plan.offsetsMs[plan.offsetsMs.length - 1] ?? 0;
    return plan;
}

export interface PlanMoment {
    alongNm: number;
    toGoNm: number;
    kts: number;
    /** Her way through the water, kn — for the apparent-wind estimate. */
    boatKts: number;
    how: SpeedHow;
    arrived: boolean;
    /** Her speed here is assumed: there is no wind forecast for this stretch. */
    assumed: boolean;
}

/** Where the plan has her `aheadMs` from now. Clamped to the table's ends. */
export function planAt(plan: PassagePlan, aheadMs: number): PlanMoment | null {
    const n = plan.offsetsMs.length;
    if (n === 0 || !Number.isFinite(aheadMs)) return null;
    const want = Math.max(0, Math.min(aheadMs, plan.endMs));
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (plan.offsetsMs[mid] <= want) lo = mid;
        else hi = mid - 1;
    }
    const next = Math.min(lo + 1, n - 1);
    const span = plan.offsetsMs[next] - plan.offsetsMs[lo];
    const f = span > 0 ? (want - plan.offsetsMs[lo]) / span : 0;
    return {
        alongNm: plan.alongNm[lo] + (plan.alongNm[next] - plan.alongNm[lo]) * f,
        toGoNm: plan.toGoNm[lo] + (plan.toGoNm[next] - plan.toGoNm[lo]) * f,
        kts: plan.kts[lo],
        boatKts: plan.boatKts[lo],
        how: plan.how[lo],
        arrived: plan.arrivalMs !== null && want >= plan.arrivalMs,
        assumed: plan.how[lo] === 'assumed',
    };
}

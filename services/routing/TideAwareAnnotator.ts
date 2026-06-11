/**
 * TideAwareAnnotator — Masterplan Phases 7–8.
 *
 * Pure POST-PROCESSING over any route polyline: walk the legs with a
 * SpeedModel to stamp per-leg ETAs, then (when a TideField is present)
 * attach the tide height expected at each leg's ETA. The route GEOMETRY
 * is never touched — this honours the engine doctrine that chart datum
 * is LAT and that tide changes feasibility/timing, never preference.
 *
 * Phase 8 (masterplan §5): the same walk solves the vector triangle per
 * leg. Drift w = current + leeway (leeway = coefficient × wind10m,
 * |leeway| capped at capFraction×STW — displacement hull under power);
 * SOG = w·d̂ + sqrt(STW² − |w⊥|²). DOCTRINE: currents/leeway affect
 * ETAs ONLY — never feasibility, never geometry. ≈1/12° CMEMS cannot
 * resolve channel jets, so an "infeasible under drift" leg (STW ≤ |w⊥|,
 * or net SOG ≤ 0 against a foul stream) is FLAGGED for honesty and the
 * ETA walk falls back to plain STW: ETAs must always exist, the flag
 * carries the doubt.
 *
 * Env fields are sampled at each leg's START position and time — an
 * approximation that is fine while legs are short relative to the
 * ≈1/12° (≈9 km) resolution of the source data.
 *
 * Degradation ladder by construction: no env opts → output is
 * byte-identical to the Phase 7 shape (no drift keys on legs); fields
 * present but out of coverage at a leg → that leg's drift fields are
 * null and the walk uses STW. Consumers render what exists and stay
 * silent about what doesn't.
 */

import type { CurrentField2D, SpeedModel, TideField, TideProvenance, Vector2, WindField2D } from './env/EnvFields';

export type LonLat = [number, number]; // GeoJSON order, matches RouteResult.polyline

export type CurrentProvenance = CurrentField2D['provenance'];

/** Masterplan §5 drift-vector model defaults (displacement hull under power). */
export const DEFAULT_LEEWAY_COEFFICIENT = 0.035;
export const DEFAULT_LEEWAY_CAP_FRACTION = 0.3;
/**
 * Advisory-only threshold: legs whose cross-track drift |w⊥| exceeds this
 * fraction of STW count toward AnnotatedRoute.steeringWarnings ("expect
 * set onto the green"). Never gates or reroutes — UI labelling only.
 */
export const STEERING_WARNING_FRACTION = 0.25;

export interface AnnotatedLeg {
    /** Index into the source polyline: leg i runs polyline[i] → polyline[i+1]. */
    index: number;
    lengthM: number;
    /** Course over ground, degrees true (constant-bearing approximation). */
    courseDeg: number;
    /** Unix ms at the leg's START. */
    startMs: number;
    /** Unix ms at the leg's END (start of the next leg). */
    etaMs: number;
    /** Metres above LAT at etaMs, or null (no field / out of coverage). */
    tideAtEtaM: number | null;

    // ── Phase 8 drift fields. ABSENT when annotateRoute was called without
    // env opts (Phase 7 byte-compatibility); NULL when the fields had no
    // coverage at the leg's start, or (sogMs/headingToSteerDeg) when the
    // leg is infeasible under drift and the walk fell back to STW. ──

    /** Speed over ground from the vector triangle, m/s. */
    sogMs?: number | null;
    /** |current| sampled at the leg start, m/s — set magnitude excluding leeway. */
    currentMs?: number | null;
    /** |w⊥| — total drift (current + leeway) across the track, m/s. */
    driftAcrossTrackMs?: number | null;
    /** Heading whose water-track cancels w⊥ (crab upstream into the set),
     *  degrees true. Null when no heading can hold the track. */
    headingToSteerDeg?: number | null;
    /** STW cannot cancel the cross-track drift (or cannot make way against
     *  the stream). Honesty flag ONLY — the ETA walk used plain STW. */
    infeasibleUnderDrift?: boolean;
}

export interface AnnotatedRoute {
    legs: AnnotatedLeg[];
    departMs: number;
    arriveMs: number;
    totalLengthM: number;
    /** Provenance of the tide source used, 'NONE' when absent. */
    tideProvenance: TideProvenance;
    /** Provenance of the current source used, 'NONE' when absent. */
    currentProvenance: CurrentProvenance;
    /** Count of legs where |w⊥| > STEERING_WARNING_FRACTION × STW. Advisory only. */
    steeringWarnings: number;
}

function haversineM(aLonLat: LonLat, bLonLat: LonLat): number {
    const R = 6371000;
    const [aLon, aLat] = aLonLat;
    const [bLon, bLat] = bLonLat;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

function courseDeg(aLonLat: LonLat, bLonLat: LonLat): number {
    const [aLon, aLat] = aLonLat;
    const [bLon, bLat] = bLonLat;
    const φ1 = (aLat * Math.PI) / 180;
    const φ2 = (bLat * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Per-leg outcome of the vector triangle; speedUsedMs always exists. */
interface LegDrift {
    sogMs: number | null;
    currentMs: number | null;
    driftAcrossTrackMs: number | null;
    headingToSteerDeg: number | null;
    infeasible: boolean;
    steeringWarning: boolean;
    /** What the ETA walk advances the clock with (SOG, or STW on fallback). */
    speedUsedMs: number;
}

function solveLegDrift(course: number, stw: number, current: Vector2 | null, leeway: Vector2 | null): LegDrift {
    const noData: LegDrift = {
        sogMs: null,
        currentMs: null,
        driftAcrossTrackMs: null,
        headingToSteerDeg: null,
        infeasible: false,
        steeringWarning: false,
        speedUsedMs: stw,
    };
    if (!current && !leeway) return noData; // out of coverage — degrade to plain STW

    const w: Vector2 = {
        u: (current?.u ?? 0) + (leeway?.u ?? 0),
        v: (current?.v ?? 0) + (leeway?.v ?? 0),
    };
    const θ = (course * Math.PI) / 180;
    // d̂ along-track, n̂ its starboard perpendicular, in (east, north) components.
    const wAlong = w.u * Math.sin(θ) + w.v * Math.cos(θ);
    const wAcrossSigned = w.u * Math.cos(θ) - w.v * Math.sin(θ); // +ve = set to starboard
    const wAcross = Math.abs(wAcrossSigned);

    const currentMs = current ? Math.hypot(current.u, current.v) : null;
    const steeringWarning = wAcross > STEERING_WARNING_FRACTION * stw;

    // STW ≤ |w⊥|: no heading cancels the cross set. SOG ≤ 0: the boat can
    // hold the track line but is set backwards along it. Both are flagged,
    // both fall back to STW so the ETA walk always completes.
    if (stw <= wAcross) {
        return {
            sogMs: null,
            currentMs,
            driftAcrossTrackMs: wAcross,
            headingToSteerDeg: null,
            infeasible: true,
            steeringWarning,
            speedUsedMs: stw,
        };
    }
    const sog = wAlong + Math.sqrt(stw * stw - wAcross * wAcross);
    if (sog <= 0) {
        return {
            sogMs: null,
            currentMs,
            driftAcrossTrackMs: wAcross,
            headingToSteerDeg: null,
            infeasible: true,
            steeringWarning,
            speedUsedMs: stw,
        };
    }

    // Crab upstream: water-track cross component STW·sin(δ) must equal −w⊥.
    const crabDeg = (Math.asin(-wAcrossSigned / stw) * 180) / Math.PI;
    const headingToSteerDeg = (((course + crabDeg) % 360) + 360) % 360;

    return {
        sogMs: sog,
        currentMs,
        driftAcrossTrackMs: wAcross,
        headingToSteerDeg,
        infeasible: false,
        steeringWarning,
        speedUsedMs: sog,
    };
}

/**
 * Annotate a route polyline with per-leg ETAs, tide heights, and (when
 * current/wind fields are given) vector-triangle SOG + set/drift +
 * heading-to-steer. Returns null for degenerate polylines (<2 points)
 * or a non-positive speed — never throws on route-shaped data.
 *
 * Backward compatible: calls without currents/wind produce exactly the
 * Phase 7 leg shape (no drift keys), 'NONE' currentProvenance, and a
 * zero steeringWarnings count.
 */
export function annotateRoute(opts: {
    polyline: LonLat[];
    departMs: number;
    speed: SpeedModel;
    tide?: TideField | null;
    currents?: CurrentField2D | null;
    wind?: WindField2D | null;
    leeway?: { coefficient?: number; capFractionOfStw?: number };
}): AnnotatedRoute | null {
    const { polyline, departMs, speed, tide, currents, wind } = opts;
    if (!Array.isArray(polyline) || polyline.length < 2) return null;
    const stw = speed.stwMs();
    if (!isFinite(stw) || stw <= 0) return null;

    const envRequested = !!(currents || wind);
    const leewayCoeff = opts.leeway?.coefficient ?? DEFAULT_LEEWAY_COEFFICIENT;
    const leewayCapMs = (opts.leeway?.capFractionOfStw ?? DEFAULT_LEEWAY_CAP_FRACTION) * stw;

    const legs: AnnotatedLeg[] = [];
    let clockMs = departMs;
    let totalLengthM = 0;
    let steeringWarnings = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const lengthM = haversineM(a, b);
        const course = courseDeg(a, b);
        const startMs = clockMs;

        let speedUsedMs = stw;
        let drift: LegDrift | null = null;
        if (envRequested) {
            // Sample both fields at the leg START position + time (see header).
            const [lon, lat] = a;
            const cur = currents ? currents.currentAt(lat, lon, startMs) : null;
            const w10 = wind ? wind.windAt(lat, lon, startMs) : null;
            let leewayVec: Vector2 | null = null;
            if (w10) {
                let lu = leewayCoeff * w10.u;
                let lv = leewayCoeff * w10.v;
                const mag = Math.hypot(lu, lv);
                if (mag > leewayCapMs && mag > 0) {
                    lu *= leewayCapMs / mag;
                    lv *= leewayCapMs / mag;
                }
                leewayVec = { u: lu, v: lv };
            }
            drift = solveLegDrift(course, stw, cur, leewayVec);
            speedUsedMs = drift.speedUsedMs;
            if (drift.steeringWarning) steeringWarnings++;
        }

        const etaMs = startMs + (lengthM / speedUsedMs) * 1000;
        const leg: AnnotatedLeg = {
            index: i,
            lengthM,
            courseDeg: course,
            startMs,
            etaMs,
            tideAtEtaM: tide ? tide.heightAt(etaMs) : null,
        };
        if (drift) {
            leg.sogMs = drift.sogMs;
            leg.currentMs = drift.currentMs;
            leg.driftAcrossTrackMs = drift.driftAcrossTrackMs;
            leg.headingToSteerDeg = drift.headingToSteerDeg;
            if (drift.infeasible) leg.infeasibleUnderDrift = true;
        }
        legs.push(leg);
        clockMs = etaMs;
        totalLengthM += lengthM;
    }

    return {
        legs,
        departMs,
        arriveMs: clockMs,
        totalLengthM,
        tideProvenance: tide?.provenance ?? 'NONE',
        currentProvenance: currents?.provenance ?? 'NONE',
        steeringWarnings,
    };
}

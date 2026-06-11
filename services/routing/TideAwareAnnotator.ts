/**
 * TideAwareAnnotator — Masterplan Phase 7.
 *
 * Pure POST-PROCESSING over any route polyline: walk the legs with a
 * SpeedModel to stamp per-leg ETAs, then (when a TideField is present)
 * attach the tide height expected at each leg's ETA. The route GEOMETRY
 * is never touched — this honours the engine doctrine that chart datum
 * is LAT and that tide changes feasibility/timing, never preference.
 *
 * Degradation ladder by construction: no TideField → ETAs only; no
 * coverage at a leg's ETA → that leg's tide is null. Consumers render
 * what exists and stay silent about what doesn't.
 *
 * Phase 8 extends the same walk with current set/drift and leeway
 * (vector-triangle SOG); the leg shape already carries the slots.
 */

import type { SpeedModel, TideField, TideProvenance } from './env/EnvFields';

export type LonLat = [number, number]; // GeoJSON order, matches RouteResult.polyline

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
}

export interface AnnotatedRoute {
    legs: AnnotatedLeg[];
    departMs: number;
    arriveMs: number;
    totalLengthM: number;
    /** Provenance of the tide source used, 'NONE' when absent. */
    tideProvenance: TideProvenance;
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

/**
 * Annotate a route polyline with per-leg ETAs (and tide heights when a
 * field is available). Returns null for degenerate polylines (<2 points)
 * or a non-positive speed — never throws on route-shaped data.
 */
export function annotateRoute(opts: {
    polyline: LonLat[];
    departMs: number;
    speed: SpeedModel;
    tide?: TideField | null;
}): AnnotatedRoute | null {
    const { polyline, departMs, speed, tide } = opts;
    if (!Array.isArray(polyline) || polyline.length < 2) return null;
    const stw = speed.stwMs();
    if (!isFinite(stw) || stw <= 0) return null;

    const legs: AnnotatedLeg[] = [];
    let clockMs = departMs;
    let totalLengthM = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const lengthM = haversineM(a, b);
        const startMs = clockMs;
        const etaMs = startMs + (lengthM / stw) * 1000;
        legs.push({
            index: i,
            lengthM,
            courseDeg: courseDeg(a, b),
            startMs,
            etaMs,
            tideAtEtaM: tide ? tide.heightAt(etaMs) : null,
        });
        clockMs = etaMs;
        totalLengthM += lengthM;
    }

    return {
        legs,
        departMs,
        arriveMs: clockMs,
        totalLengthM,
        tideProvenance: tide?.provenance ?? 'NONE',
    };
}

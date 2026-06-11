/**
 * Land backstop — caller-side sanity sweep over an inshore route polyline.
 *
 * WHY (field bug, 2026-06-12, Newport → Mooloolaba): the inshore engine's
 * grid default is PERMISSIVE — space with no chart features at all is
 * UNKNOWN_OPEN, freely navigable. Inside a well-charted harbour that is
 * the right call; across a chart-coverage gap it means islands literally
 * do not exist (reproduced: a 32.7 NM dead-straight route over Bribie
 * Island with zero caution flags when the corridor's cells are missing).
 * The coverage gate only checks the route ENDPOINTS, so a mid-corridor
 * hole sails straight through.
 *
 * This backstop validates the FINAL polyline against GEBCO bathymetry
 * (~450 m grid, global, already cached app-side): sampled points whose
 * GEBCO value reads at/above sea level, in runs long enough to not be a
 * coastal-pixel kiss, mean the route crosses land → the caller rejects
 * the inshore result and falls back to the offshore pipeline.
 *
 * Deliberately conservative the other way too: GEBCO is too coarse to
 * veto legitimate dredged channels (they read as WATER below datum, not
 * land), and a single land-flagged sample (~450 m) is ignored — only a
 * run of ≥ MIN_RUN_SAMPLES (~0.8 km of solid ground) rejects. Bribie is
 * 8 km wide; no real channel transit trips this.
 *
 * Structural fix (corridor coverage gate + UNCHARTED ≠ OPEN in the
 * engine) is Lane B work — see ROUTING_COLLAB.md reply 16. This backstop
 * stays afterwards as defence in depth.
 */

import { GebcoDepthService, type DepthResult } from '../GebcoDepthService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('landBackstop');

export type LonLat = [number, number];

/** GEBCO reading at/above this (metres of water) counts as land-ish. */
export const LAND_DEPTH_THRESHOLD_M = 0;
/** Consecutive land samples required to call it a crossing (≥ ~0.8 km). */
export const MIN_RUN_SAMPLES = 2;
/** Along-route sampling interval. */
export const SAMPLE_STEP_M = 400;
/** Hard cap on samples per validation (GEBCO edge-function batch limit). */
export const MAX_SAMPLES = 180;

export interface LandRun {
    /** Index of the first sample in the run. */
    startIdx: number;
    samples: number;
    /** Representative coordinate (first sample of the run). */
    lat: number;
    lon: number;
}

/**
 * Pure: find runs of consecutive land-reading samples. Null depths
 * (GEBCO gaps) break runs — unknown is not evidence of land.
 */
export function findLandRuns(depths: DepthResult[], thresholdM = LAND_DEPTH_THRESHOLD_M): LandRun[] {
    const runs: LandRun[] = [];
    let start = -1;
    for (let i = 0; i <= depths.length; i++) {
        const isLand = i < depths.length && depths[i].depth_m !== null && (depths[i].depth_m as number) <= thresholdM;
        if (isLand && start === -1) start = i;
        if (!isLand && start !== -1) {
            runs.push({ startIdx: start, samples: i - start, lat: depths[start].lat, lon: depths[start].lon });
            start = -1;
        }
    }
    return runs;
}

/** Pure: sample a polyline every ~stepM, capped at maxSamples (incl. ends). */
export function samplePolyline(polyline: LonLat[], stepM = SAMPLE_STEP_M, maxSamples = MAX_SAMPLES): LonLat[] {
    if (polyline.length < 2) return [...polyline];
    const R = 6371000;
    const dist = (a: LonLat, b: LonLat): number => {
        const dLat = ((b[1] - a[1]) * Math.PI) / 180;
        const dLon = ((b[0] - a[0]) * Math.PI) / 180;
        const s =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    };
    let total = 0;
    for (let i = 0; i < polyline.length - 1; i++) total += dist(polyline[i], polyline[i + 1]);
    const step = Math.max(stepM, total / Math.max(1, maxSamples - 1));

    const out: LonLat[] = [polyline[0]];
    let carried = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const segLen = dist(a, b);
        if (segLen === 0) continue;
        let along = step - carried;
        while (along < segLen) {
            const t = along / segLen;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            along += step;
        }
        carried = (carried + segLen) % step;
    }
    out.push(polyline[polyline.length - 1]);
    return out;
}

export interface LandBackstopResult {
    crossesLand: boolean;
    runs: LandRun[];
    samplesChecked: number;
}

/**
 * Validate an inshore route polyline against GEBCO. Fails OPEN on data
 * unavailability (offline / edge error → crossesLand=false with zero
 * samples): this is a backstop, not a gate — refusing every route when
 * GEBCO is unreachable would break offline routing that the chart layer
 * already validated properly.
 */
export async function inshoreRouteCrossesLand(polyline: LonLat[]): Promise<LandBackstopResult> {
    try {
        const samples = samplePolyline(polyline);
        const depths = await GebcoDepthService.queryRouteDepths(
            samples.map(([lon, lat]) => ({ lat, lon })),
            MAX_SAMPLES,
        );
        if (!depths || depths.length === 0) return { crossesLand: false, runs: [], samplesChecked: 0 };
        const runs = findLandRuns(depths).filter((r) => r.samples >= MIN_RUN_SAMPLES);
        if (runs.length > 0) {
            log.warn(
                `[landBackstop] inshore route crosses land: ${runs.length} run(s), first at ` +
                    `${runs[0].lat.toFixed(4)},${runs[0].lon.toFixed(4)} (${runs[0].samples} samples) — rejecting`,
            );
        }
        return { crossesLand: runs.length > 0, runs, samplesChecked: depths.length };
    } catch (e) {
        log.warn('[landBackstop] GEBCO unavailable — failing open:', e);
        return { crossesLand: false, runs: [], samplesChecked: 0 };
    }
}

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
 * This backstop corroborates the FINAL polyline against NOAA ETOPO global
 * relief (nominal 1 arc-minute / ~1.8 km grid, cached app-side): sampled
 * points whose ETOPO value reads at/above sea level, in runs long enough to not be a
 * coastal-pixel kiss, mean the route crosses land → the caller rejects
 * the inshore result and falls back to the offshore pipeline.
 *
 * Deliberately conservative the other way too: ETOPO is too coarse to
 * veto legitimate dredged channels (they read as WATER below datum, not
 * land), and a single land-flagged request point is ignored — only a
 * run of ≥ MIN_RUN_SAMPLES rejects. Request points are ~400 m apart but
 * are not independent grid cells; this remains a coarse veto, never a
 * fine-resolution clearance. Bribie is
 * 8 km wide; no real channel transit trips this.
 *
 * Structural fix (corridor coverage gate + UNCHARTED ≠ OPEN in the
 * engine) is Lane B work — see ROUTING_COLLAB.md reply 16. This backstop
 * stays afterwards as defence in depth.
 */

import { GebcoDepthService, type DepthResult } from '../GebcoDepthService';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';

const log = createLogger('landBackstop');

/**
 * Hard cap on how long a SUCCESSFUL inshore route may wait on this
 * backstop before it renders. GebcoDepthService bounds its own fetch
 * at 30 s. A timeout is an explicit unavailable verdict: callers must
 * not present the route as verified safe.
 */
export const BACKSTOP_DEADLINE_MS = 10_000;

export type LonLat = [number, number];

/** ETOPO elevation at/above sea level counts as land-ish. */
export const LAND_DEPTH_THRESHOLD_M = 0;
/** Consecutive land-reading request points required to call it a crossing. */
export const MIN_RUN_SAMPLES = 2;
/** Along-route sampling interval. */
export const SAMPLE_STEP_M = 400;
/** Hard cap on samples per validation (legacy gebco-depth endpoint batch limit). */
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
 * Pure: find runs of consecutive land-reading samples. NOAA ETOPO uses
 * negative elevation below sea level and positive elevation on land.
 * Null depths break runs — unknown is not evidence of land.
 */
export function findLandRuns(depths: DepthResult[], thresholdM = LAND_DEPTH_THRESHOLD_M): LandRun[] {
    const runs: LandRun[] = [];
    let start = -1;
    for (let i = 0; i <= depths.length; i++) {
        const depth = i < depths.length ? depths[i].depth_m : null;
        const isLand = depth !== null && Number.isFinite(depth) && depth >= thresholdM;
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
    /** Whether the no-land/crosses-land verdict is complete enough to trust. */
    status: 'verified' | 'unavailable';
    crossesLand: boolean;
    runs: LandRun[];
    /** Samples with a finite NOAA ETOPO value. */
    samplesChecked: number;
    /** Samples requested along the final route geometry. */
    samplesRequested: number;
}

/**
 * Corroborate an inshore route polyline against coarse NOAA ETOPO. Data unavailability
 * is explicit and fail-closed: a caller may draw a route as verified only
 * when status='verified' and crossesLand=false. A confirmed land run is a
 * verified rejection even if another sample was unavailable.
 */
export async function inshoreRouteCrossesLand(polyline: LonLat[]): Promise<LandBackstopResult> {
    const samples = samplePolyline(polyline);
    const unavailable = (samplesChecked = 0): LandBackstopResult => ({
        status: 'unavailable',
        crossesLand: false,
        runs: [],
        samplesChecked,
        samplesRequested: samples.length,
    });

    if (samples.length < 2) return unavailable();

    try {
        const depths = await withTimeout(
            GebcoDepthService.queryRouteDepths(
                samples.map(([lon, lat]) => ({ lat, lon })),
                MAX_SAMPLES,
            ),
            null,
            BACKSTOP_DEADLINE_MS,
        );
        if (!depths || depths.length !== samples.length) {
            log.warn('[landBackstop] ETOPO response missing or misaligned — route remains unverified');
            return unavailable();
        }

        const samplesChecked = depths.filter((sample) => Number.isFinite(sample.depth_m)).length;
        const runs = findLandRuns(depths).filter((r) => r.samples >= MIN_RUN_SAMPLES);
        if (runs.length > 0) {
            log.warn(
                `[landBackstop] inshore route crosses land: ${runs.length} run(s), first at ` +
                    `${runs[0].lat.toFixed(4)},${runs[0].lon.toFixed(4)} (${runs[0].samples} samples) — rejecting`,
            );
            return {
                status: 'verified',
                crossesLand: true,
                runs,
                samplesChecked,
                samplesRequested: samples.length,
            };
        }

        if (samplesChecked !== samples.length) {
            log.warn(
                `[landBackstop] ETOPO unavailable for ${samples.length - samplesChecked}/${samples.length} sample(s) — ` +
                    'route remains unverified',
            );
            return unavailable(samplesChecked);
        }

        return {
            status: 'verified',
            crossesLand: false,
            runs: [],
            samplesChecked,
            samplesRequested: samples.length,
        };
    } catch (e) {
        log.warn('[landBackstop] ETOPO unavailable — route remains unverified:', e);
        return unavailable();
    }
}

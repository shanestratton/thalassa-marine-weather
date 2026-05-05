/**
 * departureWindow.ts — Multi-departure-time planning across a window.
 *
 * PredictWind's flagship feature: instead of routing for ONE departure
 * time, run the optimiser across N departure times in a window and let
 * the user pick the best one based on ETA / max wind / max wave / gale
 * exposure. For a Newport→Bermuda passage with a front coming through
 * Wednesday, this surfaces "depart Tuesday 06:00 UTC, arrive 4 days
 * later in 12-15 kt winds" vs "depart Wednesday 06:00 UTC, arrive 5
 * days later in 30+ kt winds with 12 gale hours."
 *
 * Architecture:
 *   - Caller specifies a window start, duration, and interval (e.g. next
 *     7 days, every 12 hours = 14 candidate departures)
 *   - For each candidate, run computeIsochrones with the route's wind /
 *     current / cyclone-exclusion fields (cached across runs — same
 *     route, different departure)
 *   - Score each scenario: ETA (low = better), max wind, gale hours
 *   - Return ranked array
 *
 * Streaming: emits 'thalassa:departure-window-progress' on the window
 * after each scenario completes so the UI can show live ranking
 * updates rather than waiting for all N to finish.
 */

import { createLogger } from '../utils/createLogger';
import type { VesselProfile } from '../types';
import type { WindField, CurrentField, ExclusionField, IsochroneNode, IsochroneResult } from './IsochroneRouter';

const log = createLogger('DeparturePlan');

/** Wind speed (kts) at or above which we count an hour as "gale exposure". */
const GALE_THRESHOLD_KTS = 34;

/** Wind speed at or above which we count "storm exposure" (Beaufort 10+). */
const STORM_THRESHOLD_KTS = 48;

/**
 * Per-departure-time scenario produced by planDepartureWindow.
 */
export interface DepartureScenario {
    /** ISO 8601 departure time. */
    departureTime: string;
    /** ISO 8601 arrival time (departureTime + durationHours). */
    arrivalTime: string;
    /** Total passage duration in hours. */
    durationHours: number;
    /** Total passage distance in nautical miles. */
    distanceNM: number;
    /** Maximum true wind speed encountered along the route (kts). */
    maxWindKts: number;
    /** Average true wind speed weighted by time at each node (kts). */
    avgWindKts: number;
    /** Hours spent in winds ≥ 34 kts (gale force). */
    galeHours: number;
    /** Hours spent in winds ≥ 48 kts (storm force). */
    stormHours: number;
    /**
     * Composite score (lower is better). Weights ETA by 1, gale-hours
     * by 6, storm-hours by 20. So a 5-day passage with 0 gale beats
     * a 4-day passage with 6 gale-hours; a route with ANY storm hours
     * is heavily penalised.
     */
    score: number;
    /**
     * Human-readable verdict — "go", "maybe", "avoid", "no-go".
     * Used for the UI traffic-light chip.
     */
    verdict: 'go' | 'maybe' | 'avoid' | 'no-go';
    /** True if the engine returned a viable route, false if it failed. */
    routeFound: boolean;
}

export interface DepartureWindowOptions {
    /** Departure-time interval in hours. Default: 12. */
    intervalHours?: number;
    /** Total window duration in hours. Default: 168 (7 days). */
    windowHours?: number;
    /** Maximum scenarios to run (caps interval × window). Default: 14. */
    maxScenarios?: number;
}

/**
 * Compute summary stats from an isochrone result's route nodes.
 */
function summariseRoute(route: IsochroneNode[]): {
    maxWindKts: number;
    avgWindKts: number;
    galeHours: number;
    stormHours: number;
} {
    if (route.length === 0) {
        return { maxWindKts: 0, avgWindKts: 0, galeHours: 0, stormHours: 0 };
    }

    let maxWind = 0;
    let weightedSum = 0;
    let totalWeight = 0;
    let galeH = 0;
    let stormH = 0;

    for (let i = 1; i < route.length; i++) {
        const node = route[i];
        const prev = route[i - 1];
        const segHours = node.timeHours - prev.timeHours;
        const segWind = node.tws ?? 0;

        if (segWind > maxWind) maxWind = segWind;
        weightedSum += segWind * segHours;
        totalWeight += segHours;

        if (segWind >= GALE_THRESHOLD_KTS) galeH += segHours;
        if (segWind >= STORM_THRESHOLD_KTS) stormH += segHours;
    }

    return {
        maxWindKts: Math.round(maxWind),
        avgWindKts: totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0,
        galeHours: Math.round(galeH * 10) / 10,
        stormHours: Math.round(stormH * 10) / 10,
    };
}

/**
 * Composite scorer — lower is better. Weights:
 *   1.0  per hour of duration
 *   6.0  per hour of gale exposure
 *  20.0  per hour of storm exposure
 *
 * So a 96-hour passage with 6 gale-hours scores 96 + 36 = 132,
 * versus a 110-hour passage with 0 gale = 110. The longer-but-calmer
 * route wins, as it should for a cruising sailor.
 */
function score(durationHours: number, galeHours: number, stormHours: number): number {
    return durationHours + 6 * galeHours + 20 * stormHours;
}

/**
 * Verdict chip — synthesised from the metrics, not just the score.
 */
function verdictForMetrics(
    routeFound: boolean,
    galeHours: number,
    stormHours: number,
    maxWindKts: number,
): DepartureScenario['verdict'] {
    if (!routeFound) return 'no-go';
    if (stormHours > 0 || maxWindKts >= 50) return 'no-go';
    if (galeHours >= 6 || maxWindKts >= 40) return 'avoid';
    if (galeHours >= 1 || maxWindKts >= 30) return 'maybe';
    return 'go';
}

/**
 * Plan a departure window — run the isochrone optimiser across N
 * candidate departure times and return ranked scenarios.
 *
 * The route's wind / current / cyclone-exclusion fields are passed in
 * once and reused across all runs (they don't depend on departure
 * time, only on absolute clock time which the engine handles via
 * `timeOffsetHours` lookups).
 *
 * Each scenario takes ~10-30 seconds at default isochrone resolution.
 * Caller should expect a multi-minute total compute on a 14-scenario
 * window. UI receives 'thalassa:departure-window-progress' events
 * with the partial results so the user sees scenarios populating.
 */
export async function planDepartureWindow(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    vessel: VesselProfile,
    windField: WindField,
    polar: import('../types').PolarData,
    bathyGrid: import('./BathymetryCache').BathymetryGrid | null,
    currentField: CurrentField | null,
    exclusionField: ExclusionField | null,
    windowStartIso: string,
    options: DepartureWindowOptions = {},
): Promise<DepartureScenario[]> {
    const intervalHours = options.intervalHours ?? 12;
    const windowHours = options.windowHours ?? 168;
    const maxScenarios = options.maxScenarios ?? 14;

    const windowStartMs = new Date(windowStartIso).getTime();
    const stepCount = Math.min(maxScenarios, Math.floor(windowHours / intervalHours) + 1);

    log.info(
        `planning ${stepCount} departures every ${intervalHours}h starting ${windowStartIso} (window: ${windowHours}h)`,
    );

    const { computeIsochrones } = await import('./IsochroneRouter');
    const scenarios: DepartureScenario[] = [];

    for (let i = 0; i < stepCount; i++) {
        const depMs = windowStartMs + i * intervalHours * 3600_000;
        const depIso = new Date(depMs).toISOString();

        let result: IsochroneResult | null = null;
        try {
            result = await computeIsochrones(
                origin,
                destination,
                depIso,
                polar,
                windField,
                {
                    vesselDraft: vessel.draft || 2.5,
                    motoringSpeed: vessel.cruisingSpeed || 6,
                    minDepthM: null,
                    // Coarser config to keep total compute time reasonable —
                    // departure-window is exploratory; once the user picks
                    // one we re-run at full resolution via the main pipeline.
                    timeStepHours: 12,
                    bearingCount: 24,
                    comfortParams:
                        vessel.maxWindSpeed || vessel.maxWaveHeight
                            ? {
                                  maxWindKts: vessel.maxWindSpeed,
                                  maxWaveM: vessel.maxWaveHeight,
                              }
                            : undefined,
                },
                bathyGrid,
                currentField,
                exclusionField,
            );
        } catch (e) {
            log.warn(`scenario ${i + 1}/${stepCount} (${depIso}) threw:`, e);
        }

        if (!result) {
            const scenario: DepartureScenario = {
                departureTime: depIso,
                arrivalTime: depIso,
                durationHours: 0,
                distanceNM: 0,
                maxWindKts: 0,
                avgWindKts: 0,
                galeHours: 0,
                stormHours: 0,
                score: Infinity,
                verdict: 'no-go',
                routeFound: false,
            };
            scenarios.push(scenario);
        } else {
            const stats = summariseRoute(result.route);
            const sc = score(result.totalDurationHours, stats.galeHours, stats.stormHours);
            const verdict = verdictForMetrics(true, stats.galeHours, stats.stormHours, stats.maxWindKts);
            scenarios.push({
                departureTime: depIso,
                arrivalTime: result.arrivalTime,
                durationHours: result.totalDurationHours,
                distanceNM: result.totalDistanceNM,
                ...stats,
                score: sc,
                verdict,
                routeFound: true,
            });
        }

        // Emit progress so the UI can update incrementally
        try {
            window.dispatchEvent(
                new CustomEvent('thalassa:departure-window-progress', {
                    detail: { completed: i + 1, total: stepCount, scenarios: [...scenarios] },
                }),
            );
        } catch (_) {
            /* SSR safety */
        }

        // Yield to UI — back-to-back isochrone runs will starve the main thread
        await new Promise((r) => setTimeout(r, 0));
    }

    // Sort: best (lowest score) first. no-go scenarios drop to the bottom.
    scenarios.sort((a, b) => a.score - b.score);

    log.info(
        `complete: best = ${scenarios[0]?.departureTime} (${scenarios[0]?.durationHours}h, ${scenarios[0]?.galeHours} gale-h, score ${scenarios[0]?.score.toFixed(1)})`,
    );

    return scenarios;
}

/**
 * DepartureSweepInshore v1 — Masterplan Phase 8 §8.3 (Lane A).
 *
 * The "when should I leave?" engine behind the owner-approved explicit
 * best-departure button: sweep candidate departure times, stamp each with
 * the Phase 7 ETA walk, and gate every declared shallow spot's ETA against
 * its tidal windows. Pure and synchronous given the fields — the UI sheet
 * supplies the polyline/spots and renders the option strip later.
 *
 * DOCTRINE (masterplan §5): tide changes FEASIBILITY AND TIMING, never
 * preference — this sweep labels departures, it never alters route
 * geometry. Currents/leeway (the parallel Phase 8 ETA layer) shift ETAs
 * ONLY; ≈1/12° CMEMS cannot resolve channel jets, so they must never
 * appear in the open/blocked decision here.
 *
 * v1 simplifications (documented for v2):
 *   - No in-passage waiting: a departure is 'blocked' the moment any
 *     spot's ETA misses every window. Anchoring short of the bar and
 *     carrying on at the next opening is a future 'wait' classification.
 *   - best = earliest 'clear' option, shortest passage breaking ties.
 *     Under the constant-STW model every passage ties, so this reduces to
 *     "leave at the first green slot"; the tie-break starts doing work
 *     when the current-aware SOG walk makes passage time depend on the
 *     departure.
 *
 * Degradation ladder: no TideField → every gated departure is 'unknown'
 * (never a guess, never a throw); a spot's ETA outside curve coverage
 * errs closed via computeTidalWindows (no windows there → blocked).
 */

import { annotateRoute, type CurrentProvenance, type LonLat } from './TideAwareAnnotator';
import type { CurrentField2D, SpeedModel, TideField } from './env/EnvFields';
import { computeTidalWindows, type TidalWindow } from './tidalWindow';

export const DEFAULT_SWEEP_COUNT = 25;
export const DEFAULT_SWEEP_STEP_MS = 30 * 60_000;
/**
 * Tidal windows are searched over [departMs, arriveMs + this slack] so a
 * spot's chips include the NEXT opening even when this departure's ETA
 * misses it — half a semidiurnal cycle always reaches one.
 */
export const ARRIVAL_SLACK_MS = 6 * 3_600_000;

export type DepartureStatus = 'clear' | 'blocked' | 'unknown';

export interface ShallowSpot {
    /** Index into the annotated legs: leg i runs polyline[i] → polyline[i+1]. */
    legIndex: number;
    /** Charted minimum depth below LAT over the shallow run (metres). */
    minDepthM: number;
}

/** Per-spot verdict + windows for one departure — feeds the UI chips. */
export interface SpotWindows {
    legIndex: number;
    minDepthM: number;
    /** ETA at the spot for THIS departure; null when legIndex is invalid. */
    etaMs: number | null;
    /** Passable intervals over [departMs, arriveMs + slack]; empty when
     *  alwaysOpen (no gate needed) or when the tide never serves. */
    windows: TidalWindow[];
    alwaysOpen: boolean;
    /** ETA lands inside a window (or alwaysOpen); null when unknowable
     *  (no tide field). Invalid legIndex errs closed → false. */
    openAtEta: boolean | null;
}

export interface DepartureOption {
    departMs: number;
    arriveMs: number;
    passageMs: number;
    status: DepartureStatus;
    /** Count of legs with advisory cross-set warnings on this departure's
     *  walk (|w⊥| > 0.25×STW). 0 when no current/wind fields given. */
    steeringWarnings: number;
    /** Min over spots of (tideAtEta + minDepth − draft): the tightest
     *  ACTUAL under-keel clearance expected on passage — the safety
     *  margin gates the windows, it is NOT subtracted here. Null when
     *  there is no tide field, no spots, or any spot's ETA falls outside
     *  curve coverage (a partial min would overstate certainty). */
    minUkcM: number | null;
    /** Parallel to shallowSpots — one entry per declared spot. */
    windows: SpotWindows[];
}

export interface DepartureSweep {
    options: DepartureOption[];
    /** Provenance of the current source threaded into the ETA walks. */
    currentProvenance: CurrentProvenance;
    /** Earliest 'clear' option (shortest passage among ties); null when
     *  nothing in the sweep is clear or the route input is degenerate. */
    best: DepartureOption | null;
}

/**
 * Sweep `count` departures from `startMs` at `stepMs` spacing and classify
 * each against the declared shallow spots. Pure given the fields; never
 * throws on route-shaped input — degenerate polylines / non-positive
 * speeds yield an empty sweep.
 */
export function sweepDepartures(opts: {
    polyline: LonLat[];
    speed: SpeedModel;
    tide: TideField | null;
    /** Optional CMEMS field — refines per-departure ETAs via the vector
     *  triangle (flood vs ebb passage-time asymmetry). ETA-ONLY per
     *  doctrine: never enters the open/blocked decision. */
    currents?: CurrentField2D | null;
    /** Charted chokepoints to gate; omitted/empty ⇒ nothing gates ('clear'). */
    shallowSpots?: ShallowSpot[];
    /** Vessel draft in METRES — vessel.draft is stored in FEET upstream,
     *  callers convert (÷3.28084) before reaching the routing stack. */
    draftM: number;
    tideSafetyM?: number;
    startMs: number;
    count?: number;
    stepMs?: number;
}): DepartureSweep {
    const { polyline, speed, tide, draftM, tideSafetyM, startMs } = opts;
    const spots = opts.shallowSpots ?? [];
    const count =
        typeof opts.count === 'number' && Number.isInteger(opts.count) && opts.count > 0
            ? opts.count
            : DEFAULT_SWEEP_COUNT;
    const stepMs =
        typeof opts.stepMs === 'number' && isFinite(opts.stepMs) && opts.stepMs > 0
            ? opts.stepMs
            : DEFAULT_SWEEP_STEP_MS;
    if (!isFinite(startMs)) return { options: [], best: null, currentProvenance: 'NONE' };

    const options: DepartureOption[] = [];
    let best: DepartureOption | null = null;

    for (let i = 0; i < count; i++) {
        const departMs = startMs + i * stepMs;
        const route = annotateRoute({ polyline, departMs, speed, tide, currents: opts.currents ?? null });
        // Annotator nulls are departure-independent (degenerate polyline /
        // bad speed), so the whole sweep degrades rather than throwing.
        if (!route) return { options: [], best: null, currentProvenance: 'NONE' };

        const spotWindows: SpotWindows[] = [];
        let allOpen = true;
        let structurallyBlocked = false;
        let ukcUnknown = tide === null || spots.length === 0;
        let minUkcM: number | null = null;

        for (const spot of spots) {
            const leg = Number.isInteger(spot.legIndex) ? route.legs[spot.legIndex] : undefined;
            if (!leg) {
                // A spot pointing at a leg this route doesn't have cannot
                // be vouched for — err closed, never silently 'clear'.
                structurallyBlocked = true;
                ukcUnknown = true;
                spotWindows.push({
                    legIndex: spot.legIndex,
                    minDepthM: spot.minDepthM,
                    etaMs: null,
                    windows: [],
                    alwaysOpen: false,
                    openAtEta: false,
                });
                continue;
            }

            if (!tide) {
                spotWindows.push({
                    legIndex: spot.legIndex,
                    minDepthM: spot.minDepthM,
                    etaMs: leg.etaMs,
                    windows: [],
                    alwaysOpen: false,
                    openAtEta: null,
                });
                continue;
            }

            const res = computeTidalWindows({
                minDepthM: spot.minDepthM,
                draftM,
                tideSafetyM,
                tide,
                fromMs: departMs,
                untilMs: route.arriveMs + ARRIVAL_SLACK_MS,
            });
            const openAtEta =
                res.alwaysOpen || res.windows.some((w) => w.openMs <= leg.etaMs && leg.etaMs <= w.closeMs);
            if (!openAtEta) allOpen = false;

            const h = leg.tideAtEtaM;
            if (h === null) {
                ukcUnknown = true; // ETA outside curve coverage — never guess
            } else {
                const ukc = h + spot.minDepthM - draftM;
                minUkcM = minUkcM === null ? ukc : Math.min(minUkcM, ukc);
            }

            spotWindows.push({
                legIndex: spot.legIndex,
                minDepthM: spot.minDepthM,
                etaMs: leg.etaMs,
                windows: res.windows,
                alwaysOpen: res.alwaysOpen,
                openAtEta,
            });
        }

        let status: DepartureStatus;
        if (spots.length === 0) {
            status = 'clear'; // nothing gates this passage
        } else if (structurallyBlocked) {
            status = 'blocked';
        } else if (!tide) {
            status = 'unknown'; // every spot is unknowable without a field
        } else {
            status = allOpen ? 'clear' : 'blocked';
        }

        const option: DepartureOption = {
            departMs,
            arriveMs: route.arriveMs,
            passageMs: route.arriveMs - departMs,
            status,
            steeringWarnings: route.steeringWarnings,
            minUkcM: ukcUnknown ? null : minUkcM,
            windows: spotWindows,
        };
        options.push(option);

        if (
            option.status === 'clear' &&
            (best === null ||
                option.departMs < best.departMs ||
                (option.departMs === best.departMs && option.passageMs < best.passageMs))
        ) {
            best = option;
        }
    }

    return { options, best, currentProvenance: opts.currents?.provenance ?? 'NONE' };
}

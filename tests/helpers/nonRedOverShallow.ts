/**
 * Metres of a route NOT drawn red over water the finest S-57 survey charts
 * drying (< 0) or shallower than draft + UKC, sampled every 5 m against the
 * chart's own bands — the colour the planner actually draws (per-segment
 * state, with the backstop's stretches laid over it). Round-3 review
 * (2026-09-30): ~2.9 km of every Newport → Brisbane River route drew a yellow
 * 'marked channel' across the river mouth's charted drying bank.
 *
 * Owner decision 10 (Shane, 2026-09-30: "Amber if a tide clears it"): shallow
 * water may now be drawn needs-tide AMBER too, where some tide gives draft +
 * UKC over it. `highestM` is the highest tide assumed there (null — no tide
 * data, what the planner draws before the curve arrives, and all a test
 * without a curve can show: everything shallow red, as before). dryM and
 * shallowM count shallow water drawn NEITHER red NOR needs-tide amber;
 * amberBeyondTideM counts water drawn needs-tide amber that the tide cannot
 * clear at the sample (its charted depth needs more than `highestM`).
 * amberUnchartedM (round-4 review, 2026-09-30) counts water drawn
 * needs-tide amber where no S-57 band charts a depth at all: a tide proves
 * nothing there. MEASURED before the fix: 24 m of the Brisbane River mouth
 * with no band, under four LNDARE polygons, drawn amber on newport-shane at
 * any highest tide of 2.6 m or more — this helper skipped d === null, and the
 * goldens only asked at 2.5 m.
 */
import type { RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers } from '../../services/engine/types';
import { chartAreaIndexFor, chartedDepthAt } from '../../services/routing/leadLandClip';
import { haversineM } from '../../services/engine/geometry';
import {
    inshoreRoutePieces,
    inshoreSegmentStates,
    routeTideDepths,
    tideClears,
} from '../../components/map/inshoreRouteState';

export function nonRedOverShallow(
    r: RouteResult,
    layers: InshoreLayers,
    needM: number,
    highestM: number | null = null,
): { dryM: number; shallowM: number; amberBeyondTideM: number; amberUnchartedM: number } {
    const depth = chartAreaIndexFor(layers).depth;
    const states = inshoreSegmentStates(r);
    let dryM = 0;
    let shallowM = 0;
    let amberBeyondTideM = 0;
    let amberUnchartedM = 0;
    if (!states) return { dryM, shallowM, amberBeyondTideM, amberUnchartedM };
    const pieces = inshoreRoutePieces(r.polyline, states, [], r.chartedShallowSpans ?? [], {
        depthM: routeTideDepths(r),
        needM,
        highestM,
    });
    for (const p of pieces) {
        for (let i = 0; i + 1 < p.coordinates.length; i++) {
            const [lonA, latA] = p.coordinates[i];
            const [lonB, latB] = p.coordinates[i + 1];
            const segM = haversineM(latA, lonA, latB, lonB);
            const steps = Math.max(1, Math.ceil(segM / 5));
            for (let k = 0; k < steps; k++) {
                const t = (k + 0.5) / steps;
                if (p.state === 'danger') continue;
                const d = chartedDepthAt(depth, lonA + (lonB - lonA) * t, latA + (latB - latA) * t);
                if (d === null) {
                    if (p.state === 'tide') amberUnchartedM += segM / steps;
                    continue;
                }
                if (p.state === 'tide') {
                    if (!tideClears(d, needM, highestM)) amberBeyondTideM += segM / steps;
                    continue;
                }
                if (d < 0) dryM += segM / steps;
                if (d < needM) shallowM += segM / steps;
            }
        }
    }
    return { dryM, shallowM, amberBeyondTideM, amberUnchartedM };
}

/** The highest tides a D10 check sweeps (round-4 review, 2026-09-30: the
 *  goldens asked only at 2.5 m, and the uncharted amber began at 2.6 m). */
export const HIGHEST_TIDE_SWEEP_M: readonly (number | null)[] = [null, 1, 1.5, 2, 2.5, 2.6, 3, 3.5, 4, 5, 6];

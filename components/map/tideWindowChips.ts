/**
 * Phase 7 tide-window chips — "clears 09:40–15:10 ≈" on the route's red runs.
 *
 * The inshore engine ships charted-shallow caution runs with their real charted
 * min depth (RouteResult.shallowRuns, from grid.shallowDepthM). This module
 * turns each of those runs into an amber map chip at the run midpoint, computed
 * against the cached WorldTides extremes curve (LAT, half-cosine interp) via
 * the shipped computeTidalWindows maths.
 *
 * Doctrine (masterplan §5, enforced in review): tide changes FEASIBILITY AND
 * TIMING, never geometry or preference — this file is display-only and runs
 * AFTER the route has rendered, off the compute path.
 *
 * Field rules honoured here:
 *  - ONE tide-curve fetch per route (the direct WorldTides fallback is
 *    rate-limited to 10/hr and per-run coords would fragment the pi cache) —
 *    the curve is fetched at the LONGEST eligible run's midpoint and shared.
 *  - minDepthM === null (uncharted/conflict caution) NEVER gets a window — a
 *    number computed from nothing would be fabricated confidence.
 *  - Zero windows with a curve that doesn't COVER the horizon is a data gap,
 *    not "never clears" — those runs get no chip and a console line instead.
 *  - Chips key off the RENDERED state (stateMask 'danger'), not raw
 *    cautionMask, so a caution segment under a yellow marked channel — where
 *    the marks are the depth authority — never grows a chip.
 *  - CapacitorHttp ignores AbortSignal on device: the fetch is bounded with
 *    withTimeout, never trusted to time out on its own.
 */
import mapboxgl from 'mapbox-gl';
import { fetchTideCurve } from '../../services/TideHeightService';
import { tideFieldFromCurve } from '../../services/routing/env/EnvFields';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import type { ShallowRunInfo } from '../../services/engine/types';
import { withTimeout } from '../../utils/deadline';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('tideWindow');

const HORIZON_MS = 24 * 3600_000; // window search horizon from departure
const CURVE_FETCH_TIMEOUT_MS = 12_000;

/** Amber pill, styled inline (Tailwind can't see runtime-created elements). */
function chipElement(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
        background: 'rgba(15, 23, 42, 0.92)',
        border: '1px solid rgba(251, 191, 36, 0.4)',
        color: '#fcd34d',
        borderRadius: '9999px',
        padding: '2px 9px',
        fontSize: '11px',
        fontWeight: '600',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
    } satisfies Partial<CSSStyleDeclaration>);
    return el;
}

function fmtHM(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface TideChipOptions {
    map: mapboxgl.Map;
    runs: readonly ShallowRunInfo[];
    /** The renderer's per-segment state — chips only on rendered-'danger' runs. */
    stateMask: readonly ('danger' | 'channel' | 'offshore' | 'green' | 'ntmlock')[] | null;
    /** Vessel draft in METRES (caller converts — vessel.draft is stored in feet). */
    draftM: number;
    /** Departure time (ms epoch) — the window horizon start. */
    departureMs: number;
    /** True ⇒ a newer compute superseded this one; never touch the map. */
    isStale: () => boolean;
    /** Marker sink — the CALLER owns removal (route clear / next compute). */
    markers: mapboxgl.Marker[];
}

/**
 * Compute + place the chips. Fire-and-forget from the planner AFTER the route
 * renders; every await is followed by an isStale() gate.
 */
export async function annotateTideWindows(opts: TideChipOptions): Promise<void> {
    const { map, runs, stateMask, draftM, departureMs, isStale, markers } = opts;
    try {
        const eligible = runs.filter((r) => {
            if (r.minDepthM === null) return false; // uncharted — no fabricated windows
            if (stateMask) {
                // A run touching an un-acked NtM lock gets NO chip: the grey
                // leg's instruction is "read the notice", and a chart-edition
                // window there would contradict the survey the skipper hasn't
                // applied yet (review finding #18).
                for (let s = r.startSeg; s <= r.endSeg && s < stateMask.length; s++) {
                    if (stateMask[s] === 'ntmlock') return false;
                }
            }
            const midSeg = Math.floor((r.startSeg + r.endSeg) / 2);
            return !stateMask || stateMask[midSeg] === 'danger';
        });
        if (eligible.length === 0) return;

        // One curve per route, at the longest run's midpoint (0.25° cache buckets
        // make neighbouring runs share it anyway).
        const anchor = eligible.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
        const untilMs = departureMs + HORIZON_MS;
        const curve = await withTimeout(
            fetchTideCurve(anchor.midLat, anchor.midLon, departureMs, untilMs),
            null,
            CURVE_FETCH_TIMEOUT_MS,
        );
        if (isStale()) return;
        if (!curve) {
            log.warn(`[tideWindow] no tide curve (offline / non-LAT / timeout) — ${eligible.length} chip(s) skipped`);
            return;
        }
        const tide = tideFieldFromCurve(curve);
        const [covStart, covEnd] = tide.coverage();
        const covered = covStart <= departureMs && covEnd >= untilMs;

        const placed: string[] = [];
        for (const run of eligible) {
            const res = computeTidalWindows({
                minDepthM: run.minDepthM as number,
                draftM,
                tideSafetyM: DEFAULT_TIDE_SAFETY_M,
                tide,
                fromMs: departureMs,
                untilMs,
            });
            if (res.alwaysOpen) continue; // margin actually clears at all tides — no chip needed
            let label: string;
            if (res.windows.length === 0) {
                if (!covered) {
                    // Data gap, NOT "never clears" — no chip, honest console line.
                    log.warn(
                        `[tideWindow] curve coverage gap over run @${run.midLat.toFixed(4)},${run.midLon.toFixed(4)} — chip skipped`,
                    );
                    continue;
                }
                label = `needs +${res.requiredRiseM.toFixed(1)} m — no window in 24 h`;
            } else {
                const w = res.windows[0];
                const approx = w.approx ? ' ≈' : '';
                label =
                    w.openMs <= departureMs
                        ? `clears until ${fmtHM(w.closeMs)}${approx}`
                        : `clears ${fmtHM(w.openMs)}–${fmtHM(w.closeMs)}${approx}`;
            }
            // Depth from an acknowledged NtM survey, not the chart edition —
            // say so: the skipper needs to know WHICH authority the number is.
            if (run.ntmSurveyed) label += ' (NtM survey)';
            if (isStale()) return;
            const marker = new mapboxgl.Marker({ element: chipElement(label), anchor: 'bottom', offset: [0, -8] })
                .setLngLat([run.midLon, run.midLat])
                .addTo(map);
            markers.push(marker);
            placed.push(`${(run.lengthM / 1852).toFixed(2)}NM@${run.minDepthM?.toFixed(1)}m→"${label}"`);
        }
        if (placed.length > 0)
            log.warn(
                `[tideWindow] ${placed.length} chip(s) via ${curve.stationName ?? 'station'}: ${placed.join(' | ')}`,
            );
    } catch (err) {
        // Annotation must never break the rendered route.
        log.warn(`[tideWindow] failed (route unaffected): ${err instanceof Error ? err.message : String(err)}`);
    }
}

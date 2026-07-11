/**
 * Tidal windows — Masterplan Phase 7. The "bar opens 09:40–15:10" maths.
 *
 * Given a shallow spot's charted minimum depth (below LAT), the vessel's
 * draft and the skipper's under-keel margin, compute when the tide lifts
 * the water enough to pass:
 *
 *     requiredRiseM = draftM + tideSafetyM − minDepthM   (≤0 ⇒ always open)
 *
 * and sweep the TideField for the intervals where height ≥ requiredRise.
 * TRUE tide crossings are PADDED INWARD (default 30 min); a window edge
 * that butts the sweep horizon is NOT a crossing and is never padded —
 * padding it made "you can cross RIGHT NOW" inexpressible (the 17:34 bug,
 * 2026-07-12).
 *
 * The old EXTREMES_INTERP +0.3 m threshold band is GONE (owner call,
 * 2026-07-12): the live-depth banner and tide scrubber present the SAME
 * interpolated curve as decision-grade, so a hidden extra buffer made the
 * app contradict itself — "+1.0 m right now" beside "needs +0.9, wait for
 * 17:34". The owner margin (tideSafetyM, §8-confirmed 0.5 m) is the
 * buffer; approximate curves stay labelled "(approx)" instead.
 *
 * Pure; wiring to real caution runs arrives with Phase 4's reason codes
 * (per-run min depareVerdict depth). Until then callers supply minDepthM.
 */

import type { TideField } from './env/EnvFields';

/** Owner-confirmed default under-keel margin over a bar (§8 answer 4). */
export const DEFAULT_TIDE_SAFETY_M = 0.5;
/** True-crossing window edges are pulled inward by this much. */
export const EDGE_PAD_MS = 30 * 60_000;

const SWEEP_STEP_MS = 5 * 60_000;

export interface TidalWindow {
    openMs: number;
    closeMs: number;
    /** True when built from an EXTREMES_INTERP field — label "approx". */
    approx: boolean;
}

export interface TidalWindowResult {
    /** Passable intervals within [fromMs, untilMs], edge-padded, sorted. */
    windows: TidalWindow[];
    /** The rise the tide must supply; ≤ 0 means no tide is needed. */
    requiredRiseM: number;
    /** True when the spot is passable at ANY tide (requiredRise ≤ 0). */
    alwaysOpen: boolean;
}

/**
 * Compute passable windows over a shallow spot.
 *
 * Returns alwaysOpen=true (and no windows) when the charted depth already
 * carries draft + margin at LAT. Returns empty windows when the tide
 * never reaches the required rise inside the asked interval — including
 * when the field simply has no coverage there (err closed, never guess).
 */
export function computeTidalWindows(opts: {
    /** Charted minimum depth below LAT over the shallow run (metres). */
    minDepthM: number;
    /** Vessel draft in METRES (callers convert via vesselDraftMetres). */
    draftM: number;
    tideSafetyM?: number;
    tide: TideField;
    fromMs: number;
    untilMs: number;
}): TidalWindowResult {
    const { minDepthM, draftM, tide, fromMs, untilMs } = opts;
    const tideSafetyM = opts.tideSafetyM ?? DEFAULT_TIDE_SAFETY_M;

    const requiredRiseM = draftM + tideSafetyM - minDepthM;
    if (requiredRiseM <= 0) {
        return { windows: [], requiredRiseM, alwaysOpen: true };
    }

    const approx = tide.provenance === 'EXTREMES_INTERP';

    // Sweep the interval for contiguous ≥requiredRise spans.
    const raw: Array<{ open: number; close: number }> = [];
    let openAt: number | null = null;
    for (let t = fromMs; t <= untilMs; t += SWEEP_STEP_MS) {
        const h = tide.heightAt(t);
        const passable = h !== null && h >= requiredRiseM;
        if (passable && openAt === null) openAt = t;
        if (!passable && openAt !== null) {
            raw.push({ open: openAt, close: t - SWEEP_STEP_MS });
            openAt = null;
        }
    }
    if (openAt !== null) raw.push({ open: openAt, close: untilMs });

    // Pad TRUE crossings inward; drop windows the padding consumes
    // entirely. An edge butting the sweep horizon is not a crossing —
    // the tide was already over the line at fromMs (or still over it at
    // untilMs) — and padding it hid the already-open-NOW window.
    const windows: TidalWindow[] = [];
    for (const w of raw) {
        const openMs = w.open <= fromMs ? w.open : w.open + EDGE_PAD_MS;
        const closeMs = w.close >= untilMs ? w.close : w.close - EDGE_PAD_MS;
        if (closeMs > openMs) windows.push({ openMs, closeMs, approx });
    }

    return { windows, requiredRiseM, alwaysOpen: false };
}

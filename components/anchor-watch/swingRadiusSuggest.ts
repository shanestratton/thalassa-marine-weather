/**
 * swingRadiusSuggest — Observed-arc-based swing radius proposal.
 *
 * After the anchor has been down for ~30 minutes and the boat has had a
 * chance to swing around with wind/tide shifts, this pure function
 * measures how far the vessel has ACTUALLY swung and proposes a radius
 * that comfortably contains the observed arc.
 *
 * This is a *safety-side* suggestion — the proposal is always bounded
 * below by the observed maximum. Accepting the suggestion increases the
 * safety margin just enough to match reality, eliminating the most
 * common cause of nuisance alarms ("I set 30m but the boat actually
 * swings 38m when the tide turns").
 *
 * Algorithm:
 *   1. Require ≥ 30 min elapsed and ≥ 20 position samples
 *   2. Compute max haversine distance from anchor across history
 *   3. Pad by a 15 % safety buffer
 *   4. Round UP to the nearest 5 m for a clean UX number
 *   5. Only propose if the result differs from the current radius by
 *      more than 15 % — otherwise the math already matched reality.
 *
 * This is NOT a circle-fit — circle-fit would find the arc's centre
 * (which might not be the anchor if drag is occurring) and radius.
 * For *proposing a safe swing*, we want the max observed distance FROM
 * THE ANCHOR, not the circle centre. Max-distance is the correct
 * signal here; circle-fit is a diagnostic for a different question.
 *
 * No drift / drag detection is done here — that's AnchorWatchService's
 * responsibility (alarm fires when readings exit the geofence). This
 * function assumes the vessel is holding and proposes a radius that
 * reflects the actual swing envelope.
 */
import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { haversineDistance } from '../../services/AnchorWatchService';

/** Minimum time on the hook before the suggestion is meaningful. */
const MIN_WATCH_MS = 30 * 60 * 1000;
/** Minimum number of position samples before fitting. */
const MIN_SAMPLES = 20;
/** How much the proposed radius must differ from current before we bother surfacing it. */
const SIGNIFICANT_DELTA_PCT = 0.15;
/** Safety buffer added on top of observed max. */
const SAFETY_BUFFER_PCT = 0.15;
/** Round up to this granularity for a clean displayable number. */
const ROUND_TO_M = 5;

export interface SwingRadiusSuggestion {
    /** Proposed radius in metres, rounded up to the nearest ROUND_TO_M. */
    proposed: number;
    /** The current configured swing radius, passed through for UI comparison. */
    current: number;
    /** The raw maximum observed distance from anchor (un-padded, un-rounded). */
    observedMaxM: number;
    /** Number of position samples used in the fit. */
    samples: number;
    /** Whether the proposal is LARGER (alarm-risk-reducer) or SMALLER (tighter). */
    direction: 'larger' | 'smaller';
}

/**
 * Compute a swing-radius suggestion from the current snapshot, or return
 * null if it's too early or the current radius already matches reality.
 */
export function suggestSwingRadius(snapshot: AnchorWatchSnapshot | null): SwingRadiusSuggestion | null {
    if (!snapshot) return null;
    if (snapshot.state !== 'watching') return null;
    if (!snapshot.anchorPosition) return null;
    if (!snapshot.watchStartedAt) return null;

    const elapsed = Date.now() - snapshot.watchStartedAt;
    if (elapsed < MIN_WATCH_MS) return null;

    const history = snapshot.positionHistory;
    if (!history || history.length < MIN_SAMPLES) return null;

    // Max observed distance from anchor across the whole history window.
    // Using the full history (not just recent) because the wind/tide that
    // produced the widest swing might have been an hour ago — we want to
    // remember that reality, not forget it.
    const anchorLat = snapshot.anchorPosition.latitude;
    const anchorLon = snapshot.anchorPosition.longitude;
    let observedMaxM = 0;
    for (const p of history) {
        const d = haversineDistance(anchorLat, anchorLon, p.latitude, p.longitude);
        if (d > observedMaxM) observedMaxM = d;
    }

    // Sanity: if the boat has barely moved (< 3m swing), we don't have
    // enough data to propose anything useful. Return null rather than
    // propose a tiny radius that would trigger false drag alarms on
    // the next GPS wobble.
    if (observedMaxM < 3) return null;

    // Pad + round.
    const padded = observedMaxM * (1 + SAFETY_BUFFER_PCT);
    const proposed = Math.ceil(padded / ROUND_TO_M) * ROUND_TO_M;

    const current = snapshot.swingRadius;
    // Guard against divide-by-zero on brand-new anchor drops before
    // calculateSwingRadius has run.
    if (current <= 0) return null;

    const deltaPct = Math.abs(proposed - current) / current;
    if (deltaPct < SIGNIFICANT_DELTA_PCT) return null;

    return {
        proposed,
        current,
        observedMaxM,
        samples: history.length,
        direction: proposed > current ? 'larger' : 'smaller',
    };
}

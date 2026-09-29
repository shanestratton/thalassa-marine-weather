/**
 * The Instrument Panel's shoaling trend, in the depth's own reference.
 *
 * shoalRate (services/sailing/sereneSailing.ts) adds an offset to the shown
 * depth to reach the keel. The only boat figure it needs is the DRAFT, from
 * the vessel profile (Shane 2026-09-29: "we should not need the offset for
 * the transducer. just the draft … lets not make it too complicated for the
 * punter"). It used to be handed Serene Summer's tape-measured
 * transducer-to-keel offset (-1.46 m) and a hard-coded 2.0 m draft, which
 * were wrong for every other boat and, once the Pi sent the boat display's
 * depth under the keel, subtracted the keel twice.
 *
 * The trace follows ONE reference too: when the feed switches (the Pi's keel
 * figure to a local sounder's transducer figure, say), the track restarts, so
 * the step between the two is never read as the bottom moving.
 *
 * PURE — no React, no store.
 */
import type { NmeaDepthReference } from '../../types/navigation';
import { shoalRate, type DepthTrackPoint } from '../../services/sailing/sereneSailing';

/** The trend's memory: 15 minutes of trace (shoalRate reads the last 6). */
export const DEPTH_TRACK_WINDOW_S = 900;

export interface DepthTrack {
    /** What every point's depth is measured from (null: the feed does not say). */
    reference: NmeaDepthReference | null;
    points: DepthTrackPoint[];
}

export const newDepthTrack = (): DepthTrack => ({ reference: null, points: [] });

/**
 * The offset shoalRate adds to a depth to reach the keel.
 *   • below the keel: 0 — the sounder already says what is under her;
 *   • anything else (below the waterline, below the transducer, or a feed
 *     that does not say): minus the draft. For a transducer below the
 *     waterline that takes off a little more than it needs to, which errs
 *     the safe way and needs no figure a skipper would have to measure.
 */
export function keelOffsetFor(reference: NmeaDepthReference | null | undefined, draftM: number): number {
    if (reference === 'below-keel') return 0;
    return -Math.max(0, draftM);
}

/** Add a live reading, restarting the trace if its reference differs, and
 * forget anything older than the window. Mutates `track`. */
export function recordDepth(
    track: DepthTrack,
    point: DepthTrackPoint,
    reference: NmeaDepthReference | null | undefined,
    windowS = DEPTH_TRACK_WINDOW_S,
): void {
    const ref = reference ?? null;
    if (track.reference !== ref) {
        track.reference = ref;
        track.points = [];
    }
    track.points.push(point);
    while (track.points.length > 0 && point.t - track.points[0].t > windowS) track.points.shift();
}

/** The shoaling trend for the trace, with the offset its reference needs.
 *
 * `draftAssumed` (vesselDraftIsAssumed: no draft in the vessel profile, or an
 * estimated one): a depth not measured from the keel then gives no keel time
 * — the fallback draft would tell a deeper boat an optimistic "keel down in
 * N min" — and the note says 'draft not set' instead (final review
 * 2026-09-29). A keel figure needs no draft, so its keel time stands.
 *
 * The colour comes from the same minutes, so it is not trusted either: a
 * shoaling trend with no draft set is never below 'serious' (safety tidy
 * 2026-09-29 — unknown data never gets a reassuring colour). A trace too
 * short to read, steady or deepening is left as it is. */
export function depthTrendFor(
    track: DepthTrack,
    draftM: number,
    nowMs: number = Date.now(),
    draftAssumed = false,
): ReturnType<typeof shoalRate> {
    const trend = shoalRate(track.points, keelOffsetFor(track.reference, draftM), nowMs);
    if (draftAssumed && track.reference !== 'below-keel' && trend.text.startsWith('Shoaling')) {
        return { ...trend, level: trend.level === 'critical' ? 'critical' : 'serious', note: 'draft not set' };
    }
    return trend;
}

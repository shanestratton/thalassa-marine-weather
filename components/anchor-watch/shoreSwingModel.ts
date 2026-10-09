/**
 * Shore Watch's radar (126-03a): the swing-circle canvas's model, built from
 * the latest broadcast and the trail this phone heard. Pure.
 *
 * No fake full snapshot: the canvas reads six fields, and these are they. The
 * Pi sends no fix accuracy, so the accuracy ring is drawn only when a boat's
 * phone sent one.
 *
 * Her trail is drawn only as far back as this phone heard her without a gap.
 * A shore phone sleeps (locked, in the background, a marina's LTE): drawn
 * whole, the trail joined the last half-minute before the gap to the first
 * after it with a straight line, and the canvas, which colours by place in the
 * line, painted hours-old points as recent. The newest unbroken stretch is one
 * half-minute apart, so its place in the line is its age, and the screen says
 * when it starts.
 */
import type { PositionBroadcast } from '../../services/AnchorWatchSyncService';
import type { SwingCanvasModel } from './SwingCircleCanvas';

/** Half-minutes of trail drawn (about 4 h): as many points as the boat's own radar draws. */
export const SHORE_TRAIL_DRAW_MAX = 500;

/**
 * Half-minutes further apart than this are a stretch this phone did not hear:
 * the trail breaks there. Up to two missed half-minutes (a socket's hiccup)
 * do not break it.
 */
export const SHORE_TRAIL_MAX_GAP_MS = 90_000;

type LatLon = { latitude: number; longitude: number };

/** One half-minute of her trail, timed by its start (SwingTrack's means are). */
export type ShoreTrailPoint = LatLon & { timestamp: number };

export type ShoreSwingModel = SwingCanvasModel & {
    /** When the trail drawn starts (its first half-minute), or null when none is drawn. */
    trailSince: number | null;
};

const NO_TRAIL: readonly ShoreTrailPoint[] = [];

const place = (p: LatLon): LatLon => ({ latitude: p.latitude, longitude: p.longitude });

/** The newest stretch heard without a gap, oldest first. */
function newestUnbrokenRun(trail: readonly ShoreTrailPoint[]): readonly ShoreTrailPoint[] {
    let start = trail.length;
    while (start > 0) {
        const t = trail[start - 1].timestamp;
        if (!Number.isFinite(t)) break;
        if (start < trail.length) {
            const gap = trail[start].timestamp - t;
            if (!(gap > 0 && gap <= SHORE_TRAIL_MAX_GAP_MS)) break;
        }
        start -= 1;
    }
    return start === 0 ? trail : trail.slice(start);
}

export function shoreSwingModel(
    data: PositionBroadcast,
    trail: readonly ShoreTrailPoint[],
    /** The shore's own confirmed drag (a push or an alarm packet) as well as the packet's flag. */
    isAlarm: boolean = data.isAlarm === true,
    max: number = SHORE_TRAIL_DRAW_MAX,
): ShoreSwingModel {
    const accuracy = data.vessel?.accuracy;
    let run = newestUnbrokenRun(trail);
    // The trail must lead to where she is: one that stopped well before her
    // latest fix is a stretch from before a gap, not her recent swing.
    const fixAt = Number.isFinite(data.vessel?.timestamp) ? data.vessel.timestamp : data.timestamp;
    if (run.length > 0 && Number.isFinite(fixAt) && fixAt - run[run.length - 1].timestamp > SHORE_TRAIL_MAX_GAP_MS) {
        run = NO_TRAIL;
    }
    if (run.length > max) run = run.slice(run.length - max);
    const drawn = run.length > 1 ? run : NO_TRAIL;
    return {
        state: isAlarm ? 'alarm' : 'watching',
        anchorPosition: data.anchor ? place(data.anchor) : null,
        vesselPosition: data.vessel ? place(data.vessel) : null,
        swingRadius: data.swingRadius,
        gpsAccuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0,
        positionHistory: drawn,
        trailSince: drawn.length > 0 ? drawn[0].timestamp : null,
    };
}

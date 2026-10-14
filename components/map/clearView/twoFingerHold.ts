/**
 * The clear view's gesture on Obs (129-13): two fingers held still on the chart.
 *
 * Shane, 2026-10-14: "We need a way to clear everything off the screen so we
 * can actually see the screen. A toggle of some kind. One that you can turn
 * on or off at the press of a (not another button)."
 *
 * Not a two-finger TAP: Mapbox GL already owns that. Its TapZoomHandler
 * (mapbox-gl 3.19.0, a TapRecognizer of two touches, one tap) zooms the chart
 * out a level, as Apple and Google Maps do, for any two-finger tap shorter
 * than 500 ms that moves under 30 px. A HOLD is free: Mapbox's recogniser
 * gives up once a touch ends more than 500 ms after the first began, pan and
 * pinch need movement, pitch and rotation are off on Obs, and the app's own
 * long press is one finger and stands down when a second lands.
 *
 * So: both fingers land within LAND_WITHIN_MS of each other, stay within
 * MAX_DRIFT_PX of where they landed, keep their spacing (a pinch is a zoom),
 * and are held HOLD_MS. It is decided as the fingers lift, on the touch
 * events' own timeStamps, the clock Mapbox decides its tap on: a touch that
 * Mapbox reads as a tap (under 500 ms) can never read as a hold here (600 ms
 * or more), however late a busy phone delivers the events.
 *
 * Drift is allowed on purpose: Mapbox starts a pan at 3 px of movement, and
 * fingers on a moving boat creep more than that. A hold that cancelled the
 * moment Mapbox panned would work only some of the time. The pan it allows
 * is bounded by MAX_DRIFT_PX.
 *
 * Pure: fed the touches still down and the event's time, so it is tested
 * without a browser (tests/ObsClearViewGesture.test.ts).
 */

export interface HoldPoint {
    id: number;
    x: number;
    y: number;
}

export const TWO_FINGER_HOLD = {
    /** The second finger lands within this of the first. */
    landWithinMs: 200,
    /** Held at least this long: past Mapbox's 500 ms two-finger tap, so a hold never zooms out. */
    holdMs: 600,
    /** No finger strays further than this from where it landed. */
    maxDriftPx: 12,
    /** The fingers' spacing changes no more than this (log2): Mapbox's own pinch threshold is 0.1. */
    maxSpreadLog2: 0.1,
} as const;

type Phase = 'idle' | 'one' | 'two' | 'done';

export class TwoFingerHold {
    private phase: Phase = 'idle';
    private firstAt = 0;
    private bothAt = 0;
    private starts = new Map<number, { x: number; y: number }>();
    private spread0 = 0;

    /**
     * The touches still down after a touchstart, touchmove or touchend, and
     * the event's time. True when this is the lift that ends a hold: toggle.
     */
    touches(points: readonly HoldPoint[], now: number): boolean {
        if (this.phase === 'two' && points.length < 2) {
            // The first finger up decides it, as it does for Mapbox's tap.
            const held = now - this.bothAt >= TWO_FINGER_HOLD.holdMs;
            this.phase = 'done';
            if (points.length === 0) this.reset();
            return held;
        }
        if (points.length === 0) {
            this.reset();
            return false;
        }
        if (this.phase === 'done') return false;
        if (points.length > 2) {
            this.phase = 'done';
            return false;
        }
        if (this.phase === 'idle') {
            this.starts.clear();
            for (const p of points) this.starts.set(p.id, { x: p.x, y: p.y });
            this.firstAt = now;
            if (points.length === 2) this.both(points, now);
            else this.phase = 'one';
            return false;
        }
        if (this.drifted(points)) {
            this.phase = 'done';
            return false;
        }
        if (this.phase === 'one' && points.length === 2) {
            if (now - this.firstAt > TWO_FINGER_HOLD.landWithinMs) {
                this.phase = 'done';
                return false;
            }
            for (const p of points) if (!this.starts.has(p.id)) this.starts.set(p.id, { x: p.x, y: p.y });
            this.both(points, now);
            return false;
        }
        if (this.phase === 'two' && this.pinched(points)) this.phase = 'done';
        return false;
    }

    /** Mapbox began a pinch, rotate or pitch, the touch was cancelled, or a mode took the chart. */
    cancel(): void {
        if (this.phase !== 'idle') this.phase = 'done';
    }

    private both(points: readonly HoldPoint[], now: number): void {
        this.phase = 'two';
        this.bothAt = now;
        this.spread0 = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    private drifted(points: readonly HoldPoint[]): boolean {
        for (const p of points) {
            const start = this.starts.get(p.id);
            if (!start) continue;
            if (Math.hypot(p.x - start.x, p.y - start.y) > TWO_FINGER_HOLD.maxDriftPx) return true;
        }
        return false;
    }

    private pinched(points: readonly HoldPoint[]): boolean {
        const spread = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        if (this.spread0 < 1 || spread < 1) return false;
        return Math.abs(Math.log2(spread / this.spread0)) > TWO_FINGER_HOLD.maxSpreadLog2;
    }

    private reset(): void {
        this.phase = 'idle';
        this.starts.clear();
        this.spread0 = 0;
    }
}

/**
 * rainTimeAxis — which rain frame shows a given moment, and how far the rain
 * imagery reaches. Phase 3 of the passage strip: the chart's rain follows the
 * look-ahead scrubber WHERE a product reaches that far, and says where it stops.
 *
 * The frames are not a uniform axis, so nothing here does index arithmetic:
 *   - radar frames carry their own unix time (RainViewer);
 *   - forecast frames are the Rainbow snapshot's time plus their offset — the
 *     snapshot id IS a clock (probed 2026-09-19: 1789761600, on the hour, 15.7
 *     minutes old), but it is only trusted as one when it is plausibly recent;
 *   - the steps are 10, 20 and 30 minutes, the newest radar frame is up to ten
 *     minutes old, and the first forecast frame is snapshot + 10 min — the seam
 *     between observed and forecast is neither "now" nor contiguous.
 * So: every frame that HAS a time is a candidate, the nearest one wins, and a
 * moment past the last of them is `beyond` — never the last frame held.
 */

export interface TimedRainFrame {
    /** Valid time of the frame, epoch ms; absent when it cannot be known. */
    timeMs?: number;
}

/** A snapshot id is believed to be a clock only this close to now. */
export const SNAPSHOT_MAX_AGE_MS = 3 * 3_600_000;
export const SNAPSHOT_MAX_AHEAD_MS = 10 * 60_000;
/** Past the last frame by more than this and the imagery has ended. */
export const RAIN_BEYOND_MS = 15 * 60_000;

/** The Rainbow snapshot as epoch ms, or null when it does not look like a recent clock. */
export function snapshotClockMs(snapshot: number | null | undefined, nowMs: number): number | null {
    if (typeof snapshot !== 'number' || !Number.isFinite(snapshot) || snapshot <= 0) return null;
    const ms = snapshot * 1000;
    return nowMs - ms <= SNAPSHOT_MAX_AGE_MS && ms - nowMs <= SNAPSHOT_MAX_AHEAD_MS ? ms : null;
}

/**
 * The frame nearest `targetMs`. Null when no frame carries a time. `beyond`
 * when the moment is past the last timed frame — the caller must NOT show that
 * last frame as though it were the answer.
 */
export function rainFrameForTime(
    frames: readonly TimedRainFrame[],
    targetMs: number,
): { index: number; beyond: boolean } | null {
    if (!Number.isFinite(targetMs)) return null;
    let best = -1;
    let bestDelta = Infinity;
    let last = -Infinity;
    for (let i = 0; i < frames.length; i++) {
        const t = frames[i]?.timeMs;
        if (typeof t !== 'number' || !Number.isFinite(t)) continue;
        if (t > last) last = t;
        const delta = Math.abs(t - targetMs);
        // `<=`: on a tie the LATER frame (the forecast, across the seam) wins.
        if (delta <= bestDelta) {
            best = i;
            bestDelta = delta;
        }
    }
    if (best < 0) return null;
    return { index: best, beyond: targetMs > last + RAIN_BEYOND_MS };
}

/** Hours ahead of now that timed imagery reaches; null when none of it is ahead of now. */
export function rainReachHours(frames: readonly TimedRainFrame[], nowMs: number): number | null {
    let last = -Infinity;
    for (const f of frames) {
        if (typeof f?.timeMs === 'number' && Number.isFinite(f.timeMs) && f.timeMs > last) last = f.timeMs;
    }
    const hours = (last - nowMs) / 3_600_000;
    return Number.isFinite(hours) && hours > 0 ? hours : null;
}

/** Closer to now than this, "the rain at that moment" IS the observed radar. */
export const RAIN_FOLLOW_FROM_MS = 10 * 60_000;

/**
 * The frame the chart should show while the passage look-ahead stands `aheadMs`
 * from now. Three rules, each a way of not lying:
 *   - at NOW (and for the first ten minutes) it is the newest OBSERVED frame —
 *     the clock-nearest frame at 03:16 is the 03:20 FORECAST, and now is not a
 *     forecast;
 *   - within the imagery's reach it is the frame nearest that moment, by clock;
 *   - past the reach it goes BACK to the observed frame, and the scrubber says
 *     where the rain ended. The last forecast frame is never held.
 */
export function rainFollowIndex(
    frames: readonly TimedRainFrame[],
    nowIdx: number,
    nowMs: number,
    aheadMs: number,
): number {
    const observed = Math.max(0, Math.min(Number.isFinite(nowIdx) ? Math.trunc(nowIdx) : 0, frames.length - 1));
    if (!(aheadMs >= RAIN_FOLLOW_FROM_MS)) return observed;
    const hit = rainFrameForTime(frames, nowMs + aheadMs);
    return hit && !hit.beyond ? hit.index : observed;
}

/**
 * mergeSettle — the windowed-merge generation slot, and the quiet-camera
 * discipline that keeps stale merges from ever allocating.
 *
 * Extracted pure from EncHazardService (2026-08-25, kill #27 — the second
 * Lady Musgrave kill) for the same reason mergeCap was: EncHazardService
 * subscribes to the cell registry at import time, and this logic needs
 * behavioural tests that must not inherit that side effect.
 *
 * WHY THIS EXISTS — kill #27 read straight off the Last Flight card:
 *
 *   enc:merge-start(9cells,30.6MB,a3268)@42s → merge-fail
 *   → start(21.0MB)→fail → start(15.4)→fail → start(15.1)→fail
 *   → start(17.6)→fail → start(15.7)→fail            (six in five seconds)
 *   → merge-done(8cells)@47s
 *   → enc:merge-start(6cells,10.6MB,a3339)@55s → PROCESS DIED
 *
 * Supersede-at-enqueue (2026-08-21) made stale merges ABORTABLE, but two
 * gaps remained, and the trail shows both:
 *
 *   1. A stale job still STARTED — the headroom brake, the start crumb and
 *      at least one multi-MB JSON.parse all ran before the first slice
 *      boundary could kill it. Six start/fail pairs is that cost, six times,
 *      with zero GC idle between them.
 *   2. The newest job started while the camera was still moving, so it was
 *      superseded mid-parse and its replacement started equally hot. The
 *      serial queue never saw a quiet moment; the 55 s build then landed on
 *      a process fattened by five seconds of abandoned transients and died.
 *      The a#### crumbs prove the killer was invisible to the native gauge
 *      (3.3 GB "available" at the death — see utils/heapGauge.ts): on iOS
 *      the WebContent ceiling cannot be measured, so the merge must be
 *      disciplined BY CONSTRUCTION, not by gauge.
 *
 * The discipline: a job at the front of the queue (a) skips outright if its
 * generation is already stale — no brake, no crumb ceremony, no parse — and
 * (b) holds until the generation has been quiet for MERGE_SETTLE_MS before
 * building. A stepped zoom across bucket edges now produces N-1 free skips
 * and ONE build that starts on a still camera, instead of N aborted parses.
 * This protects Chrome the same way — the 2026-08-09 "Aw, Snap" desktop
 * death was the identical pattern against a ~2.1 GB tab heap limit.
 *
 * ABORT COOLDOWN — kill #30 (Mackay harbour, 2026-08-25, same day):
 *
 *   merge-start(28.0MB)@42s→fail → start(31.3)@43s→fail → start(28.9)@43s
 *   → …nine starts, nine aborts, 13→5 cells, @42s–@50s… → merge-done@51s
 *   → geo-dispatch(w38619)@51s → tracer:ctx-start(8km,a3339)@56s
 *   → PROCESS DIED (foreground, no JS)
 *
 * The settle quiet coalesces claims within ONE continuous gesture. Kill #30
 * is the browse pattern it cannot see: pause, study the approach, nudge the
 * camera, pause — every pause is 350 ms quiet, so every pause legitimately
 * starts a ~30 MB parse that the next nudge aborts mid-build. Nine paid
 * aborts in ten seconds fattened the heap the gauge cannot read, and the
 * tracer context build was the last straw. So every mid-parse abort now arms
 * a COOLDOWN: the next build must additionally wait out the cooldown before
 * it may start, doubling per consecutive abort (1.5 s → 3 s, capped). Under
 * churn, builds degrade into free skips instead of paid parses; a completed
 * merge clears the state. The camera-quiet rule is unchanged.
 */

/**
 * How long the newest windowed-merge claim must go unchallenged before its
 * build may start. Long enough that a pinch-zoom stepping across bucket
 * edges (claims observed ~0.8 s apart in kill #27's trail) coalesces to one
 * build; short enough to be invisible next to a multi-second merge.
 */
export const MERGE_SETTLE_MS = 350;

/** Poll floor — never busy-wait tighter than this while settling. */
const SETTLE_POLL_FLOOR_MS = 50;

/** First-abort cooldown; doubles per consecutive abort up to the cap. */
export const MERGE_ABORT_COOLDOWN_MS = 1500;
export const MERGE_ABORT_COOLDOWN_MAX_MS = 3000;

let lastAbortAt = -Infinity;
let consecutiveAborts = 0;

/** A build was superseded MID-PARSE — it paid allocation before dying.
 *  Called from EncHazardService's MergeSupersededError branch. */
export function noteMergeAborted(now: number = performance.now()): void {
    consecutiveAborts = Math.min(consecutiveAborts + 1, 8);
    lastAbortAt = now;
}

/** A merge ran to completion — the churn is over, drop the cooldown. */
export function noteMergeCompleted(): void {
    consecutiveAborts = 0;
    lastAbortAt = -Infinity;
}

/** Milliseconds the NEXT heavy build must still wait out after recent
 *  mid-parse aborts. Zero once the cooldown has aged off. */
export function abortCooldownRemainingMs(now: number = performance.now()): number {
    if (consecutiveAborts === 0) return 0;
    const cooldown = Math.min(MERGE_ABORT_COOLDOWN_MS * 2 ** (consecutiveAborts - 1), MERGE_ABORT_COOLDOWN_MAX_MS);
    return Math.max(0, lastAbortAt + cooldown - now);
}

/** Monotonic id of the newest WINDOWED merge (full/seaway merges — zoom
 *  null — never participate: they serve a different consumer). */
let mergeGen = 0;
/** When the newest claim happened, on the performance.now() clock. */
let mergeGenClaimedAt = -Infinity;

/** Claim the newest-windowed-merge slot. Called at ENQUEUE time so a merge
 *  is stale-checkable from the moment it queues, not the moment the serial
 *  queue finally runs it (2026-08-21). */
export function claimMergeGen(now: number = performance.now()): number {
    mergeGenClaimedAt = now;
    return ++mergeGen;
}

/** True when a newer windowed merge has claimed the slot — this one's
 *  output would paint a chart nobody is looking at. An integer compare,
 *  safe in a tight loop. */
export function isMergeGenStale(myGen: number): boolean {
    return myGen !== mergeGen;
}

/**
 * Hold until `myGen` has been the unchallenged newest claim for
 * MERGE_SETTLE_MS. Resolves true when the camera has settled and the build
 * should run; false the moment a newer claim lands — the caller skips
 * without having allocated anything. Terminates fast by construction:
 * either the age crosses the threshold or the generation moves on.
 */
export async function awaitMergeGenSettle(
    myGen: number,
    now: () => number = () => performance.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
    while (!isMergeGenStale(myGen)) {
        const age = now() - mergeGenClaimedAt;
        const cooldown = abortCooldownRemainingMs(now());
        if (age >= MERGE_SETTLE_MS && cooldown <= 0) return true;
        await sleep(Math.max(SETTLE_POLL_FLOOR_MS, Math.max(MERGE_SETTLE_MS - age, cooldown)));
    }
    return false;
}

/**
 * Hold a NON-merge heavy build (the tracer's grading-context build) until
 * any active abort cooldown has aged off. A no-op in the common case;
 * under live churn it keeps the tracer from stacking its allocation on a
 * heap already fattened by aborted parses. Bounded by construction: the
 * cooldown only shrinks with time and is capped at
 * MERGE_ABORT_COOLDOWN_MAX_MS.
 */
export async function awaitMergeAbortCooldown(
    now: () => number = () => performance.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
    for (;;) {
        const remaining = abortCooldownRemainingMs(now());
        if (remaining <= 0) return;
        await sleep(Math.max(SETTLE_POLL_FLOOR_MS, remaining));
    }
}

/** Test-only: reset the slot so cases don't order-couple. */
export function __resetMergeGenForTest(): void {
    mergeGen = 0;
    mergeGenClaimedAt = -Infinity;
    lastAbortAt = -Infinity;
    consecutiveAborts = 0;
}

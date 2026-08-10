/**
 * serialQueue — run heavyweight async jobs ONE AT A TIME.
 *
 * Born 2026-08-10, the day every per-job memory bound held and the renderer
 * died anyway. The fatal trail's last crumbs:
 *
 *     enc:merge-start(14cells,23.5MB)@41891
 *     enc:merge-start(14cells,26.6MB)@42983   ← died in here
 *
 * Two merges CONCURRENT — each within its 32 MB register budget, together
 * carrying two registers plus two JSON.parse transients (a parse of a 26 MB
 * register briefly costs several times that in heap). Earlier in the same
 * trail, two tracer context builds overlapped the same way. Every bound in
 * the system is per-job; nothing bounded how many jobs ran at once.
 *
 * A queue caps the peak: jobs enqueue and run strictly in order, a failed
 * job rejects its own caller but never blocks the queue. Deliberately NOT
 * keyed or deduplicating — in-flight coalescing (merge cache, tracer
 * inflightBuilds) already handles identical requests; this only spaces out
 * DIFFERENT ones.
 */
export type SerialQueue = <T>(job: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
    let tail: Promise<unknown> = Promise.resolve();
    return function enqueue<T>(job: () => Promise<T>): Promise<T> {
        // Run after the previous job settles, whether it resolved or threw.
        const run = tail.then(job, job);
        // The tail must never be a rejected promise or the queue stalls with
        // an unhandled rejection; swallow here — `run` still rejects for the
        // caller.
        tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    };
}

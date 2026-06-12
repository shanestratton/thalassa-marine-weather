/**
 * deadline — JS-level wall-clock bounds for promises.
 *
 * WHY THIS EXISTS (field bug, 2026-06-12, on-water): with
 * `CapacitorHttp.enabled: true` (capacitor.config.ts), Capacitor patches
 * window.fetch to route requests through the native layer — and the
 * patch NEVER reads `options.signal`. Every `AbortSignal.timeout(...)`
 * in the codebase is therefore a silent no-op on device, and the native
 * default timeout is 600 000 ms. A stalled marine-LTE socket blocks an
 * await for up to 10 minutes. AbortSignal still works in desktop
 * browsers, so this never reproduces at the desk.
 *
 * These helpers cannot cancel the underlying request (nothing JS-side
 * can, under the patch) — they unblock the AWAITER so routes and UI
 * never sit behind a dead socket. The orphaned request finishes or dies
 * on its own in the native layer.
 */

/** Thrown by withDeadline when the promise doesn't settle in time. */
export class DeadlineExceeded extends Error {
    constructor(label: string, ms: number) {
        super(`${label} exceeded ${ms}ms deadline`);
        this.name = 'DeadlineExceeded';
    }
}

/**
 * Resolve `fallback` if `promise` hasn't settled within `ms`.
 * Rejections from the promise still propagate (callers' existing catch
 * blocks keep working). Use for fail-open semantics.
 */
export function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(fallback);
            }
        }, ms);
        promise.then(
            (v) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            (e) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(e);
                }
            },
        );
    });
}

/**
 * Reject with DeadlineExceeded if `promise` hasn't settled within `ms`.
 * Use where the caller already has an error path that must fire.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new DeadlineExceeded(label, ms));
            }
        }, ms);
        promise.then(
            (v) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(v);
                }
            },
            (e) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(e);
                }
            },
        );
    });
}

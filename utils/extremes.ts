/**
 * Max/min over an array WITHOUT spreading it into arguments.
 *
 * `Math.max(...arr)` passes every element as a separate function argument, so
 * on a long array it throws RangeError: Maximum call stack size exceeded. The
 * limit is engine-dependent and lower on JavaScriptCore than on V8, which is
 * exactly the wrong way round for an iOS app: it works on the simulator and
 * on a short test track, then dies on a real passage.
 *
 * Shane 2026-09-04: "i can not stop a route via the log page. the stop
 * tracking button does not work, and it kills the app and the app goes back to
 * the glass page." The crash was `Math.max(0, ...ve.map(...))` over every GPS
 * entry of the voyage being stopped — the longer the passage, the more certain
 * the crash, on the one action that ends it.
 */

/** Largest value, or `fallback` for an empty array. Never spreads. */
export function maxOf(values: readonly number[], fallback = 0): number {
    let out = fallback;
    let seen = false;
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (!seen || v > out) {
            out = v;
            seen = true;
        }
    }
    return out;
}

/** Smallest value, or `fallback` for an empty array. Never spreads. */
export function minOf(values: readonly number[], fallback = 0): number {
    let out = fallback;
    let seen = false;
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (!seen || v < out) {
            out = v;
            seen = true;
        }
    }
    return out;
}

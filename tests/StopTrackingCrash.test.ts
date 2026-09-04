/**
 * End Voyage must never take the app down with it.
 *
 * Shane 2026-09-04: "i can not stop a route via the log page. the stop
 * tracking button does not work, and it kills the app and the app goes back to
 * the glass page. this is an urgent bug fix."
 *
 * Both halves of that sentence were one bug. `Math.max(0, ...ve.map(...))`
 * spreads EVERY GPS entry of the voyage into function arguments, so on a real
 * passage it throws RangeError: Maximum call stack size exceeded. It sat in
 * the tidy-up AFTER the try/catch, so the throw escaped into the LogPage error
 * boundary, which unmounted the page and dropped the skipper back on The
 * Glass — looking like the button had not worked, when the track HAD stopped.
 *
 * The limit is engine-dependent and lower on JavaScriptCore than V8: exactly
 * the wrong way round for an iOS app. It passes on a short test track and dies
 * on a long passage — the one the skipper most wants to end.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { maxOf, minOf } from '../utils/extremes';

const hook = readFileSync('hooks/useLogPageState.ts', 'utf8');

/**
 * Source with comments removed.
 *
 * Asserting "this pattern is gone" against raw source keeps failing on the
 * COMMENT that explains why it was removed — three times in one day. A comment
 * naming the old code is documentation, not a regression; only executable code
 * counts.
 */
const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('maxOf / minOf survive a real passage', () => {
    it('handles an array far past the argument limit', () => {
        // 200k entries: Math.max(...this) throws RangeError on every engine.
        const many = Array.from({ length: 200_000 }, (_, i) => i);
        expect(() => Math.max(...many)).toThrow();
        expect(maxOf(many)).toBe(199_999);
        expect(minOf(many)).toBe(0);
    });

    it('returns the fallback for an empty array rather than -Infinity', () => {
        expect(maxOf([])).toBe(0);
        expect(minOf([], 99)).toBe(99);
        // Math.max() with no args is -Infinity, which would render as a
        // distance of "-Infinity NM" rather than an empty voyage.
        expect(maxOf([])).not.toBe(-Infinity);
    });

    it('ignores NaN rather than poisoning the whole result', () => {
        expect(maxOf([1, NaN, 3])).toBe(3);
        expect(minOf([5, NaN, 2])).toBe(2);
    });
});

describe('the End Voyage path', () => {
    it('never spreads entries into Math.max', () => {
        expect(code).not.toMatch(/Math\.max\([^)]*\.\.\./);
        expect(code).not.toMatch(/Math\.min\([^)]*\.\.\./);
        expect(code).toMatch(/const dist = maxOf\(ve\.map\(/);
    });

    it('the tidy-up after the track stops cannot escape into the error boundary', () => {
        // The GPS is already stopped by then — the half the button promised.
        // Anything that fails afterwards is recoverable from the Vessel tab.
        const fn = hook.slice(hook.indexOf('const confirmStopVoyage'), hook.indexOf('// ── Entry CRUD'));
        expect(fn).toMatch(/EVERYTHING BELOW IS TIDY-UP/);
        expect(fn).toMatch(/log\.warn\('post-stop tidy-up failed \(track IS stopped\)', e\)/);
    });
});

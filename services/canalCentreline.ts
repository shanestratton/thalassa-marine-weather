import type { Cell, GridShape } from './marinaCenterline';
import { visitGridSegment } from './gridSegmentTraversal';

const MAX_PATH_CELLS = 100_000;
const MAX_SIMPLIFICATION_WORK = 250_000;
const MAX_DEVIATION_CELLS = 0.75;
const CLEARANCE_TOLERANCE_CELLS = 1;

/** De-staircase a four-connected canal centreline without pulling it taut
 * against an inside bank. All original cells are checked before simplification;
 * exhausted work budgets retain that original checked geometry, never a chord.
 * Geometry clearance is not an assertion of depth or vessel clearance. */
export function preserveCanalCentreline(
    path: Cell[],
    passable: Uint8Array,
    clearance: Float32Array,
    { width, height }: GridShape,
): Cell[] | null {
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        passable.length !== width * height ||
        clearance.length !== passable.length ||
        !path.length ||
        path.length > MAX_PATH_CELLS
    )
        return null;
    const original: Cell[] = [];
    for (const cell of path) {
        const { x, y } = cell;
        if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            x < 0 ||
            y < 0 ||
            x >= width ||
            y >= height ||
            !passable[y * width + x] ||
            !Number.isFinite(clearance[y * width + x])
        )
            return null;
        const previous = original.at(-1);
        const step = previous ? Math.abs(x - previous.x) + Math.abs(y - previous.y) : 1;
        if (step > 1) return null; // Only the original adjacent-cell solver path may be a fallback.
        if (step) original.push({ x, y });
    }
    if (original.length < 3) return original;
    const keep = new Uint8Array(original.length);
    keep[0] = keep[original.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, original.length - 1]];
    let work = 0;
    let exhausted = false;
    const chordClear = (lo: number, hi: number): boolean => {
        const a = original[lo];
        const b = original[hi];
        return visitGridSegment(a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5, (x, y, t) => {
            if (++work > MAX_SIMPLIFICATION_WORK) {
                exhausted = true;
                return false;
            }
            if (x < 0 || y < 0 || x >= width || y >= height || !passable[y * width + x]) return false;
            const actual = clearance[y * width + x];
            const referenceIndex = lo + Math.max(0, Math.min(1, t)) * (hi - lo);
            const before = original[Math.floor(referenceIndex)];
            const after = original[Math.ceil(referenceIndex)];
            const reference = Math.min(clearance[before.y * width + before.x], clearance[after.y * width + after.x]);
            return Number.isFinite(actual) && actual + CLEARANCE_TOLERANCE_CELLS >= reference;
        });
    };
    while (stack.length) {
        const [lo, hi] = stack.pop()!;
        if (hi <= lo + 1) continue;
        const a = original[lo];
        const b = original[hi];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        let worst = -1;
        let split = lo + 1;
        for (let index = lo + 1; index < hi; index++) {
            if (++work > MAX_SIMPLIFICATION_WORK) return original;
            const c = original[index];
            const fraction = lengthSquared
                ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSquared))
                : 0;
            const deviation = (c.x - a.x - fraction * dx) ** 2 + (c.y - a.y - fraction * dy) ** 2;
            if (deviation > worst) {
                worst = deviation;
                split = index;
            }
        }
        if (worst <= MAX_DEVIATION_CELLS ** 2 && chordClear(lo, hi)) continue;
        if (exhausted) return original;
        keep[split] = 1;
        stack.push([lo, split], [split, hi]);
    }
    return original.filter((_, index) => keep[index]);
}

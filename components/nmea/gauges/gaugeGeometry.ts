/**
 * Shared dial geometry for the round instrument faces.
 *
 * Extracted when the rudder gauge was built alongside the barometer
 * (2026-09-02): two faces drawing the same arcs from two copies of the same
 * trigonometry is how they drift apart, and a dial that disagrees with its
 * neighbour about where "up" is looks broken even when both are correct.
 *
 * ANGLES ARE DIAL DEGREES: 0 is straight up, increasing clockwise, which is
 * how an instrument is described out loud ("needle's at two o'clock") rather
 * than how SVG measures things.
 */

/** Dial degrees → SVG point on a circle. */
export function polarToCart(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** An arc path between two dial angles, always drawn clockwise. */
export function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const s = polarToCart(cx, cy, r, startDeg);
    const e = polarToCart(cx, cy, r, endDeg);
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

/**
 * Tangential text rotation that never reads upside down.
 *
 * A label rotated by its own dial angle inverts anywhere past the horizontal —
 * which is exactly how STORMY and RAIN ended up unreadable on the first
 * barometer face. Normalised first, because a sweep that starts at 225 runs
 * past 360 and the naive test then silently flips labels back.
 */
export function uprightRotation(angleDeg: number): number {
    const a = ((angleDeg % 360) + 360) % 360;
    return a > 90 && a < 270 ? a + 180 : a;
}

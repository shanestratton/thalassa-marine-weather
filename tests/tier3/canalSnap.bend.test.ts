/**
 * snapRouteToCanalLines — canal-bend corner-cut regression (Newport "off the
 * centre at the bend").
 *
 * Root cause (Claude + Geeps, 2026-06-24, docs/AI_COLLAB.md): the snap's
 * `onCanal` detector measured distance to the nearest canal-graph NODE, not the
 * nearest line SEGMENT. Real canal centre-lines have long straight runs (Newport
 * has 447 m / 297 m / 261 m segments). A fine-grid route emits ~12 m-spaced
 * points; the ones mid-long-segment sit >80 m from either endpoint node, so the
 * node-distance test flagged them OFF-canal even though they're 0 m from the
 * line. With ~20 consecutive points flagged off, the snap "run" shattered
 * (≫ CANAL_RUN_GAP) and the Dijkstra centre-line never spanned the bend — leaving
 * the raw corner-cut. Fix: detect on-canal by point-to-SEGMENT distance.
 * (Fix first landed in 6493f9d2, was lost with the reverted base in cc4e2840,
 * restored 2026-07-02.)
 *
 * This test is synthetic (no Pi, CI-able): an L-shaped canal with a long lead-in
 * segment + a dense route that corner-cuts the bend. It must come out riding the
 * centre-line within a couple of cells.
 */
import { describe, it, expect } from 'vitest';
import { snapRouteToCanalLines } from '../../services/tier3/canalLineFollower';
import type { LatLon } from '../../services/routing/legContract';

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Point→segment distance (m) in a local planar frame. */
function pointToSegM(p: LatLon, a: LatLon, b: LatLon): number {
    const refLat = (a[1] + b[1]) / 2;
    const mx = mPerLon(refLat);
    const my = M_PER_LAT;
    const ax = a[0] * mx,
        ay = a[1] * my;
    const bx = b[0] * mx,
        by = b[1] * my;
    const px = p[0] * mx,
        py = p[1] * my;
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Min point→polyline-segment distance (m). */
function offToLine(p: LatLon, line: readonly LatLon[]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, pointToSegM(p, line[i], line[i + 1]));
    return best;
}

describe('snapRouteToCanalLines — bend corner-cut (node-vs-segment regression)', () => {
    // L-shaped canal centre-line: ~445 m due-north lead-in (A→B), then ~495 m
    // due-east (B→C). The bend is at B. Both legs are SINGLE long segments —
    // this is what makes the node-distance detector fail.
    const A: LatLon = [153.09, -27.21];
    const B: LatLon = [153.09, -27.206]; // 0.004° lat ≈ 442 m north of A
    const C: LatLon = [153.095, -27.206]; // 0.005° lon ≈ 495 m east of B
    const canalLine: LatLon[] = [A, B, C];
    const canalLines = [canalLine];

    // Raw route mimicking a fine-grid pass: dense (~11 m) points UP the lead-in
    // riding the centre-line, a 2-point corner-cut that clips ~45 m inside the
    // bend, then dense points OUT along the east leg. Everything but the corner
    // clip sits exactly on the centre-line.
    function buildRoute(): LatLon[] {
        const pts: LatLon[] = [];
        // up the lead-in A→ (stop short of B for the cut), every 0.0001° (~11 m)
        for (let lat = -27.21; lat <= -27.2069; lat += 0.0001) pts.push([153.09, +lat.toFixed(6)]);
        // corner-cut: clip the inside of the bend (east of the lead-in, south of BC)
        pts.push([153.0906, -27.2063]); // ~45 m off the centre-line corner
        pts.push([153.0912, -27.2061]);
        // out along B→C, every 0.0001° lon (~10 m)
        for (let lon = 153.0915; lon <= 153.095; lon += 0.0001) pts.push([+lon.toFixed(6), -27.206]);
        return pts;
    }

    it('a long lead-in segment must not shatter the snap run (every output vertex rides the centre-line)', () => {
        const route = buildRoute();
        // Sanity: the raw route's worst point is the corner-cut (off the line).
        const rawWorst = Math.max(...route.map((p) => offToLine(p, canalLine)));
        expect(rawWorst).toBeGreaterThan(30); // the cut really does leave the line

        const { polyline, onCanal } = snapRouteToCanalLines(route, canalLines);

        // Every output vertex must ride the centre-line (the snap routed the bend
        // via the graph). Allow a couple of cells of slack for the pinned ends.
        const offs = polyline.map((p) => offToLine(p, canalLine));
        const worst = Math.max(...offs);
        const meanOff = offs.reduce((s, v) => s + v, 0) / offs.length;
        // eslint-disable-next-line no-console
        console.log(
            `[canalSnap.bend] raw worst=${rawWorst.toFixed(0)}m → snapped worst=${worst.toFixed(0)}m mean=${meanOff.toFixed(1)}m onCanal=${onCanal.filter(Boolean).length}/${onCanal.length}`,
        );

        expect(worst, 'snapped route must not corner-cut the bend').toBeLessThan(20);
        // The bulk of the run must be flagged on-canal (so it renders RED).
        expect(onCanal.filter(Boolean).length).toBeGreaterThan(onCanal.length / 2);
    });
});

/**
 * Out-and-back detection for route tests (no out-and-back, 2026-10-01): a
 * route must never visit deep water only to come back through the same
 * shallows.
 */
import { haversineM } from '../../services/engine/geometry';

/**
 * An out-and-back: some stretch of the route comes back within `nearM` of a
 * point it passed more than `apartM` earlier along it (sampled every 20 m).
 */
export function revisits(poly: readonly [number, number][], nearM = 60, apartM = 400): boolean {
    const pts: { p: [number, number]; m: number }[] = [];
    let m = 0;
    for (let i = 0; i + 1 < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[i + 1];
        const seg = haversineM(ay, ax, by, bx);
        const n = Math.max(1, Math.ceil(seg / 20));
        for (let k = 0; k < n; k++)
            pts.push({ p: [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n], m: m + (seg * k) / n });
        m += seg;
    }
    for (let j = 0; j < pts.length; j++)
        for (let i = 0; i < j; i++) {
            if (pts[j].m - pts[i].m <= apartM) break;
            if (haversineM(pts[i].p[1], pts[i].p[0], pts[j].p[1], pts[j].p[0]) < nearM) return true;
        }
    return false;
}

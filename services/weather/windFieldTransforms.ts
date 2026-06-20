/**
 * windFieldTransforms — pure WindGrid → WindGrid transforms for the chart's
 * field switcher.
 *
 * The WebGL particle engine (WindParticleLayer) colours both its trails and the
 * scalar heatmap from the grid's velocity magnitude (√(u²+v²)) and `speed`
 * array. Rather than thread a "field" mode deep into the 1300-line renderer, we
 * express the GUST field as a DATA transform: keep the wind DIRECTION (gusts
 * have none of their own) but rescale the U/V magnitude to the gust speed, and
 * set `speed` to the gust magnitude. The renderer then colours by gust for free,
 * and particles surge at gust speed in the wind's direction — physically honest.
 */

import type { WindGrid } from './windField';

/** Below this sustained speed (m/s) the wind direction is noise — don't try to
 *  rescale a near-zero vector (it would blow up). Spawn a zero vector there;
 *  the heatmap still shows the gust magnitude via `speed`. */
const CALM_EPSILON_MS = 0.05;

/**
 * Return a WindGrid whose particle/heatmap magnitude reflects GUST rather than
 * sustained wind, preserving wind direction.
 *
 * No-op (returns the input unchanged) when the grid carries no `gust` data —
 * GFS-GRIB-edge grids and CMEMS grids don't, so callers can apply this
 * unconditionally and only get the transform when gust is actually available.
 */
export function applyGustField(grid: WindGrid): WindGrid {
    if (!grid.gust || grid.gust.length === 0) return grid;

    const size = grid.width * grid.height;
    const u: Float32Array[] = [];
    const v: Float32Array[] = [];
    const speed: Float32Array[] = [];

    for (let h = 0; h < grid.totalHours; h++) {
        const uSrc = grid.u[h];
        const vSrc = grid.v[h];
        const gSrc = grid.gust[h];

        // Hour missing gust (ragged source) → pass the sustained-wind step
        // through untouched. Always advance all three arrays together (zero-
        // filling a missing component) so they stay index-aligned with the
        // hour loop — a desync would feed the renderer mismatched timesteps.
        if (!uSrc || !vSrc || !gSrc) {
            u.push(uSrc ?? new Float32Array(size));
            v.push(vSrc ?? new Float32Array(size));
            speed.push(grid.speed[h] ?? new Float32Array(size));
            continue;
        }

        const uOut = new Float32Array(size);
        const vOut = new Float32Array(size);
        const sOut = new Float32Array(size);

        for (let i = 0; i < size; i++) {
            const su = uSrc[i];
            const sv = vSrc[i];
            const gust = gSrc[i];
            const sustained = Math.hypot(su, sv);
            sOut[i] = gust;
            if (sustained > CALM_EPSILON_MS) {
                const scale = gust / sustained;
                uOut[i] = su * scale;
                vOut[i] = sv * scale;
            }
            // else: calm — leave u/v at 0 (no direction to surge along)
        }

        u.push(uOut);
        v.push(vOut);
        speed.push(sOut);
    }

    return { ...grid, u, v, speed };
}

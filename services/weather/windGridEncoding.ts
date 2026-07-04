/**
 * windGridEncoding — the pure, dependency-free core of the wind field: the
 * WindGrid shape, the texture-encoding constant, and the RGBA encoder the
 * WebGL particle engine uploads.
 *
 * Split out of windField.ts (2026-07-05) so the GPU renderer (WindGLEngine)
 * can be reused on the PUBLIC voyage-log page WITHOUT dragging in the app's
 * fetch stack (PiCacheService, Capacitor, API keys). The fetching half stays
 * in windField.ts and re-exports these; nothing else changes for the app.
 */

export const MAX_SPEED = 60.0; // m/s — clamp range for texture encoding

export interface WindGrid {
    /** U component (m/s, +east) per hour: [hour][row][col] */
    u: Float32Array[];
    /** V component (m/s, +north) per hour: [hour][row][col] */
    v: Float32Array[];
    /** Scalar speed (m/s) per hour: [hour][row][col] */
    speed: Float32Array[];
    /** Optional scalar wind-GUST magnitude (m/s) per hour: [hour][row][col]. */
    gust?: Float32Array[];
    /** Grid coordinates */
    width: number; // columns
    height: number; // rows
    lats: number[];
    lons: number[];
    /** Bounds */
    north: number;
    south: number;
    west: number;
    east: number;
    totalHours: number;
    /** GFS model run reference time (ISO string), if available */
    refTime?: string;
    /** Optional u8[width*height] land mask: 1=land, 0=ocean. */
    landMask?: Uint8Array;
    /** Actual forecast-hour offset per step-index (0-based) — UI labels. */
    hourOffsets?: number[];
    /** Forecast-hour offset of each time step — authoritative for sampling. */
    stepHours?: number[];
}

/**
 * Pack one hour of the grid into an RGBA texture the shader decodes:
 *   R = (u + MAX_SPEED) / (2·MAX_SPEED)   G = (v + MAX_SPEED) / (2·MAX_SPEED)
 *   B = speed / MAX_SPEED                 A = 255
 */
export function encodeWindTexture(grid: WindGrid, hour: number): Uint8Array {
    const h = Math.min(hour, grid.totalHours - 1);
    const uData = grid.u[h];
    const vData = grid.v[h];
    const sData = grid.speed[h];
    const size = grid.width * grid.height;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
        const u = uData[i];
        const v = vData[i];
        const s = sData[i];

        rgba[i * 4 + 0] = Math.round(Math.max(0, Math.min(255, ((u + MAX_SPEED) / (2 * MAX_SPEED)) * 255)));
        rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, ((v + MAX_SPEED) / (2 * MAX_SPEED)) * 255)));
        rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, (s / MAX_SPEED) * 255)));
        rgba[i * 4 + 3] = 255;
    }

    return rgba;
}

/**
 * satelliteWater — classify the navigable water of a canal/marina from Mapbox
 * SATELLITE RASTER tiles, so the tier-3 fine canal pass routes the REAL channel
 * shape instead of the coarse OSM `water` polygons.
 *
 * Why (2026-06-19): the ENC omits canal water entirely; we had been filling it
 * with Mapbox's VECTOR `water` layer (services/mapboxWater.ts) — but that is
 * OSM-derived and coarsely simplified, so the canal outline it gives is wrong,
 * and routeMarina's medial axis of a wrong outline is off-centre/wobbly. The
 * satellite imagery we already render shows the canal water plainly; classifying
 * its PIXELS yields the true channel shape, and the medial axis of true water is
 * the true centreline.
 *
 * Scope: tier-3 ONLY (canal/marina endpoint crops). Tier-2 open water is left to
 * the ENC, unchanged. This is a drop-in for fetchMapboxWater at the injection
 * seam in InshoreRouter — it returns the same `water polygons` FeatureCollection.
 *
 * Split: the classifier (classifyWaterMask) and the mask→polygons step
 * (maskToWaterPolygons) are PURE and unit-tested on synthetic pixels. Only
 * fetchSatelliteWater touches the network + canvas (browser-only decode).
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { withTimeout } from '../utils/deadline';
import { tilesForBbox, type TileId } from './mapboxWater';

/** Retina (@2x) tile edge in pixels. */
const TILE_PX = 512;

/** Zoom for the satellite raster. z14 (≈4 m/px @2x at this latitude) is the sweet
 *  spot: a 50 m canal is ~12 px (ample for the 12 m fine grid), the canal SURFACE
 *  averages smooth so the texture gate keeps it WHOLE, and a ~6 km crop is only
 *  ~9 tiles. z15 looked tempting for detail but its finer pixels surface
 *  boat/jetty/ripple texture that shatters the canal into specks the size filter
 *  deletes — verified on real Newport: z15 → 5% sparse/broken water, z14 → 12%
 *  connected. Detail beyond the routing grid is worse than useless here. */
export const SAT_WATER_ZOOM = 14;

/** Synthetic depth (m) stamped on satellite water — matches MAPBOX_WATER_DEPTH_M
 *  so the downstream injectedCanal/fine-pass behaviour is identical. */
export const SAT_WATER_DEPTH_M = 5;

const rasterTileUrl = (t: TileId, token: string): string =>
    `https://api.mapbox.com/v4/mapbox.satellite/${t.z}/${t.x}/${t.y}@2x.png?access_token=${token}`;

export interface ClassifyParams {
    /** Half-window (px) for the local-texture (smoothness) test. */
    textureHalf: number;
    /** Max local std (gray 0..1) for a pixel to count as smooth (water-like). */
    textureMax: number;
    /** Binary-closing iterations (dilate ×N then erode ×N) BEFORE the
     *  connected-component filter — bridges the gaps a jetty/boat/ripple punches
     *  in a canal so the whole network stays ONE component and survives the size
     *  filter. The cure for the fragmented z15 mess. */
    closeIterations: number;
    /** Drop connected water components smaller than this fraction of the image
     *  (removes pools / dark roofs / shadows; keeps the canal network, which is
     *  one large body connected to the inlet/bay). */
    minComponentFrac: number;
}

export const DEFAULT_CLASSIFY: ClassifyParams = {
    // Tuned on real Newport imagery. Half-window 2 (≈5 px) catches house-scale
    // texture while barely eroding a canal edge. closeIterations 2 bridges
    // jetty/boat gaps so the canal tree stays one connected body. See SAT_WATER_ZOOM
    // — z14 (not z15) is essential: z15's finer detail surfaces boat/ripple texture
    // that fragments the canal into specks the size filter then deletes (5% sparse
    // water); z14 averages that smooth and the canal comes out whole (~12%).
    textureHalf: 2,
    textureMax: 0.06,
    closeIterations: 2,
    minComponentFrac: 0.002,
};

// ── Binary morphology (8-connected) ─────────────────────────────────
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (mask[i]) {
                out[i] = 1;
                continue;
            }
            let any = 0;
            for (let dy = -1; dy <= 1 && !any; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= w) continue;
                    if (mask[ny * w + nx]) {
                        any = 1;
                        break;
                    }
                }
            }
            out[i] = any;
        }
    }
    return out;
}

function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!mask[i]) continue;
            let all = 1;
            for (let dy = -1; dy <= 1 && all; dy++) {
                const ny = y + dy;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) {
                        all = 0;
                        break;
                    }
                }
            }
            out[i] = all;
        }
    }
    return out;
}

/**
 * Classify each pixel of an RGBA satellite raster as water (1) or not (0). PURE.
 *
 * Three gates, matching the proven Python prototype:
 *   1. COLOUR — bluish (blue ≥ red) and not bright, OR very dark (deep/shadowed
 *      water); explicitly excludes bright green vegetation.
 *   2. TEXTURE — water is smooth: low local standard deviation. This is what
 *      rejects the suburban roofs/roads/pools that share water's colour.
 *   3. CONNECTIVITY — close 1 px gaps, keep only connected components above
 *      minComponentFrac (the canal network is one large body; specks are noise),
 *      then open to shed 1 px spurs.
 */
export function classifyWaterMask(
    rgba: Uint8ClampedArray | Uint8Array,
    w: number,
    h: number,
    params: ClassifyParams = DEFAULT_CLASSIFY,
): Uint8Array {
    const n = w * h;
    const gray = new Float64Array(n);
    const colour = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const bright = (r + g + b) / 3;
        gray[i] = bright / 255;
        // NEAR-BLACK is unfetched/no-data, NOT water — real daytime water is ≥ ~15
        // bright. Without this, an undelivered tile (rgba zeros) reads as a giant
        // dark-water blob ⇒ the router shortcuts through fake water ⇒ "route too
        // small". (fetchSatelliteWater also masks uncovered pixels; belt + braces.)
        const tooBlack = bright < 8;
        const bluishDark = (b >= r - 6 && bright < 135) || bright < 45;
        const greenVeg = g > r + 25 && g > b + 15;
        colour[i] = bluishDark && !greenVeg && !tooBlack ? 1 : 0;
    }

    // Local std via integral images of gray and gray² — O(1) per pixel.
    const W1 = w + 1;
    const sat = new Float64Array(W1 * (h + 1));
    const sat2 = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = gray[y * w + x];
            const a = (y + 1) * W1 + (x + 1);
            sat[a] = v + sat[y * W1 + (x + 1)] + sat[(y + 1) * W1 + x] - sat[y * W1 + x];
            sat2[a] = v * v + sat2[y * W1 + (x + 1)] + sat2[(y + 1) * W1 + x] - sat2[y * W1 + x];
        }
    }
    const boxStat = (table: Float64Array, x0: number, y0: number, x1: number, y1: number): number =>
        table[(y1 + 1) * W1 + (x1 + 1)] - table[y0 * W1 + (x1 + 1)] - table[(y1 + 1) * W1 + x0] + table[y0 * W1 + x0];

    const hw = params.textureHalf;
    const water = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!colour[i]) continue;
            const x0 = Math.max(0, x - hw);
            const y0 = Math.max(0, y - hw);
            const x1 = Math.min(w - 1, x + hw);
            const y1 = Math.min(h - 1, y + hw);
            const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
            const mean = boxStat(sat, x0, y0, x1, y1) / cnt;
            const variance = boxStat(sat2, x0, y0, x1, y1) / cnt - mean * mean;
            if (Math.sqrt(Math.max(0, variance)) < params.textureMax) water[i] = 1;
        }
    }

    // Close gaps (dilate ×N then erode ×N) so a canal split by a jetty/boat/ripple
    // stays ONE connected body — else the size filter below deletes the pieces.
    let m: Uint8Array = water;
    for (let k = 0; k < params.closeIterations; k++) m = dilate(m, w, h);
    for (let k = 0; k < params.closeIterations; k++) m = erode(m, w, h);

    // Keep only large connected components (4-connected BFS).
    const labels = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const minSize = n * params.minComponentFrac;
    const keep = new Uint8Array(n);
    let cur = 0;
    for (let s = 0; s < n; s++) {
        if (!m[s] || labels[s] !== -1) continue;
        let head = 0;
        let tail = 0;
        queue[tail++] = s;
        labels[s] = cur;
        const members: number[] = [];
        while (head < tail) {
            const idx = queue[head++];
            members.push(idx);
            const x = idx % w;
            const y = (idx / w) | 0;
            if (x > 0 && m[idx - 1] && labels[idx - 1] === -1) {
                labels[idx - 1] = cur;
                queue[tail++] = idx - 1;
            }
            if (x < w - 1 && m[idx + 1] && labels[idx + 1] === -1) {
                labels[idx + 1] = cur;
                queue[tail++] = idx + 1;
            }
            if (y > 0 && m[idx - w] && labels[idx - w] === -1) {
                labels[idx - w] = cur;
                queue[tail++] = idx - w;
            }
            if (y < h - 1 && m[idx + w] && labels[idx + w] === -1) {
                labels[idx + w] = cur;
                queue[tail++] = idx + w;
            }
        }
        if (members.length >= minSize) for (const idx of members) keep[idx] = 1;
        cur++;
    }

    // Open to shed 1 px spurs left by the close.
    m = dilate(erode(keep, w, h), w, h);
    return m;
}

/** Maps a stitched-image pixel (px,py) to [lon,lat]. */
export type PxToLonLat = (px: number, py: number) => [number, number];

/**
 * Convert a water mask to GeoJSON Polygon features at `cellPx` resolution. PURE.
 * Downsamples the fine satellite mask to ~routing-grid cells (a cell is water if
 * ≥ half its pixels are water), then emits one rectangle per horizontal run of
 * water cells — far fewer features than per-pixel, accurate at the fine-grid
 * resolution the polygons are re-rasterised to. Each ring is closed lon/lat.
 */
export function maskToWaterPolygons(
    mask: Uint8Array,
    w: number,
    h: number,
    pxToLonLat: PxToLonLat,
    cellPx: number,
): Feature<Polygon>[] {
    const cw = Math.max(1, Math.floor(w / cellPx));
    const ch = Math.max(1, Math.floor(h / cellPx));
    // Downsample: cell water if ≥ half its source pixels are water.
    const cell = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            const px0 = cx * cellPx;
            const py0 = cy * cellPx;
            const px1 = Math.min(w, px0 + cellPx);
            const py1 = Math.min(h, py0 + cellPx);
            let wet = 0;
            let tot = 0;
            for (let py = py0; py < py1; py++)
                for (let px = px0; px < px1; px++) {
                    tot++;
                    if (mask[py * w + px]) wet++;
                }
            cell[cy * cw + cx] = tot > 0 && wet * 2 >= tot ? 1 : 0;
        }
    }
    const feats: Feature<Polygon>[] = [];
    for (let cy = 0; cy < ch; cy++) {
        let cx = 0;
        while (cx < cw) {
            if (!cell[cy * cw + cx]) {
                cx++;
                continue;
            }
            let runEnd = cx;
            while (runEnd < cw && cell[cy * cw + runEnd]) runEnd++;
            // Rectangle [cx, runEnd) × [cy, cy+1) in cells → px corners → lon/lat.
            const x0 = cx * cellPx;
            const x1 = runEnd * cellPx;
            const y0 = cy * cellPx;
            const y1 = (cy + 1) * cellPx;
            const tl = pxToLonLat(x0, y0);
            const tr = pxToLonLat(x1, y0);
            const br = pxToLonLat(x1, y1);
            const bl = pxToLonLat(x0, y1);
            feats.push({
                type: 'Feature',
                properties: {},
                geometry: { type: 'Polygon', coordinates: [[tl, tr, br, bl, tl]] },
            });
            cx = runEnd;
        }
    }
    return feats;
}

/** Inverse slippy transform: global @2x pixel → [lon,lat] at zoom z. */
function globalPxToLonLat(gx: number, gy: number, z: number): [number, number] {
    const world = TILE_PX * 2 ** z;
    const lon = (gx / world) * 360 - 180;
    const merc = (1 - (2 * gy) / world) * Math.PI;
    const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
    return [lon, lat];
}

/** Decode a PNG ArrayBuffer to RGBA via the browser canvas. Browser-only. */
async function decodePng(buf: ArrayBuffer): Promise<{ rgba: Uint8ClampedArray; w: number; h: number } | null> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { rgba: data, w: bmp.width, h: bmp.height };
}

/**
 * Fetch + classify satellite water over `bbox`, returning water polygons in the
 * same shape fetchMapboxWater does (so it's a drop-in at the injection seam).
 * Network + canvas; returns an empty FeatureCollection on any failure (the caller
 * then falls back to chart-only, never throwing).
 *
 * @param cellPx  routing-cell size in satellite pixels (≈ fine-grid 12 m / res).
 */
export async function fetchSatelliteWater(
    bbox: readonly [number, number, number, number],
    token: string,
    zoom: number = SAT_WATER_ZOOM,
    classify: ClassifyParams = DEFAULT_CLASSIFY,
): Promise<FeatureCollection> {
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    if (!token) return empty;
    const tiles = tilesForBbox(bbox, zoom);
    if (tiles.length === 0 || tiles.length > 64) return empty; // bound on-device cost
    const minX = Math.min(...tiles.map((t) => t.x));
    const minY = Math.min(...tiles.map((t) => t.y));
    const maxX = Math.max(...tiles.map((t) => t.x));
    const maxY = Math.max(...tiles.map((t) => t.y));
    const cols = maxX - minX + 1;
    const rows = maxY - minY + 1;
    const W = cols * TILE_PX;
    const H = rows * TILE_PX;
    const rgba = new Uint8ClampedArray(W * H * 4);
    // 1 only where a tile was actually decoded into place. Unfetched regions stay
    // black (rgba zeros), which classifies as dark water — so we must NEVER call
    // an uncovered pixel water (a single dropped tile would fabricate a km-scale
    // false channel ⇒ the route shortcuts through it ⇒ "route too small").
    const covered = new Uint8Array(W * H);
    let got = 0;
    await Promise.all(
        tiles.map(async (t) => {
            try {
                const buf = await withTimeout(
                    fetch(rasterTileUrl(t, token)).then((r) => (r.ok ? r.arrayBuffer() : null)),
                    null as ArrayBuffer | null,
                    8000,
                );
                if (!buf) return;
                const dec = await decodePng(buf);
                if (!dec || dec.w !== TILE_PX || dec.h !== TILE_PX) return;
                const ox = (t.x - minX) * TILE_PX;
                const oy = (t.y - minY) * TILE_PX;
                for (let py = 0; py < TILE_PX; py++) {
                    const srcRow = py * TILE_PX * 4;
                    const dstRow = ((oy + py) * W + ox) * 4;
                    rgba.set(dec.rgba.subarray(srcRow, srcRow + TILE_PX * 4), dstRow);
                    covered.fill(1, (oy + py) * W + ox, (oy + py) * W + ox + TILE_PX);
                }
                got++;
            } catch {
                /* tile dropped — fall through */
            }
        }),
    );
    // Require the crop to be (near-)fully covered: a partial mosaic leaves the
    // canal disconnected at the holes AND risks the false-water blob above, so
    // fall back to the vector water instead (caller's behaviour today).
    if (got < tiles.length) return empty;
    const mask = classifyWaterMask(rgba, W, H, classify);
    for (let i = 0; i < mask.length; i++) if (!covered[i]) mask[i] = 0;
    const groundResM = (156_543.03 / 2 ** zoom) * Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180);
    const cellPx = Math.max(2, Math.round(12 / (groundResM / 2))); // @2x ⇒ half the standard res
    const pxToLonLat: PxToLonLat = (px, py) => globalPxToLonLat(minX * TILE_PX + px, minY * TILE_PX + py, zoom);
    const features = maskToWaterPolygons(mask, W, H, pxToLonLat, cellPx);
    return { type: 'FeatureCollection', features };
}

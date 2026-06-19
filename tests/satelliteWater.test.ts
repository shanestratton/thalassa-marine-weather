/**
 * satelliteWater pure-core tests — the classifier (colour + texture +
 * connected-components) and mask→polygons, on synthetic pixels. The network +
 * canvas fetch is browser-only and verified on-device.
 */
import { describe, expect, it } from 'vitest';
import { classifyWaterMask, maskToWaterPolygons, DEFAULT_CLASSIFY } from '../services/satelliteWater';

/** Build an RGBA image: textured "suburb" everywhere, with a smooth blue "canal"
 *  stripe down the middle. The classifier should keep the canal and reject the
 *  suburb (same colour-ish in places, but high-texture). */
function synthetic(w: number, h: number, canalX0: number, canalX1: number) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (x >= canalX0 && x < canalX1) {
                // Canal: smooth dark-blue water (b ≥ r, mid-dark, uniform).
                rgba[i] = 30;
                rgba[i + 1] = 55;
                rgba[i + 2] = 75;
                rgba[i + 3] = 255;
            } else {
                // Suburb: bright, high-texture (alternating roofs/roads) — colour
                // mostly fails (bright tan), and texture is high where it doesn't.
                const v = rnd() < 0.5 ? 200 + rnd() * 50 : 20 + rnd() * 40;
                rgba[i] = v;
                rgba[i + 1] = v * 0.9;
                rgba[i + 2] = v * 0.8;
                rgba[i + 3] = 255;
            }
        }
    }
    return rgba;
}

describe('satelliteWater.classifyWaterMask', () => {
    const w = 120;
    const h = 120;
    const canalX0 = 45;
    const canalX1 = 75; // 30 px wide canal, full height (≫ minComponent)
    const mask = classifyWaterMask(synthetic(w, h, canalX0, canalX1), w, h, DEFAULT_CLASSIFY);

    it("classifies the canal's core as water (edges eroded by the texture window)", () => {
        let wet = 0;
        let tot = 0;
        // The core, clear of the texture-window edge band.
        for (let y = 10; y < h - 10; y++)
            for (let x = canalX0 + 6; x < canalX1 - 6; x++) {
                tot++;
                if (mask[y * w + x]) wet++;
            }
        expect(wet / tot).toBeGreaterThan(0.9);
    });

    it('rejects the textured suburb (no large false-positive water body)', () => {
        let suburbWet = 0;
        let tot = 0;
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                if (x >= canalX0 && x < canalX1) continue;
                tot++;
                if (mask[y * w + x]) suburbWet++;
            }
        expect(suburbWet / tot).toBeLessThan(0.05);
    });
});

describe('satelliteWater.maskToWaterPolygons', () => {
    it('emits water rectangles over the canal, in lon/lat', () => {
        const w = 120;
        const h = 120;
        const mask = classifyWaterMask(synthetic(w, h, 50, 70), w, h, DEFAULT_CLASSIFY);
        // Identity-ish px→lonlat: map pixel to a small lon/lat box.
        const pxToLonLat = (px: number, py: number): [number, number] => [153 + px * 1e-5, -27 - py * 1e-5];
        const feats = maskToWaterPolygons(mask, w, h, pxToLonLat, 6);
        expect(feats.length).toBeGreaterThan(0);
        // Every ring is a closed 5-point rectangle.
        for (const f of feats) {
            const ring = f.geometry.coordinates[0];
            expect(ring.length).toBe(5);
            expect(ring[0]).toEqual(ring[4]);
        }
        // The water lies in the canal lon band (px 50..70 → lon ~153.0005..153.0007).
        const lons = feats.flatMap((f) => f.geometry.coordinates[0].map((c) => c[0]));
        const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
        expect(meanLon).toBeGreaterThan(153.0004);
        expect(meanLon).toBeLessThan(153.0008);
    });
});

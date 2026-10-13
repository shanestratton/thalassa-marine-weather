/**
 * satelliteWater pure-core tests — the classifier (colour + texture +
 * connected-components) and mask→polygons, on synthetic pixels. The network +
 * canvas fetch is browser-only and verified on-device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    classifyWaterMask,
    maskToWaterPolygons,
    DEFAULT_CLASSIFY,
    fetchSatelliteWater,
} from '../services/satelliteWater';

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

    it('does NOT classify an all-black (unfetched) region as water', () => {
        // rgba all zeros = black = no-data from a dropped tile. Must be 0 water,
        // else a missing tile fabricates a km-scale false channel ("route too small").
        const black = new Uint8ClampedArray(60 * 60 * 4);
        const m = classifyWaterMask(black, 60, 60, DEFAULT_CLASSIFY);
        let wet = 0;
        for (let i = 0; i < m.length; i++) wet += m[i];
        expect(wet).toBe(0);
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

describe('satelliteWater.fetchSatelliteWater, stopped (128-ROUTE-P)', () => {
    // The router asks for its two endpoint crops at the start of its prep,
    // beside the OSM water. A route stopped meanwhile must not then decode or
    // classify them on the main thread beside a re-tap's fresh route (review
    // 2026-10-11). The tiles already asked for can't be cancelled (the
    // CapacitorHttp fetch ignores AbortSignal); they are dropped.
    const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    /** An invented corner of open sea at 161.0E 20.3S: a few z14 tiles. */
    const BBOX = [161.0, -20.301, 161.002, -20.3] as const;
    let decodes = 0;
    beforeEach(() => {
        decodes = 0;
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => {
                decodes++;
                return { width: 512, height: 512 };
            }),
        );
        vi.stubGlobal(
            'OffscreenCanvas',
            class {
                getContext() {
                    return {
                        drawImage() {},
                        getImageData: (_x: number, _y: number, w: number, h: number) => ({
                            data: new Uint8ClampedArray(w * h * 4),
                        }),
                    };
                }
            },
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('decodes every tile when nothing stops it', async () => {
        let tiles = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            tiles++;
            return new Response(PNG_HEAD);
        });
        await fetchSatelliteWater(BBOX, 'pk.test-not-a-token');
        expect(tiles).toBeGreaterThan(0);
        expect(decodes).toBe(tiles);
    });

    it('a crop stopped while its tiles are in flight decodes and classifies nothing', async () => {
        const stop = new AbortController();
        let land!: () => void;
        const landed = new Promise<void>((r) => (land = r));
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            await landed;
            return new Response(PNG_HEAD);
        });
        const crop = fetchSatelliteWater(BBOX, 'pk.test-not-a-token', undefined, undefined, stop.signal);
        stop.abort();
        land();
        await expect(crop).resolves.toEqual({ type: 'FeatureCollection', features: [] });
        expect(decodes).toBe(0);
    });
});

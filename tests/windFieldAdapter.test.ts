/**
 * WindFieldAdapter forecast-step indexing tests
 *
 * The GFS pipeline delivers NON-uniform forecast steps ([0,3,6,9,12,18,24,36,48,72]),
 * so createWindFieldFromGrid must map timeOffsetHours onto the grid's stepHours axis
 * instead of treating the step index as an hour. Grids without stepHours (Open-Meteo
 * producers are genuinely hourly) must keep the legacy index-as-hour behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import type { WindGrid } from '../services/weather/windField';
import { createWindFieldFromGrid } from '../services/weather/WindFieldAdapter';
import { decodeGrib2WindMultiHour } from '../services/weather/decodeGrib2Wind';

// GribWindParser imports Capacitor at module scope — mock so encode/parse are testable
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: { writeFile: vi.fn(), readFile: vi.fn() },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));

import { encodeWindBin, parseWindBin } from '../services/weather/GribWindParser';

const KTS_PER_MS = 1.94384;

// ── Helper: 2×2 grid with one uniform wind-speed value per time step ─────

function makeGrid(speedsKts: number[], opts: Partial<WindGrid> = {}): WindGrid {
    const width = 2;
    const height = 2;
    const u: Float32Array[] = [];
    const v: Float32Array[] = [];
    const speed: Float32Array[] = [];

    for (const kts of speedsKts) {
        // Wind FROM 180° (south) — blows TO north, so U=0, V=+speed
        const ms = kts / KTS_PER_MS;
        u.push(new Float32Array([0, 0, 0, 0]));
        v.push(new Float32Array([ms, ms, ms, ms]));
        speed.push(new Float32Array([ms, ms, ms, ms]));
    }

    return {
        u,
        v,
        speed,
        width,
        height,
        lats: [-34, -33],
        lons: [150, 151],
        north: -33,
        south: -34,
        west: 150,
        east: 151,
        totalHours: speedsKts.length,
        ...opts,
    };
}

const QUERY = { lat: -33.5, lon: 150.5 };

// ── Non-uniform stepHours indexing ────────────────────────────────────────

describe('createWindFieldFromGrid with stepHours [0,3,6]', () => {
    const grid = makeGrid([10, 20, 30], { stepHours: [0, 3, 6] });
    const wf = createWindFieldFromGrid(grid);

    it('t=0 samples step 0 exactly', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 0)!.speed).toBeCloseTo(10, 1);
    });

    it('t=3 samples step 1 exactly (not step 3)', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 3)!.speed).toBeCloseTo(20, 1);
    });

    it('t=6 samples step 2 exactly', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 6)!.speed).toBeCloseTo(30, 1);
    });

    it('t=1.5 is a 50/50 blend of steps 0 and 1', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 1.5)!.speed).toBeCloseTo(15, 1);
    });

    it('t=4.5 is a 50/50 blend of steps 1 and 2', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 4.5)!.speed).toBeCloseTo(25, 1);
    });

    it('t beyond the last step clamps to the last step', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 100)!.speed).toBeCloseTo(30, 1);
    });

    it('t before the first step clamps to step 0', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, -2)!.speed).toBeCloseTo(10, 1);
    });

    it('preserves direction across the blend', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 1.5)!.direction).toBe(180);
    });

    it('non-uniform GFS spacing: t=30 blends steps at 24h and 36h', () => {
        // 10 steps mirroring the real fetch-wind-grid step array
        const gfs = makeGrid([5, 10, 15, 20, 25, 30, 35, 40, 45, 50], {
            stepHours: [0, 3, 6, 9, 12, 18, 24, 36, 48, 72],
        });
        const f = createWindFieldFromGrid(gfs);
        // t=30 is halfway between steps 24h (35 kts) and 36h (40 kts)
        expect(f.getWind(QUERY.lat, QUERY.lon, 30)!.speed).toBeCloseTo(37.5, 1);
        // The OLD index-as-hour bug would have clamped t=30 to the last index (50 kts)
        expect(f.getWind(QUERY.lat, QUERY.lon, 30)!.speed).not.toBeCloseTo(50, 0);
    });
});

// ── Legacy hourly behaviour (no stepHours) ────────────────────────────────

describe('createWindFieldFromGrid without stepHours (legacy hourly)', () => {
    const grid = makeGrid([10, 20, 30]);
    const wf = createWindFieldFromGrid(grid);

    it('t=1.5 blends indices 1 and 2 (hourly semantics)', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 1.5)!.speed).toBeCloseTo(25, 1);
    });

    it('t beyond the last index clamps', () => {
        expect(wf.getWind(QUERY.lat, QUERY.lon, 50)!.speed).toBeCloseTo(30, 1);
    });

    it('mismatched stepHours length falls back to hourly', () => {
        const bad = makeGrid([10, 20, 30], { stepHours: [0, 3] }); // length ≠ totalHours
        const f = createWindFieldFromGrid(bad);
        expect(f.getWind(QUERY.lat, QUERY.lon, 1.5)!.speed).toBeCloseTo(25, 1);
    });
});

// ── .wind.bin round-trip preserves the temporal axis ──────────────────────

describe('encodeWindBin / parseWindBin stepHours trailer', () => {
    it('round-trips stepHours', () => {
        const grid = makeGrid([10, 20, 30], { stepHours: [0, 3, 6] });
        const parsed = parseWindBin(encodeWindBin(grid));
        expect(parsed.stepHours).toEqual([0, 3, 6]);
        expect(parsed.totalHours).toBe(3);
        // Data integrity through the trailer-extended format
        expect(parsed.v[1][0]).toBeCloseTo(20 / KTS_PER_MS, 4);
    });

    it('grids without stepHours produce legacy buffers with no trailer', () => {
        const grid = makeGrid([10, 20]);
        const buf = encodeWindBin(grid);
        // 28-byte header + 2 hours × 4 cells × 3 fields × 4 bytes, no trailer
        expect(buf.byteLength).toBe(28 + 2 * 4 * 3 * 4);
        expect(parseWindBin(buf).stepHours).toBeUndefined();
    });
});

// ── GRIB2 decoder extracts stepHours from the PDS ──────────────────────────

/** Build one synthetic GRIB2 message (template 4.0, simple packing, 2×2 grid). */
function buildGribMessage(paramNumber: number, forecastHour: number, values: number[]): Uint8Array {
    const sec0 = 16;
    const sec1 = 21;
    const sec3 = 72;
    const sec4 = 34;
    const sec5 = 21;
    const sec7 = 5 + values.length; // 8 bits per packed value
    const sec8 = 4;
    const total = sec0 + sec1 + sec3 + sec4 + sec5 + sec7 + sec8;

    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    const signMag = (deg: number) => (deg < 0 ? 0x80000000 + Math.round(-deg * 1e6) : Math.round(deg * 1e6));
    let p = 0;

    // Section 0 — "GRIB", discipline 0, edition 2, total length (uint64 BE)
    buf.set([0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2], p);
    view.setUint32(p + 8, 0, false);
    view.setUint32(p + 12, total, false);
    p += sec0;

    // Section 1 — identification (refTime 2026-06-11T00:00Z)
    view.setUint32(p, sec1, false);
    view.setUint8(p + 4, 1);
    view.setUint16(p + 12, 2026, false);
    view.setUint8(p + 14, 6);
    view.setUint8(p + 15, 11);
    p += sec1;

    // Section 3 — grid definition template 3.0, 2×2, lat -10..-8, lon 150..152
    view.setUint32(p, sec3, false);
    view.setUint8(p + 4, 3);
    view.setUint32(p + 6, 4, false); // numDataPoints
    view.setUint32(p + 30, 2, false); // Ni (width)
    view.setUint32(p + 34, 2, false); // Nj (height)
    view.setUint32(p + 46, signMag(-10), false); // La1
    view.setUint32(p + 50, signMag(150), false); // Lo1
    view.setUint32(p + 55, signMag(-8), false); // La2
    view.setUint32(p + 59, signMag(152), false); // Lo2
    p += sec3;

    // Section 4 — PDS template 4.0: time unit = hour, forecast time
    view.setUint32(p, sec4, false);
    view.setUint8(p + 4, 4);
    view.setUint16(p + 7, 0, false); // template 4.0
    view.setUint8(p + 9, 2); // category: momentum
    view.setUint8(p + 10, paramNumber); // 2 = UGRD, 3 = VGRD
    view.setUint8(p + 17, 1); // time unit: hour
    view.setUint32(p + 18, forecastHour, false);
    p += sec4;

    // Section 5 — simple packing: R=0, E=0, D=0, 8 bits → Y = packed byte
    view.setUint32(p, sec5, false);
    view.setUint8(p + 4, 5);
    view.setUint32(p + 5, values.length, false);
    view.setUint16(p + 9, 0, false); // template 5.0
    view.setFloat32(p + 11, 0, false);
    view.setInt16(p + 15, 0, false);
    view.setInt16(p + 17, 0, false);
    view.setUint8(p + 19, 8);
    p += sec5;

    // Section 7 — packed data
    view.setUint32(p, sec7, false);
    view.setUint8(p + 4, 7);
    buf.set(values, p + 5);
    p += sec7;

    // Section 8 — "7777"
    buf.set([0x37, 0x37, 0x37, 0x37], p);

    return buf;
}

describe('decodeGrib2WindMultiHour stepHours extraction', () => {
    it('reads non-uniform forecast steps from Section 4', () => {
        const steps = [0, 3, 6];
        const vMs = [5, 10, 15]; // m/s per step, V component (U = 0)
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < steps.length; i++) {
            chunks.push(buildGribMessage(2, steps[i], [0, 0, 0, 0])); // UGRD
            chunks.push(buildGribMessage(3, steps[i], [vMs[i], vMs[i], vMs[i], vMs[i]])); // VGRD
        }
        const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
        const concat = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
            concat.set(c, off);
            off += c.byteLength;
        }

        const grid = decodeGrib2WindMultiHour(concat.buffer);
        expect(grid.totalHours).toBe(3);
        expect(grid.stepHours).toEqual([0, 3, 6]);
        expect(grid.refTime).toBe('2026-06-11T00:00:00Z');

        // End-to-end: the adapter samples t=1.5 as a blend of steps 0h and 3h
        const wf = createWindFieldFromGrid(grid);
        const wind = wf.getWind(-9, 151, 1.5);
        expect(wind).not.toBeNull();
        expect(wind!.speed).toBeCloseTo(7.5 * KTS_PER_MS, 1);
        expect(wind!.direction).toBe(180);
    });
});

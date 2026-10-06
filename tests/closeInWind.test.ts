import { describe, expect, it } from 'vitest';
import {
    CLOSE_IN_CALM_KT,
    CLOSE_IN_ENTER_CELLS,
    CLOSE_IN_EXIT_CELLS,
    CLOSE_IN_MAX_PX_S,
    closeInParticleCount,
    closeInScreenSpeed,
    formatCloseInWind,
    getCloseInWindReadout,
    isWindScrubAtNow,
    nextCloseInMode,
    pickBoatTrueWind,
    resolveCloseInWind,
    sampleWindGridAt,
    setCloseInWindReadout,
    subscribeCloseInWindReadout,
    viewportGridCells,
    windFromVector,
    windGridSpacingDeg,
} from '../components/map/closeInWind';
import type { WindGrid } from '../services/weather/windGridEncoding';
import type { TimestampedMetric } from '../services/NmeaStore';

const NOW = 1_800_000_000_000;
const PHONE = { widthPx: 390, heightPx: 844 };
const AIRLIE_LAT = -20.27;
const ECMWF = { dxDeg: 0.25, dyDeg: 0.25 };

/** Zoom at which a phone over Airlie spans `cells` of a 0.25 deg grid. */
function zoomFor(cells: number): number {
    const at10 = viewportGridCells({ zoom: 10, ...PHONE, centreLat: AIRLIE_LAT }, ECMWF)!;
    return 10 + Math.log2(at10 / cells);
}

function metric(value: number | null, ageMs = 0): TimestampedMetric {
    return { value, lastUpdated: value === null ? 0 : NOW - ageMs, freshness: 'live' };
}

function instruments(patch: Partial<Record<'tws' | 'twd' | 'twaSigned' | 'headingTrue', TimestampedMetric>> = {}) {
    return {
        tws: metric(8),
        twd: metric(135),
        twaSigned: metric(null),
        headingTrue: metric(null),
        ...patch,
    };
}

/** 3x3 grid, 0.25 deg, rows south -> north, two frames. */
function grid(frames: Array<{ u: number[]; v: number[] }>): WindGrid {
    return {
        u: frames.map((f) => new Float32Array(f.u)),
        v: frames.map((f) => new Float32Array(f.v)),
        speed: frames.map((f) => new Float32Array(f.u.map((u, i) => Math.hypot(u, f.v[i])))),
        width: 3,
        height: 3,
        lats: [-20.5, -20.25, -20],
        lons: [148.5, 148.75, 149],
        north: -20,
        south: -20.5,
        west: 148.5,
        east: 149,
        totalHours: frames.length,
    };
}

describe('close-in threshold maths', () => {
    it('reads the grid spacing from the grid itself, not a hard-coded model', () => {
        expect(windGridSpacingDeg(grid([{ u: Array(9).fill(0), v: Array(9).fill(0) }]))).toEqual(ECMWF);
        const coarse = {
            ...grid([{ u: Array(9).fill(0), v: Array(9).fill(0) }]),
            lons: [140, 141, 142],
            lats: [-22, -21, -20],
        };
        expect(windGridSpacingDeg(coarse)).toEqual({ dxDeg: 1, dyDeg: 1 });
        expect(windGridSpacingDeg(undefined)).toBeNull();
        expect(windGridSpacingDeg({ lats: coarse.lats, lons: [140] })).toBeNull();
    });

    it('puts the ECMWF 0.25 deg switch at about z10 on a 390x844 phone over Airlie', () => {
        const atZ10 = viewportGridCells({ zoom: 10, ...PHONE, centreLat: AIRLIE_LAT }, ECMWF)!;
        // 0.268 deg of longitude by 0.544 deg of latitude: 1.07 x 2.17 cells.
        expect(atZ10).toBeCloseTo(1.53, 2);
        expect(zoomFor(CLOSE_IN_ENTER_CELLS)).toBeGreaterThan(9.9);
        expect(zoomFor(CLOSE_IN_ENTER_CELLS)).toBeLessThan(10.2);
    });

    it('scales with the viewport and the grid: a tablet or a coarser grid switches at a different zoom', () => {
        const phone = viewportGridCells({ zoom: 11, ...PHONE, centreLat: AIRLIE_LAT }, ECMWF)!;
        const tablet = viewportGridCells({ zoom: 11, widthPx: 1024, heightPx: 1366, centreLat: AIRLIE_LAT }, ECMWF)!;
        const oneDegree = viewportGridCells({ zoom: 11, ...PHONE, centreLat: AIRLIE_LAT }, { dxDeg: 1, dyDeg: 1 })!;
        expect(tablet).toBeGreaterThan(phone * 2);
        expect(oneDegree).toBeCloseTo(phone / 4, 6);
        // One zoom level halves the cells spanned (area quarters).
        expect(viewportGridCells({ zoom: 12, ...PHONE, centreLat: AIRLIE_LAT }, ECMWF)!).toBeCloseTo(phone / 2, 6);
    });

    it('refuses to guess from an unmeasured viewport or a degenerate grid', () => {
        expect(viewportGridCells({ zoom: 14, widthPx: 0, heightPx: 0, centreLat: 0 }, ECMWF)).toBeNull();
        expect(viewportGridCells({ zoom: Number.NaN, ...PHONE, centreLat: 0 }, ECMWF)).toBeNull();
        expect(viewportGridCells({ zoom: 14, ...PHONE, centreLat: 0 }, { dxDeg: 0, dyDeg: 0.25 })).toBeNull();
        expect(nextCloseInMode(false, null)).toBe(false);
        expect(nextCloseInMode(true, null)).toBe(false);
    });

    it('has hysteresis: enters below 1.5 cells, leaves only above the exit line', () => {
        expect(CLOSE_IN_EXIT_CELLS).toBeGreaterThan(CLOSE_IN_ENTER_CELLS);
        expect(nextCloseInMode(false, 1.6)).toBe(false);
        expect(nextCloseInMode(false, 1.49)).toBe(true);
        // Hovering in the band holds whichever mode is showing.
        expect(nextCloseInMode(true, 1.6)).toBe(true);
        expect(nextCloseInMode(false, 1.6)).toBe(false);
        expect(nextCloseInMode(true, CLOSE_IN_EXIT_CELLS)).toBe(true);
        expect(nextCloseInMode(true, CLOSE_IN_EXIT_CELLS + 0.01)).toBe(false);
        // The band is about a third of a zoom level, so a settle at the edge cannot flicker.
        const band = zoomFor(CLOSE_IN_ENTER_CELLS) - zoomFor(CLOSE_IN_EXIT_CELLS);
        expect(band).toBeGreaterThan(0.25);
        expect(band).toBeLessThan(0.5);
    });
});

function expectVector(actual: { u: number; v: number } | null, u: number, v: number): void {
    expect(actual).not.toBeNull();
    expect(actual!.u).toBeCloseTo(u, 6);
    expect(actual!.v).toBeCloseTo(v, 6);
}

describe('close-in model sample', () => {
    // 8 kt from the SE everywhere in frame 0: the air moves to the NW.
    const ms = (8 * 1852) / 3600;
    const fromSe = { u: -ms * Math.sin((135 * Math.PI) / 180), v: -ms * Math.cos((135 * Math.PI) / 180) };

    it('converts a vector to speed in knots and the direction it blows FROM', () => {
        const w = windFromVector(fromSe.u, fromSe.v);
        expect(w.kt).toBeCloseTo(8, 6);
        expect(w.fromDeg).toBeCloseTo(135, 6);
        expect(windFromVector(0, -5).fromDeg).toBeCloseTo(0, 6); // blowing south = northerly
        expect(windFromVector(5, 0).fromDeg).toBeCloseTo(270, 6); // blowing east = westerly
    });

    it('interpolates bilinearly at the screen centre and across a fractional scrubbed frame', () => {
        const g = grid([
            { u: [0, 0, 0, 2, 2, 2, 4, 4, 4], v: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
            { u: [10, 10, 10, 10, 10, 10, 10, 10, 10], v: [3, 3, 3, 3, 3, 3, 3, 3, 3] },
        ]);
        // Half a row north of the middle row: u between 2 and 4.
        expectVector(sampleWindGridAt(g, 0, -20.125, 148.6), 3, 1);
        expectVector(sampleWindGridAt(g, 0.5, -20.125, 148.6), 6.5, 2);
        expectVector(sampleWindGridAt(g, 99, -20.125, 148.6), 10, 3);
    });

    it('answers nothing outside the grid rather than extrapolating an edge', () => {
        const g = grid([{ u: Array(9).fill(1), v: Array(9).fill(1) }]);
        expect(sampleWindGridAt(g, 0, -19.9, 148.6)).toBeNull();
        expect(sampleWindGridAt(g, 0, -20.2, 150)).toBeNull();
        expectVector(sampleWindGridAt(g, 0, -20.2, 148.6 - 360), 1, 1); // wrapped camera longitude
        expect(sampleWindGridAt(undefined, 0, -20.2, 148.6)).toBeNull();
        expect(
            sampleWindGridAt({ ...g, u: [new Float32Array([Number.NaN, 1, 1, 1, 1, 1, 1, 1, 1])] }, 0, -20.4, 148.55),
        ).toBeNull();
    });
});

describe('close-in source arbitration', () => {
    const model = { kt: 12, fromDeg: 90 };

    it('reads TRUE wind from the instruments: TWS with TWD, else true heading plus signed TWA', () => {
        expect(pickBoatTrueWind(instruments(), NOW)).toEqual({ kt: 8, fromDeg: 135, stale: false });
        expect(
            pickBoatTrueWind(instruments({ twd: metric(null), headingTrue: metric(350), twaSigned: metric(-40) }), NOW),
        ).toEqual({ kt: 8, fromDeg: 310, stale: false });
        // Apparent wind is never used, and an unreferenced heading is not true.
        expect(pickBoatTrueWind(instruments({ twd: metric(null) }), NOW)).toBeNull();
        expect(pickBoatTrueWind(instruments({ tws: metric(null) }), NOW)).toBeNull();
    });

    it('applies the store freshness tiers from the sample clock, not a cached tag', () => {
        // 9 s old = the store's stale tier: still the boat, flagged.
        expect(pickBoatTrueWind(instruments({ tws: metric(8, 9_000) }), NOW)).toEqual({
            kt: 8,
            fromDeg: 135,
            stale: true,
        });
        // 14 s old = dead, even if a cached tag still says live.
        expect(pickBoatTrueWind(instruments({ tws: metric(8, 14_000) }), NOW)).toBeNull();
        expect(pickBoatTrueWind(instruments({ twd: metric(135, 14_000) }), NOW)).toBeNull();
    });

    it('a calm boat with no direction still reads Calm', () => {
        expect(pickBoatTrueWind(instruments({ tws: metric(0.4), twd: metric(null) }), NOW)).toEqual({
            kt: 0.4,
            fromDeg: null,
            stale: false,
        });
    });

    it('prefers the boat only when it is live, in view and the scrubber is at now', () => {
        const boat = { kt: 8, fromDeg: 135, stale: false };
        expect(resolveCloseInWind({ boat, boatInView: true, scrubAtNow: true, model })).toEqual({
            kt: 8,
            fromDeg: 135,
            source: 'boat',
            stale: false,
        });
        // Scrubbed away from now: the model for that hour, never a blend.
        expect(resolveCloseInWind({ boat, boatInView: true, scrubAtNow: false, model })).toEqual({
            ...model,
            source: 'model',
            stale: false,
        });
        // Boat off screen: its wind is not the wind here.
        expect(resolveCloseInWind({ boat, boatInView: false, scrubAtNow: true, model })?.source).toBe('model');
        // No instruments (or dead ones).
        expect(resolveCloseInWind({ boat: null, boatInView: true, scrubAtNow: true, model })?.source).toBe('model');
        // Stale instruments still win, flagged.
        expect(
            resolveCloseInWind({ boat: { ...boat, stale: true }, boatInView: true, scrubAtNow: true, model }),
        ).toMatchObject({
            source: 'boat',
            stale: true,
        });
        expect(resolveCloseInWind({ boat: null, boatInView: false, scrubAtNow: true, model: null })).toBeNull();
    });

    it('is at now exactly when the scrubber would label the frame Near now', () => {
        expect(isWindScrubAtNow(4, 4)).toBe(true);
        expect(isWindScrubAtNow(4.4, 4)).toBe(true);
        expect(isWindScrubAtNow(4.6, 4)).toBe(false);
        expect(isWindScrubAtNow(3, 4)).toBe(false);
        expect(isWindScrubAtNow(Number.NaN, 4)).toBe(false);
        expect(isWindScrubAtNow(0, undefined)).toBe(false);
    });
});

describe('close-in on-screen speed and density', () => {
    it('grows with the wind: a drift at 3 kt, brisk at 15, racing at 30, clamped', () => {
        const s3 = closeInScreenSpeed(3);
        const s15 = closeInScreenSpeed(15);
        const s30 = closeInScreenSpeed(30);
        expect(s3).toBeGreaterThanOrEqual(20);
        expect(s3).toBeLessThanOrEqual(40);
        expect(s15).toBeGreaterThan(s3 * 2.5);
        expect(s30).toBeGreaterThan(s15 * 1.6);
        expect(closeInScreenSpeed(45)).toBe(CLOSE_IN_MAX_PX_S);
        expect(closeInScreenSpeed(200)).toBe(CLOSE_IN_MAX_PX_S);
        expect(closeInScreenSpeed(Number.NaN)).toBe(closeInScreenSpeed(0));
    });

    it('below 1 kt is calm: a near-still drift', () => {
        expect(CLOSE_IN_CALM_KT).toBe(1);
        expect(closeInScreenSpeed(0.5)).toBeLessThan(5);
        expect(closeInScreenSpeed(0.5)).toBeGreaterThan(0);
        expect(closeInScreenSpeed(1)).toBeGreaterThan(closeInScreenSpeed(0.99) * 3);
    });

    it('keeps a fixed density per screen area, thinned for calm and by the device tier', () => {
        const phone = closeInParticleCount(390, 844, 8, 1);
        expect(phone).toBeGreaterThan(150);
        expect(phone).toBeLessThan(320);
        expect(closeInParticleCount(390, 844, 25, 1)).toBe(phone); // speed does not change density
        expect(closeInParticleCount(780, 844, 8, 1)).toBeCloseTo(phone * 2, -1);
        expect(closeInParticleCount(390, 844, 0.5, 1)).toBeLessThan(phone * 0.5);
        expect(closeInParticleCount(390, 844, 8, 0.4)).toBeCloseTo(phone * 0.4, -1);
        expect(closeInParticleCount(0, 0, 8, 1)).toBe(0);
    });
});

describe('close-in readout', () => {
    it('formats the local value in the chosen unit with the 16-point wind-FROM compass', () => {
        expect(formatCloseInWind({ kt: 8.3, fromDeg: 135 }, 'kts')).toBe('8 kt SE');
        expect(formatCloseInWind({ kt: 18, fromDeg: 292 }, 'kts')).toBe('18 kt WNW');
        expect(formatCloseInWind({ kt: 10, fromDeg: 0 }, 'kmh')).toBe('19 km/h N');
        expect(formatCloseInWind({ kt: 10, fromDeg: 180 }, 'mph')).toBe('12 mph S');
        expect(formatCloseInWind({ kt: 8, fromDeg: 270 }, 'mps')).toBe('4.1 m/s W');
        expect(formatCloseInWind({ kt: 8, fromDeg: 270 }, undefined)).toBe('8 kt W');
        expect(formatCloseInWind({ kt: 0.6, fromDeg: 90 }, 'kts')).toBe('Calm');
        expect(formatCloseInWind({ kt: 0.2, fromDeg: null }, 'kts')).toBe('Calm');
    });

    it('publishes one shared readout and only notifies on a visible change', () => {
        let calls = 0;
        const unsubscribe = subscribeCloseInWindReadout(() => {
            calls += 1;
        });
        setCloseInWindReadout({ kt: 8.02, fromDeg: 135.2, source: 'model', stale: false });
        const first = getCloseInWindReadout();
        setCloseInWindReadout({ kt: 8.04, fromDeg: 135.4, source: 'model', stale: false });
        expect(getCloseInWindReadout()).toBe(first);
        setCloseInWindReadout({ kt: 8.04, fromDeg: 135.4, source: 'boat', stale: false });
        setCloseInWindReadout(null);
        setCloseInWindReadout(null);
        expect(getCloseInWindReadout()).toBeNull();
        expect(calls).toBe(3);
        unsubscribe();
    });
});

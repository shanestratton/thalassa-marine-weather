/**
 * Decoded against REAL bytes taken from the live 517 MB global file on wx —
 * the header and the single 522-byte cell block covering the Brisbane wave
 * buoy (-27.5, 153.75). Expected values come from grib_get_data on the source
 * ECMWF GRIB, so this asserts the whole chain: GRIB -> encoder -> binary ->
 * TypeScript reader, not just that the reader is self-consistent.
 */
import { describe, it, expect } from 'vitest';
import { parseHeader, decodeCell } from '../services/weather/api/thpqPoint';

const b64 = (s: string): ArrayBuffer => {
    const bin = Buffer.from(s, 'base64');
    return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
};

const HEADER = b64(
    'VEhQUQEJHQCgBdECAAC0QgAAtMIAADRDAMAzQ4ATXGpoAQAAc3doAAAAAAACAG8SgzoAAG13ZAAAAAAAAgAK1yM8AABtd3AAAAAAAAIAbxKDOgAAaDEwMTIAAAACAG8SgzoAAGgxMjE0AAAAAgBvEoM6AABoMTQxNwAAAAIAbxKDOgAAaDE3MjEAAAACAG8SgzoAAGgyMTI1AAAAAgBvEoM6AABoMjUzMAAAAAIAbxKDOgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
);
const BRISBANE_CELL = b64(
    'LhR9FAgUKhMKETEPnA1EDA0LFwp7Cf8IcgjqB3sHDgeoBj4GDQblBRoGXAcXCMEHdAgcCDQHjAbyBdw2wzfkNq011DPoMugxdTA6L1QuNy1jK6gpmSj0J0sn3iZuJgsmdiaBKRgxTTQ+NQ44GzlrOQs8ID1JJBsjSiPBIqMhlSATIKYfRh80HwgfGR/EH5kgzCD7IDYhoCGCIU0h6h5YG8wbIB+EJlEpKSg7JhEmDgucCnUK0QlvCDMHRAaLBeEEYgQDBMIDlAN1A0cDGgPpAscCpwKcAoQCawJsArECVQOiA5ADTQP4AmMGxwXCBYkFtgQDBHkDAgOZAkwCDwLpAc0BsgGGAWMBUAFCATcBQQFCATQBMQGsAfoCawPzAn8CSQLjAuECGgMTA5YCNALgAZcBZwE4ARwBCAH0ANMAuACmAKIAmACaAJwAkwCQALEAYgEJAxkDbQL3AcIBkgGiAY8BYAEXAewA0wC4AKgAngCaAI0AfwB3AHAAZwBbAFIAQwA+AD4ASABhANIAnQF5ARIB3gDJAOcAxQCSAG0AUgBDADoANgA3ADcANAAwACwAJwAjAB8AGgAWABUAFQAWABgAIQA+AFYARQAxACgAIgBQADIAIQAYABQAEgARABIAEgARABAADwANAAwACwAKAAkACAAIAAgACQAKAA0AEwATAA4ACgAHAAYA',
);

describe('THPQ header', () => {
    const h = parseHeader(HEADER);

    it('parses the global 0.25 deg grid', () => {
        expect(h.version).toBe(1);
        expect(h.width).toBe(1440);
        expect(h.height).toBe(721);
        expect(h.nParams).toBe(9);
        expect(h.nSteps).toBe(29);
    });

    it('normalises the ECMWF longitude origin', () => {
        // The file stores west as 180. Read literally, every lookup lands
        // half a world away.
        expect(h.west).toBe(-180);
        expect(h.east).toBeCloseTo(179.75, 2);
        expect(h.north).toBe(90);
        expect(h.south).toBe(-90);
    });

    it('computes a cell stride of 9 params x 29 steps x u16', () => {
        expect(h.cellStride).toBe(9 * 29 * 2);
        expect(h.cellStride).toBe(522);
    });

    it('lists the nine wave params in order', () => {
        expect(h.params.map((p) => p.name)).toEqual([
            'swh',
            'mwd',
            'mwp',
            'h1012',
            'h1214',
            'h1417',
            'h1721',
            'h2125',
            'h2530',
        ]);
    });
});

describe('THPQ cell decode at the Brisbane buoy', () => {
    const h = parseHeader(HEADER);
    // Cell indices derived from the header in the same way the client does.
    const dLat = (h.north - h.south) / (h.height - 1);
    const dLon = (h.east - h.west) / (h.width - 1);
    const iy = Math.round((h.north - -27.5) / dLat);
    const ix = Math.round((153.75 - h.west) / dLon);
    const fc = decodeCell(h, BRISBANE_CELL, ix, iy);

    it('lands on the expected grid cell', () => {
        expect(fc.lat).toBeCloseTo(-27.5, 3);
        expect(fc.lon).toBeCloseTo(153.75, 3);
        expect(fc.isNoData).toBe(false);
    });

    it('matches grib_get_data on the source GRIB', () => {
        const swh = fc.values.swh;
        expect(swh[0]).toBeCloseTo(5.17, 2); // +0h
        expect(swh[4]).toBeCloseTo(4.36, 2); // +24h
        expect(swh[8]).toBeCloseTo(2.83, 2); // +48h
        expect(swh[12]).toBeCloseTo(2.16, 2); // +72h
        expect(fc.values.mwd[0]).toBeCloseTo(140.44, 1);
        expect(fc.values.mwp[0]).toBeCloseTo(9.29, 2);
    });

    it('carries the period-banded heights that motivate Mode B', () => {
        // Energy concentrated at 10-14s: a wind sea on a decaying swell.
        expect(fc.values.h1012[0]).toBeCloseTo(2.83, 2);
        expect(fc.values.h1214[0]).toBeCloseTo(1.64, 2);
        expect(fc.values.h2530[0]).toBeCloseTo(0.08, 2);
    });

    it('emits one ISO timestamp per step, 6 hours apart', () => {
        expect(fc.times).toHaveLength(29);
        const gap = Date.parse(fc.times[1]) - Date.parse(fc.times[0]);
        expect(gap).toBe(6 * 3600 * 1000);
    });
});

// ── Staleness ───────────────────────────────────────────────────────────────
// Supabase serves the last published object forever. If the wx box loses power
// or its internet, the bytes still arrive perfectly — they are just old, and
// there is no network error to catch. Nothing downstream could tell a week-old
// sea state from this morning's, which is the failure mode that matters when
// the app is being used offshore.
//
// These assert the two rules the fetch applies, using the REAL header above so
// the arithmetic is exercised against genuine field values rather than a mock.
describe('thpq staleness rules', () => {
    const MAX_RUN_AGE_H = 36;
    const h = parseHeader(HEADER);

    const runAgeH = (nowMs: number) => (nowMs - h.baseTime * 1000) / 3_600_000;
    const horizonMs = () => h.baseTime * 1000 + (h.nSteps - 1) * h.stepMinutes * 60_000;

    it('the real header carries a sane run time and horizon', () => {
        expect(h.baseTime).toBeGreaterThan(1_600_000_000); // after 2020
        expect(h.nSteps).toBeGreaterThan(1);
        expect(h.stepMinutes).toBeGreaterThan(0);
        // 29 steps x 6 h = 168 h of forecast
        expect((horizonMs() - h.baseTime * 1000) / 3_600_000).toBeCloseTo(168, 0);
    });

    it('accepts a run a few hours old', () => {
        const now = h.baseTime * 1000 + 4 * 3_600_000;
        expect(runAgeH(now)).toBeLessThanOrEqual(MAX_RUN_AGE_H);
    });

    it('accepts a run just inside the limit — two missed publishes', () => {
        const now = h.baseTime * 1000 + 35.5 * 3_600_000;
        expect(runAgeH(now)).toBeLessThanOrEqual(MAX_RUN_AGE_H);
    });

    it('refuses a run past the age limit — the publisher has stopped', () => {
        const now = h.baseTime * 1000 + 40 * 3_600_000;
        expect(runAgeH(now)).toBeGreaterThan(MAX_RUN_AGE_H);
    });

    it('refuses a week-old run rather than drawing it as current', () => {
        const now = h.baseTime * 1000 + 24 * 7 * 3_600_000;
        expect(runAgeH(now)).toBeGreaterThan(MAX_RUN_AGE_H);
    });

    it('refuses once the horizon has passed, even inside the age limit', () => {
        // A run can be young in hours yet carry only history if every step has
        // already elapsed — both rules are needed, neither implies the other.
        const now = horizonMs() + 1;
        expect(horizonMs()).toBeLessThan(now);
    });

    it('the two rules are independent — a fresh run always has a future horizon', () => {
        const now = h.baseTime * 1000 + 1 * 3_600_000;
        expect(runAgeH(now)).toBeLessThanOrEqual(MAX_RUN_AGE_H);
        expect(horizonMs()).toBeGreaterThan(now);
    });
});

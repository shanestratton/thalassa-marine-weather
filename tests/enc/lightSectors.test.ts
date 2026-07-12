/**
 * lightSectors — the night-approach geometry. Covers the S-57 sector
 * conventions that, if wrong, put a helmsman in the red thinking he's
 * in the white: clockwise sweep, limit-leg presence, colour carry, and
 * the case/attr-code fallbacks.
 */
import { describe, it, expect } from 'vitest';

import {
    SECTOR_ARC_RADIUS_M,
    buildSectorFeatures,
    clockwiseSweep,
    readSectorBearings,
} from '../../services/enc/lightSectors';

describe('clockwiseSweep — S-57 sectors run clockwise SECTR1→SECTR2', () => {
    it('a simple sector', () => {
        expect(clockwiseSweep(0, 90)).toBe(90);
    });
    it('wraps through north', () => {
        expect(clockwiseSweep(350, 20)).toBe(30);
    });
    it('equal bearings = all-round (360, never 0)', () => {
        expect(clockwiseSweep(45, 45)).toBe(360);
    });
    it('nearly-full sweep', () => {
        expect(clockwiseSweep(10, 5)).toBe(355);
    });
});

describe('buildSectorFeatures', () => {
    const at: [number, number] = [153.1, -27.4];

    it('emits an arc + two limit legs for a normal sector', () => {
        const fs = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 90, colorHex: '#ef4444' });
        const arcs = fs.filter((f) => f.properties?._secKind === 'arc');
        const legs = fs.filter((f) => f.properties?._secKind === 'leg');
        expect(arcs).toHaveLength(1);
        expect(legs).toHaveLength(2);
        for (const f of fs) expect(f.properties?._secColor).toBe('#ef4444');
    });

    it('the arc starts on SECTR1 and ends on SECTR2, swept clockwise', () => {
        const [arc] = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 90, colorHex: '#fff' });
        const coords = arc.geometry.coordinates;
        // First point due N of the light (bearing 0): same lon, greater lat.
        expect(coords[0][0]).toBeCloseTo(at[0], 4);
        expect(coords[0][1]).toBeGreaterThan(at[1]);
        // Last point due E (bearing 90): greater lon, ~same lat.
        const last = coords[coords.length - 1];
        expect(last[0]).toBeGreaterThan(at[0]);
        expect(last[1]).toBeCloseTo(at[1], 3);
    });

    it('arc radius is the fixed display radius, not the light range', () => {
        const [arc] = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 10, colorHex: '#fff' });
        const [lon, lat] = arc.geometry.coordinates[0];
        const dLatM = (lat - at[1]) * 111_320;
        expect(dLatM).toBeCloseTo(SECTOR_ARC_RADIUS_M, 0);
        expect(lon).toBeCloseTo(at[0], 4);
    });

    it('an all-round sector draws the arc but NO limit legs', () => {
        const fs = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 0, colorHex: '#fff' });
        expect(fs.filter((f) => f.properties?._secKind === 'leg')).toHaveLength(0);
        expect(fs.filter((f) => f.properties?._secKind === 'arc')).toHaveLength(1);
    });

    it('non-finite bearings yield nothing (never a bogus arc)', () => {
        expect(buildSectorFeatures({ position: at, sectr1: NaN, sectr2: 90, colorHex: '#fff' })).toEqual([]);
        expect(buildSectorFeatures({ position: [NaN, -27], sectr1: 0, sectr2: 90, colorHex: '#fff' })).toEqual([]);
    });

    it('copies provenance/base props onto every emitted feature', () => {
        const fs = buildSectorFeatures({
            position: at,
            sectr1: 0,
            sectr2: 90,
            colorHex: '#fff',
            baseProps: { _cellId: 'AU5X', OBJNAM: 'Cape Pt', _minZoom: 11 },
        });
        for (const f of fs) {
            expect(f.properties?._cellId).toBe('AU5X');
            expect(f.properties?.OBJNAM).toBe('Cape Pt');
        }
    });
});

describe('readSectorBearings — case + attr-code defensive', () => {
    it('reads uppercase SECTR1/SECTR2', () => {
        expect(readSectorBearings({ SECTR1: 12, SECTR2: 34 })).toEqual({ sectr1: 12, sectr2: 34 });
    });
    it('reads lowercase', () => {
        expect(readSectorBearings({ sectr1: 12, sectr2: 34 })).toEqual({ sectr1: 12, sectr2: 34 });
    });
    it('falls back to the S-57 attr codes (_attr136/137)', () => {
        expect(readSectorBearings({ _attr136: 12, _attr137: 34 })).toEqual({ sectr1: 12, sectr2: 34 });
    });
    it('numeric strings parse', () => {
        expect(readSectorBearings({ SECTR1: '12.5', SECTR2: '34' })).toEqual({ sectr1: 12.5, sectr2: 34 });
    });
    it('a non-sectored light returns null', () => {
        expect(readSectorBearings({ VALNMR: 8, COLOUR: '1' })).toBeNull();
        expect(readSectorBearings({ SECTR1: 12 })).toBeNull(); // needs both
    });
});

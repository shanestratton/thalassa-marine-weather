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

    it('draws the wedge on the RECIPROCAL (from-light) side, not from-seaward', () => {
        // SECTR1=0/SECTR2=90 are from-seaward bearings, so the coloured wedge
        // radiates from the light on the reciprocals (180 / 270), NOT 0 / 90.
        const [arc] = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 90, colorHex: '#fff' });
        const coords = arc.geometry.coordinates;
        // First point on SECTR1 reciprocal (180 = due S): same lon, LOWER lat.
        expect(coords[0][0]).toBeCloseTo(at[0], 4);
        expect(coords[0][1]).toBeLessThan(at[1]);
        // Last point on SECTR2 reciprocal (270 = due W): LOWER lon, ~same lat.
        const last = coords[coords.length - 1];
        expect(last[0]).toBeLessThan(at[0]);
        expect(last[1]).toBeCloseTo(at[1], 3);
    });

    it('a light seen bearing 090° from seaward paints its arc to the WEST', () => {
        // Regression guard for the mirror bug: an observer measuring the light
        // at ~090° is due WEST of it, so the sector they see must be drawn to
        // the WEST. Centre the sweep on 090 from-seaward → arc midpoint ~270.
        const [arc] = buildSectorFeatures({ position: at, sectr1: 80, sectr2: 100, colorHex: '#fff' });
        const coords = arc.geometry.coordinates;
        const mid = coords[Math.floor(coords.length / 2)];
        expect(mid[0]).toBeLessThan(at[0]); // west of the light, never east
    });

    it('arc radius is the fixed display radius, not the light range', () => {
        const [arc] = buildSectorFeatures({ position: at, sectr1: 0, sectr2: 10, colorHex: '#fff' });
        const [lon, lat] = arc.geometry.coordinates[0];
        const dLatM = (lat - at[1]) * 111_320;
        // SECTR1=0 reciprocal is 180 (due S) → radius on the negative-lat side.
        expect(dLatM).toBeCloseTo(-SECTOR_ARC_RADIUS_M, 0);
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

/**
 * Isochrone Geodesy — Unit tests
 *
 * Tests pure spherical math: haversine distance, initial bearing,
 * position projection, TWA calculation, and bearing between.
 */

import { describe, it, expect } from 'vitest';
import {
    R_NM,
    toRad,
    toDeg,
    haversineNm,
    initialBearing,
    projectPosition,
    calcTWA,
    bearingBetween,
} from '../services/isochrone/geodesy';

// ── Constants ───────────────────────────────────────────────────

describe('geodesy constants', () => {
    it('R_NM is Earth radius in nautical miles', () => {
        expect(R_NM).toBeCloseTo(3440.065, 1);
    });
});

describe('toRad / toDeg', () => {
    it('converts degrees to radians', () => {
        expect(toRad(180)).toBeCloseTo(Math.PI, 10);
        expect(toRad(90)).toBeCloseTo(Math.PI / 2, 10);
        expect(toRad(0)).toBe(0);
    });

    it('converts radians to degrees', () => {
        expect(toDeg(Math.PI)).toBeCloseTo(180, 10);
        expect(toDeg(Math.PI / 2)).toBeCloseTo(90, 10);
        expect(toDeg(0)).toBe(0);
    });

    it('round-trip conversion is identity', () => {
        expect(toDeg(toRad(45))).toBeCloseTo(45, 10);
        expect(toDeg(toRad(-123.456))).toBeCloseTo(-123.456, 10);
    });
});

// ── Haversine ───────────────────────────────────────────────────

describe('haversineNm', () => {
    it('returns 0 for same point', () => {
        expect(haversineNm(-33.868, 151.209, -33.868, 151.209)).toBe(0);
    });

    it('calculates Sydney → Melbourne (~385 NM great circle)', () => {
        const dist = haversineNm(-33.868, 151.209, -37.814, 144.963);
        expect(dist).toBeGreaterThan(370);
        expect(dist).toBeLessThan(400);
    });

    it('equator one degree of latitude ≈ 60 NM', () => {
        const dist = haversineNm(0, 0, 1, 0);
        expect(dist).toBeCloseTo(60, 0);
    });

    it('is symmetric', () => {
        const d1 = haversineNm(-33, 151, -37, 145);
        const d2 = haversineNm(-37, 145, -33, 151);
        expect(d1).toBeCloseTo(d2, 6);
    });

    it('antipodal points ≈ half circumference (~10,800 NM)', () => {
        const dist = haversineNm(0, 0, 0, 180);
        expect(dist).toBeCloseTo(Math.PI * R_NM, 0);
    });
});

// ── Initial Bearing ─────────────────────────────────────────────

describe('initialBearing', () => {
    it('due north is ~0°', () => {
        const brng = initialBearing(0, 0, 1, 0);
        expect(brng).toBeCloseTo(0, 0);
    });

    it('due east is ~90°', () => {
        const brng = initialBearing(0, 0, 0, 1);
        expect(brng).toBeCloseTo(90, 0);
    });

    it('due south is ~180°', () => {
        const brng = initialBearing(0, 0, -1, 0);
        expect(brng).toBeCloseTo(180, 0);
    });

    it('due west is ~270°', () => {
        const brng = initialBearing(0, 0, 0, -1);
        expect(brng).toBeCloseTo(270, 0);
    });

    it('result is always in [0, 360)', () => {
        const brng = initialBearing(0, 0, -1, -1);
        expect(brng).toBeGreaterThanOrEqual(0);
        expect(brng).toBeLessThan(360);
    });
});

// ── Project Position ────────────────────────────────────────────

describe('projectPosition', () => {
    it('projecting 0 NM returns same position', () => {
        const pos = projectPosition(-33.868, 151.209, 90, 0);
        expect(pos.lat).toBeCloseTo(-33.868, 4);
        expect(pos.lon).toBeCloseTo(151.209, 4);
    });

    it('projecting north increases latitude', () => {
        const pos = projectPosition(0, 0, 0, 60);
        expect(pos.lat).toBeCloseTo(1, 0); // ~1° north
        expect(pos.lon).toBeCloseTo(0, 1);
    });

    it('projecting east increases longitude', () => {
        const pos = projectPosition(0, 0, 90, 60);
        expect(pos.lat).toBeCloseTo(0, 0);
        expect(pos.lon).toBeCloseTo(1, 0); // ~1° east
    });

    it('round trip: project then measure distance ≈ original distance', () => {
        const dist = 100;
        const pos = projectPosition(-33, 151, 45, dist);
        const measured = haversineNm(-33, 151, pos.lat, pos.lon);
        expect(measured).toBeCloseTo(dist, 0);
    });

    it('normalizes longitude past 180°', () => {
        const pos = projectPosition(0, 179, 90, 120);
        expect(pos.lon).toBeLessThanOrEqual(180);
        expect(pos.lon).toBeGreaterThanOrEqual(-180);
    });

    it('normalizes longitude past -180°', () => {
        const pos = projectPosition(0, -179, 270, 120);
        expect(pos.lon).toBeLessThanOrEqual(180);
        expect(pos.lon).toBeGreaterThanOrEqual(-180);
    });
});

// ── TWA (True Wind Angle) ───────────────────────────────────────

describe('calcTWA', () => {
    it('head-on wind = 180° TWA', () => {
        // Heading north (0°), wind from south (180°)
        expect(calcTWA(0, 180)).toBe(180);
    });

    it('tailwind = 0° TWA', () => {
        // Heading north (0°), wind from north (0°)
        expect(calcTWA(0, 0)).toBe(0);
    });

    it('beam reach = 90° TWA', () => {
        // Heading north (0°), wind from east (90°)
        expect(calcTWA(0, 90)).toBe(90);
    });

    it('result is always 0-180 (symmetric)', () => {
        expect(calcTWA(0, 270)).toBe(90);
        expect(calcTWA(180, 90)).toBe(90);
    });

    it('handles wrap-around correctly', () => {
        // Heading 350°, wind from 10°
        expect(calcTWA(350, 10)).toBe(20);
    });
});

// ── Bearing Between ─────────────────────────────────────────────

describe('bearingBetween', () => {
    it('matches initialBearing for cardinal directions', () => {
        expect(bearingBetween(0, 0, 1, 0)).toBeCloseTo(0, 0);
        expect(bearingBetween(0, 0, 0, 1)).toBeCloseTo(90, 0);
        expect(bearingBetween(0, 0, -1, 0)).toBeCloseTo(180, 0);
        expect(bearingBetween(0, 0, 0, -1)).toBeCloseTo(270, 0);
    });

    it('result is always in [0, 360)', () => {
        for (let i = 0; i < 10; i++) {
            const brng = bearingBetween(
                Math.random() * 180 - 90,
                Math.random() * 360 - 180,
                Math.random() * 180 - 90,
                Math.random() * 360 - 180,
            );
            expect(brng).toBeGreaterThanOrEqual(0);
            expect(brng).toBeLessThan(360);
        }
    });
});

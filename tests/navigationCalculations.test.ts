/**
 * Unit Tests for Navigation Calculations
 * Tests Haversine distance, bearing calculations, DMS formatting, and validations
 */

import { describe, it, expect } from 'vitest';
import {
    calculateDistance,
    calculateBearing,
    formatDMS,
    parseDMS,
    toRadians,
    toDegrees,
    calculateSpeed,
    isValidLatitude,
    isValidLongitude
} from '../utils/navigationCalculations';

describe('Navigation Calculations', () => {
    describe('calculateDistance', () => {
        it('should calculate distance between Newport and Noumea', () => {
            // Newport, QLD to Noumea, New Caledonia
            const distance = calculateDistance(-27.2086, 153.0874, -22.2758, 166.4581);
            // Expected: ~786 nautical miles (great circle distance)
            expect(distance).toBeGreaterThan(780);
            expect(distance).toBeLessThan(790);
        });

        it('should return 0 for same position', () => {
            const distance = calculateDistance(0, 0, 0, 0);
            expect(distance).toBe(0);
        });

        it('should calculate distance between Sydney and Auckland', () => {
            // Sydney to Auckland
            const distance = calculateDistance(-33.8688, 151.2093, -36.8485, 174.7633);
            // Expected: ~1165 nautical miles
            expect(distance).toBeGreaterThan(1150);
            expect(distance).toBeLessThan(1180);
        });

        it('should handle crossing the equator', () => {
            const distance = calculateDistance(-10, 150, 10, 150);
            // 20 degrees of latitude = ~1200 NM
            expect(distance).toBeGreaterThan(1190);
            expect(distance).toBeLessThan(1210);
        });

        it('should handle crossing the international date line', () => {
            const distance = calculateDistance(0, 179, 0, -179);
            // Should be about 2 degrees = ~120 NM, not ~358 degrees
            expect(distance).toBeLessThan(150);
        });
    });

    describe('calculateBearing', () => {
        it('should calculate bearing from Newport to Noumea', () => {
            const bearing = calculateBearing(-27.2086, 153.0874, -22.2758, 166.4581);
            // Expected: Northeast (roughly 45-90 degrees)
            expect(bearing).toBeGreaterThan(40);
            expect(bearing).toBeLessThan(90);
        });

        it('should return 0 degrees for due north', () => {
            const bearing = calculateBearing(0, 0, 1, 0);
            expect(bearing).toBeCloseTo(0, 1);
        });

        it('should return 90 degrees for due east', () => {
            const bearing = calculateBearing(0, 0, 0, 1);
            expect(bearing).toBeCloseTo(90, 1);
        });

        it('should return 180 degrees for due south', () => {
            const bearing = calculateBearing(0, 0, -1, 0);
            expect(bearing).toBeCloseTo(180, 1);
        });

        it('should return 270 degrees for due west', () => {
            const bearing = calculateBearing(0, 0, 0, -1);
            expect(bearing).toBeCloseTo(270, 1);
        });

        it('should always return value between 0-360', () => {
            const bearing = calculateBearing(-45, -120, 45, 120);
            expect(bearing).toBeGreaterThanOrEqual(0);
            expect(bearing).toBeLessThan(360);
        });
    });

    describe('formatDMS', () => {
        it('should format Newport coordinates correctly', () => {
            const dms = formatDMS(-27.2086, 153.0874);
            expect(dms).toContain('27°');
            expect(dms).toContain('S');
            expect(dms).toContain('153°');
            expect(dms).toContain('E');
        });

        it('should format northern hemisphere correctly', () => {
            const dms = formatDMS(40.7128, -74.0060);
            expect(dms).toContain('N');
            expect(dms).toContain('W');
        });

        it('should format minutes correctly', () => {
            const dms = formatDMS(27.5, 153.5);
            expect(dms).toContain('30.0'); // 0.5 * 60 = 30 minutes
        });

        it('should handle zero coordinates', () => {
            const dms = formatDMS(0, 0);
            expect(dms).toContain('0°0.0');
        });

        it('should handle equator and prime meridian', () => {
            const dms = formatDMS(0, 0);
            expect(dms).toContain('N');
            expect(dms).toContain('E');
        });
    });

    describe('parseDMS', () => {
        it('should parse southern latitude correctly', () => {
            const lat = parseDMS("27°12.5'S");
            expect(lat).toBeCloseTo(-27.208333, 5);
        });

        it('should parse eastern longitude correctly', () => {
            const lon = parseDMS("153°5.2'E");
            expect(lon).toBeCloseTo(153.086667, 5);
        });

        it('should parse northern latitude correctly', () => {
            const lat = parseDMS("40°42.8'N");
            expect(lat).toBeCloseTo(40.713333, 5);
        });

        it('should parse western longitude correctly', () => {
            const lon = parseDMS("74°0.4'W");
            expect(lon).toBeCloseTo(-74.006667, 5);
        });

        it('should throw error for invalid format', () => {
            expect(() => parseDMS('invalid')).toThrow('Invalid DMS format');
        });
    });

    describe('toRadians and toDegrees', () => {
        it('should convert 180 degrees to PI radians', () => {
            expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
        });

        it('should convert 90 degrees to PI/2 radians', () => {
            expect(toRadians(90)).toBeCloseTo(Math.PI / 2, 10);
        });

        it('should convert PI radians to 180 degrees', () => {
            expect(toDegrees(Math.PI)).toBeCloseTo(180, 10);
        });

        it('should convert PI/2 radians to 90 degrees', () => {
            expect(toDegrees(Math.PI / 2)).toBeCloseTo(90, 10);
        });

        it('should be invertible', () => {
            const degrees = 45;
            const radians = toRadians(degrees);
            const backToDegrees = toDegrees(radians);
            expect(backToDegrees).toBeCloseTo(degrees, 10);
        });
    });

    describe('calculateSpeed', () => {
        it('should calculate 6 knots for 6 NM in 1 hour', () => {
            const speed = calculateSpeed(6, 1);
            expect(speed).toBe(6);
        });

        it('should calculate 12 knots for 6 NM in 0.5 hours', () => {
            const speed = calculateSpeed(6, 0.5);
            expect(speed).toBe(12);
        });

        it('should return 0 for zero time', () => {
            const speed = calculateSpeed(10, 0);
            expect(speed).toBe(0);
        });

        it('should handle decimal values', () => {
            const speed = calculateSpeed(15.3, 2.5);
            expect(speed).toBeCloseTo(6.12, 2);
        });
    });

    describe('Validation Functions', () => {
        describe('isValidLatitude', () => {
            it('should accept valid latitudes', () => {
                expect(isValidLatitude(0)).toBe(true);
                expect(isValidLatitude(45)).toBe(true);
                expect(isValidLatitude(-45)).toBe(true);
                expect(isValidLatitude(90)).toBe(true);
                expect(isValidLatitude(-90)).toBe(true);
            });

            it('should reject invalid latitudes', () => {
                expect(isValidLatitude(91)).toBe(false);
                expect(isValidLatitude(-91)).toBe(false);
                expect(isValidLatitude(100)).toBe(false);
            });
        });

        describe('isValidLongitude', () => {
            it('should accept valid longitudes', () => {
                expect(isValidLongitude(0)).toBe(true);
                expect(isValidLongitude(90)).toBe(true);
                expect(isValidLongitude(-90)).toBe(true);
                expect(isValidLongitude(180)).toBe(true);
                expect(isValidLongitude(-180)).toBe(true);
            });

            it('should reject invalid longitudes', () => {
                expect(isValidLongitude(181)).toBe(false);
                expect(isValidLongitude(-181)).toBe(false);
                expect(isValidLongitude(200)).toBe(false);
            });
        });
    });

    describe('Real-world accuracy tests', () => {
        it('should match known distance: San Francisco to Tokyo', () => {
            // San Francisco (37.7749°N, 122.4194°W) to Tokyo (35.6762°N, 139.6503°E)
            const distance = calculateDistance(37.7749, -122.4194, 35.6762, 139.6503);
            // Known distance: ~4468 nautical miles (great circle)
            expect(distance).toBeGreaterThan(4450);
            expect(distance).toBeLessThan(4500);
        });

        it('should match known bearing: London to Paris', () => {
            // London to Paris should be roughly Southeast (120-150 degrees)
            const bearing = calculateBearing(51.5074, -0.1278, 48.8566, 2.3522);
            expect(bearing).toBeGreaterThan(120);
            expect(bearing).toBeLessThan(160);
        });
    });
});

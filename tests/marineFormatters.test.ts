/**
 * Unit Tests for Marine Formatters
 * Tests Beaufort scale, Douglas sea state, watch periods, and formatting
 */

import { describe, it, expect } from 'vitest';
import {
    formatTime24,
    formatTime24Colon,
    windToBeaufort,
    getBeaufortDescription,
    waveToSeaState,
    getSeaStateDescription,
    getWatchPeriod,
    getWatchPeriodName,
    getWatchPeriodRange,
    formatCourseTrue,
    getVisibilityCategory,
    getVisibilityDescription,
} from '../utils/marineFormatters';

describe('Marine Formatters', () => {
    describe('formatTime24', () => {
        it('should format AM time correctly', () => {
            expect(formatTime24(new Date('2026-01-01T02:05:00'))).toBe('0205');
        });
        it('should format PM time correctly', () => {
            expect(formatTime24(new Date('2026-01-01T14:35:00'))).toBe('1435');
        });
        it('should format midnight correctly', () => {
            expect(formatTime24(new Date('2026-01-01T00:00:00'))).toBe('0000');
        });
        it('should accept string input', () => {
            const result = formatTime24('2026-01-01T09:15:00');
            expect(result).toMatch(/^\d{4}$/);
        });
    });

    describe('formatTime24Colon', () => {
        it('should format with colon', () => {
            expect(formatTime24Colon(new Date('2026-01-01T14:35:00'))).toBe('14:35');
        });
        it('should include seconds when requested', () => {
            expect(formatTime24Colon(new Date('2026-01-01T14:35:45'), true)).toBe('14:35:45');
        });
    });

    describe('windToBeaufort', () => {
        it('should return 0 for calm (< 1 kts)', () => {
            expect(windToBeaufort(0)).toBe(0);
            expect(windToBeaufort(0.5)).toBe(0);
        });
        it('should return 5 for fresh breeze (17-21 kts)', () => {
            expect(windToBeaufort(17)).toBe(5);
            expect(windToBeaufort(21)).toBe(5);
        });
        it('should return 8 for gale (34-40 kts)', () => {
            expect(windToBeaufort(34)).toBe(8);
            expect(windToBeaufort(40)).toBe(8);
        });
        it('should return 12 for hurricane (>= 64 kts)', () => {
            expect(windToBeaufort(64)).toBe(12);
            expect(windToBeaufort(100)).toBe(12);
        });
        it('should handle boundary values', () => {
            expect(windToBeaufort(1)).toBe(1);
            expect(windToBeaufort(3)).toBe(1);
            expect(windToBeaufort(4)).toBe(2);
        });
    });

    describe('getBeaufortDescription', () => {
        it('should return "Calm" for 0', () => {
            expect(getBeaufortDescription(0)).toBe('Calm');
        });
        it('should return "Hurricane" for 12', () => {
            expect(getBeaufortDescription(12)).toBe('Hurricane');
        });
        it('should return "Gale" for 8', () => {
            expect(getBeaufortDescription(8)).toBe('Gale');
        });
    });

    describe('waveToSeaState: WMO code 3700 (130-04; it ran one band calm before build 130)', () => {
        // Code: 0 calm (glassy) 0 m; 1 calm (rippled) 0–0.1; 2 smooth 0.1–0.5;
        // 3 slight 0.5–1.25; 4 moderate 1.25–2.5; 5 rough 2.5–4; 6 very rough 4–6;
        // 7 high 6–9; 8 very high 9–14; 9 phenomenal over 14. Lower bound inclusive.
        it.each([
            [0, 0],
            [0.05, 1],
            [0.1, 2],
            [0.49, 2],
            [0.5, 3],
            [1.24, 3],
            [1.25, 4],
            [1.5, 4],
            [2.4, 4],
            [2.5, 5],
            [3.99, 5],
            [4, 6],
            [5.99, 6],
            [6, 7],
            [9, 8],
            [13.9, 8],
            [14, 9],
            [25, 9],
        ])('%s m is code %s', (metres, code) => {
            expect(waveToSeaState(metres)).toBe(code);
        });

        it('1.5 m is Moderate, as WMO says (it read Slight)', () => {
            expect(getSeaStateDescription(waveToSeaState(1.5))).toBe('Moderate');
            expect(getSeaStateDescription(waveToSeaState(2.5))).toBe('Rough');
            expect(getSeaStateDescription(waveToSeaState(0.3))).toBe('Smooth');
        });
    });

    describe('getSeaStateDescription', () => {
        it('should return "Glassy" for 0', () => {
            expect(getSeaStateDescription(0)).toBe('Glassy');
        });
        it('should return "Phenomenal" for 9', () => {
            expect(getSeaStateDescription(9)).toBe('Phenomenal');
        });
    });

    describe('getWatchPeriod', () => {
        it('should return middle watch for 0-3', () => {
            expect(getWatchPeriod(0)).toBe('middle');
            expect(getWatchPeriod(3)).toBe('middle');
        });
        it('should return morning watch for 4-7', () => {
            expect(getWatchPeriod(4)).toBe('morning');
            expect(getWatchPeriod(7)).toBe('morning');
        });
        it('should return forenoon watch for 8-11', () => {
            expect(getWatchPeriod(8)).toBe('forenoon');
            expect(getWatchPeriod(11)).toBe('forenoon');
        });
        it('should return afternoon watch for 12-15', () => {
            expect(getWatchPeriod(12)).toBe('afternoon');
            expect(getWatchPeriod(15)).toBe('afternoon');
        });
        it('should return first dog watch for 16-17', () => {
            expect(getWatchPeriod(16)).toBe('firstDog');
            expect(getWatchPeriod(17)).toBe('firstDog');
        });
        it('should return second dog watch for 18-19', () => {
            expect(getWatchPeriod(18)).toBe('secondDog');
            expect(getWatchPeriod(19)).toBe('secondDog');
        });
        it('should return first watch for 20-23', () => {
            expect(getWatchPeriod(20)).toBe('first');
            expect(getWatchPeriod(23)).toBe('first');
        });
    });

    describe('getWatchPeriodName', () => {
        it('should return full names', () => {
            expect(getWatchPeriodName('middle')).toBe('Middle Watch');
            expect(getWatchPeriodName('firstDog')).toBe('First Dog Watch');
        });
    });

    describe('getWatchPeriodRange', () => {
        it('should return time ranges', () => {
            expect(getWatchPeriodRange('middle')).toBe('0000-0400');
            expect(getWatchPeriodRange('afternoon')).toBe('1200-1600');
        });
    });

    describe('formatCourseTrue', () => {
        it('should format with leading zeros and °T suffix', () => {
            expect(formatCourseTrue(45)).toBe('045°T');
        });
        it('should format 3-digit courses', () => {
            expect(formatCourseTrue(270)).toBe('270°T');
        });
        it('should handle 0', () => {
            expect(formatCourseTrue(0)).toBe('000°T');
        });
        it('should handle 360', () => {
            expect(formatCourseTrue(360)).toBe('360°T');
        });
    });

    describe('getVisibilityCategory', () => {
        it('should return "poor" for < 2nm', () => {
            expect(getVisibilityCategory(1)).toBe('poor');
        });
        it('should return "moderate" for 2-5nm', () => {
            expect(getVisibilityCategory(3)).toBe('moderate');
        });
        it('should return "good" for 5-10nm', () => {
            expect(getVisibilityCategory(7)).toBe('good');
        });
        it('should return "excellent" for >= 10nm', () => {
            expect(getVisibilityCategory(15)).toBe('excellent');
        });
    });

    describe('getVisibilityDescription', () => {
        it('should return description with range', () => {
            expect(getVisibilityDescription(1)).toBe('Poor (<2nm)');
            expect(getVisibilityDescription(15)).toBe('Excellent (>10nm)');
        });
    });
});

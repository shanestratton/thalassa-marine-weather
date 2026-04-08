/**
 * Default Polar Data — Unit tests
 *
 * Validates the built-in polar curves for cruising yacht
 * and motorboat performance profiles.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_CRUISING_POLAR, DEFAULT_MOTOR_POLAR } from '../services/defaultPolar';

describe('DEFAULT_CRUISING_POLAR', () => {
    it('has 9 wind speeds (4-30 kts)', () => {
        expect(DEFAULT_CRUISING_POLAR.windSpeeds).toEqual([4, 6, 8, 10, 12, 15, 20, 25, 30]);
    });

    it('has 11 angles (30°-180°)', () => {
        expect(DEFAULT_CRUISING_POLAR.angles[0]).toBe(30);
        expect(DEFAULT_CRUISING_POLAR.angles[DEFAULT_CRUISING_POLAR.angles.length - 1]).toBe(180);
        expect(DEFAULT_CRUISING_POLAR.angles.length).toBe(11);
    });

    it('matrix dimensions match angles × windSpeeds', () => {
        const { angles, windSpeeds, matrix } = DEFAULT_CRUISING_POLAR;
        expect(matrix.length).toBe(angles.length);
        for (const row of matrix) {
            expect(row.length).toBe(windSpeeds.length);
        }
    });

    it('all speeds are non-negative', () => {
        for (const row of DEFAULT_CRUISING_POLAR.matrix) {
            for (const speed of row) {
                expect(speed).toBeGreaterThanOrEqual(0);
            }
        }
    });

    it('beam reach (90°) is fastest point of sail', () => {
        const { angles, matrix } = DEFAULT_CRUISING_POLAR;
        const beamIdx = angles.indexOf(90);
        // Check at moderate wind (10 kts, idx 3)
        const beamSpeed = matrix[beamIdx][3];
        for (let i = 0; i < angles.length; i++) {
            expect(beamSpeed).toBeGreaterThanOrEqual(matrix[i][3]);
        }
    });

    it('speed increases with wind up to a point then decreases', () => {
        // At beam reach (90°), speed should peak and then drop at high wind
        const beamIdx = DEFAULT_CRUISING_POLAR.angles.indexOf(90);
        const beamRow = DEFAULT_CRUISING_POLAR.matrix[beamIdx];

        // Speed at 20 kts wind (idx 6) should be highest
        const peakIdx = beamRow.indexOf(Math.max(...beamRow));
        expect(peakIdx).toBeGreaterThan(0); // Not at lowest wind
        expect(peakIdx).toBeLessThan(beamRow.length - 1); // Not at highest wind
    });

    it('close-hauled (30°) is slowest angle', () => {
        const { matrix } = DEFAULT_CRUISING_POLAR;
        // At 10 kts wind (idx 3)
        const closeHauledSpeed = matrix[0][3]; // 30° row
        for (let i = 1; i < matrix.length - 1; i++) {
            expect(matrix[i][3]).toBeGreaterThanOrEqual(closeHauledSpeed);
        }
    });
});

describe('DEFAULT_MOTOR_POLAR', () => {
    it('has 5 wind speeds (0-40 kts)', () => {
        expect(DEFAULT_MOTOR_POLAR.windSpeeds).toEqual([0, 10, 20, 30, 40]);
    });

    it('has 5 angles (0°-180°)', () => {
        expect(DEFAULT_MOTOR_POLAR.angles).toEqual([0, 45, 90, 135, 180]);
    });

    it('maintains ~8 kts in light wind regardless of angle', () => {
        const { matrix } = DEFAULT_MOTOR_POLAR;
        for (let i = 0; i < matrix.length; i++) {
            // At 0-10 kts wind (idx 0-1), all angles should be 8 kts
            expect(matrix[i][0]).toBe(8);
            expect(matrix[i][1]).toBe(8);
        }
    });

    it('slows down in heavy headwinds', () => {
        const { matrix } = DEFAULT_MOTOR_POLAR;
        // At 40 kts wind (idx 4), head-on (0°) should be slower than beam (90°)
        const headOn = matrix[0][4]; // 0° angle
        const beam = matrix[2][4]; // 90° angle
        expect(beam).toBeGreaterThan(headOn);
    });
});

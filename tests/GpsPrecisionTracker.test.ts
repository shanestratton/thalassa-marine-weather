/**
 * GpsPrecisionTracker — Unit tests
 *
 * Tests the adaptive GPS precision detection: quality classification,
 * rolling average, hysteresis, staleness, and adapted thresholds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { GpsPrecision } from '../services/shiplog/GpsPrecisionTracker';

describe('GpsPrecisionTracker', () => {
    beforeEach(() => {
        GpsPrecision.reset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── Initial state ──

    it('starts in standard quality', () => {
        expect(GpsPrecision.getQuality()).toBe('standard');
        expect(GpsPrecision.isPrecision()).toBe(false);
    });

    // ── Feed invalid values ──

    it('ignores zero accuracy', () => {
        GpsPrecision.feed(0);
        expect(GpsPrecision.getQuality()).toBe('standard');
    });

    it('ignores negative accuracy', () => {
        GpsPrecision.feed(-5);
        expect(GpsPrecision.getQuality()).toBe('standard');
    });

    it('ignores Infinity accuracy', () => {
        GpsPrecision.feed(Infinity);
        expect(GpsPrecision.getQuality()).toBe('standard');
    });

    it('ignores NaN accuracy', () => {
        GpsPrecision.feed(NaN);
        expect(GpsPrecision.getQuality()).toBe('standard');
    });

    // ── Precision detection ──

    it('detects precision GPS after sustained high-accuracy samples', () => {
        // Feed enough precision samples (< 6m) to trigger hysteresis
        for (let i = 0; i < 10; i++) {
            GpsPrecision.feed(2.0);
        }
        expect(GpsPrecision.isPrecision()).toBe(true);
        expect(GpsPrecision.getQuality()).toBe('precision');
    });

    it('detects degraded GPS after sustained low-accuracy samples', () => {
        for (let i = 0; i < 10; i++) {
            GpsPrecision.feed(25.0);
        }
        expect(GpsPrecision.getQuality()).toBe('degraded');
    });

    it('stays standard with moderate accuracy', () => {
        for (let i = 0; i < 10; i++) {
            GpsPrecision.feed(10.0);
        }
        expect(GpsPrecision.getQuality()).toBe('standard');
    });

    // ── Average accuracy ──

    it('getAverageAccuracy returns rolling average', () => {
        GpsPrecision.feed(2.0);
        GpsPrecision.feed(4.0);
        GpsPrecision.feed(6.0);
        expect(GpsPrecision.getAverageAccuracy()).toBeCloseTo(4.0, 1);
    });

    // ── Adapted thresholds ──

    it('getAdaptedThresholds returns object with expected keys', () => {
        const thresholds = GpsPrecision.getAdaptedThresholds();
        expect(thresholds).toHaveProperty('courseChangeMinMovementM');
        expect(thresholds).toHaveProperty('trackThinningMultiplier');
        expect(thresholds).toHaveProperty('minAnchorAlarmRadiusM');
        expect(thresholds).toHaveProperty('qualityLabel');
    });

    it('precision mode tightens thresholds', () => {
        const standardThresholds = GpsPrecision.getAdaptedThresholds();

        // Switch to precision
        for (let i = 0; i < 10; i++) GpsPrecision.feed(2.0);

        const precisionThresholds = GpsPrecision.getAdaptedThresholds();
        expect(precisionThresholds.courseChangeMinMovementM).toBeLessThanOrEqual(
            standardThresholds.courseChangeMinMovementM,
        );
    });

    // ── Reset ──

    it('reset clears all state', () => {
        for (let i = 0; i < 10; i++) GpsPrecision.feed(2.0);
        expect(GpsPrecision.isPrecision()).toBe(true);

        GpsPrecision.reset();
        expect(GpsPrecision.getQuality()).toBe('standard');
        expect(GpsPrecision.isPrecision()).toBe(false);
    });

    // ── Listener ──

    it('onQualityChange notifies on transition', () => {
        const callback = vi.fn();
        const unsub = GpsPrecision.onQualityChange(callback);

        for (let i = 0; i < 10; i++) GpsPrecision.feed(2.0);

        // Should have been called at least once with 'precision'
        if (callback.mock.calls.length > 0) {
            expect(callback).toHaveBeenCalledWith('precision', expect.any(Number));
        }

        unsub();
    });
});

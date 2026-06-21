/**
 * Tests for the anchor-watch blind-watch watchdog decision.
 *
 * The bug this guards against: drag detection only runs when a fresh,
 * accurate GPS fix arrives, so a dragging boat with lost/degraded GPS
 * freezes distanceFromAnchor and NEVER alarms. The watchdog must declare
 * the watch "blind" once no usable fix has arrived within the budget.
 */
import { describe, it, expect } from 'vitest';
import { isAnchorGpsStale, GPS_LOST_THRESHOLD_MS } from '../services/anchorGpsWatchdog';

const T0 = Date.UTC(2026, 5, 21, 12, 0, 0); // fixed epoch — no wall-clock dependence

describe('isAnchorGpsStale', () => {
    it('has a sane default budget (90s)', () => {
        expect(GPS_LOST_THRESHOLD_MS).toBe(90_000);
    });

    it('is NOT stale before any fix has been recorded (cold start)', () => {
        // null lastFix → the watch-start seed handles the grace window, never alarm here
        expect(isAnchorGpsStale(T0, null, GPS_LOST_THRESHOLD_MS)).toBe(false);
    });

    it('is NOT stale while fixes are recent', () => {
        expect(isAnchorGpsStale(T0 + 10_000, T0, GPS_LOST_THRESHOLD_MS)).toBe(false);
    });

    it('is NOT stale exactly at the threshold (strictly greater required)', () => {
        expect(isAnchorGpsStale(T0 + GPS_LOST_THRESHOLD_MS, T0, GPS_LOST_THRESHOLD_MS)).toBe(false);
    });

    it('IS stale one millisecond past the threshold', () => {
        expect(isAnchorGpsStale(T0 + GPS_LOST_THRESHOLD_MS + 1, T0, GPS_LOST_THRESHOLD_MS)).toBe(true);
    });

    it('IS stale after a long GPS dropout (the dragging-with-lost-GPS case)', () => {
        // boat keeps moving but no fix for 5 minutes → must be flagged blind
        expect(isAnchorGpsStale(T0 + 5 * 60_000, T0, GPS_LOST_THRESHOLD_MS)).toBe(true);
    });

    it('uses the default budget when the threshold arg is omitted', () => {
        expect(isAnchorGpsStale(T0 + 60_000, T0)).toBe(false);
        expect(isAnchorGpsStale(T0 + 120_000, T0)).toBe(true);
    });

    it('stays fresh across a realistic 3s fix cadence, then trips on a dropout', () => {
        // Simulate the watchdog clock advancing as fixes arrive every 3s for 5 min
        let lastFix = T0;
        for (let t = T0; t <= T0 + 5 * 60_000; t += 3_000) {
            lastFix = t; // a usable fix arrived this tick
            expect(isAnchorGpsStale(t, lastFix, GPS_LOST_THRESHOLD_MS)).toBe(false);
        }
        // Now the fixes stop. 91s later the watch is blind.
        expect(isAnchorGpsStale(lastFix + 91_000, lastFix, GPS_LOST_THRESHOLD_MS)).toBe(true);
    });
});

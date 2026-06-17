/**
 * Tests for trackViz pure helpers — wind bucketing (incl. the explicit
 * no-data band that dominates real offshore passages), the speed
 * sparkline (gap-tolerant, never NaN), and nearest-track projection.
 */
import { describe, it, expect } from 'vitest';
import {
    windBucket,
    buildSparkline,
    nearestTrackEntry,
    WIND_BUCKETS,
    WIND_NODATA_COLOR,
} from '../services/shiplog/trackViz';
import type { ShipLogEntry } from '../types';

function entry(over: Partial<ShipLogEntry> = {}): ShipLogEntry {
    return {
        id: 'e',
        voyageId: 'v1',
        timestamp: '2026-06-17T00:00:00Z',
        latitude: -27.5,
        longitude: 153.0,
        entryType: 'auto',
        ...over,
    } as ShipLogEntry;
}

describe('windBucket', () => {
    it('returns the no-data bucket for missing/invalid wind', () => {
        expect(windBucket(undefined).key).toBe('nodata');
        expect(windBucket(null).key).toBe('nodata');
        expect(windBucket(NaN).key).toBe('nodata');
        expect(windBucket(undefined).color).toBe(WIND_NODATA_COLOR);
    });

    it('buckets across the wind ramp by the Beaufort breakpoints', () => {
        expect(windBucket(0).key).toBe('calm');
        expect(windBucket(5.9).key).toBe('calm');
        expect(windBucket(6).key).toBe('gentle');
        expect(windBucket(15).key).toBe('moderate');
        expect(windBucket(20).key).toBe('fresh');
        expect(windBucket(25).key).toBe('strong');
        expect(windBucket(30).key).toBe('neargale');
        expect(windBucket(40).key).toBe('gale');
        expect(windBucket(999).key).toBe('gale');
    });

    it('clamps negative wind to the lowest band', () => {
        expect(windBucket(-3).key).toBe('calm');
    });

    it('every bucket has a distinct colour (a real legend)', () => {
        const colors = new Set([WIND_NODATA_COLOR, ...WIND_BUCKETS.map((b) => b.color)]);
        expect(colors.size).toBe(WIND_BUCKETS.length + 1);
    });
});

describe('buildSparkline', () => {
    it('returns an empty path for <2 entries without NaN', () => {
        expect(buildSparkline([], 100, 20).path).toBe('');
        expect(buildSparkline([entry({ speedKts: 5 })], 100, 20).path).toBe('');
    });

    it('spans the full width and inverts y (faster = higher)', () => {
        const es = [entry({ speedKts: 0 }), entry({ speedKts: 5 }), entry({ speedKts: 10 })];
        const s = buildSparkline(es, 100, 20);
        expect(s.maxKts).toBe(10);
        expect(s.xs[0]).toBe(0);
        expect(s.xs[2]).toBe(100);
        // First point speed 0 → bottom (y = h); last speed 10 (max) → top (y = 0).
        expect(s.path.startsWith('M0.0 20.0')).toBe(true);
        expect(s.path.endsWith('L100.0 0.0')).toBe(true);
    });

    it('treats missing/zero/negative speed as a 0 gap, never NaN', () => {
        const es = [entry({ speedKts: undefined }), entry({ speedKts: 6 }), entry({ speedKts: -1 })];
        const s = buildSparkline(es, 60, 10);
        expect(s.path).not.toContain('NaN');
        expect(s.maxKts).toBe(6);
    });

    it('flat (all-zero) track still draws with maxKts floored at 1', () => {
        const es = [entry({ speedKts: 0 }), entry({ speedKts: 0 })];
        const s = buildSparkline(es, 50, 10);
        expect(s.maxKts).toBe(1);
        expect(s.path).not.toContain('NaN');
    });
});

describe('nearestTrackEntry', () => {
    it('finds the closest trackworthy entry', () => {
        const es = [
            entry({ id: 'a', latitude: -27.5, longitude: 153.0 }),
            entry({ id: 'b', latitude: -27.6, longitude: 153.1 }),
            entry({ id: 'c', latitude: -27.55, longitude: 153.05 }),
        ];
        expect(nearestTrackEntry(es, -27.59, 153.09)?.id).toBe('b');
    });

    it('ignores turn pins and manual entries (not on the track line)', () => {
        const es = [
            entry({ id: 'pin', latitude: -27.59, longitude: 153.09, entryType: 'waypoint', waypointName: 'COG N → E' }),
            entry({ id: 'manual', latitude: -27.591, longitude: 153.091, entryType: 'manual' }),
            entry({ id: 'real', latitude: -27.5, longitude: 153.0 }),
        ];
        // Tap right on the pin → still returns the real track point.
        expect(nearestTrackEntry(es, -27.59, 153.09)?.id).toBe('real');
    });

    it('returns null when there are no trackworthy entries', () => {
        const es = [entry({ entryType: 'manual' })];
        expect(nearestTrackEntry(es, -27.5, 153.0)).toBeNull();
    });
});

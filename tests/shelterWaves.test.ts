/**
 * Tests for the sheltered-water wave fix:
 *  - fetchLimitedSea: the wind-sea physics (caps, never raises).
 *  - shelterGeometry: the enclosure raycast (boxed-in vs open coast).
 * Both are safety-relevant — a wrong cap or a mis-classified open coast would
 * under-state real waves, so the wrap/edge cases are pinned explicitly.
 */
import { describe, it, expect } from 'vitest';
import {
    fetchLimitedHsMeters,
    fullyDevelopedHsMeters,
    capWaveToFetch,
} from '../services/weather/shelter/fetchLimitedSea';
import { assessFetch, type Segment, type LngLat } from '../services/weather/shelter/shelterGeometry';

describe('fetchLimitedSea — physics', () => {
    it('a short bay fetch in a fresh breeze gives a small sea', () => {
        // 15 kt over 10 km of bay → a few tenths of a metre, not metres.
        const hs = fetchLimitedHsMeters(15, 10);
        expect(hs).toBeGreaterThan(0.2);
        expect(hs).toBeLessThan(0.7);
    });

    it('grows with fetch but never exceeds fully developed', () => {
        const short = fetchLimitedHsMeters(20, 5);
        const long = fetchLimitedHsMeters(20, 500);
        expect(long).toBeGreaterThan(short);
        expect(long).toBeLessThanOrEqual(fullyDevelopedHsMeters(20) + 1e-9);
    });

    it('is zero with no wind or no fetch', () => {
        expect(fetchLimitedHsMeters(0, 10)).toBe(0);
        expect(fetchLimitedHsMeters(15, 0)).toBe(0);
        expect(fetchLimitedHsMeters(null, 10)).toBe(0);
    });

    it('capWaveToFetch pulls down an over-stated model wave', () => {
        // Model says 2.7 m; 12 kt over 12 km can only sustain ~0.4 m.
        const r = capWaveToFetch(2.7, 12, 12);
        expect(r.capped).toBe(true);
        expect(r.hsMeters).toBeLessThan(0.7);
        expect(r.hsMeters).toBe(r.capMeters);
    });

    it('capWaveToFetch NEVER raises a wave that is already within fetch', () => {
        const r = capWaveToFetch(0.3, 25, 40);
        expect(r.capped).toBe(false);
        expect(r.hsMeters).toBe(0.3);
    });

    it('a strong wind over a long fetch does not cap a legit big sea', () => {
        const r = capWaveToFetch(2.5, 35, 300);
        expect(r.capped).toBe(false);
        expect(r.hsMeters).toBe(2.5);
    });
});

describe('shelterGeometry — enclosure raycast', () => {
    const lat0 = -27.2;
    const lon0 = 153.1;
    const W = 0.1; // ~10 km in lon
    const H = 0.09; // ~10 km in lat
    const NW: LngLat = [lon0 - W, lat0 + H];
    const NE: LngLat = [lon0 + W, lat0 + H];
    const SE: LngLat = [lon0 + W, lat0 - H];
    const SW: LngLat = [lon0 - W, lat0 - H];
    const north: Segment = [NW, NE];
    const east: Segment = [NE, SE];
    const south: Segment = [SE, SW];
    const west: Segment = [SW, NW];

    it('a point boxed in by coast on all sides is ENCLOSED', () => {
        const r = assessFetch(lat0, lon0, [north, east, south, west]);
        expect(r.enclosed).toBe(true);
        expect(r.openBearings).toBe(0);
        expect(r.maxFetchKm).toBeLessThan(20); // ~10–14 km box, never the 55 km sentinel
    });

    it('an open coast (sea to the east) is NOT enclosed', () => {
        const r = assessFetch(lat0, lon0, [north, south, west]);
        expect(r.enclosed).toBe(false);
        expect(r.openBearings).toBeGreaterThan(2);
        expect(r.maxFetchKm).toBeGreaterThan(50); // some bearing reaches open water
    });

    it('missing / empty coastline is NOT enclosed (safe default — never damp)', () => {
        const r = assessFetch(lat0, lon0, []);
        expect(r.enclosed).toBe(false);
        expect(r.openBearings).toBe(36);
    });

    it('a bay with one narrow mouth still reads enclosed (mouth tolerance)', () => {
        // East wall split into two halves leaving a small gap at the middle.
        const gap = 0.012; // ~1.3 km mouth
        const eastTop: Segment = [NE, [lon0 + W, lat0 + gap]];
        const eastBot: Segment = [[lon0 + W, lat0 - gap], SE];
        const r = assessFetch(lat0, lon0, [north, eastTop, eastBot, south, west]);
        expect(r.enclosed).toBe(true);
        expect(r.openBearings).toBeLessThanOrEqual(2);
    });
});

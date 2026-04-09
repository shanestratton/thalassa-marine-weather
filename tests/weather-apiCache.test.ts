/**
 * API Cache — Unit tests
 *
 * Tests the universal API response cache: set/get, TTL enforcement
 * per provider, location key rounding, invalidation, eviction, and stats.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { apiCacheGet, apiCacheSet, apiCacheInvalidate, apiCacheStats } from '../services/weather/apiCache';

describe('apiCache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── Basic set/get ─────────────────────────────────────────

    describe('set and get', () => {
        it('stores and retrieves data', () => {
            apiCacheSet('openmeteo', -33.8, 151.2, { temp: 22 });
            const result = apiCacheGet<{ temp: number }>('openmeteo', -33.8, 151.2);
            expect(result).toEqual({ temp: 22 });
        });

        it('returns null for missing entry', () => {
            expect(apiCacheGet('openmeteo', 0, 0)).toBeNull();
        });

        it('supports extra key suffix', () => {
            apiCacheSet('stormglass', -33.8, 151.2, { wind: 15 }, 'hourly');
            expect(apiCacheGet('stormglass', -33.8, 151.2, 'hourly')).toEqual({ wind: 15 });
            expect(apiCacheGet('stormglass', -33.8, 151.2)).toBeNull();
        });
    });

    // ── Location key rounding ────────────────────────────────

    describe('location key rounding (0.1° grid)', () => {
        it('coalesces nearby coordinates', () => {
            apiCacheSet('openmeteo', -33.84, 151.23, { val: 1 });
            // -33.84 rounds to -33.8, 151.23 rounds to 151.2
            expect(apiCacheGet('openmeteo', -33.81, 151.19)).toEqual({ val: 1 });
        });

        it('separates distant coordinates', () => {
            apiCacheSet('openmeteo', -33.8, 151.2, { val: 1 });
            // -34.0 is more than 0.1° away
            expect(apiCacheGet('openmeteo', -34.0, 151.2)).toBeNull();
        });
    });

    // ── TTL enforcement ──────────────────────────────────────

    describe('TTL per provider', () => {
        it('openmeteo expires after 30 minutes', () => {
            apiCacheSet('openmeteo', 0, 0, { data: 'test' });

            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
            expect(apiCacheGet('openmeteo', 0, 0)).toBeNull();
        });

        it('weatherkit expires after 15 minutes', () => {
            apiCacheSet('weatherkit', 0, 0, { data: 'test' });

            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
            expect(apiCacheGet('weatherkit', 0, 0)).toBeNull();
        });

        it('worldtides valid for 24 hours', () => {
            apiCacheSet('worldtides', 0, 0, { data: 'test' });

            // 23 hours later — still valid
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 23 * 60 * 60 * 1000);
            expect(apiCacheGet('worldtides', 0, 0)).toEqual({ data: 'test' });
        });

        it('stormglass expires after 3 hours', () => {
            apiCacheSet('stormglass', 0, 0, { data: 'test' });

            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3.1 * 60 * 60 * 1000);
            expect(apiCacheGet('stormglass', 0, 0)).toBeNull();
        });

        it('noaa_gfs expires after 3 hours', () => {
            apiCacheSet('noaa_gfs', 0, 0, { data: 'test' });

            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3.1 * 60 * 60 * 1000);
            expect(apiCacheGet('noaa_gfs', 0, 0)).toBeNull();
        });

        it('tides valid for 24 hours', () => {
            apiCacheSet('tides', 0, 0, { data: 'test' });

            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 23 * 60 * 60 * 1000);
            expect(apiCacheGet('tides', 0, 0)).not.toBeNull();
        });
    });

    // ── Invalidation ─────────────────────────────────────────

    describe('invalidation', () => {
        it('removes specific entry', () => {
            apiCacheSet('openmeteo', -33.8, 151.2, { data: 'a' });
            apiCacheSet('stormglass', -33.8, 151.2, { data: 'b' });

            apiCacheInvalidate('openmeteo', -33.8, 151.2);
            expect(apiCacheGet('openmeteo', -33.8, 151.2)).toBeNull();
            expect(apiCacheGet('stormglass', -33.8, 151.2)).toEqual({ data: 'b' });
        });
    });

    // ── Stats ────────────────────────────────────────────────

    describe('stats', () => {
        it('returns empty stats for empty cache', () => {
            expect(apiCacheStats()).toEqual([]);
        });

        it('counts entries per provider', () => {
            apiCacheSet('openmeteo', 0, 0, 'a');
            apiCacheSet('openmeteo', 10, 10, 'b');
            apiCacheSet('stormglass', 0, 0, 'c');

            const stats = apiCacheStats();
            const om = stats.find((s) => s.provider === 'openmeteo');
            const sg = stats.find((s) => s.provider === 'stormglass');
            expect(om?.count).toBe(2);
            expect(sg?.count).toBe(1);
        });
    });

    // ── Corrupt data handling ────────────────────────────────

    describe('corrupt data', () => {
        it('returns null for corrupt JSON', () => {
            const key = 'thalassa_apicache_v1_openmeteo_0.0_0.0';
            localStorage.setItem(key, 'not-json');
            expect(apiCacheGet('openmeteo', 0, 0)).toBeNull();
        });
    });
});

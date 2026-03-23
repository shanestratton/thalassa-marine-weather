/**
 * RateLimiter — Unit tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimiter } from '../utils/rateLimiter';

describe('rateLimiter', () => {
    beforeEach(() => {
        rateLimiter.reset();
    });

    it('allows requests within limit', () => {
        // Default 'stormglass' limit is 10/day
        for (let i = 0; i < 10; i++) {
            expect(rateLimiter.acquire('stormglass')).toBe(true);
        }
    });

    it('blocks requests beyond limit', () => {
        for (let i = 0; i < 10; i++) {
            rateLimiter.acquire('stormglass');
        }
        // 11th request should be blocked
        expect(rateLimiter.acquire('stormglass')).toBe(false);
    });

    it('tracks remaining tokens', () => {
        expect(rateLimiter.remaining('stormglass')).toBe(10);
        rateLimiter.acquire('stormglass');
        expect(rateLimiter.remaining('stormglass')).toBe(9);
    });

    it('uses default config for unknown APIs', () => {
        // Default is 30 per minute
        expect(rateLimiter.remaining('unknown-api')).toBe(30);
    });

    it('supports multiple independent buckets', () => {
        rateLimiter.acquire('stormglass');
        expect(rateLimiter.remaining('stormglass')).toBe(9);
        expect(rateLimiter.remaining('open-meteo')).toBe(60);
    });

    it('reset clears all buckets', () => {
        rateLimiter.acquire('stormglass');
        rateLimiter.reset();
        expect(rateLimiter.remaining('stormglass')).toBe(10);
    });

    it('getStats returns all active buckets', () => {
        rateLimiter.acquire('stormglass');
        rateLimiter.acquire('mapbox');
        const stats = rateLimiter.getStats();
        expect(stats.stormglass).toBeDefined();
        expect(stats.stormglass.remaining).toBe(9);
        expect(stats.stormglass.max).toBe(10);
        expect(stats.mapbox).toBeDefined();
        expect(stats.mapbox.remaining).toBe(99);
    });

    it('configure allows custom limits', () => {
        rateLimiter.configure('custom-api', {
            maxTokens: 5,
            refillAmount: 5,
            refillIntervalMs: 1000,
        });
        expect(rateLimiter.remaining('custom-api')).toBe(5);
        for (let i = 0; i < 5; i++) {
            rateLimiter.acquire('custom-api');
        }
        expect(rateLimiter.acquire('custom-api')).toBe(false);
    });

    it('gemini limit is 15 per minute', () => {
        expect(rateLimiter.remaining('gemini')).toBe(15);
    });

    it('open-meteo limit is 60 per hour', () => {
        expect(rateLimiter.remaining('open-meteo')).toBe(60);
    });

    it('mapbox limit is 100 per minute', () => {
        expect(rateLimiter.remaining('mapbox')).toBe(100);
    });
});

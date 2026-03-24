/**
 * RateLimiter — Additional Unit Tests
 *
 * Tests token bucket logic, refill mechanics, custom configs,
 * and reset functionality.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rateLimiter } from '../utils/rateLimiter';

describe('rateLimiter', () => {
    beforeEach(() => {
        rateLimiter.reset();
    });

    afterEach(() => {
        rateLimiter.reset();
        vi.restoreAllMocks();
    });

    it('allows requests within quota', () => {
        expect(rateLimiter.acquire('default')).toBe(true);
        expect(rateLimiter.remaining('default')).toBe(29); // 30 maxTokens - 1 acquired
    });

    it('blocks requests when tokens exhausted', () => {
        // Drain all tokens
        for (let i = 0; i < 30; i++) {
            rateLimiter.acquire('default');
        }
        expect(rateLimiter.acquire('default')).toBe(false);
        expect(rateLimiter.remaining('default')).toBe(0);
    });

    it('uses correct config for named APIs', () => {
        // stormglass has maxTokens: 10
        expect(rateLimiter.remaining('stormglass')).toBe(10);
        for (let i = 0; i < 10; i++) {
            expect(rateLimiter.acquire('stormglass')).toBe(true);
        }
        expect(rateLimiter.acquire('stormglass')).toBe(false);
    });

    it('falls back to default for unknown APIs', () => {
        expect(rateLimiter.remaining('unknown-api')).toBe(30);
    });

    it('supports custom config via configure()', () => {
        rateLimiter.configure('test-api', {
            maxTokens: 3,
            refillAmount: 3,
            refillIntervalMs: 1000,
        });

        expect(rateLimiter.remaining('test-api')).toBe(3);
        for (let i = 0; i < 3; i++) {
            expect(rateLimiter.acquire('test-api')).toBe(true);
        }
        expect(rateLimiter.acquire('test-api')).toBe(false);
    });

    it('refills tokens after interval passes', () => {
        rateLimiter.configure('refill-test', {
            maxTokens: 5,
            refillAmount: 5,
            refillIntervalMs: 100,
        });

        // Drain tokens
        for (let i = 0; i < 5; i++) {
            rateLimiter.acquire('refill-test');
        }
        expect(rateLimiter.remaining('refill-test')).toBe(0);

        // Advance time past refill interval
        vi.useFakeTimers();
        vi.advanceTimersByTime(150);
        expect(rateLimiter.remaining('refill-test')).toBe(5);
        vi.useRealTimers();
    });

    it('reset clears all buckets', () => {
        rateLimiter.acquire('stormglass');
        rateLimiter.acquire('mapbox');
        rateLimiter.reset();
        expect(rateLimiter.remaining('stormglass')).toBe(10);
        expect(rateLimiter.remaining('mapbox')).toBe(100);
    });

    it('getStats returns stats for active buckets', () => {
        rateLimiter.acquire('gemini');
        const stats = rateLimiter.getStats();
        expect(stats['gemini']).toBeDefined();
        expect(stats['gemini'].remaining).toBe(14); // 15 - 1
        expect(stats['gemini'].max).toBe(15);
    });

    it('tokens do not exceed maxTokens after refill', () => {
        rateLimiter.configure('cap-test', {
            maxTokens: 5,
            refillAmount: 10, // More than max
            refillIntervalMs: 100,
        });

        rateLimiter.acquire('cap-test');
        vi.useFakeTimers();
        vi.advanceTimersByTime(150);
        expect(rateLimiter.remaining('cap-test')).toBeLessThanOrEqual(5);
        vi.useRealTimers();
    });
});

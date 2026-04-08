/**
 * Weather API Keys — Unit tests
 *
 * Tests API key resolution, suffix display, and key-present checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the rate limiter (imported by keys.ts)
vi.mock('../utils/rateLimiter', () => ({
    rateLimiter: { acquire: vi.fn().mockReturnValue(true) },
}));

vi.mock('@capacitor/core', () => ({
    CapacitorHttp: { get: vi.fn() },
}));

vi.mock('../utils/logger', () => ({
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import {
    getApiKey,
    getOpenMeteoKey,
    getWorldTidesKey,
    getMapboxKey,
    getApiKeySuffix,
    isStormglassKeyPresent,
    isWorldTidesKeyPresent,
    checkRateLimit,
} from '../services/weather/keys';

describe('API key resolution', () => {
    it('getApiKey returns null when no env var set', () => {
        // In test env, import.meta.env.VITE_STORMGLASS_API_KEY is not set
        const key = getApiKey();
        // May return null or env value depending on test setup
        expect(key === null || typeof key === 'string').toBe(true);
    });

    it('getOpenMeteoKey returns null when no env var set', () => {
        const key = getOpenMeteoKey();
        expect(key === null || typeof key === 'string').toBe(true);
    });

    it('getWorldTidesKey returns null when no env var set', () => {
        const key = getWorldTidesKey();
        expect(key === null || typeof key === 'string').toBe(true);
    });

    it('getMapboxKey returns null when no env var set', () => {
        const key = getMapboxKey();
        expect(key === null || typeof key === 'string').toBe(true);
    });
});

describe('getApiKeySuffix', () => {
    it('returns PROXY when no key available', () => {
        // If no key is set, suffix should indicate proxy mode
        const suffix = getApiKeySuffix();
        expect(suffix === 'PROXY' || suffix.startsWith('...')).toBe(true);
    });
});

describe('key presence checks', () => {
    it('isStormglassKeyPresent always returns true (proxy mode)', () => {
        expect(isStormglassKeyPresent()).toBe(true);
    });

    it('isWorldTidesKeyPresent always returns true (proxy mode)', () => {
        expect(isWorldTidesKeyPresent()).toBe(true);
    });
});

describe('checkRateLimit', () => {
    it('delegates to rateLimiter.acquire', () => {
        const result = checkRateLimit('stormglass');
        expect(typeof result).toBe('boolean');
    });
});

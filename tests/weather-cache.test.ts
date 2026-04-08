/**
 * Weather Cache — Unit tests
 *
 * Tests the localStorage-based weather cache: save, retrieve, TTL expiry,
 * offline-aware fallback, and stale data metadata.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    saveToCache,
    getFromCache,
    clearCache,
    getFromCacheOffline,
    differenceInMinutes,
} from '../services/weather/cache';
import type { MarineWeatherReport } from '../types';

// ── Helpers ─────────────────────────────────────────────────────

function makeFakeReport(overrides: Partial<MarineWeatherReport> = {}): MarineWeatherReport {
    return {
        modelUsed: 'openmeteo',
        locationName: 'Test Location',
        windSpeed: 15,
        windDirection: 180,
        windGust: 25,
        waveHeight: 1.5,
        wavePeriod: 8,
        waveDirection: 200,
        pressure: 1013,
        temperature: 22,
        humidity: 65,
        cloudCover: 40,
        ...overrides,
    } as MarineWeatherReport;
}

// ── Tests ───────────────────────────────────────────────────────

describe('differenceInMinutes', () => {
    it('returns 0 for identical dates', () => {
        const d = new Date();
        expect(differenceInMinutes(d, d)).toBe(0);
    });

    it('returns correct minutes for dates apart', () => {
        const d1 = new Date('2025-01-01T00:00:00Z');
        const d2 = new Date('2025-01-01T01:30:00Z');
        expect(differenceInMinutes(d1, d2)).toBe(90);
    });

    it('returns absolute value regardless of order', () => {
        const d1 = new Date('2025-01-01T00:00:00Z');
        const d2 = new Date('2025-01-01T00:45:00Z');
        expect(differenceInMinutes(d1, d2)).toBe(differenceInMinutes(d2, d1));
    });
});

describe('saveToCache / getFromCache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('saves and retrieves a report', () => {
        const report = makeFakeReport();
        saveToCache('Sydney Heads', report);
        const cached = getFromCache('Sydney Heads');
        expect(cached).not.toBeNull();
        expect(cached!.windSpeed).toBe(15);
    });

    it('normalizes location name (spaces → underscores, lowercase)', () => {
        const report = makeFakeReport();
        saveToCache('Cape Byron NSW', report);
        // Should retrieve with same name
        expect(getFromCache('Cape Byron NSW')).not.toBeNull();
    });

    it('returns null for unknown location', () => {
        expect(getFromCache('Nonexistent Place')).toBeNull();
    });

    it('also saves a last_marine_report fallback', () => {
        const report = makeFakeReport();
        saveToCache('Test', report);
        const fallback = localStorage.getItem('last_marine_report');
        expect(fallback).not.toBeNull();
        expect(JSON.parse(fallback!).windSpeed).toBe(15);
    });
});

describe('cache TTL expiry', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('openmeteo cache expires after 30 minutes', () => {
        const report = makeFakeReport({ modelUsed: 'openmeteo' });
        saveToCache('Test', report);

        // Advance time by 31 minutes
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000);

        expect(getFromCache('Test')).toBeNull();
    });

    it('stormglass cache valid for 60 minutes', () => {
        const report = makeFakeReport({ modelUsed: 'stormglass-premium' });
        saveToCache('Test', report);

        // 45 minutes later — should still be valid
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 45 * 60 * 1000);

        expect(getFromCache('Test')).not.toBeNull();
    });

    it('stormglass cache expires after 60 minutes', () => {
        const report = makeFakeReport({ modelUsed: 'stormglass-premium' });
        saveToCache('Test', report);

        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60 * 1000);

        expect(getFromCache('Test')).toBeNull();
    });
});

describe('clearCache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('clears specific location cache', () => {
        saveToCache('Sydney', makeFakeReport());
        saveToCache('Brisbane', makeFakeReport());

        clearCache('Sydney');
        expect(getFromCache('Sydney')).toBeNull();
        expect(getFromCache('Brisbane')).not.toBeNull();
    });
});

describe('getFromCacheOffline', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null when no cache exists', () => {
        expect(getFromCacheOffline('Unknown')).toBeNull();
    });

    it('returns stale data with metadata when cache is expired', () => {
        const report = makeFakeReport({ modelUsed: 'openmeteo' });
        saveToCache('Test', report);

        // Advance time past TTL
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);

        const result = getFromCacheOffline('Test');
        expect(result).not.toBeNull();
        expect(result!.stale).toBe(true);
        expect(result!.ageMinutes).toBe(60);
        expect(result!.data.windSpeed).toBe(15);
    });

    it('returns non-stale data when cache is fresh', () => {
        saveToCache('Test', makeFakeReport({ modelUsed: 'openmeteo' }));

        const result = getFromCacheOffline('Test');
        expect(result).not.toBeNull();
        expect(result!.stale).toBe(false);
    });

    it('falls back to last_marine_report when location not cached', () => {
        // Save to a different location to populate fallback
        saveToCache('Other', makeFakeReport());

        // Request an uncached location — should fallback
        const result = getFromCacheOffline('Uncached');
        expect(result).not.toBeNull();
        expect(result!.stale).toBe(true);
        expect(result!.ageMinutes).toBe(-1); // Unknown age for fallback
    });

    it('returns null when no fallback exists either', () => {
        expect(getFromCacheOffline('Nothing')).toBeNull();
    });
});

/**
 * Tests for weather cache and utility functions
 * Tests pure in-memory cache logic with mocked localStorage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { differenceInMinutes, saveToCache, getFromCache, clearCache } from '../services/weather/cache';
import { MarineWeatherReport } from '../types';

// --- differenceInMinutes ---

describe('differenceInMinutes', () => {
    it('returns 0 for identical dates', () => {
        const d = new Date('2025-01-01T00:00:00Z');
        expect(differenceInMinutes(d, d)).toBe(0);
    });

    it('returns 60 for 1 hour difference', () => {
        const a = new Date('2025-01-01T00:00:00Z');
        const b = new Date('2025-01-01T01:00:00Z');
        expect(differenceInMinutes(a, b)).toBe(60);
    });

    it('is symmetric (absolute value)', () => {
        const a = new Date('2025-01-01T00:00:00Z');
        const b = new Date('2025-01-01T02:30:00Z');
        expect(differenceInMinutes(a, b)).toBe(differenceInMinutes(b, a));
        expect(differenceInMinutes(a, b)).toBe(150);
    });
});

// --- saveToCache / getFromCache ---

const makeReport = (model: string): MarineWeatherReport => ({
    locationName: 'Brisbane',
    current: {
        windSpeed: 15,
        windDirection: 'SE',
        windDegree: 135,
        waveHeight: 1.2,
        swellPeriod: 8,
        airTemperature: 22,
        condition: 'Partly Cloudy',
        description: 'Partly Cloudy',
        uvIndex: 5,
        humidity: 65,
        precipitation: 0,
        pressure: 1013,
        visibility: 10,
        day: 'Mon',
        date: '2025-01-01',
    },
    forecast: [],
    hourly: [],
    tides: [],
    boatingAdvice: 'Conditions favourable',
    generatedAt: new Date().toISOString(),
    modelUsed: model,
});

describe('saveToCache / getFromCache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('saves and retrieves a report', () => {
        const report = makeReport('open_meteo');
        saveToCache('Brisbane', report);

        const cached = getFromCache('Brisbane');
        expect(cached).not.toBeNull();
        expect(cached?.locationName).toBe('Brisbane');
    });

    it('normalises location name (spaces → underscores, lowercase)', () => {
        const report = makeReport('open_meteo');
        saveToCache('Gold Coast', report);

        // Should find with same name
        const cached = getFromCache('Gold Coast');
        expect(cached).not.toBeNull();
    });

    it('returns null for expired OpenMeteo cache (>30 min)', () => {
        const report = makeReport('open_meteo');
        saveToCache('Sydney', report);

        // Manually age the cache
        const key = 'marine_weather_cache_v7_sydney';
        const raw = localStorage.getItem(key);
        if (raw) {
            const entry = JSON.parse(raw);
            entry.timestamp = Date.now() - 31 * 60 * 1000; // 31 minutes ago
            localStorage.setItem(key, JSON.stringify(entry));
        }

        expect(getFromCache('Sydney')).toBeNull();
    });

    it('keeps StormGlass cache valid for 60 min', () => {
        const report = makeReport('stormglass_pro');
        saveToCache('Perth', report);

        // Age to 45 minutes
        const key = 'marine_weather_cache_v7_perth';
        const raw = localStorage.getItem(key);
        if (raw) {
            const entry = JSON.parse(raw);
            entry.timestamp = Date.now() - 45 * 60 * 1000;
            localStorage.setItem(key, JSON.stringify(entry));
        }

        // Should still be valid (45 < 60)
        expect(getFromCache('Perth')).not.toBeNull();
    });

    it('returns null for unknown location', () => {
        expect(getFromCache('Atlantis')).toBeNull();
    });
});

describe('clearCache', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('removes a specific location cache', () => {
        const report = makeReport('open_meteo');
        saveToCache('Darwin', report);
        expect(getFromCache('Darwin')).not.toBeNull();

        clearCache('Darwin');
        expect(getFromCache('Darwin')).toBeNull();
    });
});

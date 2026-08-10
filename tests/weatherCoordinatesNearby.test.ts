/**
 * weatherCoordinatesNearby — the "same sky" tolerance behind the instant
 * morning refresh (Shane 2026-08-10). The wake/boot paths fetch against the
 * cached report's point immediately and use this to decide whether the GPS
 * fix that lands later warrants a corrective re-fetch. Too tight and every
 * morning pays a second full fetch for GPS jitter; too loose and sailing
 * overnight serves yesterday's anchorage its old forecast.
 */
import { describe, expect, it } from 'vitest';
import { weatherCoordinatesNearby } from '../services/weather/cache';

const NEWPORT = { lat: -27.208, lon: 153.102 };

describe('weatherCoordinatesNearby', () => {
    it('overnight GPS jitter and an anchor swing are the same sky', () => {
        // ~50 m north — a boat swinging on its rode.
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat + 0.00045, lon: NEWPORT.lon })).toBe(true);
        // ~1 km — walked to the shops.
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat + 0.009, lon: NEWPORT.lon })).toBe(true);
    });

    it('a genuine overnight move is not the same sky', () => {
        // ~28 km — sailed to Moreton Island.
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat, lon: NEWPORT.lon + 0.28 })).toBe(false);
    });

    it('the tolerance is respected in longitude at latitude (cos scaling)', () => {
        // 0.018° of longitude at 27°S ≈ 1.78 km — inside 2 km.
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat, lon: NEWPORT.lon + 0.018 })).toBe(true);
        // 0.021° ≈ 2.08 km — just outside.
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat, lon: NEWPORT.lon + 0.021 })).toBe(false);
    });

    it('missing or non-finite coordinates never match', () => {
        expect(weatherCoordinatesNearby(null, NEWPORT)).toBe(false);
        expect(weatherCoordinatesNearby(NEWPORT, undefined)).toBe(false);
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NaN, lon: 153.1 })).toBe(false);
    });

    it('caller can widen the tolerance', () => {
        expect(weatherCoordinatesNearby(NEWPORT, { lat: NEWPORT.lat, lon: NEWPORT.lon + 0.28 }, 50)).toBe(true);
    });
});

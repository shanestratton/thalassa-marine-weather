/**
 * ChannelRouter — Unit tests for channel exit routing logic
 *
 * Tests: equirectangular distance, depth classification, and
 * channel routing with mock seamarks.
 */

import { describe, it, expect, vi } from 'vitest';
import { _testableInternals, routeChannel } from '../services/ChannelRouter';
import type { SeamarkCollection, SeamarkFeature, SeamarkClass } from '../services/SeamarkService';

const { distNM, classifyDepth } = _testableInternals;

// ── Equirectangular Distance (NM) ──

describe('distNM (equirectangular)', () => {
    it('returns 0 for same point', () => {
        expect(distNM(0, 0, 0, 0)).toBe(0);
    });

    it('1° latitude ≈ 60 NM', () => {
        const d = distNM(0, 0, 1, 0);
        expect(d).toBeCloseTo(60, 0);
    });

    it('1° longitude at equator ≈ 60 NM', () => {
        const d = distNM(0, 0, 0, 1);
        expect(d).toBeCloseTo(60, 0);
    });

    it('1° longitude at 60° latitude ≈ 30 NM (cosine correction)', () => {
        const d = distNM(60, 0, 60, 1);
        // cos(60°) = 0.5, so ~30 NM
        expect(d).toBeGreaterThan(25);
        expect(d).toBeLessThan(35);
    });

    it('is symmetric', () => {
        const d1 = distNM(-33.868, 151.209, -33.9, 151.25);
        const d2 = distNM(-33.9, 151.25, -33.868, 151.209);
        expect(d1).toBeCloseTo(d2, 6);
    });

    it('short harbor distance ≈ correct (Moreton Bay ~5 NM)', () => {
        // Redcliffe to Deception Bay: ~5 NM
        const d = distNM(-27.2277, 153.1044, -27.16, 153.1);
        expect(d).toBeGreaterThan(3);
        expect(d).toBeLessThan(7);
    });
});

// ── Depth Classification ──

describe('classifyDepth', () => {
    const draft = 2.0; // 2m draft vessel

    it('classifies land (depth >= 0)', () => {
        expect(classifyDepth(0, draft)).toBe('land');
        expect(classifyDepth(5, draft)).toBe('land');
        expect(classifyDepth(100, draft)).toBe('land');
    });

    it('classifies safe depth (> 3× draft)', () => {
        // 3× draft = 6m, so -7m (7m below surface) = safe
        expect(classifyDepth(-7, draft)).toBe('safe');
        expect(classifyDepth(-20, draft)).toBe('safe');
        expect(classifyDepth(-100, draft)).toBe('safe');
    });

    it('classifies caution depth (between 1.5× and 3× draft)', () => {
        // 1.5× draft = 3m, 3× draft = 6m
        // -4m (4m depth) = caution
        expect(classifyDepth(-4, draft)).toBe('caution');
        expect(classifyDepth(-5, draft)).toBe('caution');
    });

    it('classifies danger depth (< 1.5× draft)', () => {
        // 1.5× draft = 3m, -2m (2m depth) = danger
        expect(classifyDepth(-2, draft)).toBe('danger');
        expect(classifyDepth(-1, draft)).toBe('danger');
        expect(classifyDepth(-0.5, draft)).toBe('danger');
    });

    it('boundary: exactly 3× draft is caution (not safe)', () => {
        // -6 → abs = 6, 6 > 6 is false, 6 > 3 is true → caution
        expect(classifyDepth(-6, draft)).toBe('caution');
    });

    it('boundary: exactly 1.5× draft is danger (not caution)', () => {
        // -3 → abs = 3, 3 > 6 is false, 3 > 3 is false → danger
        expect(classifyDepth(-3, draft)).toBe('danger');
    });

    it('works with larger vessel draft', () => {
        const deepDraft = 5.0;
        // 3× = 15m, 1.5× = 7.5m
        expect(classifyDepth(-20, deepDraft)).toBe('safe');
        expect(classifyDepth(-10, deepDraft)).toBe('caution');
        expect(classifyDepth(-5, deepDraft)).toBe('danger');
    });
});

// ── Channel Routing (Integration) ──

describe('routeChannel', () => {
    // Mock the GebcoDepthService
    vi.mock('../services/GebcoDepthService', () => ({
        GebcoDepthService: {
            queryDepths: vi.fn().mockResolvedValue([]),
        },
    }));

    const emptySeamarks: SeamarkCollection = {
        type: 'FeatureCollection',
        features: [],
        metadata: {
            center: [153, -27.5],
            radiusNM: 5,
            fetchedAt: new Date().toISOString(),
            count: 0,
            ialaRegion: 'A' as const,
        },
    };

    const makeMark = (lat: number, lon: number, name: string, cls: SeamarkClass): SeamarkFeature => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { name, _class: cls, _type: 'buoy' },
    });

    it('returns direct route when no seamarks available', async () => {
        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, emptySeamarks);

        expect(result.seamarkAssisted).toBe(false);
        expect(result.waypoints.length).toBe(2);
        expect(result.waypoints[0].lat).toBe(-27.23);
        expect(result.waypoints[1].lat).toBe(-27.15);
    });

    it('total distance is positive and reasonable', async () => {
        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, emptySeamarks);
        expect(result.totalDistanceNM).toBeGreaterThan(0);
        expect(result.totalDistanceNM).toBeLessThan(50);
    });

    it('routes through nav marks when available', async () => {
        const seamarks: SeamarkCollection = {
            ...emptySeamarks,
            features: [
                makeMark(-27.22, 153.1, 'Mark 1', 'port'),
                makeMark(-27.2, 153.1, 'Mark 2', 'starboard'),
                makeMark(-27.18, 153.1, 'Channel Exit', 'safe_water'),
            ],
            metadata: { ...emptySeamarks.metadata, count: 3 },
        };

        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, seamarks);

        expect(result.seamarkAssisted).toBe(true);
        expect(result.waypoints.length).toBeGreaterThan(2);
        expect(result.seamarkCount).toBe(3);
    });

    it('returns IALA region from seamarks metadata', async () => {
        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, emptySeamarks);
        expect(result.ialaRegion).toBe('A');
    });

    it('ignores marks outside NAV_CLASSES', async () => {
        const seamarks: SeamarkCollection = {
            ...emptySeamarks,
            features: [makeMark(-27.22, 153.1, 'Mooring', 'mooring'), makeMark(-27.2, 153.1, 'Anchorage', 'anchorage')],
            metadata: { ...emptySeamarks.metadata, count: 2 },
        };

        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, seamarks);

        // Non-NAV marks should result in direct route
        expect(result.seamarkAssisted).toBe(false);
        expect(result.waypoints.length).toBe(2);
    });

    it('ignores marks outside search radius', async () => {
        const farMark: SeamarkCollection = {
            ...emptySeamarks,
            features: [
                // Mark 50 NM away — should be out of SEARCH_RADIUS_NM (5.0)
                makeMark(-26.0, 153.1, 'Far Mark', 'port'),
            ],
            metadata: { ...emptySeamarks.metadata, count: 1 },
        };

        const result = await routeChannel(-27.23, 153.1, -27.15, 153.1, 2.0, farMark);
        expect(result.seamarkAssisted).toBe(false);
    });
});

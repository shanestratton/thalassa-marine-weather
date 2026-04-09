/**
 * Isochrone Pruning — Unit tests
 *
 * Tests sector-based wavefront pruning with fallback candidates.
 */

import { describe, it, expect } from 'vitest';
import { pruneWavefrontWithFallbacks } from '../services/isochrone/pruning';
import type { IsochroneNode } from '../services/isochrone/types';

// ── Helper ──────────────────────────────────────────────────────

function makeEntry(lat: number, lon: number, distToDest: number, distance = 0) {
    const node: IsochroneNode = {
        lat,
        lon,
        timeHours: 0,
        bearing: 0,
        speed: 6,
        tws: 12,
        twa: 90,
        parentIndex: null,
        distance,
    };
    return { node, distToDest };
}

// ── Tests ───────────────────────────────────────────────────────

describe('pruneWavefrontWithFallbacks', () => {
    const origin = { lat: 0, lon: 0 };
    const destination = { lat: -10, lon: 10 };

    it('returns empty for empty input', () => {
        const result = pruneWavefrontWithFallbacks([], origin, destination, 36);
        expect(result).toEqual([]);
    });

    it('returns sectors with ranked nodes', () => {
        const entries = [
            makeEntry(1, 0, 100), // North
            makeEntry(-1, 0, 80), // South
            makeEntry(0, 1, 90), // East
            makeEntry(0, -1, 110), // West
        ];
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 4);
        expect(result.length).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(4); // max 4 sectors
    });

    it('each sector contains up to 3 candidates', () => {
        // Many entries in same direction (all north)
        const entries = Array.from({ length: 10 }, (_, i) => makeEntry(1 + i * 0.01, 0.01 * i, 100 - i));
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 36);
        for (const sector of result) {
            expect(sector.length).toBeLessThanOrEqual(3);
        }
    });

    it('ranks by distance to destination (closest first)', () => {
        const entries = [
            makeEntry(1, 0, 200),
            makeEntry(1.01, 0, 50), // Closest
            makeEntry(1.02, 0, 150),
        ];
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 36);
        // The first candidate in the matching sector should be the closest
        const sector = result.find((s) => s.length > 0);
        if (sector && sector.length > 1) {
            expect(sector[0].lat).toBeCloseTo(1.01, 1);
        }
    });

    it('exploration mode ranks by negative distance from origin', () => {
        const entries = [
            makeEntry(1, 0, 200, 10), // Short distance from origin
            makeEntry(1.01, 0, 50, 100), // Long distance from origin (best in explore mode)
        ];
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 36, true);
        const sector = result.find((s) => s.length > 0);
        if (sector && sector.length > 1) {
            // In exploration mode, the node with greater distance should rank first
            expect(sector[0].distance).toBe(100);
        }
    });

    it('distributes entries across sectors by bearing', () => {
        const entries = [
            makeEntry(5, 0, 100), // Due north
            makeEntry(0, 5, 100), // Due east
            makeEntry(-5, 0, 100), // Due south
            makeEntry(0, -5, 100), // Due west
        ];
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 4);
        // Should have 4 sectors (one per cardinal direction)
        expect(result.length).toBe(4);
    });
});

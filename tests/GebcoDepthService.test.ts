/**
 * GebcoDepthService — Unit tests
 *
 * Tests the pure functions (classifyDepth, depthCostPenalty)
 * and the caching/query behaviour with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GebcoDepthService } from '../services/GebcoDepthService';

// ── classifyDepth ────────────────────────────────────────────

describe('GebcoDepthService.classifyDepth', () => {
    const draft = 2.0; // 2m vessel draft

    it('returns null for null depth', () => {
        expect(GebcoDepthService.classifyDepth(null, draft)).toBeNull();
    });

    it('returns "land" for positive depth (above sea level)', () => {
        expect(GebcoDepthService.classifyDepth(0, draft)).toBe('land');
        expect(GebcoDepthService.classifyDepth(5, draft)).toBe('land');
        expect(GebcoDepthService.classifyDepth(100, draft)).toBe('land');
    });

    it('returns "danger" for depth ≤ 1.5× draft', () => {
        // 1.5 × 2.0 = 3.0m → depth of -3.0 or shallower = danger
        expect(GebcoDepthService.classifyDepth(-2, draft)).toBe('danger');
        expect(GebcoDepthService.classifyDepth(-3, draft)).toBe('danger');
    });

    it('returns "caution" for depth between 1.5× and 3× draft', () => {
        // 1.5 × 2.0 = 3.0m, 3 × 2.0 = 6.0m
        expect(GebcoDepthService.classifyDepth(-4, draft)).toBe('caution');
        expect(GebcoDepthService.classifyDepth(-5, draft)).toBe('caution');
        expect(GebcoDepthService.classifyDepth(-6, draft)).toBe('caution');
    });

    it('returns "safe" for depth > 3× draft', () => {
        // 3 × 2.0 = 6.0m → depth deeper than -6m = safe
        expect(GebcoDepthService.classifyDepth(-7, draft)).toBe('safe');
        expect(GebcoDepthService.classifyDepth(-100, draft)).toBe('safe');
        expect(GebcoDepthService.classifyDepth(-5000, draft)).toBe('safe');
    });
});

// ── depthCostPenalty ─────────────────────────────────────────

describe('GebcoDepthService.depthCostPenalty', () => {
    const draft = 2.0;

    it('returns 1.2 (slight caution) for null depth', () => {
        expect(GebcoDepthService.depthCostPenalty(null, draft)).toBe(1.2);
    });

    it('returns Infinity for land', () => {
        expect(GebcoDepthService.depthCostPenalty(0, draft)).toBe(Infinity);
        expect(GebcoDepthService.depthCostPenalty(10, draft)).toBe(Infinity);
    });

    it('returns 10.0 for very shallow (≤ 1.5× draft)', () => {
        expect(GebcoDepthService.depthCostPenalty(-2, draft)).toBe(10.0);
    });

    it('returns 3.0 for tight (1.5-2× draft)', () => {
        expect(GebcoDepthService.depthCostPenalty(-3.5, draft)).toBe(3.0);
    });

    it('returns 1.5 for getting shallow (2-3× draft)', () => {
        expect(GebcoDepthService.depthCostPenalty(-5, draft)).toBe(1.5);
    });

    it('returns 1.0 for deep water (> 3× draft)', () => {
        expect(GebcoDepthService.depthCostPenalty(-10, draft)).toBe(1.0);
        expect(GebcoDepthService.depthCostPenalty(-5000, draft)).toBe(1.0);
    });

    it('penalty increases monotonically as depth decreases', () => {
        const depths = [-100, -10, -5, -3.5, -2, -1];
        const penalties = depths.map((d) => GebcoDepthService.depthCostPenalty(d, draft));
        for (let i = 1; i < penalties.length; i++) {
            expect(penalties[i]).toBeGreaterThanOrEqual(penalties[i - 1]);
        }
    });
});

// ── Cache ────────────────────────────────────────────────────

describe('GebcoDepthService cache', () => {
    beforeEach(() => {
        GebcoDepthService.clearCache();
    });

    it('starts with empty cache', () => {
        expect(GebcoDepthService.cacheSize).toBe(0);
    });

    it('clears cache completely', () => {
        GebcoDepthService.clearCache();
        expect(GebcoDepthService.cacheSize).toBe(0);
    });
});

// ── queryDepths / queryDepth ─────────────────────────────────

describe('GebcoDepthService.queryDepths', () => {
    beforeEach(() => {
        GebcoDepthService.clearCache();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(
                JSON.stringify({
                    depths: [{ lat: -33.868, lon: 151.209, depth_m: -45 }],
                    elapsed_ms: 50,
                    source: 'gebco',
                }),
                { status: 200 },
            );
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns empty array for empty input', async () => {
        const result = await GebcoDepthService.queryDepths([]);
        expect(result).toEqual([]);
    });

    it('fetches depth for a single point', async () => {
        const result = await GebcoDepthService.queryDepths([{ lat: -33.868, lon: 151.209 }]);
        expect(result.length).toBe(1);
        expect(result[0].depth_m).toBe(-45);
    });

    it('caches results and reuses them', async () => {
        // First call — fetches from network
        await GebcoDepthService.queryDepths([{ lat: -33.868, lon: 151.209 }]);
        expect(GebcoDepthService.cacheSize).toBeGreaterThan(0);

        // Record fetch call count before second query
        const callCountBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

        // Second call — should use cache, not fetch again
        await GebcoDepthService.queryDepths([{ lat: -33.868, lon: 151.209 }]);
        const callCountAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

        // No additional fetch calls for the cached point
        expect(callCountAfter).toBe(callCountBefore);
    });

    it('handles fetch errors gracefully', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

        const result = await GebcoDepthService.queryDepths([{ lat: 0, lon: 0 }]);
        expect(result.length).toBe(1);
        expect(result[0].depth_m).toBeNull();
    });
});

// ── queryRouteDepths ─────────────────────────────────────────

describe('GebcoDepthService.queryRouteDepths', () => {
    beforeEach(() => {
        GebcoDepthService.clearCache();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
            const body = JSON.parse((options?.body as string) || '{}');
            const depths = (body.points || []).map((p: { lat: number; lon: number }) => ({
                lat: p.lat,
                lon: p.lon,
                depth_m: -50,
            }));
            return new Response(JSON.stringify({ depths, elapsed_ms: 10, source: 'gebco' }), { status: 200 });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('decimates route if > maxPoints', async () => {
        const route = Array.from({ length: 500 }, (_, i) => ({
            lat: -33 + i * 0.01,
            lon: 151 + i * 0.01,
        }));

        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await GebcoDepthService.queryRouteDepths(route, 50);

        // The fetch should have been called with ≤ 50 points
        if (fetchSpy.mock.calls.length > 0) {
            const body = JSON.parse((fetchSpy.mock.calls[0][1]?.body as string) || '{}');
            expect(body.points.length).toBeLessThanOrEqual(50);
        }
    });
});

// ── queryDepth (convenience) ─────────────────────────────────

describe('GebcoDepthService.queryDepth', () => {
    beforeEach(() => {
        GebcoDepthService.clearCache();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(
                JSON.stringify({
                    depths: [{ lat: 0, lon: 0, depth_m: -100 }],
                    elapsed_ms: 5,
                    source: 'gebco',
                }),
                { status: 200 },
            );
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns depth value for a single point', async () => {
        const depth = await GebcoDepthService.queryDepth(0, 0);
        expect(depth).toBe(-100);
    });
});

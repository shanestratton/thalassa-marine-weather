/**
 * GebcoDepthService — Unit tests
 *
 * Tests the pure functions (classifyDepth, depthCostPenalty)
 * and the caching/query behaviour with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GebcoDepthService, alignDepthsToRequest } from '../services/GebcoDepthService';

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

// ── alignDepthsToRequest (positional-trust guard, closing audit #5) ─────

describe('alignDepthsToRequest', () => {
    const A = { lat: -33.0, lon: 151.0 }; // deep
    const B = { lat: -27.0, lon: 153.0 }; // shoal

    it('passes depths through when the echoed coords match the request', () => {
        const out = alignDepthsToRequest(
            [A, B],
            [
                { ...A, depth_m: -500 },
                { ...B, depth_m: -2 },
            ],
        );
        expect(out).toEqual([
            { ...A, depth_m: -500 },
            { ...B, depth_m: -2 },
        ]);
    });

    it('REORDERED response → every misaligned point drops to no-data (a shoal never inherits a neighbour depth)', () => {
        // The fail-dangerous case: response reversed. Positional trust would
        // give the shoal point B the deep -500. The guard rejects both.
        const out = alignDepthsToRequest(
            [A, B],
            [
                { ...B, depth_m: -2 },
                { ...A, depth_m: -500 },
            ],
        );
        expect(out).toEqual([
            { ...A, depth_m: null },
            { ...B, depth_m: null },
        ]);
    });

    it('keeps aligned points and drops only the swapped one (partial reorder)', () => {
        const C = { lat: -30.0, lon: 152.0 };
        const out = alignDepthsToRequest(
            [A, B, C],
            [
                { ...A, depth_m: -500 }, // aligned
                { ...C, depth_m: -9 }, // B slot carries C's coords → drop
                { ...B, depth_m: -2 }, // C slot carries B's coords → drop
            ],
        );
        expect(out[0]).toEqual({ ...A, depth_m: -500 });
        expect(out[1]).toEqual({ ...B, depth_m: null });
        expect(out[2]).toEqual({ ...C, depth_m: null });
    });

    it('a short response drops the missing tail to no-data, stays aligned to the request', () => {
        const out = alignDepthsToRequest([A, B], [{ ...A, depth_m: -500 }]);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ ...A, depth_m: -500 });
        expect(out[1]).toEqual({ ...B, depth_m: null });
    });

    it('an aligned point with a null/NaN depth passes null through (legit no-data, not corruption)', () => {
        const out = alignDepthsToRequest(
            [A, B],
            [
                { ...A, depth_m: null as unknown as number },
                { ...B, depth_m: NaN },
            ],
        );
        expect(out).toEqual([
            { ...A, depth_m: null },
            { ...B, depth_m: null },
        ]);
    });
});

describe('GebcoDepthService.queryDepths — positional-trust guard end-to-end', () => {
    const shoal = { lat: -27.4, lon: 153.1 };
    const deep = { lat: -34.5, lon: 151.5 };

    beforeEach(() => GebcoDepthService.clearCache());
    afterEach(() => vi.restoreAllMocks());

    it('a REORDERED edge response never assigns the deep depth to the shoal sample', async () => {
        // Edge echoes coords but hands them back reversed; positional trust
        // would give the shoal -500 (safe). The guard drops both to no-data.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(
                JSON.stringify({
                    depths: [
                        { ...deep, depth_m: -500 },
                        { ...shoal, depth_m: -1 },
                    ],
                    elapsed_ms: 5,
                    source: 'gebco',
                }),
                { status: 200 },
            );
        });
        const out = await GebcoDepthService.queryDepths([shoal, deep]);
        expect(out[0]).toMatchObject({ ...shoal, depth_m: null }); // shoal NOT given -500
        expect(out[1]).toMatchObject({ ...deep, depth_m: null });
        // …and nothing misaligned got cached under the wrong key.
        expect(GebcoDepthService.cacheSize).toBe(0);
    });
});

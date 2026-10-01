/**
 * The lead-graph shadow never changes the route (Phase 3, 2026-10-01).
 *
 * tryInshoreRoute runs searchLeadGraph on every local route and logs one
 * 'LEAD SHADOW' line; promotion is Phase 3b. LEAD_GRAPH_SHADOW_ENABLED is a
 * compile-time const, so "shadow on vs off" is pinned two ways: the route is
 * identical whether the shadow succeeds or throws, and the shadow block's
 * source can neither return nor assign the route.
 *
 * Synthetic only: open water with an island and a charted leading line
 * (NAVLNE CATNAV 3) near 161.5E, 31.5S — the soloMarkDiscYieldsToDeepWater
 * harness's mocks.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';

const h = vi.hoisted(() => ({
    cells: [] as { id: string; bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    throwShadow: false,
    calls: 0,
    compiles: 0,
}));

vi.mock('../../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    cellsForBBox: (b: [number, number, number, number]) =>
        h.cells.filter((c) => !(c.bbox[2] < b[0] || c.bbox[0] > b[2] || c.bbox[3] < b[1] || c.bbox[1] > b[3])),
    listCells: () => h.cells,
}));
vi.mock('../../services/enc/EncCellStore', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadCellGeoJSON: async (id: string) => h.blobs.get(id) ?? null,
}));
vi.mock('../../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getOsmRouteOverlay: async () => null,
}));
vi.mock('../../services/ntmRouting', () => ({
    activeNtmZonesFor: async () => ({ features: [], tracklines: [] }),
}));
vi.mock('../../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/lowBridges', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLowBridges: async () => [],
}));
vi.mock('../../services/TideHeightService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    fetchTideCurve: async () => null,
}));
vi.mock('../../services/seaway/leadGraphSearch', async (original) => {
    const mod = await original<typeof import('../../services/seaway/leadGraphSearch')>();
    return {
        ...mod,
        searchLeadGraph: (input: Parameters<typeof mod.searchLeadGraph>[0]) => {
            h.calls++;
            if (h.throwShadow) throw new Error('synthetic shadow failure');
            return mod.searchLeadGraph(input);
        },
    };
});

vi.mock('../../services/routing/leadCompiler', async (original) => {
    const mod = await original<typeof import('../../services/routing/leadCompiler')>();
    return {
        ...mod,
        cachedLeadGraph: (...args: Parameters<typeof mod.cachedLeadGraph>) => {
            h.compiles++;
            return mod.cachedLeadGraph(...args);
        },
    };
});

import { tryInshoreRoute } from '../../services/InshoreRouter';
import { leadGraphForView } from '../../services/routing/leadOverlayData';

const LON0 = 161.5;
const LAT0 = -31.5;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): [number, number] => [LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT];
function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
    return {
        type: 'Polygon',
        coordinates: [[ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]],
    };
}
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const E = 15_000;

function scene(cellId = 'OC-99-SYN165'): void {
    const blob = {
        cellId,
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 12_000,
        bbox: [...ll(-E, -E), ...ll(E, E)] as [number, number, number, number],
        layers: {
            LNDARE: fc([{ type: 'Feature', properties: { acronym: 'LNDARE' }, geometry: rect(-600, 400, 600, 1600) }]),
            DEPARE: fc([
                {
                    type: 'Feature',
                    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
                    geometry: rect(-E, -E, E, 400),
                },
                {
                    type: 'Feature',
                    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
                    geometry: rect(-E, 1600, E, E),
                },
                {
                    type: 'Feature',
                    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
                    geometry: rect(-E, 400, -600, 1600),
                },
                {
                    type: 'Feature',
                    properties: { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 },
                    geometry: rect(600, 400, E, 1600),
                },
            ]),
            // A charted leading line along the approach, south of the island.
            NAVLNE: fc([
                {
                    type: 'Feature',
                    properties: { acronym: 'NAVLNE', CATNAV: 3, OBJNAM: 'Synthetic leads', RCID: 7 },
                    geometry: { type: 'LineString', coordinates: [ll(-2500, 0), ll(2500, 0)] },
                },
            ]),
        },
    };
    h.cells = [
        {
            id: blob.cellId,
            sourceHO: blob.sourceHO,
            edition: blob.edition,
            issued: blob.issued,
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox: blob.bbox,
            geojsonPath: `enc/${blob.cellId}.json`,
            hazardCount: 5_000,
            usage: 'navigation',
        } as never,
    ];
    h.blobs.clear();
    h.blobs.set(blob.cellId, blob);
}

async function route() {
    const [fromLon, fromLat] = ll(-3000, 0);
    const [toLon, toLat] = ll(3000, 2000);
    const res = await tryInshoreRoute({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, 2.4, 18, 'safest', {
        tideCeilings: [],
    });
    if (!res || !('polyline' in res)) throw new Error(`no route: ${JSON.stringify(res)}`);
    const { elapsedMs: _elapsed, ...rest } = res;
    return rest;
}

afterEach(() => {
    h.throwShadow = false;
    vi.restoreAllMocks();
});

describe('lead-graph shadow wiring', { timeout: 120_000 }, () => {
    // Review fix-up (2026-10-01): the shadow reads the lead graph only when
    // the chart overlay has already compiled it for these charts — the normal
    // case is that it has not (the overlay is off by default), and then it
    // reads no cell, compiles nothing and awaits nothing.
    it('with the lead graph not compiled: logs no-graph, compiles nothing, searches nothing', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
        const warn = vi.spyOn(console, 'warn');
        // A cell of its own, so no other test's compile is in the cache.
        scene('OC-99-SYN166');
        h.calls = 0;
        h.compiles = 0;
        await route();
        expect(h.compiles, 'the shadow compiled a lead graph').toBe(0);
        expect(h.calls).toBe(0);
        const line = warn.mock.calls.map((args) => String(args.join(' '))).find((l) => l.includes('LEAD SHADOW:'));
        expect(line).toContain('LEAD SHADOW: no-graph');
    });

    it('returns the identical route whether the shadow succeeds or throws', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
        const warn = vi.spyOn(console, 'warn');
        scene();
        // The overlay compiled the lead graph for these charts (as when the
        // skipper has the leads layer on).
        const [w, s] = ll(-E, -E);
        const [e, n] = ll(E, E);
        expect(await leadGraphForView([w, s, e, n], 2.4, false, 18)).not.toBeNull();
        h.calls = 0;
        const withShadow = await route();
        expect(h.calls).toBe(1);
        const line = warn.mock.calls.map((args) => String(args.join(' '))).find((l) => l.includes('LEAD SHADOW:'));
        // It rode the route's own cached grid (a miss would read 'no-grid').
        expect(line).toBeDefined();
        expect(line).not.toContain('no-grid');
        process.stdout.write(`\n${line}\n`);
        h.throwShadow = true;
        const thrown = await route();
        expect(h.calls).toBe(2);
        expect(
            warn.mock.calls.some((args) =>
                String(args.join(' ')).includes('LEAD SHADOW: failed (route unaffected): synthetic shadow failure'),
            ),
        ).toBe(true);
        expect(JSON.stringify(thrown)).toBe(JSON.stringify(withShadow));
    });

    it('the shadow block can neither return nor assign the route', () => {
        const src = readFileSync('services/InshoreRouter.ts', 'utf8');
        expect(src).toContain('const LEAD_GRAPH_SHADOW_ENABLED = true;');
        const start = src.indexOf('// ── Lead-graph SHADOW (Phase 3, 2026-10-01)');
        const end = src.indexOf('// ── Seaway SHADOW (masterplan Phase 12)');
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const block = src.slice(start, end);
        expect(block).toContain('if (LEAD_GRAPH_SHADOW_ENABLED && !routedOnCloud) {');
        expect(block).toMatch(/try \{[\s\S]*\} catch \(err\) \{/);
        expect(block).not.toMatch(/\breturn\b/);
        expect(block).not.toMatch(/\bresult\s*=[^=]/);
        expect(block).not.toMatch(/promotedSeawayRoute/);
        // Cache-only and synchronous (2026-10-01 review): no await, so a
        // finished route is never held for the watchdog to discard.
        expect(block.replace(/\/\/.*$/gm, '')).not.toMatch(/\bawait\b/);
        expect(block).toContain('peekLeadGraphForView(');
        expect(block).not.toMatch(/(?<!peek)leadGraphForView\(/);
    });
});

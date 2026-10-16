import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { Feature } from 'geojson';
const state = vi.hoisted(() => ({
    cells: [] as EncCell[],
    blobs: new Map<string, EncConversionResult>(),
    reads: [] as { bounds: number[]; purpose?: string }[],
    genericReads: 0,
    fail: false,
    stale: false,
    hold: null as Promise<void> | null,
    bytes: 100_000,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    cellsForBBox: (box: number[]) =>
        state.cells.filter(
            (c) => !(c.bbox[2] < box[0] || c.bbox[0] > box[2] || c.bbox[3] < box[1] || c.bbox[1] > box[3]),
        ),
}));
vi.mock('../services/enc/EncCellStore', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadCellGeoJSON: async (id: string) => {
        state.genericReads++;
        return structuredClone(state.blobs.get(id) ?? null);
    },
}));
vi.mock('../services/enc/noaaPackageWindow', () => ({
    loadNoaaPackageCohort: async (
        cells: EncCell[],
        bounds: [number, number, number, number],
        assertCurrent: () => void,
        purpose?: 'leads',
    ) => {
        const { reserveNoaaResident } = await import('../services/enc/EncCellStore');
        const { noaaFeatureBounds, noaaPartIntersects, noaaLeadDependency } =
            await import('../services/enc/noaaPackageContract');
        const { getAuthIdentityScope, isAuthIdentityScopeCurrent } = await import('../services/authIdentityScope');
        const scope = getAuthIdentityScope(),
            lease = reserveNoaaResident(state.bytes);
        const authority = () => {
            if (state.stale || !isAuthIdentityScopeCurrent(scope)) throw Error('Changed chart account/revision');
        };
        const check = () => {
            assertCurrent();
            authority();
        };
        state.reads.push({ bounds, purpose });
        try {
            if (state.hold) await state.hold;
            check();
            if (state.fail) throw Error('Missing package part');
            const blobs = new Map(
                cells.map((cell) => {
                    const source = structuredClone(state.blobs.get(cell.id)!);
                    for (const [layer, fc] of Object.entries(source.layers))
                        if (fc)
                            fc.features = fc.features.filter(
                                (f) =>
                                    (purpose === 'leads' && noaaLeadDependency(layer)) ||
                                    noaaPartIntersects(noaaFeatureBounds(f), bounds),
                            );
                    return [cell.id, source] as const;
                }),
            );
            return {
                blobs,
                check,
                authority,
                bytes: state.bytes,
                release: () => {
                    blobs.clear();
                    lease.release();
                },
            };
        } catch (error) {
            lease.release();
            throw error;
        }
    },
}));
import { leadGraphForView, peekLeadGraphForView } from '../services/routing/leadOverlayData';
import {
    cachedLeadGraph,
    clearLeadGraphCache,
    compileLeadGraph,
    leadGraphCurrent,
    mergeLeadCells,
    retainLeadGraph,
    type LeadGraph,
} from '../services/routing/leadCompiler';
import { noaaResidentBytes } from '../services/enc/EncCellStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const fc = (features: Feature[]) => ({ type: 'FeatureCollection' as const, features });
const polygon = (
    west: number,
    south: number,
    east: number,
    north: number,
    properties: Record<string, unknown>,
): Feature => ({
    type: 'Feature',
    properties,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ],
        ],
    },
});
const track: Feature = {
    type: 'Feature',
    properties: { acronym: 'RECTRC', rcid: 123, CATTRK: 1, TRAFIC: 4, OBJNAM: 'Synthetic track' },
    geometry: {
        type: 'LineString',
        coordinates: [
            [-29.99, 40.5],
            [-29.5, 40.5],
        ],
    },
};
const view: [number, number, number, number] = [-29.91, 40.49, -29.89, 40.51];
const inner: [number, number, number, number] = [view[0] - 0.02, view[1] - 0.02, view[2] + 0.02, view[3] + 0.02];
const source = (): EncConversionResult => ({
    cellId: 'US5SYN01',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-01',
    bbox: [-30, 40, -29.4, 41],
    layers: {
        DEPARE: fc([polygon(-30, 40, -29.4, 41, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 })]),
        M_QUAL: fc([polygon(-30, 40, -29.4, 41, { acronym: 'M_QUAL', CATZOC: 1 })]),
        RECTRC: fc([track]),
        BRIDGE: fc([]),
        PONTON: fc([]),
        CBLOHD: fc([]),
        PIPOHD: fc([]),
        CONVYR: fc([]),
    },
});
function install(blob = source()) {
    const cell = {
        id: blob.cellId,
        sourceHO: 'US',
        edition: 1,
        issued: '2026-10-01',
        bbox: blob.bbox,
        sizeBytes: 1000,
        noaaPackage: { owner: 'anonymous', manifestSha256: 'a'.repeat(64), path: 'synthetic' },
    } as EncCell;
    state.cells = [cell];
    state.blobs.set(cell.id, blob);
    return cell;
}
const stable = (graph: LeadGraph | null) => graph && { ...graph, compileMs: 0 };
beforeEach(() => {
    clearLeadGraphCache();
    Object.assign(state, {
        cells: [],
        blobs: new Map(),
        reads: [],
        genericReads: 0,
        fail: false,
        stale: false,
        hold: null,
        bytes: 100_000,
    });
});
afterEach(() => {
    clearLeadGraphCache();
    setAuthIdentityScope(null);
    expect(noaaResidentBytes()).toBe(0);
});

it('keys both peek and compile by the exact complete window, so one cell cannot serve another window', async () => {
    install();
    const first = await leadGraphForView(view, 2, false, 18);
    expect(peekLeadGraphForView(view, 2, false, 18)).toBe(first);
    const secondView: [number, number, number, number] = [-29.7, 40.49, -29.68, 40.51];
    expect(peekLeadGraphForView(secondView, 2, false, 18)).toBeNull();
    const second = await leadGraphForView(secondView, 2, false, 18);
    expect(second).not.toBe(first);
    expect(peekLeadGraphForView(secondView, 2, false, 18)).toBe(second);
    expect(peekLeadGraphForView(view, 2, false, 18)).toBeNull();
    expect(state.genericReads).toBe(0);
});

it('clips derived crossing lines to the verified inner envelope without changing chart records or reconnecting outside segments', async () => {
    const blob = source();
    // The whole source line reaches this danger well outside the fetched
    // window. Its unverified outside portion must never be drawn clear.
    blob.layers.OBSTRN = fc([
        {
            type: 'Feature',
            properties: { acronym: 'OBSTRN', VALSOU: 1 },
            geometry: { type: 'Point', coordinates: [-29.7, 40.5] },
        },
    ]);
    install(blob);
    const original = JSON.stringify(blob);
    const graph = await leadGraphForView(view, 2, false, 18);
    expect(graph?.edges.length).toBeGreaterThan(0);
    for (const e of graph!.edges)
        for (const p of e.coordinates) {
            expect(p[0]).toBeGreaterThanOrEqual(inner[0]);
            expect(p[0]).toBeLessThanOrEqual(inner[2]);
            expect(p[1]).toBeGreaterThanOrEqual(inner[1]);
            expect(p[1]).toBeLessThanOrEqual(inner[3]);
        }
    expect(graph?.edges[0].rcids).toEqual([123]);
    expect(JSON.stringify(blob)).toBe(original);
    expect(graph?.edges.every((e) => e.depth.class === 'clear')).toBe(true);
});

it('keeps outside excursions disconnected in the derived graph and refuses invalid windows', () => {
    const blob = source();
    const crossing: Feature = {
        ...track,
        geometry: {
            type: 'LineString',
            coordinates: [
                [-29.92, 40.5],
                [-29.9, 40.6],
                [-29.88, 40.5],
            ],
        },
    };
    const layers = { ...blob.layers, RECTRC: fc([crossing]) };
    const graph = compileLeadGraph(layers, 2, { window: inner });
    expect(graph.spans).toHaveLength(2);
    expect(graph.networks).toHaveLength(2);
    expect(() => compileLeadGraph(layers, 2, { window: [-181, 40, -29, 41] })).toThrow('Invalid verified');
});

it('reads the75m halo: a hazard just beyond the clip edge still prevents a clear lead', async () => {
    const blob = source();
    blob.layers.OBSTRN = fc([
        {
            type: 'Feature',
            properties: { acronym: 'OBSTRN', rcid: 8, VALSOU: 1 },
            geometry: { type: 'Point', coordinates: [inner[2] + 0.0003, 40.5] },
        },
    ]);
    install(blob);
    const graph = await leadGraphForView(view, 2, false, 18);
    expect(state.reads[0].bounds[2]).toBeGreaterThan(inner[2] + 0.0003);
    expect(state.reads[0].purpose).toBe('leads');
    expect(graph?.edges[0].depth.review).toContain('hazard');
    expect(graph?.edges[0].depth.class).toBe('needs-review');
});

it('matches the same-cohort monolith algorithm for full mark groups, depth, land and structures', async () => {
    const blob = source();
    blob.layers.BOYLAT = fc(
        Array.from({ length: 40 }, (_, i) => ({
            type: 'Feature',
            properties: { acronym: 'BOYLAT', CATLAM: i % 2 ? 2 : 1, OBJNAM: `SYN${i + 1}`, rcid: 500 + i },
            geometry: {
                type: 'Point',
                coordinates: [-29.98 + Math.floor(i / 2) * 0.01, 40.5 + (i % 2 ? -0.001 : 0.001)],
            },
        })),
    );
    blob.layers.LNDARE = fc([polygon(-29.925, 40.4998, -29.924, 40.5002, { acronym: 'LNDARE' })]);
    blob.layers.BRIDGE = fc([
        {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', VERCLR: 8, rcid: 999 },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-29.9, 40.499],
                    [-29.9, 40.501],
                ],
            },
        },
    ]);
    const cell = install(blob);
    const reference = compileLeadGraph(
        mergeLeadCells([{ id: cell.id, bbox: cell.bbox, layers: blob.layers }]),
        2,
        { window: inner },
        0.5,
        { airDraftM: 18 },
    );
    const actual = await leadGraphForView(view, 2, false, 18);
    expect(stable(actual)).toEqual(stable(reference));
    expect(actual?.spans.some((s) => s.kind === 'channel')).toBe(true);
    expect(actual?.edges.some((e) => e.depth.class === 'blocked')).toBe(true);
    expect(actual?.clippedLandM).toBeGreaterThan(0);
});

it('failure/cap refuses the whole mixed cohort rather than exposing a coarse-only graph', async () => {
    const cell = install();
    state.cells.push({ ...cell, id: 'US2SYN01', noaaPackage: undefined });
    state.fail = true;
    await expect(leadGraphForView(view, 2)).rejects.toThrow('Missing');
    expect(state.genericReads).toBe(0);
    state.fail = false;
    await expect(leadGraphForView(view, 2)).rejects.toThrow('complete chart cohort');
    expect(peekLeadGraphForView(view, 2)).toBeNull();
    state.cells = Array.from({ length: 15 }, (_, i) => ({ ...cell, id: `US5SYN${i}` }));
    expect(await leadGraphForView(view, 2)).toBeNull();
    expect(state.reads).toHaveLength(2);
});

it('refuses a raw-plus-derived handoff over16MiB without publishing an unowned cache entry', async () => {
    install();
    state.bytes = 16 * 1024 * 1024 - 1000;
    await expect(leadGraphForView(view, 2)).rejects.toThrow('resident view limit');
    expect(noaaResidentBytes()).toBe(0);
    expect(peekLeadGraphForView(view, 2)).toBeNull();
});

it('cache clear/4-span8-graph eviction never frees an active displayed or queued-route borrower', async () => {
    install();
    const graph = await leadGraphForView(view, 2);
    const graphBytes = new TextEncoder().encode(JSON.stringify(graph)).length;
    const display = retainLeadGraph(graph),
        queued = retainLeadGraph(graph);
    clearLeadGraphCache();
    expect(noaaResidentBytes()).toBe(graphBytes);
    display();
    display();
    expect(noaaResidentBytes()).toBe(graphBytes);
    queued();
    expect(noaaResidentBytes()).toBe(0);
    expect(() => retainLeadGraph(graph)).toThrow('no longer current');
    // Fill the existing caches with ordinary graphs: ownership must also
    // end after BOTH span and graph references have really evicted.
    const owned = await leadGraphForView(view, 2);
    for (let i = 0; i < 8; i++) cachedLeadGraph([`ordinary-${i}`], 2, () => ({}));
    expect(leadGraphCurrent(owned)).toBe(false);
    expect(noaaResidentBytes()).toBe(0);
});

it.each(['cancel', 'account', 'revision'] as const)('a late%s read cannot activate or leak a graph', async (mode) => {
    install();
    let finish!: () => void;
    state.hold = new Promise<void>((r) => (finish = r));
    const stop = new AbortController();
    const pending = leadGraphForView(view, 2, false, 18, () => stop.signal.throwIfAborted());
    await vi.waitFor(() => expect(state.reads).toHaveLength(1));
    expect(noaaResidentBytes()).toBe(100_000);
    if (mode === 'cancel') stop.abort();
    else if (mode === 'account') setAuthIdentityScope('different-synthetic-account');
    else state.stale = true;
    const refused = expect(pending).rejects.toThrow();
    finish();
    await refused;
    expect(peekLeadGraphForView(view, 2, false, 18)).toBeNull();
    expect(noaaResidentBytes()).toBe(0);
});

/**
 * Phase 1 review (safety + integrity, medium): the chart overlay's lead-graph
 * cache (services/routing/leadOverlayData.ts → leadCompiler's cache).
 *
 *  • The cache was keyed on cell ids only. S-57 cell ids stay the same across
 *    new editions and same-edition updates, so after a chart update the
 *    overlay kept drawing the superseded leads (a lead withdrawn by a Notice
 *    to Mariners, say) until eviction or an app restart. The key is now the
 *    cells' content identity (encCellContentIdentity: edition, issue date,
 *    size, update number, content hash).
 *  • peek used every capped id while the store used only the ids whose blob
 *    loaded, so one missing blob made every pan reload every blob. Peek and
 *    store now use the same list.
 *  • An assumed draft reaches the classifier (nothing is clear against a
 *    guessed keel).
 */
import type { Feature } from 'geojson';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const meta = vi.hoisted(() => ({ cells: [] as Record<string, unknown>[] }));
vi.mock('../services/enc/EncCellMetadata', () => ({ cellsForBBox: () => meta.cells }));
const store = vi.hoisted(() => ({ blobs: new Map<string, unknown>(), loads: [] as string[] }));
vi.mock('../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: async (id: string) => {
        store.loads.push(id);
        return store.blobs.get(id) ?? null;
    },
}));

import { clearLeadGraphCache } from '../services/routing/leadCompiler';
import { leadGraphForView } from '../services/routing/leadOverlayData';

const X = 148.1;
const Y = -20.1;
const BBOX: [number, number, number, number] = [X, Y, X + 0.1, Y + 0.1];
const VIEW: [number, number, number, number] = [X + 0.02, Y + 0.02, X + 0.08, Y + 0.08];

const band = (d: number): Feature => ({
    type: 'Feature',
    properties: { acronym: 'DEPARE', DRVAL1: d, DRVAL2: d + 5 },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [X, Y],
                [X + 0.1, Y],
                [X + 0.1, Y + 0.1],
                [X, Y + 0.1],
                [X, Y],
            ],
        ],
    },
});
const track = (y: number): Feature => ({
    type: 'Feature',
    properties: { acronym: 'RECTRC', rcid: 1, CATTRK: 1, TRAFIC: 4 },
    geometry: {
        type: 'LineString',
        coordinates: [
            [X + 0.02, Y + y],
            [X + 0.08, Y + y],
        ],
    },
});
/** A re-extracted cell's blob: the structure layers carried empty ("extracted,
 * none charted"), so a deep track can be clear. */
const STRUCTURES = {
    BRIDGE: { features: [] },
    PONTON: { features: [] },
    CBLOHD: { features: [] },
    PIPOHD: { features: [] },
    CONVYR: { features: [] },
};
/** An A1 survey zone over the cell: without a graded M_QUAL nothing is clear
 * ('survey not graded', owner decision 4, 2026-09-30). */
const GRADED_ZONE: Feature = { ...band(0), properties: { acronym: 'M_QUAL', CATZOC: 1 } };
const blob = (depth: number, y = 0.05, structures = true) => ({
    layers: {
        DEPARE: { features: [band(depth)] },
        RECTRC: { features: [track(y)] },
        M_QUAL: { features: [GRADED_ZONE] },
        ...(structures ? STRUCTURES : {}),
    },
});
const cell = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    bbox: BBOX,
    edition: 1,
    issued: '20260101',
    sizeBytes: 1000,
    ...extra,
});

beforeEach(() => {
    clearLeadGraphCache();
    store.blobs.clear();
    store.loads = [];
});

describe('leadGraphForView — the overlay cache follows chart content, not just cell ids', () => {
    it('a new edition of the same cell recompiles: withdrawn geometry and new depths are not drawn from the old compile', async () => {
        meta.cells = [cell('AU5X')];
        store.blobs.set('AU5X', blob(10));
        const v1 = await leadGraphForView(VIEW, 2);
        expect(v1?.edges[0].depth.class).toBe('clear');

        // New edition: the track moved and the band is now charted at 1 m.
        meta.cells = [cell('AU5X', { edition: 2, issued: '20260901' })];
        store.blobs.set('AU5X', blob(1, 0.06));
        const v2 = await leadGraphForView(VIEW, 2);
        expect(v2).not.toBe(v1);
        expect(v2?.edges[0].depth.class).toBe('needs-tide');
        expect(v2?.edges[0].coordinates[0][1]).toBeCloseTo(Y + 0.06, 9);
    });

    it('a same-edition update (update number or content hash) recompiles too', async () => {
        meta.cells = [cell('AU5X')];
        store.blobs.set('AU5X', blob(10));
        const a = await leadGraphForView(VIEW, 2);
        meta.cells = [cell('AU5X', { updateNumber: 3 })];
        store.blobs.set('AU5X', blob(1));
        const b = await leadGraphForView(VIEW, 2);
        expect(b).not.toBe(a);
        expect(b?.edges[0].depth.class).toBe('needs-tide');
        meta.cells = [cell('AU5X', { updateNumber: 3, contentSha256: 'abc' })];
        store.blobs.set('AU5X', blob(10));
        const c = await leadGraphForView(VIEW, 2);
        expect(c?.edges[0].depth.class).toBe('clear');
    });

    it('unchanged content is one compile: panning within it reads no blob again', async () => {
        meta.cells = [cell('AU5X')];
        store.blobs.set('AU5X', blob(10));
        const a = await leadGraphForView(VIEW, 2);
        const loads = store.loads.length;
        const b = await leadGraphForView(VIEW, 2);
        expect(b).toBe(a);
        expect(store.loads.length).toBe(loads);
    });

    it('a cell whose blob is missing does not make every pan reload every blob', async () => {
        meta.cells = [cell('AU5X'), cell('AU5Y')];
        store.blobs.set('AU5X', blob(10)); // AU5Y has metadata but no blob
        const a = await leadGraphForView(VIEW, 2);
        expect(a?.spans).toHaveLength(1);
        const loads = store.loads.length;
        expect(loads).toBe(2);
        const b = await leadGraphForView(VIEW, 2);
        expect(b).toBe(a);
        expect(store.loads.length).toBe(loads);
    });

    // Phase 1 review (medium, 2026-09-29): neither cell pipeline extracts
    // BRIDGE, PONTON or overhead lines yet, so a blob as installed today
    // carries none of them. Through the overlay's own data path, a deep track
    // in such a cell is never drawn clear, and says why.
    it('a cell as the pipelines emit it today (no structure layers) draws nothing clear', async () => {
        meta.cells = [cell('AU5X')];
        store.blobs.set('AU5X', blob(10, 0.05, false));
        const g = await leadGraphForView(VIEW, 2);
        expect(g?.edges.length).toBeGreaterThan(0);
        expect(g?.edges.every((e) => e.depth.class !== 'clear')).toBe(true);
        expect(g?.edges[0].depth).toMatchObject({ class: 'needs-review', review: ['structures-unknown'] });
    });

    it('an assumed draft reaches the classifier: nothing is clear', async () => {
        meta.cells = [cell('AU5X')];
        store.blobs.set('AU5X', blob(10));
        const measured = await leadGraphForView(VIEW, 2.5, false);
        expect(measured?.edges[0].depth.class).toBe('clear');
        const guessed = await leadGraphForView(VIEW, 2.5, true);
        expect(guessed?.edges.every((e) => e.depth.class !== 'clear')).toBe(true);
        expect(guessed?.edges[0].depth.review).toContain('draft-not-set');
    });

    // Part B (owner decisions 2026-09-29/30): a bridge on a lead is read
    // against the vessel's air draft, through the overlay's own data path.
    it('the air draft reaches the classifier: a bridge clears one mast and blocks another', async () => {
        const bridge: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', rcid: 9, VERCLR: 25 },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [X + 0.05, Y + 0.049],
                    [X + 0.05, Y + 0.051],
                ],
            },
        };
        meta.cells = [cell('AU5X')];
        const b = blob(10);
        store.blobs.set('AU5X', { layers: { ...b.layers, BRIDGE: { features: [bridge] } } });
        const eighteen = await leadGraphForView(VIEW, 2, false, 18);
        expect(eighteen?.edges[0].depth).toMatchObject({ class: 'needs-review', review: ['bridge'] });
        // A 25 m bridge under a 30 m mast blocks the lead (owner decision 5;
        // round 2, 2026-09-30 — it was amber 'needs-review').
        const thirty = await leadGraphForView(VIEW, 2, false, 30);
        expect(thirty?.edges[0].depth).toMatchObject({ class: 'blocked', review: ['bridge-clearance'] });
        const unset = await leadGraphForView(VIEW, 2, false, null);
        expect(unset?.edges[0].depth.review).toEqual(['bridge-clearance', 'air-draft-not-set']);
        // And each air draft is its own cached class: asking again is a hit.
        expect(await leadGraphForView(VIEW, 2, false, 18)).toBe(eighteen);
    });
});

/**
 * Round 2 (2026-09-30): the overlay ranks each cell the way the router does —
 * by its compilation scale (the blob's nativeScale) or its S-57 name's usage
 * band — so decision 1 reads the same on the chart as in the route. A coarse
 * cell's land paint over a finer cell's 10 m band leaves the lead on water
 * ('needs tide · a coarser chart shows land'); two cells that do not say
 * their scale leave the land paint standing and the lead is cut away.
 */
describe("leadGraphForView — the cell's own scale decides decision 1, as in the router", () => {
    const land: Feature = {
        type: 'Feature',
        properties: { acronym: 'LNDARE', rcid: 5 },
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [X + 0.03, Y + 0.04],
                    [X + 0.07, Y + 0.04],
                    [X + 0.07, Y + 0.06],
                    [X + 0.03, Y + 0.06],
                    [X + 0.03, Y + 0.04],
                ],
            ],
        },
    };
    function install(landScale: Record<string, unknown>, bandScale: Record<string, unknown>) {
        // 9× the fine cell's area: under the 16× scale-shadow drop, so the
        // coarse land paint reaches the merge (as it does at a cell seam).
        meta.cells = [cell('COARSE', { bbox: [X - 0.1, Y - 0.1, X + 0.2, Y + 0.2] }), cell('FINE')];
        store.blobs.set('COARSE', { ...landScale, layers: { LNDARE: { features: [land] }, ...STRUCTURES } });
        store.blobs.set('FINE', { ...bandScale, ...blob(10) });
    }

    it('a finer compilation scale beats the coarser land paint: the lead stays, needs tide', async () => {
        install({ nativeScale: 350_001 }, { nativeScale: 12_000 });
        const g = await leadGraphForView(VIEW, 2, false, 18);
        expect(g?.edges[0].depth).toMatchObject({ class: 'needs-tide' });
        expect(g?.edges[0].depth.review[0]).toBe('land-paint');
    });

    it('cells that do not say their scale: the land paint stands and the lead is cut there', async () => {
        install({}, {});
        const g = await leadGraphForView(VIEW, 2, false, 18);
        expect(g?.spans.every((s) => s.depth.landConflictM === undefined || s.depth.landConflictM === 0)).toBe(true);
        expect(g?.clippedLandM).toBeGreaterThan(1_000);
    });
});

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
};
const blob = (depth: number, y = 0.05, structures = true) => ({
    layers: {
        DEPARE: { features: [band(depth)] },
        RECTRC: { features: [track(y)] },
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
});

/**
 * LOCAL-ONLY real-chart check for item f, scale-ordered chart drawing (Shane
 * 2026-10-02: "we should overlay the charts the other way so the water is
 * drawn over the land"). Cid Harbour, between Cid Island and Whitsunday
 * Island: at (148.935, -20.255) the 1:3,500,000 overview AU130120 paints the
 * harbour as land, AU230140 (1:1,500,000) charts 0–30 m and AU421148
 * (1:90,000) charts 10–15 m. The map drew the overview's brown land over the
 * harbour, soundings and all.
 *
 * The real display merge runs over the Pi's three cells and the real chart
 * layer is mounted on a recording map (tests/helpers/encLayerStack); at the
 * harbour spot, the TOP painted area fill must be AU421148's water. And every
 * AU421148 island in the overview cells' water must paint over that water.
 *
 * THE REPO IS PUBLIC: no chart data lives here. Point THALASSA_REAL_CELLS_DIR
 * at a scratch folder holding the Pi's enc-charts index.json and the three
 * `<cellId>.json` blobs (OC-61-021031, OC-61-041032, OC-61-841124), copied
 * read-only and deleted after. Without it the suite skips.
 *
 *   THALASSA_REAL_CELLS_DIR=… TZ=UTC NODE_OPTIONS=--max-old-space-size=4096 \
 *     npx vitest run tests/repro/scaleOrderedDrawingRealCells.local.test.ts --maxWorkers=1
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Feature, MultiPolygon, Polygon } from 'geojson';

const DIR = process.env.THALASSA_REAL_CELLS_DIR ?? '';
const HAVE_DATA = DIR !== '' && existsSync(join(DIR, 'index.json'));
const CELLS = ['OC-61-021031', 'OC-61-041032', 'OC-61-841124'];

const h = vi.hoisted(() => ({
    cells: [] as { id: string; bbox: [number, number, number, number] }[],
    blobs: new Map(),
}));

vi.mock('../../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    listCells: () => h.cells,
    getCell: (id: string) => h.cells.find((c) => c.id === id),
    cellsForBBox: () => h.cells,
    displayCellsForBBox: () => h.cells,
    getVersion: () => 1,
    subscribe: () => () => undefined,
}));
vi.mock('../../services/enc/EncCellStore', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadCellGeoJSON: async (id: string) => h.blobs.get(id) ?? null,
    readCellRaw: async (id: string) =>
        h.blobs.has(id) ? { kind: 'cached' as const, blob: h.blobs.get(id) } : { kind: 'missing' as const },
    blobCacheStats: () => ({ entries: 0, textMB: 0 }),
}));
vi.mock('../../components/map/seamarkIcons', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    registerSeamarkIcons: async () => undefined,
}));

import { parseAndCacheCellText } from '../../services/enc/EncCellStore';
import { validateLocalEncPack } from '../../services/enc/localEncPackImport';
import { getMergedVectorData } from '../../services/enc/EncHazardService';
import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { pointInGeometry } from '../../services/engine/geometry';
import { paintedAt, recordingMap } from '../helpers/encLayerStack';

const CID_HARBOUR = { lon: 148.935, lat: -20.255 };

interface IndexRow {
    cellId: string;
    sourceHO: string;
    sourceCellId?: string;
    edition: number;
    updateNumber?: number;
    issued: string;
    installedAt: string;
    bbox: [number, number, number, number];
    featureCount: number;
    sizeBytes: number;
}

function loadCells(): void {
    const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')) as { cells: IndexRow[] };
    for (const c of index.cells.filter((row) => CELLS.includes(row.cellId))) {
        const cell = validateLocalEncPack(JSON.parse(readFileSync(join(DIR, `${c.cellId}.json`), 'utf8'))).cells[0];
        const blob = parseAndCacheCellText(c.cellId, JSON.stringify(cell));
        if (!blob) throw new Error(`${c.cellId} did not parse`);
        h.blobs.set(c.cellId, blob);
        h.cells.push({
            id: c.cellId,
            sourceHO: c.sourceHO,
            sourceCellId: c.sourceCellId,
            edition: c.edition,
            updateNumber: c.updateNumber,
            issued: c.issued,
            importedAt: c.installedAt,
            bbox: c.bbox,
            geojsonPath: `enc/${c.cellId}.json`,
            hazardCount: c.featureCount,
            usage: 'navigation',
            sizeBytes: c.sizeBytes,
        } as never);
    }
}

const isArea = (f: Feature): f is Feature<Polygon | MultiPolygon> =>
    f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon';
const centroidish = (g: Polygon | MultiPolygon): [number, number] => {
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
    let x = 0;
    let y = 0;
    for (const [lon, lat] of ring) {
        x += lon;
        y += lat;
    }
    return [x / ring.length, y / ring.length];
};

describe.skipIf(!HAVE_DATA)('scale-ordered drawing on the Pi’s Cid Harbour cells', () => {
    it('the 1:90,000 chart’s water is on top in Cid Harbour, and its islands over the overviews’ water', async () => {
        loadCells();
        expect(h.cells.map((c) => c.id).sort()).toEqual([...CELLS].sort());
        const merged = (await getMergedVectorData())!;
        const { map, layers } = recordingMap();
        mountEncVectorLayer(map, merged, {});

        // The phone's cost: which tier layers carry features at all (an empty
        // tier layer builds no bucket), and that each feature paints once.
        const perBand = (fcol: { features: Feature[] }) =>
            JSON.stringify(
                fcol.features.reduce<Record<string, number>>((acc, f) => {
                    const tier = String(f.properties?._drawTier);
                    acc[tier] = (acc[tier] ?? 0) + 1;
                    return acc;
                }, {}),
            );
        console.log(
            `[cid] features per draw tier: water ${perBand(merged.DEPARE)}, land ${perBand(merged.LNDARE)}, ` +
                `coast ${perBand(merged.COALNE)}; ENC layers ${layers.filter((l) => l.id.startsWith('enc-vec-')).length}`,
        );

        // Every area fill over the harbour spot, in paint order (bottom → top).
        const over = (source: string, fcol: { features: Feature[] }, kind: string) =>
            fcol.features
                .filter(isArea)
                .filter((f) => pointInGeometry(CID_HARBOUR.lon, CID_HARBOUR.lat, f.geometry))
                .map((f) => ({
                    at: paintedAt(layers, source, f),
                    kind,
                    cell: String(f.properties?._cellId),
                    tier: f.properties?._drawTier,
                    drval1: f.properties?.DRVAL1,
                }));
        const stack = [
            ...over(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'water'),
            ...over(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'land'),
        ].sort((a, b) => a.at[0] - b.at[0]);
        console.log(
            `[cid] fills over (${CID_HARBOUR.lon}, ${CID_HARBOUR.lat}), bottom → top: ` +
                stack
                    .map(
                        (s) =>
                            `${s.kind} ${s.cell} tier ${s.tier}${s.drval1 !== undefined ? ` DRVAL1 ${s.drval1}` : ''} @${s.at.join(',')}`,
                    )
                    .join(' | '),
        );
        for (const s of stack) expect(s.at).toHaveLength(1);
        const top = stack.at(-1)!;
        expect(top).toMatchObject({ kind: 'water', cell: 'OC-61-841124', tier: 5, drval1: 10 });
        expect(stack.some((s) => s.kind === 'land' && s.cell === 'OC-61-021031')).toBe(true);

        // AU421148's islands that lie in the overview cells' water: every one
        // paints over that water.
        const coarseWater = merged.DEPARE.features
            .filter(isArea)
            .filter((f) => f.properties?._cellId !== 'OC-61-841124');
        let islands = 0;
        for (const land of merged.LNDARE.features.filter(isArea)) {
            if (land.properties?._cellId !== 'OC-61-841124') continue;
            const [lon, lat] = centroidish(land.geometry);
            if (!pointInGeometry(lon, lat, land.geometry)) continue;
            const under = coarseWater.filter((w) => pointInGeometry(lon, lat, w.geometry));
            if (under.length === 0) continue;
            islands++;
            const landAt = paintedAt(layers, ENC_VEC_SRC.LNDARE, land)[0];
            for (const w of under) expect(landAt).toBeGreaterThan(paintedAt(layers, ENC_VEC_SRC.DEPARE, w)[0]);
        }
        console.log(`[cid] AU421148 islands in the overview cells' water, all drawn over it: ${islands}`);
        expect(islands).toBeGreaterThan(0);
    });
});

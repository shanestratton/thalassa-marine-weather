/**
 * Cell fineness ranks for the pi-cache corridor captures — so a fixture can be
 * merged the way production merges it.
 *
 * Owner decision 1 (2026-09-30): a coarse chart's land paint over a FINER
 * survey's never-drying band is shallow water, and only a strictly finer rank
 * beats land — an unranked LNDARE always stands. The router's merges now stamp
 * `_scaleRank` (services/enc/scaleShadow.ts cellFinenessRank) on LNDARE, DEPARE
 * and DRGARE. The corridor captures (tools/capture-corridor-fixture.mjs) carry
 * no rank and no cell id: the tool concatenates each cell's whole layers in
 * the order of `_meta.cells`. Merged as they are, every band under land paint
 * is "rank unknown", so all of it is land.
 *
 * This recovers which cell each LNDARE / DEPARE / DRGARE feature came from:
 *   • features of the two cells tests/fixtures/newport-enc-cells.json.gz holds
 *     whole (OC-61-10ENB5, OC-61-10RCS5) are matched exactly (rcid + geometry);
 *   • the rest fall between those anchors in `_meta.cells` order, and a drop in
 *     rcid inside a run starts the next cell (the extractor emits a cell's
 *     records in rcid order);
 *   • every feature must then lie inside its cell's extent, or this throws —
 *     a wrong guess fails loudly instead of ranking a feature by the wrong
 *     cell.
 * Each cell's rank is the router's (services/enc/scaleShadow.ts
 * cellFinenessRank) from the cell's real compilation scale in
 * CORRIDOR_CELL_SCALE below.
 * Scale-shadow drops are NOT applied: the fixture stays the same features,
 * now ranked.
 */
import type { Feature } from 'geojson';
import { cellFinenessRank, type CellScaleFacts } from '../../services/enc/scaleShadow';
import { encCell } from './encCells';

/**
 * What each captured cell says about its scale — the facts production ranks it
 * by: the compilation scale (the SENC header's native scale, on every blob the
 * extractor writes) and the S-57 dataset name. The captures kept neither, so
 * these are READ from the Pi's own store (round 3, 2026-09-30; read-only,
 * /opt/thalassa-pi-cache/enc-charts/index.json `sourceCellId` and each cell
 * blob's `nativeScale`, the editions installed 2026-09-27):
 *
 *   cell           S-57 name  native scale  edition / update   band
 *   OC-61-051031   AU130150   1:3,000,000   16 / 8 (2025-12)   1 overview
 *   OC-61-051032   AU230150   1:1,500,000   12 / 6 (2025-10)   2 general
 *   OC-61-351824   AU428153   1:90,000      43 / 0 (2026-09)   4 approach
 *   OC-61-10ENB5   AU5BNE01   1:12,000      17 / 0 (2026-09)   5 harbour
 *   OC-61-10RCS5   AU5SCR01   1:22,000       1 / 14 (2022-03)  5 harbour
 *
 * They replace the usage bands Phase 2a inferred from each cell's extent
 * (1, 2, 3, 4, 5 in that order), which had two wrong: the Moreton cell is
 * band 4 (approach, 1:90,000), not 3, and the Brisbane harbour cell 10ENB5 is
 * band 5 at 1:12,000 — FINER than the Scarborough cell 10RCS5 (1:22,000),
 * not a band coarser. A capture's editions can be older than these; the
 * compilation scale of a cell does not change between editions. A cell not
 * listed is unranked: production's "unknown".
 */
export const CORRIDOR_CELL_SCALE: Readonly<Record<string, CellScaleFacts>> = {
    'OC-61-051031': { nativeScale: 3_000_000, sourceCellId: 'AU130150' },
    'OC-61-051032': { nativeScale: 1_500_000, sourceCellId: 'AU230150' },
    'OC-61-351824': { nativeScale: 90_000, sourceCellId: 'AU428153' },
    'OC-61-10ENB5': { nativeScale: 12_000, sourceCellId: 'AU5BNE01' },
    'OC-61-10RCS5': { nativeScale: 22_000, sourceCellId: 'AU5SCR01' },
};

type BBox = [number, number, number, number];
const ANCHORS = ['OC-61-10ENB5', 'OC-61-10RCS5'] as const;
const RANKED_LAYERS = ['LNDARE', 'DEPARE', 'DRGARE'] as const;

const identity = (f: Feature): string =>
    `${(f.properties as { rcid?: unknown } | null)?.rcid}|${JSON.stringify((f.geometry as { coordinates?: unknown })?.coordinates)}`;

function extentOf(features: readonly Feature[]): BBox {
    const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') {
            b[0] = Math.min(b[0], c[0] as number);
            b[1] = Math.min(b[1], c[1] as number);
            b[2] = Math.max(b[2], c[0] as number);
            b[3] = Math.max(b[3], c[1] as number);
        } else for (const x of c) walk(x);
    };
    for (const f of features) walk((f.geometry as { coordinates?: unknown } | null)?.coordinates);
    return b;
}

export interface CorridorCellRanks {
    /** The cell each ranked-layer feature came from (by feature identity). */
    cellOf: Map<Feature, string>;
    /** cellFinenessRank per cell (null: the cell does not say — unranked). */
    rank: Record<string, number | null>;
    /** Features per cell across LNDARE, DEPARE and DRGARE. */
    counts: Record<string, number>;
}

export function corridorCellRanks(
    order: readonly string[],
    cells: Record<string, { features: Feature[] } | undefined>,
): CorridorCellRanks {
    const anchorKeys = new Set<string>();
    const anchorBbox: Record<string, BBox> = {};
    for (const id of ANCHORS) {
        if (!order.includes(id)) continue;
        const c = encCell(id);
        const all: Feature[] = [];
        for (const [layer, fc] of Object.entries(c.layers)) {
            all.push(...fc.features);
            if ((RANKED_LAYERS as readonly string[]).includes(layer)) {
                for (const f of fc.features) anchorKeys.add(`${id}|${identity(f)}`);
            }
        }
        anchorBbox[id] = extentOf(all);
    }
    const anchorOf = (f: Feature): string | null => {
        const key = identity(f);
        for (const id of Object.keys(anchorBbox)) if (anchorKeys.has(`${id}|${key}`)) return id;
        return null;
    };
    /** The first cell after position `from` that is not an anchor. */
    const nextUnknown = (from: number): number => {
        let i = from + 1;
        while (i < order.length && order[i] in anchorBbox) i++;
        return i;
    };

    const cellOf = new Map<Feature, string>();
    for (const layer of RANKED_LAYERS) {
        let at = -1;
        let inAnchor = false;
        let lastRcid = -Infinity;
        for (const f of cells[layer]?.features ?? []) {
            const anchor = anchorOf(f);
            if (anchor) {
                const pos = order.indexOf(anchor);
                if (pos < at) throw new Error(`${layer}: ${anchor} features out of capture order`);
                at = pos;
                inAnchor = true;
                cellOf.set(f, anchor);
                continue;
            }
            const rcid = Number((f.properties as { rcid?: unknown } | null)?.rcid);
            if (at === -1 || inAnchor) {
                at = nextUnknown(at);
                inAnchor = false;
                lastRcid = -Infinity;
            } else if (rcid < lastRcid) {
                at = nextUnknown(at);
            }
            if (at >= order.length) throw new Error(`${layer}: more cell runs than _meta.cells lists`);
            lastRcid = rcid;
            cellOf.set(f, order[at]);
        }
    }

    const byCell = new Map<string, Feature[]>();
    for (const [f, id] of cellOf) byCell.set(id, [...(byCell.get(id) ?? []), f]);
    // A cell's extent: the anchors' whole-cell data; otherwise its LNDARE and
    // DEPARE, which tile a cell. Every feature — its DRGARE included — must
    // lie inside the cell it was given (a hair of slack for rounding).
    const tiles = new Set<Feature>([...(cells.LNDARE?.features ?? []), ...(cells.DEPARE?.features ?? [])]);
    const extent: Record<string, BBox> = {};
    for (const [id, fs] of byCell) extent[id] = anchorBbox[id] ?? extentOf(fs.filter((f) => tiles.has(f)));
    const EPS = 1e-6;
    for (const [f, id] of cellOf) {
        const b = extentOf([f]);
        const e = extent[id];
        if (b[0] < e[0] - EPS || b[1] < e[1] - EPS || b[2] > e[2] + EPS || b[3] > e[3] + EPS) {
            throw new Error(`feature rcid ${(f.properties as { rcid?: unknown } | null)?.rcid} lies outside ${id}`);
        }
    }
    const rank: Record<string, number | null> = {};
    const counts: Record<string, number> = {};
    for (const [id, fs] of byCell) {
        rank[id] = cellFinenessRank(CORRIDOR_CELL_SCALE[id]);
        counts[id] = fs.length;
    }
    return { cellOf, rank, counts };
}

/**
 * A copy of `layers` with LNDARE, DEPARE and DRGARE stamped the way the
 * router's merge stamps them (`_scaleRank`, `_cellId`), for the features that
 * came from the capture's cells; injected features (OSM water, marinas) stay
 * unranked, as in production. Features are copied, never mutated.
 */
export function withCorridorCellRanks<T extends Record<string, { features: Feature[] } | undefined>>(
    layers: T,
    ranks: CorridorCellRanks,
): T {
    const out: Record<string, unknown> = { ...layers };
    for (const layer of RANKED_LAYERS) {
        const fc = layers[layer];
        if (!fc) continue;
        out[layer] = {
            ...fc,
            features: fc.features.map((f) => {
                const id = ranks.cellOf.get(f);
                const rank = id ? ranks.rank[id] : null;
                return id
                    ? {
                          ...f,
                          properties: {
                              ...(f.properties ?? {}),
                              ...(rank === null ? {} : { _scaleRank: rank }),
                              _cellId: id,
                          },
                      }
                    : f;
            }),
        };
    }
    return out as T;
}

/**
 * Ranks for a corridor capture that does NOT list `_meta.cells` — the May 2026
 * clips (newport-rivergate, newport-tangalooma) behind the goldens, the
 * scorecard and the seaway corpus. Each S-57 LNDARE / DEPARE / DRGARE feature
 * (it carries an `acronym`) is matched to the SAME feature in a whole-cell
 * reference capture that does list its cells — layer, rcid, and a bbox equal
 * within 2e-5 deg (the clips round coordinates to 5 dp) — and takes that
 * cell's rank (corridorCellRanks on the reference). A chart feature that
 * matches nothing stays UNRANKED, which is production's "unknown": its land
 * paint stands and its band beats nothing. A feature matching two reference
 * features throws. Features without an acronym (the GMRT test pack, OSM
 * injections) are not chart cells' and stay unranked.
 *
 * Phase 2a review (2026-09-30): the corridor fixtures carried no ranks, so
 * owner decision 1 kept every land paint in them — no production merge does
 * that — and the goldens moved for a reason production never sees.
 */
export function corridorCellRanksByReference(
    cells: Record<string, { features: Feature[] } | undefined>,
    reference: { order: readonly string[]; cells: Record<string, { features: Feature[] } | undefined> },
): CorridorCellRanks & { matched: number; unmatched: number } {
    const refRanks = corridorCellRanks(reference.order, reference.cells);
    const TOL = 2e-5;
    const byKey = new Map<string, { bbox: BBox; cell: string }[]>();
    for (const layer of RANKED_LAYERS) {
        for (const f of reference.cells[layer]?.features ?? []) {
            const cell = refRanks.cellOf.get(f);
            if (!cell) continue;
            const key = `${layer}|${(f.properties as { rcid?: unknown } | null)?.rcid}`;
            const list = byKey.get(key) ?? [];
            list.push({ bbox: extentOf([f]), cell });
            byKey.set(key, list);
        }
    }
    const cellOf = new Map<Feature, string>();
    let matched = 0;
    let unmatched = 0;
    for (const layer of RANKED_LAYERS) {
        for (const f of cells[layer]?.features ?? []) {
            const props = f.properties as { acronym?: unknown; rcid?: unknown } | null;
            if (typeof props?.acronym !== 'string') continue;
            const b = extentOf([f]);
            const hits = (byKey.get(`${layer}|${props.rcid}`) ?? []).filter((c) =>
                c.bbox.every((v, i) => Math.abs(v - b[i]) < TOL),
            );
            if (hits.length > 1 && new Set(hits.map((h) => h.cell)).size > 1) {
                throw new Error(
                    `${layer} rcid ${props.rcid}: matches features of ${hits.map((h) => h.cell).join(', ')}`,
                );
            }
            if (hits.length === 0) {
                unmatched++;
                continue;
            }
            cellOf.set(f, hits[0].cell);
            matched++;
        }
    }
    const counts: Record<string, number> = {};
    for (const id of cellOf.values()) counts[id] = (counts[id] ?? 0) + 1;
    return { cellOf, rank: refRanks.rank, counts, matched, unmatched };
}

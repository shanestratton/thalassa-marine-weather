/**
 * The layer contract a converted ENC cell meets on the Pi, whichever path
 * produced it (the ogr2ogr .000 upload here; the SENC extractor mirrors it in
 * tools/senc-extractor/src/s57Classes.ts — pi-cache deploys standalone and
 * cannot import from there).
 *
 * Part B (inshore router, 2026-09-30): the app's lead review
 * (services/routing/leadReview.ts LEAD_REQUIRED_STRUCTURE_LAYERS) and router
 * (services/routing/overheadClearance.ts) need the bridge and overhead
 * clearance layers. A cell that charts none of them must still CARRY them, as
 * empty collections ("extracted, none charted"); a missing key means "not
 * extracted", and then no lead there is ever clear.
 */

/** Mirrors EXTRACTOR_SCHEMA (tools/senc-extractor/src/s57Classes.ts): the
 * converter output schema recorded on each cell as `extractorSchema`. A
 * newer schema replaces an older conversion of the same chart revision in
 * the chart store (encChartStore.publishChartDelivery); never the reverse.
 *   2 — BRIDGE / PONTON / CBLOHD / PIPOHD / CONVYR, always emitted (CONVYR
 *       joined in round 2, 2026-09-30, before anything deployed). */
export const ENC_CONVERSION_SCHEMA = 2;

/** Mirrors ALWAYS_EMITTED_CLASSES in the extractor. */
export const ENC_ALWAYS_EMITTED_LAYERS = ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR'] as const;

type FeatureCollectionLike = { type: 'FeatureCollection'; features: unknown[] };

/** One ogr2ogr layer run: its collection; 'absent' — the cell has no such
 * layer (GDAL "Cannot find"); null — the output could not be read. */
export type OgrLayerOutcome = FeatureCollectionLike | 'absent' | null;

/**
 * Per-layer feature counts from an `ogrinfo -al -so` summary ("Layer name:
 * X" then "Feature Count: N"). Layers whose count is missing or negative
 * (unknown to the driver) are left out.
 */
export function ogrinfoLayerFeatureCounts(summary: string): Record<string, number> {
    const counts: Record<string, number> = {};
    let layer: string | null = null;
    for (const line of summary.split(/\r?\n/)) {
        const name = /^Layer name:\s*(\S+)/.exec(line);
        if (name) {
            layer = name[1];
            continue;
        }
        const count = /^Feature Count:\s*(-?\d+)/.exec(line);
        if (count && layer !== null) {
            const n = Number(count[1]);
            if (Number.isSafeInteger(n) && n >= 0) counts[layer] = n;
            layer = null;
        }
    }
    return counts;
}

/**
 * The cell's layers from its per-layer conversions: every collection read,
 * plus an EMPTY collection for each always-emitted layer the cell does not
 * have. A layer whose output could not be read stays absent — unknown, never
 * "none charted".
 *
 * `expectedCounts` (the cell's ogrinfo summary, ogrinfoLayerFeatureCounts)
 * holds the always-emitted STRUCTURE layers to the cell's own count (Phase 2a
 * review, 2026-09-30): ogr2ogr runs with -skipfailures, so a bridge that will
 * not convert is silently dropped and a short list would read as every bridge
 * in the cell. A structure layer with fewer features than the summary lists,
 * or one the summary cannot vouch for, stays absent — unknown.
 */
export function conversionLayers(
    outcomes: Record<string, OgrLayerOutcome>,
    expectedCounts?: Record<string, number>,
): {
    layers: Record<string, FeatureCollectionLike>;
    featureCount: number;
} {
    const layers: Record<string, FeatureCollectionLike> = {};
    let featureCount = 0;
    for (const [name, outcome] of Object.entries(outcomes)) {
        const structure = (ENC_ALWAYS_EMITTED_LAYERS as readonly string[]).includes(name);
        const expected = expectedCounts?.[name];
        if (outcome && outcome !== 'absent' && Array.isArray(outcome.features)) {
            if (structure && expectedCounts && (expected === undefined || outcome.features.length < expected)) continue;
            layers[name] = outcome;
            featureCount += outcome.features.length;
        } else if (outcome === 'absent' && structure) {
            if (expectedCounts && expected !== undefined && expected > 0) continue;
            layers[name] = { type: 'FeatureCollection', features: [] };
        }
    }
    return { layers, featureCount };
}

/**
 * The compilation scale denominator from the DSID record's CSV row (ogr2ogr
 * -f CSV of the DSID layer: upper-cased column index → value), or null when
 * the row has none or a nonsense one. The phone ranks a cell's survey
 * fineness by it (services/enc/scaleShadow.ts cellFinenessRank; round 2,
 * 2026-09-30): which chart's land paint a finer survey's water beats.
 */
export function dsidCompilationScale(colIdx: Record<string, number>, values: readonly string[]): number | null {
    const i = colIdx['DSPM_CSCL'] ?? colIdx['CSCL'] ?? -1;
    if (i < 0) return null;
    const raw = (values[i] ?? '').trim();
    if (raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 1 && v <= 1e9 ? v : null;
}

/**
 * The converter schema a stored blob `{cells: [cell]}` was produced by: the
 * cell's `extractorSchema`, 1 when absent (every conversion before the field
 * existed); null when the blob is not a single-cell batch or the field is
 * malformed — then no schema rule applies and a content difference at the
 * same revision stays a conflict.
 */
export function chartBlobExtractorSchema(raw: string | Buffer): number | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString());
    } catch {
        return null;
    }
    const cells = (parsed as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(cells) || cells.length !== 1 || !cells[0] || typeof cells[0] !== 'object') return null;
    const schema = (cells[0] as { extractorSchema?: unknown }).extractorSchema;
    if (schema === undefined) return 1;
    return Number.isSafeInteger(schema) && (schema as number) >= 1 ? (schema as number) : null;
}

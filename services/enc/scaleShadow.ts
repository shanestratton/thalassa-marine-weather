/**
 * scaleShadow — multi-scale ENC cell de-confliction ("the Tangalooma tan wall").
 *
 * ENC cells come in usage bands: a 30°×30° OVERVIEW cell (OC-61-051031 spans
 * the entire Coral Sea) charts Moreton Island as a crude blob that bulges
 * ~500 m over real water — over the Tangalooma anchorage and its wrecks —
 * while the 1°×1° DETAIL cell (OC-61-351824) carries the true coastline.
 * Rendering or routing the overview geometry where a detail cell covers the
 * same area paints land over water (Shane's "straight tan line") and feeds
 * the router fake LNDARE.
 *
 * Rule (standard ENC practice, bbox-approximated): a feature from a MUCH
 * coarser cell (bbox area ≥ RATIO× larger) is DROPPED when its own bbox lies
 * fully inside a finer cell's bbox — the finer cell owns that ground. Features
 * only partially inside are KEPT (no polygon clipping in v1): dropping them
 * would delete real land outside the detail coverage. Sibling cells of similar
 * scale never shadow each other (ratio guard), so tiled same-band cells are
 * untouched.
 */
import type { Feature } from 'geojson';
import type { EncCellContentIdentityInput } from './cellContentIdentity';
import { S57_CELL_NAME_PATTERN } from './types';

export interface CellExtent extends EncCellContentIdentityInput {
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    /** Keeps unsigned reference overlays from clipping/shadowing trusted
     * navigation geometry (and vice versa) in a shared display merge. */
    authority?: 'navigation' | 'reference';
}

/** Coarse-to-fine bbox-area ratio before a cell is shadowed by a finer one. */
export const SCALE_SHADOW_RATIO = 16;

/**
 * Glaze-clip shadow ratio — MUCH lower than SCALE_SHADOW_RATIO, and the
 * two must stay separate (adversarial review 2026-07-14): overlapping
 * cells closer than 16x produced an EMPTY shadow list, so the coarser
 * cell's glaze shipped unclipped and its SAFE-white (fill-opacity keyed
 * on DRVAL1 ≥ safetyDepth) painted over water the finer survey charts
 * as under-keel — the fine band's opacity-0 glaze can't occlude
 * translucent white stacked beneath it. White means "verified safe for
 * YOUR keel"; that's a safety-optics gap, not a cosmetic one.
 *
 * Why the base drop keeps 16x but the glaze clip can run at 2x:
 * dropping a base feature DELETES chart data, so it demands "much
 * coarser"; the glaze clip only removes coarse SAFE-white where a finer
 * survey charts SHALLOW water (< GLAZE_CLIP_MAX_SAFE_M — deep fine
 * bands never clip, which is what keeps the corridor staircase dead),
 * and wherever that shallow fine band is still keel-safe the fine
 * cell's own glaze repaints white. Genuinely safe water can never go
 * dark; the worst case is the strip-quantisation whisker of bare
 * imagery — the conservative direction.
 *
 * Why 2 and not 1: mutual shadowing needs ratio² ≤ 1, so any ratio > 1
 * makes the clip one-directional, and the 2x margin keeps same-band
 * grid siblings (near-equal bbox areas, routinely overlapping at their
 * seams) from nibbling whisker halos into each other's glaze.
 */
export const GLAZE_SHADOW_RATIO = 2;

const bboxArea = (b: [number, number, number, number]): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * DISPLAY ORDER from a cell's bbox area (the same smaller-is-finer
 * heuristic shadowingCells trusts): higher = smaller cell. The renderer's
 * merge stamps it on DEPARE for the satellite glaze's survey-competence
 * filter and sorts cells by it. It is NOT a survey scale and never decides
 * the router's questions: two cells compiled at the same scale differ by
 * any bbox unit here, and a degenerate bbox reads 0 like a real 1°×1° cell
 * (Phase 2a round 2, 2026-09-30). The router, the lead overlay and the land
 * audit rank cells with cellFinenessRank below.
 */
export function cellScaleRank(bbox: [number, number, number, number]): number {
    const a = bboxArea(bbox);
    if (!Number.isFinite(a) || a <= 0) return 0;
    return Math.max(-32000, Math.min(32000, Math.round(-Math.log10(a) * 100)));
}

// ── Survey fineness: what the router, the lead overlay and the audit compare ──

/**
 * What a cell says about its own scale. Every field optional; a cell that
 * says nothing has an UNKNOWN fineness.
 *   • nativeScale — the compilation scale denominator (S-57 DSPM CSCL). The
 *     SENC extractor carries the SENC header's native scale on every blob it
 *     writes (tools/senc-extractor geojsonEmitter), and the Pi's ogr2ogr path
 *     reads DSPM_CSCL from the DSID record.
 *   • sourceCellId / cellId — an S-57 dataset name (AU5..., US4GA22M): the
 *     digit after the producer code is the usage band, 1 overview … 6
 *     berthing. o-charts names (OC-61-10ENB5) carry no band.
 *   • usageBand — a known band given directly (fixtures, tests).
 */
export interface CellScaleFacts {
    nativeScale?: unknown;
    sourceCellId?: unknown;
    cellId?: unknown;
    usageBand?: unknown;
}

/** One usage band's span of the rank space (see cellFinenessRank). */
export const SCALE_BAND_STEP = 1000;

/** A real compilation scale denominator (1:1 … 1:1e9), or null. */
export function compilationScaleOf(raw: unknown): number | null {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 1e9 ? n : null;
}

/** The IHO usage band a compilation scale falls in (S-65 / S-57 navigational
 * purpose): 1 overview (< 1:1,500,000), 2 general, 3 coastal (< 1:90,000 …
 * 1:350,000), 4 approach, 5 harbour, 6 berthing (> 1:4,000). */
export function usageBandOfScale(cscl: number): number {
    if (cscl > 1_500_000) return 1;
    if (cscl > 350_000) return 2;
    if (cscl > 90_000) return 3;
    if (cscl > 22_000) return 4;
    if (cscl > 4_000) return 5;
    return 6;
}

/** The usage band an S-57 dataset name carries (AU5… → 5), or null — for an
 * o-charts identifier, a malformed name or a digit outside 1–6. */
export function usageBandOfName(name: unknown): number | null {
    if (typeof name !== 'string' || !S57_CELL_NAME_PATTERN.test(name)) return null;
    const band = Number(name[2]);
    return band >= 1 && band <= 6 ? band : null;
}

/**
 * The survey FINENESS RANK the router's merges stamp (`_scaleRank` on LNDARE,
 * DEPARE and DRGARE), the lead compiler's merge stamps, and the grid, the lead
 * land clip and the final land audit compare — or null when the cell does not
 * say (Phase 2a round 2, 2026-09-30). Higher is finer:
 *
 *   rank = usage band × SCALE_BAND_STEP + within-band step
 *
 * The band comes from the compilation scale when the cell gives one, else
 * from its S-57 name. The within-band step (1 … 999) exists only when the
 * compilation scale is known, and orders two cells of one band by it; a cell
 * known by its band alone has step 0 — "somewhere in this band". Its bbox
 * area plays no part: two sibling cells of one band once compared finer and
 * coarser on a one-unit bbox difference, which let an equal-scale band beat
 * land paint (owner decision 1 says it never does).
 */
export function cellFinenessRank(facts: CellScaleFacts | null | undefined): number | null {
    if (!facts) return null;
    const cscl = compilationScaleOf(facts.nativeScale);
    if (cscl !== null) {
        const step = Math.max(1, Math.min(SCALE_BAND_STEP - 1, Math.round(SCALE_BAND_STEP - 100 * Math.log10(cscl))));
        return usageBandOfScale(cscl) * SCALE_BAND_STEP + step;
    }
    const given = typeof facts.usageBand === 'number' ? facts.usageBand : NaN;
    const band =
        Number.isInteger(given) && given >= 1 && given <= 6
            ? given
            : (usageBandOfName(facts.sourceCellId) ?? usageBandOfName(facts.cellId));
    return band === null ? null : band * SCALE_BAND_STEP;
}

/** The IHO usage band (1 overview … 6 berthing) a fineness rank sits in. */
export function usageBandOfRank(rank: number): number {
    return Math.floor(rank / SCALE_BAND_STEP);
}
const bandOfRank = usageBandOfRank;
const stepOfRank = (rank: number): number => rank - bandOfRank(rank) * SCALE_BAND_STEP;

/**
 * Do two fineness ranks TIE (Phase 2a round-2 review, 2026-09-30)? The same
 * rank, or two ranks of one usage band where either is known by its band alone
 * (step 0): "somewhere in band 4" may be as fine as any band-4 cell whose
 * compilation scale is known, so neither is finer. Ranking the known one finer
 * let a CSCL-stamped 2 m band silently outrank a name-only band-4 chart that
 * says the same ground dries — and turned the coarser land paint into water.
 * At a tie the shallowest band owns the depth and a drying band makes the
 * claim drying, exactly as at an equal rank.
 */
export function surveyRanksTie(a: number, b: number): boolean {
    return a === b || (bandOfRank(a) === bandOfRank(b) && (stepOfRank(a) === 0 || stepOfRank(b) === 0));
}

/** >0: `a` is the strictly finer survey; <0: `b` is; 0: a tie (surveyRanksTie). */
export function compareSurveyRanks(a: number, b: number): number {
    return surveyRanksTie(a, b) ? 0 : a - b;
}

/** The rank that stands for two TIED ranks: the rank itself when they are
 * equal, else the band alone (step 0) — the weaker claim, so a later band of
 * the same usage band ties with it too and nothing reads finer than it is. */
export function tiedSurveyRank(a: number, b: number): number {
    return a === b ? a : bandOfRank(a) * SCALE_BAND_STEP;
}

/**
 * Which of the surveys covering one spot own it: the finest ranked one and
 * every rank tied with it (null = unranked: those own the spot only when no
 * ranked survey covers it). `rank` is the owners' weakest rank — the band
 * alone when a tied owner is known by its band alone — or null when only
 * unranked surveys (or none) cover it. The lead clip (chartedDepthAt, the
 * finest bands' land verdict) and the land audit (chartWaterEvidence) decide
 * ownership here; the grid applies the same tie per cell (navGrid Pass 1).
 */
export function finestSurveyOwners(
    ranks: readonly (number | null)[],
    opts: { unrankedToo?: boolean } = {},
): { owners: number[]; rank: number | null } {
    let max = -Infinity;
    for (const r of ranks) if (r !== null && r > max) max = r;
    if (max === -Infinity) return { owners: ranks.map((_, i) => i), rank: null };
    const owners: number[] = [];
    let rank = max;
    ranks.forEach((r, i) => {
        if (r === null) {
            if (opts.unrankedToo) owners.push(i);
            return;
        }
        if (!surveyRanksTie(r, max)) return;
        owners.push(i);
        rank = tiedSurveyRank(rank, r);
    });
    return { owners, rank };
}

/**
 * The surveys that own a spot's DEPTH and its survey GRADE: the finest ranked
 * one, every rank tied with it, and — unlike finestSurveyOwners — every
 * UNRANKED one too (round-3 review, 2026-09-30; Claude's call, told Shane
 * 2026-09-30). A survey whose scale is unknown may be a harbour survey finer than
 * any ranked one, so it is never out-surveyed: where it disagrees, the
 * shallowest depth and the worst grade win. Decision 1's land test keeps
 * finestSurveyOwners (an unknown rank there already fails safe to land).
 * `rank` is finestSurveyOwners' (the ranked owners' weakest, or null).
 */
export function depthSurveyOwners(ranks: readonly (number | null)[]): { owners: number[]; rank: number | null } {
    return finestSurveyOwners(ranks, { unrankedToo: true });
}

/**
 * A LAND rank as hard to beat as it can be: a land claim known by its band
 * alone could be the finest cell in that band, so it counts as the band's
 * top. Idempotent. The grid and the lead land clip keep the finest land
 * claim on a spot by this key.
 */
export function landRankKey(rank: number): number {
    return stepOfRank(rank) === 0 ? rank + SCALE_BAND_STEP - 1 : rank;
}

/**
 * Chart water under land paint (owner decision 1, 2026-09-30). A coarse
 * chart's LNDARE painted over a FINER survey's depth band that never dries
 * (DEPARE / DRGARE with a charted DRVAL1 ≥ 0) is shallow WATER — the finer
 * survey is the truth and the coarse cell's generalised coastline is not — but
 * never clear water: a lead through it is 'needs tide', and the grid keeps it
 * red caution. Everything else stays land:
 *   • a band charted at the SAME or a COARSER scale than the land paint —
 *     including a band in the same usage band as the land when either side's
 *     compilation scale is not known (round 2, 2026-09-30);
 *   • a drying band (DRVAL1 < 0), or one with no charted DRVAL1;
 *   • UNKNOWN fineness on either side (no `_scaleRank`): the comparison cannot
 *     be made, so the land paint stands (fail safe).
 * The lead compiler's land clip (services/routing/leadLandClip.ts), the
 * engine grid (services/engine/navGrid.ts Pass 2) and the final land audit
 * (services/engine/chartWaterEvidence.ts) all decide it here, so the overlay,
 * the router and the audit agree.
 *
 * Owner decision 12 (2026-10-02) is asked FIRST (overviewLandYields): an
 * overview or general chart's land paint (band 1–2) over a detailed chart's
 * (band 3+) never-drying depth area is no land at all, so this decision — and
 * its caution — is left to two charts of which the land paint is a detailed
 * one, and to the small-scale cells alone.
 */
export function finerBandBeatsLand(bandRank: number | null | undefined, landRank: number | null | undefined): boolean {
    if (
        typeof bandRank !== 'number' ||
        !Number.isFinite(bandRank) ||
        typeof landRank !== 'number' ||
        !Number.isFinite(landRank)
    ) {
        return false;
    }
    // A band known by its usage band alone could be the coarsest cell in it.
    return bandRank > landRankKey(landRank);
}

/**
 * The coarsest usage band that counts as a DETAILED chart: 3, coastal
 * (compilation scale 1:350,000 or finer, or a band-3+ cell name). Bands 1–2
 * (overview and general cells, e.g. 1:3,500,000 and 1:1,500,000) generalise
 * a coastline by hundreds of metres and leave small islands out. One rule for
 * owner decision 12 (overviewLandYields below) and the satellite land check's
 * scale rule (services/engine/chartWaterEvidence BACKSTOP_MIN_VOUCH_BAND).
 */
export const DETAILED_CHART_MIN_BAND = 3;

/** A fineness rank (cellFinenessRank) of a detailed chart — usage band 3 or
 * finer. An unranked (null) or malformed rank is not. */
export function isDetailedChartRank(rank: number | null | undefined): rank is number {
    return typeof rank === 'number' && Number.isFinite(rank) && usageBandOfRank(rank) >= DETAILED_CHART_MIN_BAND;
}

/**
 * Owner decision 12 (Shane, 2026-10-02, "Trust the detailed chart"): an
 * OVERVIEW or GENERAL chart's land paint (usage band 1–2) is IGNORED wherever
 * a DETAILED chart (band 3+) charts a depth area that never dries — it is not
 * land, not decision-1 'charts disagree' water, and the detailed chart's own
 * depth decides the spot (deep, or shallow and red / needs tide). Cid Harbour,
 * 2026-10-02: the 1:3,500,000 AU130120 paints the harbour land where the
 * 1:90,000 AU421148 charts 10–15 m, and the route was red "Danger reported".
 *
 *   • `bandRank` — the rank of the depth bands that OWN the spot (the finest
 *     survey and every band tied with it: finestSurveyOwners, the grid's
 *     bandRank); it must be a detailed chart's (isDetailedChartRank);
 *   • `bandsNeverDry` — every owning band charts a DRVAL1 ≥ 0 (bandNeverDries,
 *     decision 1's own test). A DRYING detailed band keeps decision 1: the
 *     land paint stands over it (Claude's call, fix-up 2026-10-03, reversing
 *     the first build's "drying bands count"). Ignored there, the land turned
 *     a charted drying bank into routable caution that the lead clip read as
 *     water — the Brisbane River mouth's ENB5 −2.2..0 under the overview's
 *     land took a 1,085 m lead crossing that HEAD blocks. An undepthed band
 *     gives no depth at all: the land stands too (fail safe);
 *   • `landRank` — the FINEST land paint on the spot (a rank, or its
 *     landRankKey: the usage band is the same). Only overview and general
 *     land (band ≤ 2) yields. A detailed chart's land — a small island the
 *     overview leaves out, or the 1:90,000 coastline over the 1:12,000
 *     Brisbane River survey — never does: decision 1 still decides between two
 *     detailed charts. Unranked land (unknown scale, such as an OSM
 *     breakwater) never yields either.
 *
 * Every spot it holds at is decision-1 water too (a band-3+ band is strictly
 * finer than band-1–2 land): decision 12 only takes that water's dispute
 * away. The grid (navGrid Pass 2), the lead land clip (leadLandClip) and the
 * land audits and the satellite check's chart evidence (chartWaterEvidence)
 * all ask it here, so the route, its colours, the leads and the audits agree.
 */
export function overviewLandYields(
    bandRank: number | null | undefined,
    bandsNeverDry: boolean,
    landRank: number | null | undefined,
): boolean {
    return (
        bandsNeverDry &&
        isDetailedChartRank(bandRank) &&
        typeof landRank === 'number' &&
        Number.isFinite(landRank) &&
        usageBandOfRank(landRank) < DETAILED_CHART_MIN_BAND
    );
}

/** A depth band that never dries (decision 1): a charted DRVAL1 ≥ 0. A
 * missing or malformed DRVAL1 is not evidence of water. */
export function bandNeverDries(drval1: number | null | undefined): boolean {
    return typeof drval1 === 'number' && Number.isFinite(drval1) && drval1 >= 0;
}

/** Stamp a cell's fineness (cellFinenessRank) onto its features as
 * `_scaleRank` — idempotent, the same value every merge. A cell that does not
 * say its scale leaves them unranked (any earlier stamp is removed): unknown
 * fineness, so its land paint stands and its bands beat nothing. */
export function stampScaleRank(features: readonly Feature[], facts: CellScaleFacts): void {
    const rank = cellFinenessRank(facts);
    for (const f of features) {
        const props = (f.properties ??= {}) as Record<string, unknown>;
        if (rank === null) {
            if ('_scaleRank' in props) delete props._scaleRank;
        } else if (props._scaleRank !== rank) props._scaleRank = rank;
    }
}

/** The finer cells that shadow `cell` (empty = nothing to drop, fast path). */
export function shadowingCells(cell: CellExtent, all: readonly CellExtent[], ratio = SCALE_SHADOW_RATIO): CellExtent[] {
    const a = bboxArea(cell.bbox);
    if (!Number.isFinite(a) || a <= 0) return [];
    return all.filter((o) => o.id !== cell.id && bboxArea(o.bbox) > 0 && a >= ratio * bboxArea(o.bbox));
}

/** Memoized per feature. Feature objects come from the LRU-cached ENC blobs
 *  and are stable across merges, so this walk (recursive over every
 *  coordinate) runs ONCE per feature for the whole session instead of once
 *  per shadow test AND once per sub-pixel-cull test each merge (audit rank 6:
 *  featureDiagDeg + featureIsShadowed were two identical full-coord walks of
 *  the same feature, ~40-50% of tagAndPush's coordinate time). */
const featureBboxCache = new WeakMap<Feature, [number, number, number, number] | null>();

export function featureBboxCached(f: Feature): [number, number, number, number] | null {
    const hit = featureBboxCache.get(f);
    if (hit !== undefined) return hit;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const visit = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const lon = coords[0] as number;
            const lat = coords[1] as number;
            if (lon < minLon) minLon = lon;
            if (lat < minLat) minLat = lat;
            if (lon > maxLon) maxLon = lon;
            if (lat > maxLat) maxLat = lat;
            return;
        }
        for (const c of coords) visit(c);
    };
    const geom = f.geometry as { coordinates?: unknown } | null;
    visit(geom?.coordinates);
    const out: [number, number, number, number] | null = Number.isFinite(minLon)
        ? [minLon, minLat, maxLon, maxLat]
        : null;
    featureBboxCache.set(f, out);
    return out;
}

function featureBbox(f: Feature): [number, number, number, number] | null {
    return featureBboxCached(f);
}

const bboxInside = (inner: [number, number, number, number], outer: [number, number, number, number]): boolean =>
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/**
 * True when `feature` (from a coarse cell) should be dropped because it lies
 * fully inside one of the finer `shadows` bboxes.
 */
export function featureIsShadowed(feature: Feature, shadows: readonly CellExtent[]): boolean {
    if (shadows.length === 0) return false;
    const fb = featureBbox(feature);
    if (!fb) return false;
    return shadows.some((s) => bboxInside(fb, s.bbox));
}

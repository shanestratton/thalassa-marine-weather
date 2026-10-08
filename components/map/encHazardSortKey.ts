/**
 * The ONE placement order for wrecks, rocks and obstructions (build 125,
 * 125-04, chart safety): the shallowest danger keeps the space when two marks
 * touch, whatever its class.
 *
 * The three classes draw from one symbol layer (ENC_VEC_LAYERS.HAZARDS), and
 * its symbol-sort-key reads the number this module stamps on every mark in the
 * merge (buildMergedPoints, as ENC_HAZARD_SORT_PROP). It is computed in JS, not
 * as a layer expression, so the attributes are read case-defensively through
 * readS57: an ogr2ogr cell can carry lower-case names (encDepthStyle.ts hard
 * rule 2), and a key on 'VALSOU' alone tied every mark of such a cell at 0 and
 * left the source order (obstructions first) to choose.
 *
 * Lower sorts first and wins. In metres, so the charted depth is the key:
 *   - VALSOU, when the mark carries a finite one (negative = dries);
 *   - no depth, but it dries or shows at some tide (WATLEV 1, 2, 4): -15 m;
 *   - no depth, awash at chart datum (WATLEV 5): 0;
 *   - no depth, and the chart itself calls it non-dangerous (foul ground,
 *     OBSTRN CATOBS 7, INT1 K31; a non-dangerous wreck, WRECKS CATWRK 1):
 *     20.1 m, behind every sounded danger to 20 m. With three layers these
 *     never hid a rock or a wreck; one layer with a flat "no depth = 0" put a
 *     depthless foul-ground hash over a 0.5 m dangerous wreck (125-04 review);
 *   - any other mark with no depth, dangerous or of unknown category: 0, the
 *     fail-safe (an unknown danger reads as awash).
 * The -15 and 20 m defaults are S-52's for these classes when VALSOU is
 * absent (conditional symbology OBSTRN/WRECKS, as implemented in OpenCPN
 * libs/s52plib/src/s52cnsy.cpp: WATLEV 1/2/4 -> -15.0, WATLEV 5 -> 0.0,
 * CATWRK 1 -> 20.0 "safe"); 20.1 sits just past 20 so a danger charted at
 * exactly 20 m still wins.
 *
 * Equal depths keep the priority the three layers had (rock, then wreck, then
 * obstruction) through a class step of 1 mm, far below any charted
 * difference: Mapbox would otherwise break the tie by source order, and the
 * merge lists obstructions first.
 *
 * The category tests mirror the glyph expressions in EncVectorLayer.ts
 * exactly (a string match on the coalesced attribute), so a mark sorts as
 * non-dangerous only when it is also drawn as non-dangerous.
 */
import { readS57 } from '../../services/enc/types';

/** The merged-points property the hazard layer's symbol-sort-key reads. */
export const ENC_HAZARD_SORT_PROP = '_hzSort';

/** No depth, but it dries or shows at some state of tide (WATLEV 1, 2, 4). */
export const HAZARD_SORT_DRIES_M = -15;
/** No depth, awash at chart datum (WATLEV 5); also any danger of unknown depth (fail-safe). */
export const HAZARD_SORT_UNKNOWN_DANGER_M = 0;
/** No depth, and charted non-dangerous (foul ground, a non-dangerous wreck). */
export const HAZARD_SORT_NON_DANGEROUS_M = 20.1;

/** Equal depths: rock, then wreck, then obstruction (the old layer order). */
const CLASS_STEP_M: Readonly<Record<string, number>> = { UWTROC: 0, WRECKS: 0.001, OBSTRN: 0.002 };

const DRIES_WATLEV = new Set(['1', '2', '4']);

/** An attribute as the layer's glyph expressions see it: ['to-string', ['coalesce', UPPER, lower, '']]. */
const attr = (props: Record<string, unknown>, key: string): string => String(readS57(props, key) ?? '');

/** A charted depth: a finite number, or numeric text. Blank, null and junk are no depth (never 0 m). */
function chartedDepth(props: Record<string, unknown>): number | undefined {
    const v = readS57(props, 'VALSOU');
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/** The sort key for one wreck, rock or obstruction (lower places first). */
export function encHazardSortKey(kind: string, props: Record<string, unknown> | null | undefined): number {
    const p = props ?? {};
    const step = CLASS_STEP_M[kind] ?? CLASS_STEP_M.OBSTRN;
    const depth = chartedDepth(p);
    if (depth !== undefined) return depth + step;
    const watlev = attr(p, 'WATLEV');
    if (DRIES_WATLEV.has(watlev)) return HAZARD_SORT_DRIES_M + step;
    if (watlev === '5') return HAZARD_SORT_UNKNOWN_DANGER_M + step;
    const nonDangerous =
        (kind === 'OBSTRN' && attr(p, 'CATOBS') === '7') || (kind === 'WRECKS' && attr(p, 'CATWRK') === '1');
    return (nonDangerous ? HAZARD_SORT_NON_DANGEROUS_M : HAZARD_SORT_UNKNOWN_DANGER_M) + step;
}

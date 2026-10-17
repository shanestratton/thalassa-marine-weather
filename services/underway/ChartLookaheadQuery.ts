/** ENC-only safety query. Existing chart bytes only: no raster fallback,
 * download, routing threshold, persistence or cloud evidence. */
import { getCoverage } from '../enc/EncHazardService';
import { getVersion } from '../enc/EncCellMetadata';
import { loadCellGeoJSON } from '../enc/EncCellStore';
import { EncSpatialIndex } from '../enc/EncSpatialIndex';
import { buildHazardsForCell, buildCoastlines } from '../enc/encHazardParse';
import { cellSoundingDatum } from '../enc/chartDatum';
import { fetchTideCurve } from '../TideHeightService';
import {
    aheadBounds,
    aheadGeometryWithinLimit,
    scanAhead,
    type AheadCone,
    type AheadHit,
    type AheadHazard,
} from './lookaheadRule';
import { coneIsCovered } from './lookaheadCoverage';

export interface ChartLookaheadResult {
    hit: AheadHit | null;
    coverage: 'charted' | 'partial' | 'none';
}
// These indexes are separate from the legacy router's lifecycle. Three
// retained cells bound their memory; a registry change invalidates all.
type LocalIndex = { index: EncSpatialIndex; datum: string | null };
const cache = new Map<string, LocalIndex>();
let version = -1;

export async function queryChartLookahead(
    cone: AheadCone,
    draftM: number,
    ukcM: number,
): Promise<ChartLookaheadResult> {
    const current = getVersion();
    if (current !== version) {
        cache.clear();
        version = current;
    }
    const boxes = aheadBounds(cone);
    const cells = getCoverage().filter((cell) =>
        boxes.some(([w, s, e, n]) => {
            const [cw, cs, ce, cn] = cell.bbox;
            return cn >= s && cs <= n && (cw <= ce ? ce >= w && cw <= e : ce >= w || cw <= e);
        }),
    );
    let hit: AheadHit | null = null;
    let loaded = 0;
    const all: AheadHazard[] = [];
    // One boat-position tide lookup, once per pass. Datum proof is evaluated
    // per cell below; this never turns a non-LAT cell into LAT water.
    let curve: Awaited<ReturnType<typeof fetchTideCurve>> | null = null;
    let curveAsked = false;
    const releases: Array<() => void> = [];
    try {
        for (const cell of cells.slice(0, 8)) {
            const indexes: LocalIndex[] = [];
            if (cell.noaaPackage) {
                // A dateline crossing needs both ordinary request boxes. Every
                // relevant window must pass before this logical cell is covered.
                // Views stay charged until candidates below are no longer retained.
                try {
                    const { loadNoaaPackageWindow } = await import('../enc/noaaPackageWindow');
                    for (const box of boxes) {
                        const [w, s, e, n] = box,
                            [cw, cs, ce, cn] = cell.bbox;
                        if (ce < w || cw > e || cn < s || cs > n) continue;
                        const view = await loadNoaaPackageWindow(cell, box);
                        releases.push(view.release);
                        indexes.push({
                            index: new EncSpatialIndex(
                                cell.id,
                                buildHazardsForCell(view.blob),
                                [],
                                buildCoastlines(view.blob),
                            ),
                            datum: cellSoundingDatum(view.blob),
                        });
                    }
                } catch {
                    // No monolith, Pi or WAN fallback; a partial package view is
                    // never promoted to complete clear-water evidence.
                    continue;
                }
            } else {
                let held = cache.get(cell.id);
                if (!held) {
                    const blob = await loadCellGeoJSON(cell.id, false).catch(() => null);
                    if (!blob || getVersion() !== current) continue;
                    held = {
                        index: new EncSpatialIndex(cell.id, buildHazardsForCell(blob), [], buildCoastlines(blob)),
                        datum: cellSoundingDatum(blob),
                    };
                    cache.set(cell.id, held);
                    while (cache.size > 3) cache.delete(cache.keys().next().value!);
                }
                indexes.push(held);
            }
            if (!indexes.length) continue;
            loaded++;
            for (const held of indexes) {
                const candidates = held.index.lookaheadCandidates(cone.polygon);
                if (all.length + candidates.length > 5000 || !aheadGeometryWithinLimit(candidates))
                    return { hit, coverage: 'partial' };
                all.push(...candidates);
                if (held.datum === 'LAT' && !curveAsked && boxes.length === 1) {
                    curveAsked = true;
                    curve = await fetchTideCurve(
                        cone.fix.lat,
                        cone.fix.lon,
                        cone.fix.at,
                        cone.fix.at + (cone.distanceNm / cone.fix.sogKn) * 3600_000,
                        { chartBounds: boxes[0] },
                    ).catch(() => null);
                }
                const next = scanAhead(cone, candidates, draftM, ukcM, (eta) =>
                    held.datum === 'LAT' && curve?.datum === 'LAT' ? curve.heightAt(eta) : null,
                );
                if (next && (!hit || next.etaMs < hit.etaMs)) hit = next;
            }
        }
        if (getVersion() !== current) return { hit: null, coverage: 'none' };
        return {
            hit,
            coverage: !loaded
                ? 'none'
                : loaded === cells.length && cells.length <= 8 && coneIsCovered(cone, all)
                  ? 'charted'
                  : 'partial',
        };
    } finally {
        for (const release of releases) release();
    }
}

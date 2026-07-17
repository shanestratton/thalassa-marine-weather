/**
 * glazeBuild — the per-cell satellite-glaze fold step, carved from the
 * ~590-line merge closure in EncHazardService (closing audit: residual
 * god module). One call per cell: paints the INSTANT strip-clipped
 * grade into the merge (memoised via glazeCellCache) and queues the
 * worker's true-coverage upgrade behind the liveness/in-flight gates.
 * Every dependency arrives through the explicit context — no module
 * state of its own, so the step is unit-mockable at the seams.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { clipFeatureOutsideBboxes, type CoverageGeom, type FineCoverage } from './clipDepareOverlap';
import { cellScaleRank, featureBboxCached } from './scaleShadow';
import { getGlazeCell, putGlazeCell, isGlazeInFlight } from './glazeCellCache';
import { GLAZE_WORKER_ENABLED, isGeoWorkerBroken, type GlazeUpgradeItem } from './geometryUpgrades';
import type { EncMergedVectorData } from './EncHazardService';

export interface GlazeBuildContext {
    cell: { id: string; bbox: [number, number, number, number]; edition?: number; sizeBytes?: number };
    blob: { layers: { DEPARE?: FeatureCollection; DRGARE?: FeatureCollection } };
    glazeShadows: Array<{ id: string; bbox: [number, number, number, number] }>;
    coverageFor: (cellId: string) => CoverageGeom | null;
    stripRectsFor: (cellId: string, extent: [number, number, number, number]) => [number, number, number, number][];
    glazeCoverageLib: Map<string, FineCoverage>;
    glazeUpgradeQueue: GlazeUpgradeItem[];
    merged: EncMergedVectorData;
    mergeGlazeKeys: string[];
    yieldIfNeeded: () => Promise<void>;
}

/** Run the glaze step for one cell. See module doc. */
export async function buildCellGlaze(ctx: GlazeBuildContext): Promise<void> {
    const {
        cell,
        blob,
        glazeShadows,
        coverageFor,
        stripRectsFor,
        glazeCoverageLib,
        glazeUpgradeQueue,
        merged,
        mergeGlazeKeys,
        yieldIfNeeded,
    } = ctx;
    // Memo key: the glaze for this cell is fully determined by its
    // own blob and the SHADOWING cells that clip it (their ids,
    // sorted — same set for both grades). Keyed by CELL CONTENT
    // (id@edition@sizeBytes — the established cell-identity triple),
    // NOT the registry version: the old v{registryVersion} prefix
    // wiped all cached glazes on ANY putCell (every hydration
    // arrival, provenance patch, Pi sync), re-clipping the whole
    // coast per arriving cell — the cold-boot cascade's biggest
    // duplicated cost (z10-boot audit #3). A re-extracted cell
    // still invalidates: same id, different sizeBytes.
    const glazeKey = `${cell.id}@${cell.edition}@${cell.sizeBytes ?? 0}:${glazeShadows
        .map((s) => s.id)
        .sort()
        .join(',')}`;
    const cached = getGlazeCell(glazeKey);
    let needQueue = false;
    if (cached) {
        putGlazeCell(glazeKey, cached); // refresh LRU position
        for (const f of cached.feats) merged.DEPARE_GLAZE.features.push(f);
        needQueue = !cached.upgraded && glazeShadows.length > 0;
    } else {
        const glazeRank = cellScaleRank(cell.bbox);
        // Strip rects, not the whole data-extent rectangle: a
        // narrow channel survey's rect clipped the coarse SAFE
        // glaze out of the water it never charts — dark squares
        // marching up the NE Channel at bay zoom (2026-07-14).
        // Strips hug the fine features (conservative: bbox ⊇
        // band), so coarse white survives only where the fine
        // survey is silent.
        const finerRects = glazeShadows.flatMap((s) => stripRectsFor(s.id, s.bbox));
        const glazeOut: Feature[] = [];
        for (const fc of [blob.layers.DEPARE, blob.layers.DRGARE]) {
            for (const feat of fc?.features ?? []) {
                if (!feat || !feat.geometry) continue;
                const base: Feature = {
                    ...feat,
                    properties: { ...(feat.properties ?? {}), _scaleRank: glazeRank },
                };
                const glazed = finerRects.length > 0 ? clipFeatureOutsideBboxes(base, finerRects) : base;
                if (glazed) glazeOut.push(glazed);
                // EVERY feature, not every 64th (review 2026-07-14):
                // one multi-thousand-vertex band vs hundreds of clip
                // rects costs whole milliseconds, so a 64-feature
                // stride let 300 ms+ run uninterrupted between yield
                // checks. The check itself early-returns in <1 µs
                // when the 12 ms slice isn't up.
                if (finerRects.length > 0) await yieldIfNeeded();
            }
        }
        for (const f of glazeOut) merged.DEPARE_GLAZE.features.push(f);
        putGlazeCell(glazeKey, { upgraded: glazeShadows.length === 0, feats: glazeOut });
        needQueue = glazeShadows.length > 0;
    }
    // Gates (audit #5/#6): compile flag; worker LIVENESS — after a
    // worker death the prefilter/parking machinery must not keep
    // accumulating payloads nothing will ever consume; and an
    // in-flight claim — a cell already being upgraded by an earlier
    // job is not re-dispatched (its answer upgrades the shared
    // cache for everyone).
    if (needQueue && GLAZE_WORKER_ENABLED && !isGeoWorkerBroken() && !isGlazeInFlight(glazeKey)) {
        // Payload for the worker's true-coverage upgrade. Coverages
        // dedupe into a per-JOB library (repro: the same fine cell
        // shadows several coarse cells, so per-cell copies made the
        // coverage arrays the bulk of a 14.5 MB clone); cells carry
        // ids into it. Gated on the flag so a disabled worker costs
        // ZERO — no payload copies built just to be thrown away.
        const coverageIds: string[] = [];
        for (const s of glazeShadows) {
            const cov = coverageFor(s.id);
            // Empty = nothing shallow = nothing to subtract. Strip
            // rects ride along as the worker's bounded fallback for
            // over-cap martinez pairs — the memo already computed
            // them for the instant grade.
            if (!cov || cov.length === 0) continue;
            if (!glazeCoverageLib.has(s.id)) {
                glazeCoverageLib.set(s.id, {
                    bbox: s.bbox,
                    coverage: cov,
                    stripRects: stripRectsFor(s.id, s.bbox),
                });
            }
            coverageIds.push(s.id);
        }
        if (coverageIds.length > 0) {
            const glazeRank = cellScaleRank(cell.bbox);
            const covBoxes = coverageIds.map((id) => glazeCoverageLib.get(id)!.bbox);
            // PRE-FILTER (round 2): only features whose bbox touches
            // a coverage extent ride to the worker — repro on real
            // cells put the untouched majority at 80-100% of the
            // payload (Newport's cell queued a pointless 1.3 MB with
            // ZERO intersecting features). Untouched features park
            // here and reassemble with the worker's answer in the
            // glaze-cell handler.
            const touchedFeats: Feature[] = [];
            const untouchedFeats: Feature[] = [];
            for (const fc of [blob.layers.DEPARE, blob.layers.DRGARE]) {
                for (const feat of fc?.features ?? []) {
                    if (!feat || !feat.geometry) continue;
                    const decorated = {
                        ...feat,
                        properties: { ...(feat.properties ?? {}), _scaleRank: glazeRank },
                    };
                    const fbb = featureBboxCached(feat);
                    const touches =
                        fbb != null &&
                        covBoxes.some((b) => !(fbb[2] <= b[0] || fbb[0] >= b[2] || fbb[3] <= b[1] || fbb[1] >= b[3]));
                    (touches ? touchedFeats : untouchedFeats).push(decorated);
                }
            }
            if (touchedFeats.length > 0) {
                glazeUpgradeQueue.push({
                    cellId: cell.id,
                    glazeKey,
                    features: touchedFeats,
                    coverageIds,
                    untouched: untouchedFeats,
                });
            } else {
                // Nothing this cell charts touches any fine coverage —
                // the instant grade IS the true-coverage result.
                const entry = getGlazeCell(glazeKey);
                if (entry) entry.upgraded = true;
            }
        } else {
            // No real coverage to subtract — the rectangle grade IS final.
            const entry = getGlazeCell(glazeKey);
            if (entry) entry.upgraded = true;
        }
    }
    mergeGlazeKeys.push(glazeKey);
}

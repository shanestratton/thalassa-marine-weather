/**
 * encGeometryWorker — the heavy-geometry sidecar for the ENC merge.
 *
 * Born from the 2026-07-13 OOM hunt: the martinez true-coverage glaze
 * clip (~1.5 s + a large allocation spike PER coarse-cell/fine-coverage
 * pair) and the sounding-derived contour Delaunay pass both detonated
 * the main thread — the first crashed iOS WKWebView and desktop Chrome
 * outright, the second hung the page a day earlier. Same lesson twice:
 * heavy geometry does not belong on the main thread.
 *
 * Here they run off-thread. The merge paints the FAST version instantly
 * (rectangle-clipped glaze, no derived contours); this worker computes
 * the good version — hole-free glaze, honest densified contours — and
 * the service swaps the sources when each answer lands. If this worker
 * dies (OOM, bug), the page never notices: the fast version simply
 * stays up. That failure mode is the whole point.
 *
 * ROUND-2 bounds (2026-07-17, after device round 1 crashed): glaze cells
 * arrive PRE-FILTERED (only features whose bbox touches a coverage — the
 * untouched majority stays main-thread side, never cloned); each job
 * carries an AGGREGATE martinez vertex budget on top of the per-pair
 * cap; and cells process one per macrotask so the engine can GC between
 * allocation spikes instead of accumulating them in one synchronous gulp.
 *
 * Messages IN:  { jobId, glazeCells?: [{cellId, glazeKey, features,
 *                 coverages}], contourPoints?: [{lon,lat,d}] }
 * Messages OUT: { jobId, type: 'glaze-cell', glazeKey, features }
 *               { jobId, type: 'contours', features }
 *               { jobId, type: 'done', glazeStats? }
 *               { jobId, type: 'error', message }
 */

import type { Feature } from 'geojson';
import {
    clipFeatureOutsideCoverage,
    emptyClipStats,
    GLAZE_MARTINEZ_VERTEX_CAP,
    type FineCoverage,
} from './clipDepareOverlap';
import type { GeometryJobMsg, GeometryWorkerReply } from './geometryWorkerProtocol';
import { buildDerivedContours } from './derivedContours';

/** Most derived-contour features one job may return. Far above every
 *  healthy reading; the theoretical worst case (~480k segments) is a
 *  renderer-killer twice over — once in the clone, once in geojson-vt. */
const CONTOUR_RESULT_FEATURE_CAP = 40_000;

/** Aggregate martinez input budget per JOB (sum of subject+clip vertices
 *  across every exact pair). The per-pair cap bounds one spike; this
 *  bounds how many spikes one job may stack before GC gets a look-in.
 *  Exhausted → remaining pairs degrade to strips (visible in the stats
 *  line as `strip-capped`). ~500k ≈ a few seconds of worker CPU on an
 *  iPhone and low-tens-of-MB transient — tune from the [glaze] line. */
export const GLAZE_JOB_VERTEX_BUDGET = 500_000;

const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent<GeometryJobMsg>) => void) | null;
    postMessage(msg: GeometryWorkerReply): void;
};

/** One macrotask gap — lets the engine GC between per-cell allocation
 *  bursts instead of stacking them in a single synchronous task. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

ctx.onmessage = (ev: MessageEvent<GeometryJobMsg>) => {
    void (async () => {
        const { jobId, glazeCells, coverageLib, contourPoints } = ev.data;
        try {
            // One stats bag + one aggregate budget per job — the 'done'
            // message carries the stats back so the main thread can log the
            // exact/degraded split (the device-session tuning signal).
            const stats = emptyClipStats();
            const budget = { remaining: GLAZE_JOB_VERTEX_BUDGET };
            const glazeT0 = performance.now();
            for (const cell of glazeCells ?? []) {
                const covs = cell.coverageIds
                    .map((id) => coverageLib?.[id])
                    .filter((c): c is FineCoverage => c != null);
                const out: Feature[] = [];
                for (const f of cell.features) {
                    if (!f || !f.geometry) continue;
                    const clipped =
                        covs.length > 0
                            ? clipFeatureOutsideCoverage(f, covs, GLAZE_MARTINEZ_VERTEX_CAP, stats, budget)
                            : f;
                    if (clipped) out.push(clipped);
                }
                ctx.postMessage({
                    jobId,
                    type: 'glaze-cell',
                    cellId: cell.cellId,
                    glazeKey: cell.glazeKey,
                    features: out,
                });
                await breathe();
            }
            if (contourPoints && contourPoints.length > 0) {
                // KILL #28 hygiene: the glaze path got a result cap on
                // 2026-08-23; the contour path never did — its worst case is
                // ~480k two-point segments from the 30k-sounding input cap,
                // structured-cloned back and serialized AGAIN into Mapbox.
                // Truncation is safe: derived contours are dashed
                // advisory-only interpolations, never the charted data.
                const contours = buildDerivedContours(contourPoints);
                const truncated = contours.length > CONTOUR_RESULT_FEATURE_CAP;
                ctx.postMessage({
                    jobId,
                    type: 'contours',
                    features: truncated ? contours.slice(0, CONTOUR_RESULT_FEATURE_CAP) : contours,
                    ...(truncated ? { truncated } : {}),
                });
            }
            ctx.postMessage({
                jobId,
                type: 'done',
                glazeStats:
                    (glazeCells?.length ?? 0) > 0
                        ? { ...stats, ms: Math.round(performance.now() - glazeT0) }
                        : undefined,
            });
        } catch (e) {
            ctx.postMessage({ jobId, type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
    })();
};

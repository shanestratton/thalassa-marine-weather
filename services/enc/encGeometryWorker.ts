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
 * Messages IN:  { jobId, glazeCells?: [{cellId, glazeKey, features,
 *                 coverages}], contourPoints?: [{lon,lat,d}] }
 * Messages OUT: { jobId, type: 'glaze-cell', glazeKey, features }
 *               { jobId, type: 'contours', features }
 *               { jobId, type: 'done' } | { jobId, type: 'error', message }
 */

import type { Feature } from 'geojson';
import { clipFeatureOutsideCoverage, type FineCoverage } from './clipDepareOverlap';
import { buildDerivedContours } from './derivedContours';

interface GlazeCellJob {
    cellId: string;
    glazeKey: string;
    features: Feature[];
    coverages: FineCoverage[];
}

interface JobMsg {
    jobId: number;
    glazeCells?: GlazeCellJob[];
    contourPoints?: Array<{ lon: number; lat: number; d: number }>;
}

const ctx = self as unknown as {
    onmessage: ((ev: MessageEvent<JobMsg>) => void) | null;
    postMessage(msg: unknown): void;
};

ctx.onmessage = (ev: MessageEvent<JobMsg>) => {
    const { jobId, glazeCells, contourPoints } = ev.data;
    try {
        for (const cell of glazeCells ?? []) {
            const out: Feature[] = [];
            for (const f of cell.features) {
                if (!f || !f.geometry) continue;
                const clipped = cell.coverages.length > 0 ? clipFeatureOutsideCoverage(f, cell.coverages) : f;
                if (clipped) out.push(clipped);
            }
            ctx.postMessage({ jobId, type: 'glaze-cell', cellId: cell.cellId, glazeKey: cell.glazeKey, features: out });
        }
        if (contourPoints && contourPoints.length > 0) {
            ctx.postMessage({ jobId, type: 'contours', features: buildDerivedContours(contourPoints) });
        }
        ctx.postMessage({ jobId, type: 'done' });
    } catch (e) {
        ctx.postMessage({ jobId, type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
};

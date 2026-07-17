/**
 * geometryWorkerProtocol — the SINGLE source of truth for the message
 * shapes crossing the encGeometryWorker boundary (2026-07-17 audit: the
 * types were hand-mirrored inline on both sides, so a drift — a renamed
 * field, a forgotten stats key — compiled clean and failed silently at
 * runtime). The worker and EncHazardService both import from here; a
 * shape change now breaks BOTH compile units.
 */
import type { Feature } from 'geojson';
import type { CoverageClipStats, FineCoverage } from './clipDepareOverlap';

/** One glaze cell queued for the true-coverage upgrade. `coverageIds`
 *  index into the job's shared coverage library. */
export interface GlazeCellJob {
    cellId: string;
    glazeKey: string;
    features: Feature[];
    coverageIds: string[];
}

/** Main thread → worker. */
export interface GeometryJobMsg {
    jobId: number;
    glazeCells?: GlazeCellJob[];
    coverageLib?: Record<string, FineCoverage>;
    contourPoints?: Array<{ lon: number; lat: number; d: number }>;
}

/** Worker → main thread. One 'glaze-cell' per queued cell, one optional
 *  'contours', then exactly one 'done' (with stats when glaze ran) or
 *  'error'. */
export type GeometryWorkerReply =
    | { jobId: number; type: 'glaze-cell'; cellId: string; glazeKey: string; features: Feature[] }
    | { jobId: number; type: 'contours'; features: Feature[] }
    | { jobId: number; type: 'done'; glazeStats?: CoverageClipStats & { ms: number } }
    | { jobId: number; type: 'error'; message: string };

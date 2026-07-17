/**
 * geometryUpgrades — the heavy-geometry worker's MAIN-THREAD plumbing,
 * carved out of the EncHazardService god-module (2026-07-17 audit: the
 * service was ~2 000 lines with this whole subsystem inlined).
 *
 * Owns: the worker lifecycle (spawn once, never respawn after death),
 * job bookkeeping, the reply handlers that swap upgraded glaze/contour
 * geometry into the cached merge, the upgrade-notification hook the
 * render layer subscribes to, and dispatchGeometryWork — the single
 * entry point the merge calls.
 */
import type { Feature } from 'geojson';
import type { Point } from 'geojson';
import { createLogger } from '../../utils/createLogger';
import type { GeometryJobMsg, GeometryWorkerReply, GlazeCellJob } from './geometryWorkerProtocol';
import { coverageVertexCount, type FineCoverage } from './clipDepareOverlap';
import type { EncMergedVectorData } from './EncHazardService';
import { getMergedData } from './mergedDataCache';
import { getDerivedContours, putDerivedContours } from './derivedContourCache';
import {
    getGlazeCell,
    putGlazeCell,
    parkGlazeAssembly,
    takeGlazeAssembly,
    releaseGlazeAssemblies,
    clearAllGlazeAssemblies,
} from './glazeCellCache';

const log = createLogger('geometryUpgrades');

/** Structured-clone payload weight caps (features + coverage vertices):
 *  soft = log a warning; hard = drop the glaze half of the job. */
export const GLAZE_CLONE_SOFT_CAP = 60_000;
export const GLAZE_CLONE_HARD_CAP = 200_000;

/** True once the worker has died/failed to spawn — the merge's queue
 *  gate must stop building payloads nothing will consume (audit #6). */
export function isGeoWorkerBroken(): boolean {
    return geoWorkerBroken;
}

/** The heavy-geometry worker carries TWO independent jobs with OPPOSITE
 *  safety profiles, so as of 2026-07-15 they get separate flags — the
 *  single GEOMETRY_WORKER_ENABLED gate threw the safe job out with the
 *  dangerous one.
 *
 *  GLAZE (martinez true-coverage clip) was the OOM detonator: a Worker is
 *  a separate THREAD in the SAME renderer process, so an unbounded
 *  martinez allocation spike killed the whole tab ("Aw, Snap" returned
 *  within minutes of the worker shipping 2026-07-13). Workers protect
 *  against HANGS, not process OOM. The post-mortem's re-enable
 *  precondition — "do not flip on until the clip is bounded (per-pair
 *  vertex caps / chunked jobs / a bounded clipper)" — is now met
 *  (2026-07-17): clipFeatureOutsideCoverage gates every subject/clip pair
 *  on GLAZE_MARTINEZ_VERTEX_CAP and degrades over-cap pairs to the
 *  strip-rect clip (bounded by construction), and the coverage payload is
 *  the SHALLOW-band subset (GLAZE_CLIP_MAX_SAFE_M), a fraction of the
 *  2026-07-13 full-coverage input. The 'done' message carries per-job
 *  clip stats, logged as the `[glaze]` warn line — watch it during the
 *  device session and tune the cap from maxPairVertices. If the tab ever
 *  dies with this on, flip it OFF first and re-read the post-mortem
 *  (lesson_web_gpu_oom_tilecache).
 *
 *  DEVICE SESSION ROUND 1 (2026-07-17): crashed to the glass page ~10 s
 *  in, right after a 10-cell wide merge dispatched. Local repro on the
 *  REAL Newport-window cells (pi-cache) explained it:
 *   - the zero-pair stats job was benign (Newport's cell queued 4 tiny
 *     fine shadows its bands never touch — 1.3 MB payload, zero work);
 *   - one wide merge cloned 14.5 MB of payload (× 2 for the clone), and
 *     ~660 real martinez pairs ran with NO aggregate bound — clone spike
 *     plus stacked martinez transients = jetsam.
 *  (A repro artefact nearly misled the diagnosis: under node, martinez
 *  resolves to its broken CJS build and EVERY diff throws "Y is not a
 *  constructor" — the exact interop trap the 2026-07-13 post-mortem
 *  warned benchmarks about. The device's vite bundle runs the ESM build:
 *  ~4 ms per bounded real pair.)
 *
 *  ROUND 2 (same day) — ON again with four bounds: queue-side feature
 *  prefilter (only coverage-touching features ride to the worker; the
 *  untouched majority parks in glazeAssemblyBase), a per-job shared
 *  coverage library (the same fine cell's polygons used to clone once
 *  PER coarse cell), per-job aggregate vertex budget
 *  (GLAZE_JOB_VERTEX_BUDGET) on top of the per-pair cap, and the worker
 *  breathing one macrotask between cells so GC reclaims between spikes.
 *  The clip is also two-phase now (martinez before any rect degrade —
 *  subtraction commutes) so boolean ops never see S–H piece output.
 *  If round 2 still crashes: flip OFF; next suspect is the RESULT clone
 *  (clipped MultiPolygons back to main).
 *
 *  CONTOURS (Delaunay + isoline march) were NEVER the crash — they were a
 *  main-thread HANG (2026-07-12), which is exactly what a worker cures.
 *  delaunator is O(n) over flat typed arrays and the input is hard-capped
 *  (DERIVED_CONTOUR_MAX_SOUNDINGS = 30 k), so the worker's peak allocation
 *  is bounded. Contours ride the same worker; their dispatch never queues
 *  a glaze cell. */
export const GLAZE_WORKER_ENABLED = true;
const DERIVED_CONTOUR_WORKER_ENABLED = true;

/** Hard ceiling on soundings fed to the Delaunay pass — belt-and-braces
 *  against a pathological dense window even inside the zoom gate. A
 *  harbour window runs a few thousand; 30k triangulates in well under a
 *  frame, past that we skip rather than risk a hang. */
export const DERIVED_CONTOUR_MAX_SOUNDINGS = 30_000;

// ── Async geometry upgrades (the heavy-geometry worker) ────────────
//
// The 2026-07-13 OOM hunt's lasting rule: heavy geometry (martinez
// true-coverage glaze clip, derived-contour Delaunay) never runs on
// the main thread. The merge returns the FAST version instantly;
// encGeometryWorker computes the good version and these hooks swap it
// into the cached merge + notify the render hook. A dead worker is
// harmless — the fast version simply stays up.

interface PendingGeometryJob {
    /** mergedCache key whose DEPARE_GLAZE / DEPCNT_DERIVED to upgrade. */
    cacheKey: string;
    /** Ordered per-cell glaze keys composing that merge's glaze. */
    glazeKeys: string[];
    /** The subset actually QUEUED to the worker this job — the cleanup
     *  scope for parked assemblies + in-flight claims (audit #5: cleaning
     *  by the merge-wide list clobbered OTHER jobs' state). */
    queuedGlazeKeys: string[];
}

let geoWorker: Worker | null = null;
let geoWorkerBroken = false;
let geoJobSeq = 0;
const pendingGeometryJobs = new Map<number, PendingGeometryJob>();
const geometryUpgradeListeners = new Set<() => void>();
// Parked untouched-feature assemblies + in-flight claims live in
// glazeCellCache (job-scoped keys, owner-checked release — audit #5).

/** Notify when a background geometry upgrade landed in the cached merge —
 *  the render hook re-pushes just the affected sources. */
export function subscribeGeometryUpgrades(cb: () => void): () => void {
    geometryUpgradeListeners.add(cb);
    return () => geometryUpgradeListeners.delete(cb);
}

function notifyGeometryUpgrade(): void {
    for (const cb of geometryUpgradeListeners) {
        try {
            cb();
        } catch {
            /* listener errors never break the pipeline */
        }
    }
}

/** Rebuild a cached merge's glaze collection from the per-cell cache
 *  (post-upgrade). Skips silently if the merge or any cell entry has
 *  been evicted — the next natural re-merge redoes it. */
function applyGlazeUpgrade(job: PendingGeometryJob): void {
    const cached = getMergedData(job.cacheKey);
    if (!cached) return;
    const feats: Feature[] = [];
    for (const key of job.glazeKeys) {
        const entry = getGlazeCell(key);
        if (!entry) return; // evicted mid-flight — abandon, stay on fast version
        feats.push(...entry.feats);
    }
    cached.DEPARE_GLAZE.features = feats;
    notifyGeometryUpgrade();
}

function getGeoWorker(): Worker | null {
    if (geoWorkerBroken) return null;
    if (geoWorker) return geoWorker;
    if (typeof Worker === 'undefined') return null;
    try {
        geoWorker = new Worker(new URL('./encGeometryWorker.ts', import.meta.url), { type: 'module' });
    } catch {
        geoWorkerBroken = true;
        return null;
    }
    geoWorker.onerror = () => {
        // Worker died (OOM/bug): the page is unaffected, the fast glaze
        // stays up. Don't respawn — same input would kill it again.
        geoWorkerBroken = true;
        geoWorker = null;
        pendingGeometryJobs.clear();
        clearAllGlazeAssemblies();
        log.warn('geometry worker died — staying on fast glaze/contours this session');
    };
    geoWorker.onmessage = (ev: MessageEvent<GeometryWorkerReply>) => {
        const msg = ev.data;
        const { jobId } = msg;
        const job = pendingGeometryJobs.get(jobId);
        if (msg.type === 'glaze-cell' && job) {
            // Require a live job, like the 'contours'/'done' siblings (closing
            // audit 2026-07-18): after onerror cleared pendingGeometryJobs +
            // clearAllGlazeAssemblies, a queued straggler reply would take an
            // EMPTY assembly and cache {upgraded:true, feats: touched-only} — a
            // permanently incomplete glaze marked final. No job → drop it.
            const { glazeKey, features } = msg;
            // Reassemble: the worker clipped only the TOUCHED subset; the
            // untouched majority parked main-thread side under THIS job's
            // key (audit #5: keying by glazeKey alone let overlapping jobs
            // truncate each other's majority and cache the incomplete
            // glaze as upgraded). Band order within a cell is immaterial
            // (bands are disjoint).
            const untouched = takeGlazeAssembly(jobId, glazeKey);
            putGlazeCell(glazeKey, { upgraded: true, feats: [...untouched, ...features] });
            return;
        }
        if (msg.type === 'contours' && job) {
            const { features } = msg;
            // Memoize under the merge key so a later re-merge of the SAME
            // selection reuses these synchronously instead of blanking +
            // recomputing (the DEPCNT_DERIVED analogue of the glaze memo).
            putDerivedContours(job.cacheKey, features);
            const cached = getMergedData(job.cacheKey);
            if (cached) {
                cached.DEPCNT_DERIVED.features = features;
                notifyGeometryUpgrade();
            }
            return;
        }
        if (msg.type === 'done' && job) {
            pendingGeometryJobs.delete(jobId);
            // Defensive leftover sweep — glaze-cell answers should have
            // consumed every parked entry; job-scoped so other jobs'
            // state is untouched (audit #5).
            releaseGlazeAssemblies(jobId, job.queuedGlazeKeys);
            if (job.glazeKeys.length > 0) applyGlazeUpgrade(job);
            // warn, not info (info is silent in prod): THE device-session
            // signal — exact/degraded split + the cap-tuning vertex peak.
            const gs = msg.glazeStats;
            if (gs) {
                log.warn(
                    `[glaze] true-coverage upgrade: exact=${gs.pairsExact} strip-capped=${gs.pairsStripped} ` +
                        `rect-fallback=${gs.pairsRectFallback} maxPairVerts=${gs.maxPairVertices} in ${gs.ms}ms`,
                );
            }
            return;
        }
        if (msg.type === 'error') {
            pendingGeometryJobs.delete(jobId);
            if (job) releaseGlazeAssemblies(jobId, job.queuedGlazeKeys);
            log.warn(`geometry worker job failed (fast version stays): ${msg.message ?? 'unknown'}`);
        }
    };
    return geoWorker;
}

/**
 * Pack the merged sounding cloud into the derived-contour worker's input
 * shape ({lon,lat,d} per point). Pure + extracted so it's unit-testable
 * (the merge core itself resists isolation — heavy module + loop state);
 * bounded by DERIVED_CONTOUR_MAX_SOUNDINGS at the call site.
 */
export function buildContourPayload(soundings: Feature[]): { lon: number; lat: number; d: number }[] {
    const out: { lon: number; lat: number; d: number }[] = [];
    for (const f of soundings) {
        if (f?.geometry?.type !== 'Point') continue;
        const c = f.geometry.coordinates;
        out.push({ lon: c[0], lat: c[1], d: Number((f.properties as { _d?: number } | null)?._d) });
    }
    return out;
}

/** One glaze true-coverage upgrade queued for the worker: the WIRE shape
 *  (geometryWorkerProtocol.GlazeCellJob — single source of truth, audit:
 *  hand-mirrored inline types drifted silently) plus the prefilter's
 *  untouched majority, which parks main-thread side at dispatch
 *  (job-scoped) and is STRIPPED from the wire payload. */
export type GlazeUpgradeItem = GlazeCellJob & { untouched: Feature[] };

/**
 * Hand the merge's HEAVY geometry to the worker (CONTOURS + optional GLAZE
 * upgrade), or fill contours synchronously from the memo. Extracted verbatim
 * from the merge tail — same module-scope worker/cache state, just named.
 * No worker (old WebView / died) = the fast version stays up.
 */
export function dispatchGeometryWork(
    cacheKey: string,
    merged: EncMergedVectorData,
    densify: boolean,
    glazeUpgradeQueue: GlazeUpgradeItem[],
    mergeGlazeKeys: string[],
    glazeCoverageLib?: ReadonlyMap<string, FineCoverage>,
): void {
    let wantContours =
        DERIVED_CONTOUR_WORKER_ENABLED && densify && merged.SOUNDG.features.length <= DERIVED_CONTOUR_MAX_SOUNDINGS;
    if (wantContours) {
        // Memo hit: this exact selection's contours were already computed (a
        // prior visit the merged cache has since evicted). Fill them in
        // synchronously — no blank on the rebuilt merge, no redundant worker
        // pass — and skip the contour job entirely.
        const memo = getDerivedContours(cacheKey);
        if (memo) {
            merged.DEPCNT_DERIVED.features = memo;
            putDerivedContours(cacheKey, memo); // refresh LRU position
            wantContours = false;
        }
    }
    if (glazeUpgradeQueue.length === 0 && !wantContours) return;
    const worker = getGeoWorker();
    if (!worker) return;
    const jobId = ++geoJobSeq;
    const queuedGlazeKeys = glazeUpgradeQueue.map((item) => item.glazeKey);
    pendingGeometryJobs.set(jobId, {
        cacheKey,
        glazeKeys: glazeUpgradeQueue.length > 0 ? mergeGlazeKeys : [],
        queuedGlazeKeys,
    });
    // Park each cell's untouched majority under THIS job's key + claim
    // the in-flight marker (audit #5: job-scoped, owner-checked).
    for (const item of glazeUpgradeQueue) parkGlazeAssembly(jobId, item.glazeKey, item.untouched);
    const contourPoints = wantContours ? buildContourPayload(merged.SOUNDG.features) : undefined;
    // Ship only the library entries the queued cells actually reference.
    let coverageLib: Record<string, FineCoverage> | undefined;
    if (glazeUpgradeQueue.length > 0 && glazeCoverageLib) {
        coverageLib = {};
        for (const item of glazeUpgradeQueue) {
            for (const id of item.coverageIds) {
                if (!coverageLib[id]) {
                    const c = glazeCoverageLib.get(id);
                    if (c) coverageLib[id] = c;
                }
            }
        }
    }
    // The wire payload strips `untouched` — those features exist to NOT
    // ride the structured clone.
    let glazeCells: GlazeCellJob[] = glazeUpgradeQueue.map(({ untouched: _parked, ...wire }) => wire);
    // CLONE BUDGET (closing audit: payload/result clone sizes were an
    // acknowledged-but-unbudgeted risk). Weight ≈ touched features +
    // coverage vertices; over the soft cap we log, over the hard cap we
    // drop the glaze half of the job (instant grade stays up — the exact
    // failure mode this machinery is designed to degrade to).
    const payloadWeight =
        glazeCells.reduce((n, c) => n + c.features.length, 0) +
        (coverageLib ? Object.values(coverageLib).reduce((n, c) => n + coverageVertexCount(c.coverage), 0) : 0);
    if (payloadWeight > GLAZE_CLONE_HARD_CAP) {
        log.warn(
            `[glaze] payload weight ${payloadWeight} > hard cap ${GLAZE_CLONE_HARD_CAP} — glaze job dropped, instant grade stays`,
        );
        releaseGlazeAssemblies(jobId, queuedGlazeKeys);
        glazeCells = [];
        coverageLib = undefined;
        if (!contourPoints || contourPoints.length === 0) {
            pendingGeometryJobs.delete(jobId);
            return;
        }
    } else if (payloadWeight > GLAZE_CLONE_SOFT_CAP) {
        log.warn(
            `[glaze] payload weight ${payloadWeight} (soft cap ${GLAZE_CLONE_SOFT_CAP}) — watch the [glaze] job stats`,
        );
    }
    try {
        const wireMsg: GeometryJobMsg = { jobId, glazeCells, coverageLib, contourPoints };
        worker.postMessage(wireMsg);
    } catch (err) {
        // Symmetric cleanup (audit #6): a failed dispatch must release its
        // parked assemblies + in-flight claims or they leak until worker
        // death — in exactly the memory-stressed mode this machinery
        // exists to survive.
        pendingGeometryJobs.delete(jobId);
        releaseGlazeAssemblies(jobId, queuedGlazeKeys);
        log.warn(`geometry worker dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

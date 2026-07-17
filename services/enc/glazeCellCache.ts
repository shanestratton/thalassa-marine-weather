/**
 * glazeCellCache — a small LRU of per-cell satellite-GLAZE fills, keyed
 * `{cellId}@{edition}@{sizeBytes}:{sortedShadowIds}` (the cell-identity
 * triple — the old v{registryVersion} prefix wiped every cached glaze on
 * ANY putCell and was retired in the z10-boot perf batch).
 *
 * A cell's glaze depends only on its own DEPARE bands + which finer cells
 * shadow it — both stable for a given cell content — so it memoizes cleanly.
 * `upgraded` marks entries the geometry worker has re-clipped against TRUE
 * fine-survey coverage (hole-free); un-upgraded entries hold the instant
 * rectangle clip and are re-queued for upgrade on use. Callers mutate
 * `entry.upgraded` in place on the object this returns (Map holds the same
 * reference), so a get-then-set-upgraded still updates the cache.
 *
 * Extracted from the EncHazardService god-module (mission audit: 16 mutable
 * caches in one namespace) so this concern owns its own state + is unit-tested.
 */
import type { Feature } from 'geojson';

export interface GlazeCellEntry {
    upgraded: boolean;
    feats: Feature[];
}

const cache = new Map<string, GlazeCellEntry>();
let maxEntries = 32;

/** Keys put since the current merge declared itself (ensureGlazeCapacity). The
 *  FEATURE-budget eviction must never drop THESE — a big-feature window would
 *  otherwise evict its own earliest cells mid-fold (before dispatch even
 *  returns) and every worker upgrade would abandon on the evicted key (cycle-4
 *  closing audit #3). The COUNT cap already grows to fit the merge
 *  (ensureGlazeCapacity), so it needs no such exemption. A new merge resets
 *  this set, so a PRIOR merge's cells are freely evictable again. */
let mergeKeys = new Set<string>();

/** INVARIANT (closing audit): the worker upgrade is all-or-nothing across
 *  ONE merge's glaze keys — if the LRU can't hold a whole merge, the fold
 *  evicts its own first cells before dispatch even returns and every
 *  upgrade abandons forever. The merge declares its size here; the cap
 *  grows (never shrinks) to fit + slack. Today's windows are ~10-25
 *  cells, so 32 usually stands — this is the guarantee, not a resize. */
export function ensureGlazeCapacity(mergeCellCount: number): void {
    const need = mergeCellCount + 8;
    if (need > maxEntries) maxEntries = need;
    // A new merge is beginning: unpin the previous merge's cells (now safely
    // evictable) and start pinning this merge's cells as putGlazeCell records
    // them, so the feature-budget eviction can't drop the window being built.
    mergeKeys = new Set();
}

/** The cached glaze entry for a key, or undefined. Returns the live object —
 *  mutating `.upgraded` on it updates the cache in place. */
export function getGlazeCell(key: string): GlazeCellEntry | undefined {
    return cache.get(key);
}

/** Store (or refresh) a cell's glaze entry, evicting the oldest beyond MAX. */
/** Feature-count budget across the whole cache (closing audit: the cache
 *  was count-capped only — 32 harbour-cell glazes of 5k features each is
 *  a very different heap than 32 corridor slivers). Evicts oldest-first
 *  once the SUM of cached features exceeds this, alongside the entry cap.
 *  ~120k features ≈ the working set of two big windows. */
const GLAZE_FEATURE_BUDGET = 120_000;

function totalFeatures(): number {
    let n = 0;
    for (const e of cache.values()) n += e.feats.length;
    return n;
}

export function putGlazeCell(key: string, entry: GlazeCellEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    mergeKeys.add(key);
    // COUNT cap: evict oldest unconditionally — maxEntries already grew to fit
    // the active merge (ensureGlazeCapacity), so this never reaches its cells.
    while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    // FEATURE budget: evict oldest NON-merge cell — never the window being
    // built (cycle-4 audit #3). A merge whose own working set exceeds the
    // budget stays briefly over it (all its keys pinned), the same deliberate
    // "hold rather than thrash out of my own render loop" escape the blob LRU
    // uses; the next merge unpins these and the budget catches up.
    if (cache.size > 1 && totalFeatures() > GLAZE_FEATURE_BUDGET) {
        for (const k of [...cache.keys()]) {
            if (!(cache.size > 1 && totalFeatures() > GLAZE_FEATURE_BUDGET)) break;
            if (mergeKeys.has(k)) continue;
            cache.delete(k);
        }
    }
}

/** Test/reset hook — drop everything. */
export function clearGlazeCell(): void {
    cache.clear();
    mergeKeys = new Set();
}

/** Current entry count (test/stat hook). */
export function glazeCellCacheSize(): number {
    return cache.size;
}

// ── Worker-assembly parking (round-2 payload prefilter) ─────────────
//
// The prefilter sends only coverage-touching features to the geometry
// worker; the untouched majority PARKS here and reassembles with the
// answer. 2026-07-17 audit (finding #5, on this very code the day it
// shipped): keyed by glazeKey alone, two overlapping jobs carrying the
// same cell truncated each other's parked majority and cached the
// incomplete glaze as upgraded — a persistent wrong keel-safety wash.
// Now: parked entries key on `${jobId}:${glazeKey}` and the in-flight
// marker records its OWNING job, so job B can neither consume A's
// parked features nor clear A's in-flight claim.

const parkedAssemblies = new Map<string, Feature[]>();
const inFlightByKey = new Map<string, number>();

/** Park a cell's untouched features for one job + mark it in flight. */
export function parkGlazeAssembly(jobId: number, glazeKey: string, untouched: Feature[]): void {
    parkedAssemblies.set(`${jobId}:${glazeKey}`, untouched);
    inFlightByKey.set(glazeKey, jobId);
}

/** Consume a job's parked features (empty if none/already taken) and
 *  release the in-flight marker — only if this job still owns it. */
export function takeGlazeAssembly(jobId: number, glazeKey: string): Feature[] {
    const key = `${jobId}:${glazeKey}`;
    const feats = parkedAssemblies.get(key) ?? [];
    parkedAssemblies.delete(key);
    if (inFlightByKey.get(glazeKey) === jobId) inFlightByKey.delete(glazeKey);
    return feats;
}

/** True while some job owes an answer for this glaze key — the queue
 *  skips re-dispatching a cell that's already being upgraded. */
export function isGlazeInFlight(glazeKey: string): boolean {
    return inFlightByKey.has(glazeKey);
}

/** Job-scoped cleanup (job error / failed dispatch / done leftovers):
 *  releases ONLY this job's parked entries and in-flight claims. */
export function releaseGlazeAssemblies(jobId: number, glazeKeys: readonly string[]): void {
    for (const k of glazeKeys) {
        parkedAssemblies.delete(`${jobId}:${k}`);
        if (inFlightByKey.get(k) === jobId) inFlightByKey.delete(k);
    }
}

/** Worker death / full reset — every job is dead, drop everything. */
export function clearAllGlazeAssemblies(): void {
    parkedAssemblies.clear();
    inFlightByKey.clear();
}

/** Test/stat hook. */
export function glazeAssemblyCount(): number {
    return parkedAssemblies.size;
}

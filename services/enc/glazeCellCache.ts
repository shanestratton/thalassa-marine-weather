/**
 * glazeCellCache — a small LRU of per-cell satellite-GLAZE fills, keyed
 * `v{ver}:{cellId}:{sortedShadowIds}`.
 *
 * A cell's glaze depends only on its own DEPARE bands + which finer cells
 * shadow it — both immutable per registry version — so it memoizes cleanly.
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
const MAX_ENTRIES = 32;

/** The cached glaze entry for a key, or undefined. Returns the live object —
 *  mutating `.upgraded` on it updates the cache in place. */
export function getGlazeCell(key: string): GlazeCellEntry | undefined {
    return cache.get(key);
}

/** Store (or refresh) a cell's glaze entry, evicting the oldest beyond MAX. */
export function putGlazeCell(key: string, entry: GlazeCellEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** Test/reset hook — drop everything. */
export function clearGlazeCell(): void {
    cache.clear();
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

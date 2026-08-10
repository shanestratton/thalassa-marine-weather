/**
 * pruneMap — the one-line answer to the 2026-08-04 cache audit's recurring
 * finding: module-scope Maps whose TTL gated REUSE but never DELETION, so
 * every distinct key ever seen stayed resident for the whole session (bbox
 * caches minting a key per ~1 km of travel, wall-clock-bucketed keys that
 * never repeat, per-tile Overpass payloads…).
 *
 * Call after every `map.set`: expired entries go first, then the oldest
 * (insertion order) until the map fits `maxEntries`. Insertion-order FIFO is
 * deliberate — these caches are read-mostly with short TTLs, so true LRU
 * bookkeeping buys nothing.
 */
export function pruneMap<K, V>(map: Map<K, V>, maxEntries: number, isExpired?: (value: V) => boolean): void {
    if (isExpired) {
        for (const [key, value] of map) {
            if (isExpired(value)) map.delete(key);
        }
    }
    while (map.size > maxEntries) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
    }
}

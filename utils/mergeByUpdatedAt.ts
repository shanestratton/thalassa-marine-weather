/**
 * mergeByUpdatedAt — merge records from multiple sources (typically a
 * local offline-first cache + a cloud table) keyed by `id`, where the
 * record with the NEWEST `updated_at` wins on conflict.
 *
 * Why this exists (2026-05-20 hardening sweep):
 *   The Vessel-tab maintenance "overdue" badge merged local + cloud
 *   tasks with "cloud wins unconditionally." But the UI writes ticks
 *   to the LOCAL store first, so right after servicing a task the
 *   local copy was fresh and the cloud copy was the stale overdue row
 *   that hadn't synced up yet. Cloud-wins overwrote the fresh local
 *   task → the badge was stuck on "1 Overdue" forever.
 *
 *   Comparing `updated_at` fixes it in BOTH directions:
 *     - a fresh local mutation (newer timestamp) beats stale cloud
 *     - a change synced down from another device (newer cloud
 *       timestamp) beats a stale local row
 *
 *   Any summary surface that combines a Local*Service with a cloud
 *   service should route through this helper instead of hand-rolling
 *   a Map merge, so the bug class can't recur.
 *
 * Order of `sources` does NOT matter — the winner is decided purely by
 * `updated_at`. A record missing `updated_at` is treated as the oldest
 * possible (epoch 0), so a record that HAS a timestamp always beats one
 * that doesn't.
 */
export function mergeByUpdatedAt<T extends { id: string; updated_at?: string | null }>(...sources: T[][]): T[] {
    const merged = new Map<string, T>();
    const time = (r: T): number => {
        if (!r.updated_at) return 0;
        const t = Date.parse(r.updated_at);
        return Number.isNaN(t) ? 0 : t;
    };
    for (const source of sources) {
        for (const record of source) {
            if (!record || typeof record.id !== 'string') continue;
            const existing = merged.get(record.id);
            if (!existing || time(record) >= time(existing)) {
                merged.set(record.id, record);
            }
        }
    }
    return Array.from(merged.values());
}

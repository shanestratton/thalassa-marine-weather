/**
 * dataChangeEvents — central registry of "this category of data changed"
 * window events.
 *
 * Each service that owns a kind of data (maintenance, documents,
 * equipment, routes/tracks…) calls `dispatchDataChange(EVENT)` after
 * any mutation. UI surfaces that display counts (Nav Station hero
 * tiles, etc.) listen for the event and refetch — no polling, no
 * manual cache invalidation tracking.
 *
 * Why a thin helper rather than direct `window.dispatchEvent`:
 *   - Single source of truth for event names — `grep DATA_EVENTS` finds
 *     every producer and consumer.
 *   - Browser-safety: a no-op fallback when `window` isn't defined
 *     (SSR, tests, future Node contexts).
 *   - One place to add cross-cutting behaviour (telemetry, throttling)
 *     if we ever need it.
 */

export const DATA_EVENTS = {
    /** Routes (planned passages) and tracks (sailed passages) — fired
     *  by invalidateRoutesAndTracks() in services/shiplog/RoutesAndTracks.ts */
    ROUTES_AND_TRACKS: 'thalassa:routes-and-tracks-changed',
    /** Maintenance tasks — created/updated/deleted/serviced. */
    MAINTENANCE: 'thalassa:maintenance-changed',
    /** Equipment register — items added/edited/removed. */
    EQUIPMENT: 'thalassa:equipment-changed',
    /** Document vault — items added/edited/removed/expired. */
    DOCUMENTS: 'thalassa:documents-changed',
    /** Ship log entries — fired when an entry is added or removed. */
    SHIP_LOG_ENTRIES: 'thalassa:ship-log-entries-changed',
} as const;

export type DataEvent = (typeof DATA_EVENTS)[keyof typeof DATA_EVENTS];

/**
 * Dispatch a data-change window event. Safe to call from anywhere —
 * no-ops outside a browser-like environment.
 */
export function dispatchDataChange(event: DataEvent): void {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(event));
    } catch {
        /* CustomEvent unavailable on some legacy runtimes — silent fallback */
    }
}

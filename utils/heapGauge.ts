/**
 * heapGauge — read the browser's ACTUAL JS heap, where available.
 *
 * Added 2026-08-10, kill #23. Five rounds of budgets — merge register 32 MB,
 * pinned merges 48 MB, tracer LRU 48 MB, one heavy build at a time — and the
 * fatal trail now shows every number healthy at the moment of death (19
 * pinned cells, 14 MB blob text, clean serialized merges, death AFTER a
 * merge-done). The census counts what OUR caches hold; it has never once
 * asked the browser what the PROCESS holds. Those can differ by hundreds of
 * MB (worker heaps, parser transients, GL buffers, fragmentation).
 *
 * Chrome exposes `performance.memory` (non-standard, desktop Chrome / Android
 * Chrome). WKWebView on iOS does not — there this returns null and callers
 * omit the reading rather than guessing. That asymmetry is fine: the
 * repeating desktop deaths are exactly where the gauge works.
 *
 * If the fatal trail shows heap CLIMBING toward the limit, the leak is real
 * but outside the counted caches. If it shows heap FLAT and modest, the
 * kills are not JS-heap OOM at all and the hunt moves to GL/native memory.
 * Either way the next trail answers the question this round could not.
 */
type ChromeMemory = { usedJSHeapSize: number; jsHeapSizeLimit: number };

export function heapMB(): { used: number; limit: number } | null {
    try {
        const m = (performance as unknown as { memory?: ChromeMemory }).memory;
        if (!m || typeof m.usedJSHeapSize !== 'number' || typeof m.jsHeapSizeLimit !== 'number') return null;
        return {
            used: Math.round(m.usedJSHeapSize / 1048576),
            limit: Math.round(m.jsHeapSizeLimit / 1048576),
        };
    } catch {
        return null;
    }
}

/**
 * Compact suffix for flight-recorder crumbs: ",h412" = 412 MB of real JS
 * heap in use when the crumb was written. Empty string where the browser
 * doesn't expose the gauge, so existing crumb formats are unchanged there.
 */
export function heapTag(): string {
    const h = heapMB();
    return h ? `,h${h.used}` : '';
}

/**
 * MapFitTargetStore — small pub/sub for "next time the map mounts
 * (or is already mounted), please fit to this bbox".
 *
 * Used to bridge "tap a thing on a non-map page" to "see that thing
 * on the map." Specific use: tapping an imported ENC cell row in
 * AvNavPage navigates to the map view and we want the map to
 * frame the cell's coverage area on arrival.
 *
 * The store holds at most one pending request. MapHub consumes it
 * on every render after mapReady, then clears it so a back-and-
 * forth navigation doesn't keep re-fitting.
 *
 * Tiny on purpose — no zustand, no react-context. Just a static
 * module + listener set, same pattern as the hazard-report
 * singleton in EncHazardReportService.
 */

export interface MapFitTarget {
    /** [minLon, minLat, maxLon, maxLat] in WGS84. */
    bbox: [number, number, number, number];
    /** Optional padding (pixels) around the fitted bbox. Default 60. */
    paddingPx?: number;
    /** Optional max zoom. Default 11 — keeps the bbox readable
     *  even if the bbox is tiny (e.g. one obstruction). */
    maxZoom?: number;
    /** Optional context label for telemetry / debug. */
    label?: string;
}

let pending: MapFitTarget | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const l of listeners) {
        try {
            l();
        } catch {
            /* listener errors are non-fatal */
        }
    }
}

/**
 * Request the map to fit to a bbox the next time it has a chance.
 * Replaces any prior pending request.
 */
export function requestMapFit(target: MapFitTarget): void {
    pending = target;
    notify();
}

/**
 * Pop the pending request, if any. Used by the map when it has
 * finished fitting (or decided not to). The store has at most one
 * outstanding request at a time.
 */
export function consumeMapFit(): MapFitTarget | null {
    const t = pending;
    pending = null;
    if (t !== null) notify();
    return t;
}

/**
 * Inspect without consuming. Used by the map host to check whether
 * a fit is pending without consuming it (so re-renders before
 * map-ready don't lose the request).
 */
export function peekMapFit(): MapFitTarget | null {
    return pending;
}

export function subscribeMapFit(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * zombieMapGuard — a removed map answers null, it does not crash the page.
 *
 * KILL CLASS (Shane 2026-08-25: "the routing page crashed when i was doing
 * a 2nd leg from lady musgrave to mackay"): mapbox-gl's Map.getLayer() is
 * the ONE style accessor with no liveness guard — `this.style.getOwnLayer`
 * throws `Cannot read properties of undefined (reading 'getOwnLayer')` the
 * moment anything queries a map after map.remove() nulled its style.
 * Reproduced twice on dev (MapView ErrorBoundary, thrown inside MapHub's
 * tree during page transitions); MapHub declares ~20 layer hooks BEFORE
 * useMapInit, so on unmount their cleanups run AFTER the map is removed,
 * and any timer/promise continuation holding a captured `map` has the same
 * window. Auditing every one of ~100 call sites is whack-a-mole; guarding
 * the boundary ends the class.
 *
 * The guard wraps the style accessors our code races against removal:
 * reads answer null/undefined, writes become no-ops — and EVERY zombie
 * call crumbs the caller's top stack frames, so the next occurrence in the
 * wild names the racing code in the flight trail instead of white-screening
 * the routing page. This is a diagnostic that also happens to be the fix.
 */
import type mapboxgl from 'mapbox-gl';
import { crumb } from '../../utils/flightRecorder';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('zombieMapGuard');

/** Style-touching Map methods that our code calls from cleanups, timers and
 *  promise continuations — the surfaces observed (or plausibly racing) a
 *  removed map. Reads return null-ish; writes no-op. */
const GUARDED: ReadonlyArray<keyof mapboxgl.Map> = [
    'getLayer',
    'getSource',
    'removeLayer',
    'removeSource',
    'setPaintProperty',
    'setLayoutProperty',
    'setFilter',
    'moveLayer',
    'addLayer',
    'addSource',
];

/** One crumb per method per map — a polling caller must not flood the trail. */
function noteZombieCall(method: string, seen: Set<string>): void {
    if (seen.has(method)) return;
    seen.add(method);
    // The two frames above the wrapper are the caller — the whole point.
    const stack = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 5)
        .map((line) => line.trim().replace(/^at /, ''))
        .join(' < ');
    crumb('map:zombie-call', `${method} ${stack.slice(0, 180)}`);
    log.warn(`[zombie-map] ${method}() on a removed map — caller: ${stack}`);
}

/**
 * Arm the guards on a freshly created map. Call once, right after
 * `new mapboxgl.Map(...)` — the wrappers delegate untouched while the map
 * is alive (`map.style` set), so live behaviour is byte-identical.
 */
export function armZombieMapGuards(map: mapboxgl.Map): void {
    const seen = new Set<string>();
    for (const method of GUARDED) {
        const raw = (map as unknown as Record<string, unknown>)[method];
        if (typeof raw !== 'function') continue;
        const bound = (raw as (...a: unknown[]) => unknown).bind(map);
        (map as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            if ((map as unknown as { style?: unknown }).style === undefined) {
                noteZombieCall(String(method), seen);
                return null;
            }
            return bound(...args);
        };
    }
}

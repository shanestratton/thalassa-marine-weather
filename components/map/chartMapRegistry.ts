/**
 * chartMapRegistry — lets a chart control find the map it sits beside.
 *
 * The Locate/zoom controls (MapActionFabs) render inside MapHub's map wrapper
 * but receive only callbacks. Rather than thread a map ref through MapHub for
 * two buttons, useMapInit registers each map against its container element and
 * a control looks up the nearest one in its own subtree. Keyed by element (a
 * WeakMap), so two live maps — the chart and an embedded one — never answer
 * for each other, and a removed map's entry goes with its container.
 */
import type mapboxgl from 'mapbox-gl';

const mapsByContainer = new WeakMap<Element, mapboxgl.Map>();
const listeners = new Set<() => void>();

function notify(): void {
    listeners.forEach((listener) => listener());
}

/** Record `map` as the map drawn into `container`. Returns the release. */
export function registerChartMap(container: Element, map: mapboxgl.Map): () => void {
    mapsByContainer.set(container, map);
    notify();
    return () => {
        if (mapsByContainer.get(container) !== map) return;
        mapsByContainer.delete(container);
        notify();
    };
}

/**
 * The map drawn beside `control`: the first registered map container found
 * under the control's nearest ancestor that holds one. Null until the map
 * exists (a child control mounts before its parent's map effect runs).
 */
export function chartMapBeside(control: Element | null): mapboxgl.Map | null {
    for (let node = control?.parentElement ?? null; node; node = node.parentElement) {
        const containers = node.querySelectorAll('.mapboxgl-map');
        for (const container of Array.from(containers)) {
            const map = mapsByContainer.get(container);
            if (map) return map;
        }
    }
    return null;
}

/** Called whenever a map is registered or released. Returns the unsubscribe. */
export function onChartMapsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

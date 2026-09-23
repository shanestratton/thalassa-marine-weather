import type mapboxgl from 'mapbox-gl';

/** Renderer lifecycle, not coverage. A loaded cell can have holes and its
 * fine detail may be suppressed at this scale. Inventory is a separate count. */
export interface EncDisplayState {
    phase: 'loading' | 'loaded' | 'unavailable' | 'zoom-in' | 'off';
    overview: boolean;
    loadedCells: number;
}

const states = new WeakMap<mapboxgl.Map, EncDisplayState>();
const listeners = new WeakMap<mapboxgl.Map, Set<() => void>>();
export const EMPTY_ENC_DISPLAY: EncDisplayState = { phase: 'unavailable', overview: false, loadedCells: 0 };

export function getEncDisplayState(map: mapboxgl.Map): EncDisplayState {
    return states.get(map) ?? EMPTY_ENC_DISPLAY;
}

export function setEncDisplayState(map: mapboxgl.Map, state: EncDisplayState): void {
    const old = states.get(map);
    if (old?.phase === state.phase && old.overview === state.overview && old.loadedCells === state.loadedCells) return;
    states.set(map, state);
    listeners.get(map)?.forEach((notify) => notify());
}

export function subscribeEncDisplay(map: mapboxgl.Map, notify: () => void): () => void {
    let subscribers = listeners.get(map);
    if (!subscribers) listeners.set(map, (subscribers = new Set()));
    subscribers.add(notify);
    return () => {
        subscribers.delete(notify);
    };
}

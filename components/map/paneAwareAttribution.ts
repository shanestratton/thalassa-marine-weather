import mapboxgl from 'mapbox-gl';

/**
 * The native 640px cutoff misses iPad half-panes just wider than 640px:
 * their chart controls leave no comfortable room for the long credit strip.
 * Measure the map itself and its pane, never the browser window. Keep the
 * provider-owned, keyboard/touch-operable ⓘ and every current source credit.
 */
export function installPaneAwareAttribution(map: mapboxgl.Map, container: HTMLElement): () => void {
    let control: mapboxgl.AttributionControl | undefined;
    let wasCompact: boolean | undefined;
    const refresh = () => {
        const width = container.clientWidth;
        const split = container.closest('[data-split-pane], [data-map-pane="split"]') !== null;
        // Large desktop panes have room for the full line; only the compact
        // chart/control layout needs the extra headroom above Mapbox's cutoff.
        const compact = width <= 640 || (split && width < 960);
        if (control && compact === wasCompact) return;
        const previous = control;
        // undefined retains Mapbox's own responsive behaviour on roomy maps.
        // Never force a permanently collapsed attribution on a full-size map.
        control = new mapboxgl.AttributionControl(compact ? { compact: true } : {});
        map.addControl(control, 'bottom-right');
        if (previous) map.removeControl(previous);
        wasCompact = compact;
    };
    refresh();
    // The map's existing ResizeObserver calls this alongside map.resize().
    // Mapbox owns removal of the final native control when map.remove() runs.
    return refresh;
}

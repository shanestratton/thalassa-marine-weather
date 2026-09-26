import mapboxgl from 'mapbox-gl';

/**
 * The native 640px cutoff misses iPad half-panes just wider than 640px:
 * their chart controls leave no comfortable room for the long credit strip.
 * Measure the map itself and its pane, never the browser window. Keep the
 * provider-owned, keyboard/touch-operable ⓘ and every current source credit.
 *
 * A phone on its side is wider than 640px too (852 x 393), so Mapbox expanded
 * the full strip across the chart there: pale 12 px text over imagery, the
 * '© Mapbox' pair printed twice, running through the coastline labels (UX
 * scorecard run 5). A short landscape map gets the same ⓘ as portrait, so the
 * credits sit behind the same toggle in both orientations — never removed.
 */
const SHORT_LANDSCAPE_MAX_HEIGHT_PX = 500;

export function installPaneAwareAttribution(map: mapboxgl.Map, container: HTMLElement): () => void {
    let control: mapboxgl.AttributionControl | undefined;
    let wasCompact: boolean | undefined;
    const refresh = () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        const split = container.closest('[data-split-pane], [data-map-pane="split"]') !== null;
        // A phone in landscape: wide but short. The height guard keeps iPads
        // (768+ tall on their side) and desktop windows on the full strip; an
        // unmeasured (0) height never counts as short.
        const shortLandscape = height > 0 && height <= SHORT_LANDSCAPE_MAX_HEIGHT_PX && width > height;
        // Large desktop panes have room for the full line; only the compact
        // chart/control layout needs the extra headroom above Mapbox's cutoff.
        const compact = width <= 640 || shortLandscape || (split && width < 960);
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
    // The map's existing ResizeObserver calls this alongside map.resize(),
    // so turning the phone re-measures both sides.
    // Mapbox owns removal of the final native control when map.remove() runs.
    return refresh;
}

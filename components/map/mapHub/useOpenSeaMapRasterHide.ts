/**
 * Hide the OpenSeaMap raster overlays when another source draws navaids —
 * moved out of MapHub.tsx verbatim.
 *
 * `activeLayers` arrives as the `activeLayers` argument; it stays in
 * the dependency array for the same reason it was there before, so this
 * effect re-asserts the hide AFTER useWeatherLayers' own sync.
 */
import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import { setOpenSeaMapRasterVisibility } from '../useMapInit';
import type { WeatherLayer } from '../mapConstants';

export function useOpenSeaMapRasterHide(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    chartsActive: boolean,
    encActive: boolean,
    activeLayers: ReadonlySet<WeatherLayer>,
): void {
    // ── Hide OpenSeaMap raster overlays when another source draws navaids ──
    // Both raster overlays — 'openseamap-overlay' (baked into the map style,
    // ThalassaMap.tsx) and 'openseamap-permanent' (added by useMapInit) —
    // show their own seamark icons. When o-charts are active they render
    // native marks, and when the ENC vector chart is rendering it draws its
    // own IALA navaids, so hide the rasters to prevent doubled icons.
    // 'openseamap-permanent' is co-owned by the 'sea' weather toggle
    // (useWeatherLayers re-syncs it to that toggle on every weather-layer
    // change), so: when not chart-hidden we defer to the toggle rather than
    // forcing it visible, and we depend on activeLayers so this
    // effect re-asserts the hide AFTER useWeatherLayers' sync (which runs
    // first — hook order) whenever weather layers change.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        const hide = chartsActive || encActive;
        const apply = (): void => {
            setOpenSeaMapRasterVisibility(map, {
                overlay: !hide,
                permanent: !hide && activeLayers.has('sea'),
            });
            // OSM seamark circles retire ENTIRELY while a real chart source
            // is active (2026-07-11, Shane: "can we kill those?" — green
            // and blue dot trails down every channel at bay zoom). They
            // were the wide-zoom read from before broad ENC coverage; the
            // ENC IALA glyphs (per-mark SCAMIN, ~z13.5+) are now the only
            // marks worth glass, and the white ramp carries the wide view.
            // No chart source = circles at every zoom, as before — they're
            // still the only marks a chartless region has.
            try {
                if (map.getLayer('harbour-seamarks-circle')) {
                    map.setLayoutProperty('harbour-seamarks-circle', 'visibility', hide ? 'none' : 'visible');
                    if (!hide) map.setLayerZoomRange('harbour-seamarks-circle', 0, 24);
                }
                if (map.getLayer('harbour-seamarks-label')) {
                    map.setLayerZoomRange('harbour-seamarks-label', hide ? 24 : 14, 24);
                }
            } catch {
                /* style mid-swap — styledata re-applies */
            }
        };
        apply();
        // Re-assert on styledata: 'openseamap-overlay' is BAKED INTO the
        // basemap style, so every chart-mode/basemap switch resurrects it
        // without any React dep changing — the doubled icon Shane caught at
        // Mooloolaba beacon 5 (2026-07-09: OSM's red-outlined-triangle+star
        // raster icon stamped over our correct green IALA glyph). COALESCED
        // (2026-07-12): setLayoutProperty/setLayerZoomRange here each emit a
        // styledata, so running per-tick joined the zoom-freeze storm; a
        // trailing timer collapses each burst into one pass.
        let pending: number | null = null;
        const scheduleApply = () => {
            if (pending !== null) return;
            pending = window.setTimeout(() => {
                pending = null;
                apply();
            }, 120);
        };
        map.on('styledata', scheduleApply);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', scheduleApply);
        };
    }, [mapRef, mapReady, chartsActive, encActive, activeLayers]);
}

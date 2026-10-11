/**
 * Hide the OpenSeaMap raster overlays when another source draws navaids —
 * moved out of MapHub.tsx verbatim — and, since 127-DESKMAP B1, the ONE owner
 * of 'openseamap-permanent': Obs's Sea marks toggle and the web desk
 * planner's Seamarks switch both draw through it.
 *
 * `activeLayers` arrives as the `activeLayers` argument; it stays in the
 * dependency array so this effect re-asserts AFTER useWeatherLayers' own sync
 * (which still owns the harbour-seamark circles and nav markers).
 */
import { useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { setOpenSeaMapRasterVisibility } from '../useMapInit';
import type { WeatherLayer } from '../mapConstants';
import { listCells, listDisplayCells } from '../../../services/enc/EncCellMetadata';

/** The web desk planner's side of the seamarks (127-DESKMAP B1). */
export interface DeskSeamarkInput {
    /** The desk's own surface: web planner, never picker, embedded or pin view. */
    surface: boolean;
    /** The Seamarks switch in the desk menu. */
    on: boolean;
    /** The chart draws its own marks: ENC on, or the tracer forcing them. */
    chartMarks: boolean;
    /** Re-test the view when cells come and go. */
    encCellCount: number;
}

type Box = [number, number, number, number];
const UNTESTED = { marks: true, chart: true, low: false, down: false };
/** [W, S, E, N] boxes meet, either side of the antimeridian. */
const meets = (view: Box, cells: ReadonlyArray<{ bbox: Box }>) =>
    cells.some(({ bbox: [w, s, e, n] }) =>
        [-360, 0, 360].some((k) => w + k <= view[2] && e + k >= view[0] && s <= view[3] && n >= view[1]),
    );

export function useOpenSeaMapRasterHide(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    chartsActive: boolean,
    encActive: boolean,
    activeLayers: ReadonlySet<WeatherLayer>,
    seamarksVisible = true,
    desk?: DeskSeamarkInput,
) {
    // ── What the desk's view holds, on the coalesced moveend ──
    // marks: a cell that draws (navigation or reference) meets the view;
    // chart: a registered navigation cell does (the strip's "No chart for this
    // area"); low: under z12, where Light's world tint shows (the seabed line;
    // a boolean, not the zoom, so a zoom that changes no line renders nothing).
    // A partial overlap counts: a missing OSM buoy is honest, a doubled one is
    // the Mooloolaba bug. Until a view is tested it counts as holding a cell,
    // so a raster that might double the chart's marks never shows "just for a
    // frame".
    // down: honest when OpenSeaMap is down. Three non-404 tile errors in 30 s
    // (a 404 is an empty tile and mapbox-gl stays quiet about it; a raster a
    // chart hides asks for no tiles); the next moveend with no new error
    // restores it.
    const [view, setView] = useState(UNTESTED);
    const surface = desk?.surface === true;
    const on = desk?.on === true;
    const cellCount = desk?.encCellCount ?? 0;
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !surface) return;
        const put = (next: Partial<typeof UNTESTED>) =>
            setView((now) => {
                const v = { ...now, ...next };
                return JSON.stringify(v) === JSON.stringify(now) ? now : v;
            });
        const test = () => {
            try {
                const b = map.getBounds();
                if (!b) return;
                const box: Box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
                put({ marks: meets(box, listDisplayCells()), chart: meets(box, listCells()), low: map.getZoom() < 12 });
            } catch {
                /* map mid-teardown */
            }
        };
        test();
        const errors: number[] = [];
        let fresh = 0;
        let down = false;
        let pending: number | null = null;
        const onMoveEnd = () => {
            if (down && !fresh) {
                down = false;
                errors.length = 0;
                put({ down });
            }
            fresh = 0;
            pending ??= window.setTimeout(() => {
                pending = null;
                test();
            }, 120);
        };
        const onError = (event: unknown) => {
            const e = event as { sourceId?: string; error?: { status?: number } };
            if (e.sourceId !== 'openseamap-permanent' || e.error?.status === 404) return;
            const now = Date.now();
            errors.push(now);
            while (now - errors[0] > 30_000) errors.shift();
            fresh += 1;
            if (!down && errors.length >= 3) {
                down = true;
                fresh = 0;
                put({ down });
            }
        };
        map.on('moveend', onMoveEnd);
        map.on('error', onError);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('moveend', onMoveEnd);
            map.off('error', onError);
            setView(UNTESTED);
        };
    }, [mapRef, mapReady, surface, cellCount, on]);
    const deskShown = surface && on && !(desk.chartMarks && view.marks);

    // ── Hide OpenSeaMap raster overlays when another source draws navaids ──
    // Both raster overlays — 'openseamap-overlay' (baked into the map style,
    // ThalassaMap.tsx) and 'openseamap-permanent' (added by useMapInit) —
    // show their own seamark icons. When o-charts are active they render
    // native marks, and when the ENC vector chart is rendering it draws its
    // own IALA navaids, so hide the rasters to prevent doubled icons.
    // 'openseamap-permanent' shows for Obs's Sea marks toggle or the desk's
    // Seamarks. Off the desk the global ENC gate stands (a bbox-aware Obs gate
    // is not in 127). On the desk only its own bbox gate above decides: the
    // global gate would hide the seamarks in every view whenever ENC was left
    // on in Obs (the planner never turns it off, useEncAtOpen), while the
    // strip and the menu still said they show.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        const hide = chartsActive || encActive;
        const apply = (): void => {
            setOpenSeaMapRasterVisibility(map, {
                overlay: !hide && seamarksVisible,
                permanent: !chartsActive && ((activeLayers.has('sea') && !encActive) || deskShown),
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
                    const show = !hide && seamarksVisible;
                    if (
                        map.getLayoutProperty('harbour-seamarks-circle', 'visibility') !== (show ? 'visible' : 'none')
                    ) {
                        map.setLayoutProperty('harbour-seamarks-circle', 'visibility', show ? 'visible' : 'none');
                    }
                }
                if (map.getLayer('harbour-seamarks-label')) {
                    const show = !hide && seamarksVisible;
                    if (map.getLayoutProperty('harbour-seamarks-label', 'visibility') !== (show ? 'visible' : 'none')) {
                        map.setLayoutProperty('harbour-seamarks-label', 'visibility', show ? 'visible' : 'none');
                    }
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
    }, [mapRef, mapReady, chartsActive, encActive, activeLayers, seamarksVisible, deskShown]);

    return { chartInView: surface && view.chart, shown: deskShown, down: deskShown && view.down, low: view.low };
}

/**
 * Layer framing on the OFF -> ON edge, moved out of MapHub.tsx.
 *
 * Switching a framed layer on eases to that layer's zoom (wind z9, rain z7,
 * pressure z2, a stack z7) about WHEREVER THE SKIPPER IS LOOKING. It never
 * moves the centre: not to the location box, not to the boat.
 *
 * Shane 2026-10-06: "when you go to select a layer like wind for example, it
 * flys you to the new location that you have in your glass page". The ease
 * used to centre on the location box (2026-08-24), which was right only while
 * Obs opened there; once Obs opened on the vessel, every toggle flew the chart
 * from the boat to the Glass location. Obs now opens where the box points
 * (useObsStartupCamera), so the zoom-only frame lands on that place anyway,
 * and after a deliberate pan it frames the water being read instead of
 * yanking the skipper back.
 *
 * Reacting to the STATE TRANSITION rather than the tap is what keeps it
 * honest: by the time this runs the set is authoritative, so it can only fire
 * when a layer actually came on, never on the tap that turned one off, and
 * never while panning or zooming with a layer already up. 'velocity' is the
 * legacy alias for wind, so both keys count.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { frameZoomForSelection, LAYER_FRAME_ZOOM, type WeatherLayer } from '../mapConstants';

export function useLayerFrameSnap(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    userLayers: ReadonlySet<WeatherLayer>,
    /** Plan and the passage HUD own their route framing. */
    suppressed: boolean,
): void {
    const prevSnapLayersRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const framed = Object.keys(LAYER_FRAME_ZOOM) as WeatherLayer[];
        const on = new Set(framed.filter((k) => userLayers.has(k)));
        const prev = prevSnapLayersRef.current;
        prevSnapLayersRef.current = on;
        // Passage owns its route framing; its bundled Wind/Rain activation
        // must not reframe the route view afterwards.
        if (suppressed) return;
        // Fire only for a layer that NEWLY appears. Comparing sets (rather
        // than a single boolean) also catches a SWITCH between two framed
        // layers, a fresh framing decision that selectInGroup makes in one tap.
        const newlyOn = [...on].find((k) => !prev.has(k)) as WeatherLayer | undefined;
        if (!newlyOn) return;
        // Any stack of two or more resolves to ONE shared frame
        // (MULTI_LAYER_FRAME_ZOOM), so adding isobars to wind holds the z7 the
        // wind frame already put you in rather than pressure's z2.
        const zoom = frameZoomForSelection(userLayers, newlyOn);
        if (zoom === undefined) return;
        const m = mapRef.current;
        if (!m) return;
        // Wind zooms IN to its frame, never out (Shane 2026-10-06: the close-in
        // wind field shows the breeze at z14, so turning wind on in the marina
        // must not pull the chart out to z9). Shane's 2026-08-22 ask, "If someone
        // presses wind, it always zooms in to level 9", still holds from further
        // out. Other layers keep their frames.
        if ((newlyOn === 'wind' || newlyOn === 'velocity') && m.getZoom() > zoom) return;
        try {
            // Zoom only. No `center`: see the header.
            m.easeTo({ zoom, duration: 600 });
        } catch {
            /* map mid-teardown */
        }
    }, [userLayers, suppressed, mapRef]);
}

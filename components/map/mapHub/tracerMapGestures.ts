/**
 * The tracer's map gestures — what a TAP and a LONG PRESS do while the Route
 * Tracer owns the chart.
 *
 * Moved out of the `useMapInit({ ... })` options object in MapHub.tsx verbatim.
 * They were already fresh arrow literals minted on every render, so building
 * them from a per-render deps object changes no identity and no behaviour;
 * every value they used is now passed in explicitly, refs as the ref OBJECTS
 * they were (never `.current` copied at the boundary).
 */
import mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../../utils/system';
import { encHasClickableFeatureAt, encSuppressNextClickPopup } from '../EncVectorLayer';
import { nearestLegForInsert } from '../mapHubHelpers';
import { snapTraceTapToLead, snapTraceTapToWater, type TracerContext } from '../../../services/routeTracer';

export interface TracerMapGestureDeps {
    mapRef: React.RefObject<mapboxgl.Map | null>;
    /** Mirrors coordCaptureMode so the map tap closure never reads a stale value. */
    coordCaptureRef: React.RefObject<boolean>;
    /** The PEN switch — armed = taps plot pins, paused = the chart is a chart. */
    plotArmedRef: React.RefObject<boolean>;
    tracerCtxRef: React.RefObject<TracerContext | null>;
    /** Mirrors insertAfter for the map-tap closure. */
    insertAfterRef: React.MutableRefObject<number | null>;
    capturedCoords: ReadonlyArray<{ lat: number; lon: number }>;
    setCapturedCoords: React.Dispatch<React.SetStateAction<Array<{ lat: number; lon: number }>>>;
    setInsertAfter: React.Dispatch<React.SetStateAction<number | null>>;
    setSelectedPin: React.Dispatch<React.SetStateAction<number | null>>;
    flashTraceFeedback: (msg: string) => void;
    browseWeatherInspectMode: boolean;
    showWeatherInspect: (lat: number, lon: number) => void;
}

export function createTracerMapTapHandler({
    mapRef,
    coordCaptureRef,
    plotArmedRef,
    capturedCoords,
    flashTraceFeedback,
    browseWeatherInspectMode,
    showWeatherInspect,
}: TracerMapGestureDeps): (lat: number, lon: number) => void {
    return (lat: number, lon: number) => {
        const map = mapRef.current;
        if (!map) return;

        // Tracer active + armed: taps no longer place — placement is
        // the LONG PRESS (Shane 2026-07-15), so a stray tap mid-pan
        // can't seed a phantom pin. A tap on a mark/light/water now
        // shows its ENC popup (Shane 2026-07-16: "tap a marker for its
        // info without closing the tracer"); we only COACH when the tap
        // hit nothing to inspect, so the popup isn't buried under a flash.
        if (coordCaptureRef.current && plotArmedRef.current) {
            if (!encHasClickableFeatureAt(map, { lat, lng: lon })) {
                // Coach the SPECIFIC gesture when the tap grazed a leg:
                // mid-route insert exists, but nobody can use a feature
                // they are never told about (Shane 2026-08-11 read the
                // append fallback as "insert is broken").
                const legHere = nearestLegForInsert(
                    map.project([lon, lat]),
                    capturedCoords.map((p) => map.project([p.lon, p.lat])),
                );
                flashTraceFeedback(
                    legHere > 0
                        ? `Hold on the line to insert between ${legHere} and ${legHere + 1}`
                        : 'Hold the chart to drop a pin',
                );
            }
            return;
        }

        // Only show weather popup if the user explicitly enabled inspect mode
        if (!browseWeatherInspectMode) return;
        // Weather inspect — stays active so the user can tap multiple
        // locations; they disable via the layer FAB menu.
        showWeatherInspect(lat, lon);
    };
}

export function createTracerMapLongPressHandler({
    mapRef,
    coordCaptureRef,
    plotArmedRef,
    tracerCtxRef,
    insertAfterRef,
    capturedCoords,
    setCapturedCoords,
    setInsertAfter,
    setSelectedPin,
    flashTraceFeedback,
}: TracerMapGestureDeps): (lat: number, lon: number) => void {
    return (lat: number, lon: number) => {
        const map = mapRef.current;
        if (!map) return;

        // Route Tracer owns the LONG PRESS when active AND ARMED —
        // record the fix (snapped off the breakwater if the fat finger
        // just missed the water), splice it mid-trace when an insert is
        // armed. PAUSED plotting (Shane 2026-07-11: "great when you
        // want it, and fucken annoying when you don't") hands the
        // gesture back to the chart.
        if (coordCaptureRef.current && plotArmedRef.current) {
            // The release-click after this placement must NOT open a
            // feature popup where the pin just landed (popups are live
            // while plotting now).
            encSuppressNextClickPopup(map);
            let pt = { lat, lon };
            const ctx = tracerCtxRef.current;
            if (ctx) {
                // Lead first (Shane 2026-07-17: "shove it directly on top
                // of the lead — very hard with fat fingers"): a pin within
                // ~120 m of a charted transit means "on the lead", and the
                // lead IS navigable water, so the water snap is moot.
                const onLead = snapTraceTapToLead(ctx, pt);
                if (onLead) {
                    pt = onLead;
                    flashTraceFeedback('Snapped onto the lead 🎯');
                } else {
                    const snapped = snapTraceTapToWater(ctx, pt);
                    if (snapped) {
                        pt = snapped;
                        flashTraceFeedback('Snapped to water');
                    }
                }
            }
            if (map.getZoom() < 13) {
                flashTraceFeedback('Zoomed out — pins are rough, zoom in for channel work');
            }
            const after = insertAfterRef.current;
            if (after !== null) {
                insertAfterRef.current = null;
                setInsertAfter(null);
                setSelectedPin(null);
                setCapturedCoords((prev) => [...prev.slice(0, after + 1), pt, ...prev.slice(after + 1)]);
                triggerHaptic('light');
                return;
            }
            // Hold ON the line → insert into that leg (Shane 2026-07-09:
            // "we need to be able to insert a waypoint along the track").
            // The leg test uses the RAW press position; the inserted pin
            // is the water-snapped one. Geometry extracted to
            // nearestLegForInsert 2026-08-11 and widened — the old
            // 16 px / middle-80% window was smaller than the fingertip
            // pressing it, so Shane only ever reached the append
            // fallback and read insert as missing entirely.
            const insertLeg = nearestLegForInsert(
                map.project([lon, lat]),
                capturedCoords.map((p) => map.project([p.lon, p.lat])),
            );
            if (insertLeg > 0) {
                setCapturedCoords((prev) => [...prev.slice(0, insertLeg), pt, ...prev.slice(insertLeg)]);
                flashTraceFeedback(`Inserted between ${insertLeg} and ${insertLeg + 1} — drag to fine-tune`);
            } else {
                setCapturedCoords((prev) => [...prev, pt]);
                if (capturedCoords.length >= 2) {
                    // Say what happened. The silent append here is what
                    // made a missed insert look like a routing bug.
                    flashTraceFeedback('Added to the end — hold on the line to insert mid-route');
                }
            }
            // Medium, not light: the hold earned a firmer thunk than
            // the old tap ever gave.
            triggerHaptic('medium');
        }
    };
}

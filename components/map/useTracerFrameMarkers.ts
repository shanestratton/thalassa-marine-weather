/**
 * useTracerFrameMarkers — the START and 🏁 ghost rings for the course frame.
 *
 * Extracted from MapHub verbatim. DOM markers rather than Mapbox layers, so
 * they survive a basemap style switch; hollow rings so they can never be
 * mistaken for trace pins.
 *
 * PAINT ORDER IS POSITIONAL. mapbox-gl.css gives `.mapboxgl-marker`
 * position:absolute and NO z-index, so among DOM markers the later insertion
 * paints on top. This hook must be called BEFORE the pin-marker hook, which is
 * what makes numbered pins paint above these ghost rings on first mount.
 * Swap the two call sites and that flips.
 *
 * TWO-PHASE TEARDOWN — both halves are load-bearing. The body-top
 * remove-and-clear does the same work as the returned cleanup, and that is not
 * redundancy: when the early return fires, NO cleanup is registered at all, so
 * teardown on that path depends entirely on the next run's body-top removal.
 * Marker.remove() is idempotent, so the double-remove costs nothing. Drop
 * either half and the ghosts leak onto the chart when capture mode ends.
 *
 * `pointer-events:none` on the marker ROOT is what stops these rings
 * swallowing trace taps at the START and finish positions. Any regeneration of
 * that cssText which loses it silently breaks pin plotting near the frame
 * endpoints, and nothing tests it.
 *
 * frameMarkersRef is hook-private and stays that way. The array is the ONLY
 * handle for removing these markers, so if it is ever threaded across a
 * boundary it must go as the ref object — copying `.current` into a local at
 * the boundary leaks the ghosts permanently.
 *
 * pinCount, not the pin array: the dep is the LENGTH on purpose. The
 * neighbouring trace-layer effect deps on the whole array because it needs
 * coordinate values; this one only needs the count. Do not normalise them.
 *
 * KNOWN, PRE-EXISTING, NOT FIXED HERE: there is no mapReady dep — mapReady is
 * declared ~1,200 lines below in MapHub — so on a cold PLAN→map mount where
 * the Mapbox object trails the render, the ghosts stay undrawn until some dep
 * changes. Unlike the trace-layer effect there is no re-entry ticket. Adding
 * one is a behaviour change and does not belong in a move commit.
 *
 * This hook draws the rings; the trace-layer effect draws the dashed
 * trace-dest-hint line between them from the same three inputs. Two halves of
 * one feature in two files — a change to one usually needs the other.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

export interface TracerFrameMarkerDeps {
    /** Ref OBJECT: .current is captured into a local at effect time and the
     *  marker factory closes over that local, not the ref. */
    mapRef: React.RefObject<mapboxgl.Map | null>;
    coordCaptureMode: boolean;
    traceOrigin: { lat: number; lon: number; name: string } | null;
    traceDest: { lat: number; lon: number; name: string } | null;
    /** capturedCoords.length — deliberately the count, not the array. */
    pinCount: number;
}

export function useTracerFrameMarkers({
    mapRef,
    coordCaptureMode,
    traceOrigin,
    traceDest,
    pinCount,
}: TracerFrameMarkerDeps): void {
    const frameMarkersRef = useRef<mapboxgl.Marker[]>([]);
    // START / 🏁 ghost markers for the course frame — DOM markers (they
    // survive basemap style switches), hollow rings so they can never be
    // mistaken for trace pins. Rebuilt whole on any frame change.
    useEffect(() => {
        frameMarkersRef.current.forEach((m) => m.remove());
        frameMarkersRef.current = [];
        const map = mapRef.current;
        if (!map || !coordCaptureMode) return;
        const mk = (p: { lat: number; lon: number; name: string }, kind: 'start' | 'finish'): mapboxgl.Marker => {
            const colour = kind === 'start' ? '#34d399' : '#f87171';
            const el = document.createElement('div');
            el.style.cssText = 'display:flex;flex-direction:column;align-items:center;pointer-events:none;';
            const ring = document.createElement('div');
            ring.style.cssText = `width:16px;height:16px;border-radius:50%;border:3px solid ${colour};background:rgba(15,23,42,0.5);box-shadow:0 0 6px rgba(0,0,0,0.7);`;
            const label = document.createElement('div');
            label.style.cssText = `margin-top:2px;max-width:96px;font:800 9px/1.15 system-ui;letter-spacing:0.04em;text-align:center;color:${colour};text-shadow:0 1px 3px #000;`;
            label.textContent = kind === 'start' ? 'START' : `🏁 ${p.name}`;
            el.append(ring, label);
            return new mapboxgl.Marker({ element: el, anchor: 'top' }).setLngLat([p.lon, p.lat]).addTo(map);
        };
        // Origin ghost only until the first real pin lands — pin 1 IS the
        // START button now, and two green STARTs on one chart is noise.
        // The 🏁 destination ghost stays: it's the target being traced
        // toward until the trace actually gets there.
        if (traceOrigin && pinCount === 0) frameMarkersRef.current.push(mk(traceOrigin, 'start'));
        if (traceDest) frameMarkersRef.current.push(mk(traceDest, 'finish'));
        return () => {
            frameMarkersRef.current.forEach((m) => m.remove());
            frameMarkersRef.current = [];
        };
    }, [mapRef, traceOrigin, traceDest, coordCaptureMode, pinCount]);
}

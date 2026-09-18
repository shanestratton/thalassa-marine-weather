/**
 * useRouteGhostMarker — where she WILL be, drawn on the chart.
 *
 * Phase 2 of the passage strip (Shane 2026-09-17: "it needs to show the vessel
 * going along the route as its normal cruising speed"). The strip works out
 * the place — her reckoned distance along the followed route, plus her
 * cruising speed times however far ahead the scrubber stands — and publishes
 * it to passageHudStore. This hook only draws what it is told.
 *
 * Dumb on purpose. The chart does not know about routes, speeds or forecasts
 * here; it moves one marker. Position and heading are written straight to the
 * marker from the store's listener — no React state, no re-render of MapHub at
 * drag rate.
 *
 * AND THE LINE IT RIDES. The Obs chart does not draw the followed route on its
 * own account (2026-08-03, "remove all of the spaghetti"), and the Passage
 * overlay only draws one it can match to an active voyage — measured on the
 * real page, the first ghost sailed up a chart with no line on it at all. So
 * for as long as the glance lasts, and not a moment longer, the water still to
 * sail is drawn here: dashed amber, from the boat to the destination.
 *
 * A GHOST, AND IT LOOKS LIKE ONE: hollow, dashed, amber — the strip's forecast
 * colour, never the ownship's. It carries its own "+6 h" chip so that nobody
 * glancing at the chart can take it for the boat.
 */
import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import { getPassageGhost, getPassageGhostPath, subscribePassageGhost } from '../../stores/passageHudStore';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Built with DOM calls, never innerHTML: the chip's text is data. */
export function createRouteGhostEl(): { root: HTMLDivElement; hull: SVGSVGElement; chip: HTMLSpanElement } {
    const root = document.createElement('div');
    root.className = 'thalassa-route-ghost';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText =
        'position:relative;width:34px;height:34px;pointer-events:none;display:flex;align-items:center;justify-content:center;';

    const hull = document.createElementNS(SVG_NS, 'svg');
    hull.setAttribute('viewBox', '0 0 34 34');
    hull.setAttribute('width', '34');
    hull.setAttribute('height', '34');
    hull.style.cssText = 'display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.7));';
    // Bow up (north = 0°); the marker's rotation turns it onto the route.
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M17 3 C23 11 25 19 23 30 L11 30 C9 19 11 11 17 3 Z');
    path.setAttribute('fill', 'rgba(251,191,36,0.18)');
    path.setAttribute('stroke', '#fbbf24');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-dasharray', '4 3');
    path.setAttribute('stroke-linejoin', 'round');
    hull.appendChild(path);
    root.appendChild(hull);

    const chip = document.createElement('span');
    chip.style.cssText =
        'position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:2px;white-space:nowrap;' +
        'padding:1px 6px;border-radius:9999px;background:rgba(2,6,23,0.88);border:1px solid rgba(251,191,36,0.55);' +
        'color:#fcd34d;font:900 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.02em;';
    root.appendChild(chip);
    return { root, hull, chip };
}

const PATH_SOURCE = 'passage-ghost-path';
const PATH_LAYER = 'passage-ghost-path-line';

/**
 * [lon, lat] pairs with the longitude kept CONTINUOUS across the antimeridian
 * (179 → 181, not 179 → -179): a line string that jumps 358° is drawn the long
 * way round the planet.
 */
export function ghostPathCoordinates(path: readonly { lat: number; lon: number }[]): [number, number][] {
    const out: [number, number][] = [];
    let previous: number | null = null;
    for (const p of path) {
        let lon = p.lon;
        if (previous !== null) {
            while (lon - previous > 180) lon -= 360;
            while (lon - previous < -180) lon += 360;
        }
        previous = lon;
        out.push([lon, p.lat]);
    }
    return out;
}

export function useRouteGhostMarker(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean): void {
    useEffect(() => {
        const map = mapRef.current;
        if (!mapReady || !map) return;

        let marker: mapboxgl.Marker | null = null;
        let parts: ReturnType<typeof createRouteGhostEl> | null = null;

        let drawnPath: ReturnType<typeof getPassageGhostPath> = null;
        const clearPath = () => {
            try {
                if (map.getLayer(PATH_LAYER)) map.removeLayer(PATH_LAYER);
                if (map.getSource(PATH_SOURCE)) map.removeSource(PATH_SOURCE);
            } catch {
                /* the style is mid-swap; its layers are going anyway */
            }
            drawnPath = null;
        };
        const drawPath = () => {
            const path = getPassageGhostPath();
            if (!path) {
                if (drawnPath) clearPath();
                return;
            }
            // A basemap switch throws every custom layer away; `drawnPath`
            // alone would say it is still there.
            const present = !!map.getSource(PATH_SOURCE);
            if (path === drawnPath && present) return;
            if (!map.isStyleLoaded() && !present) return; // styledata will call again
            const data: GeoJSON.Feature<GeoJSON.LineString> = {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: ghostPathCoordinates(path) },
            };
            try {
                const source = map.getSource(PATH_SOURCE) as mapboxgl.GeoJSONSource | undefined;
                if (source) source.setData(data);
                else {
                    map.addSource(PATH_SOURCE, { type: 'geojson', data });
                    map.addLayer({
                        id: PATH_LAYER,
                        type: 'line',
                        source: PATH_SOURCE,
                        layout: { 'line-cap': 'round', 'line-join': 'round' },
                        paint: {
                            'line-color': '#fbbf24',
                            'line-width': 2.5,
                            'line-opacity': 0.9,
                            'line-dasharray': [2, 2],
                        },
                    });
                }
                drawnPath = path;
            } catch {
                /* style not ready: the next styledata tries again */
            }
        };

        const draw = () => {
            drawPath();
            const ghost = getPassageGhost();
            if (!ghost) {
                marker?.remove();
                marker = null;
                parts = null;
                return;
            }
            if (!marker || !parts) {
                parts = createRouteGhostEl();
                // The ROOT stays upright so the chip reads level; only the hull
                // turns. rotationAlignment 'map' would spin the chip with it.
                marker = new mapboxgl.Marker({ element: parts.root, anchor: 'center' })
                    .setLngLat([ghost.lon, ghost.lat])
                    .addTo(map);
            } else {
                marker.setLngLat([ghost.lon, ghost.lat]);
            }
            parts.chip.textContent = ghost.label;
            // Bearing is true; the screen is rotated by the map's own bearing.
            parts.hull.style.transform = `rotate(${ghost.bearingDeg - map.getBearing()}deg)`;
        };

        draw();
        const unsubscribe = subscribePassageGhost(draw);
        map.on('rotate', draw);
        map.on('styledata', drawPath);
        return () => {
            unsubscribe();
            map.off('rotate', draw);
            map.off('styledata', drawPath);
            marker?.remove();
            clearPath();
        };
    }, [mapRef, mapReady]);
}

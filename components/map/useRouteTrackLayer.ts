/**
 * useRouteTrackLayer — render ONE selected route or track on the chart.
 *
 * Used twice in MapHub:
 *   - For the "Routes" Charts entry → purple colour, solid line
 *   - For the "Tracks" Charts entry → amber colour, solid line
 *
 * Separate source/layer ids let MapHub replace route with track (or vice
 * versa) without reusing stale geometry. MapHub owns exclusive selection.
 *
 * On select:
 *   1. Builds a GeoJSON LineString from the selected item's points
 *   2. Mounts the source + layer (line + glow + endpoint dots)
 *   3. fitBounds() on an explicit selection change. Geometry updates and
 *      basemap reloads redraw without taking the chart away from the skipper.
 *
 * On clear (item === null):
 *   - Removes source + layer + endpoint markers
 */
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';
import { getPassageLookAhead } from '../../stores/passageHudStore';

export type RouteTrackVariant = 'route' | 'track';

const VARIANT_STYLE: Record<
    RouteTrackVariant,
    { color: string; glowColor: string; startLabel: string; endLabel: string }
> = {
    route: {
        // Violet (purple-500) — distinct from the sky-blue the active
        // follow-route line used while it lived on this chart (removed
        // 2026-08-03, OBS stays uncluttered; sky-blue remains the live
        // voyage colour on the Log and public pages). Chart colours:
        //   violet    = saved planned route (this layer)
        //   amber     = recorded track (useRouteTrackLayer track variant)
        color: '#a855f7',
        glowColor: 'rgba(168, 85, 247, 0.35)',
        startLabel: 'A',
        endLabel: 'B',
    },
    track: {
        color: '#fbbf24', // amber-400 — actually-sailed
        glowColor: 'rgba(251, 191, 36, 0.35)',
        startLabel: '◉',
        endLabel: '⚑',
    },
};

interface Args {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    variant: RouteTrackVariant;
    /** Currently-selected route/track to render. null → nothing visible. */
    selected: RouteOrTrack | null;
}

export function useRouteTrackLayer({ mapRef, mapReady, variant, selected }: Args) {
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const syncRef = useRef<(() => void) | null>(null);
    const fittedRef = useRef<{ map: mapboxgl.Map; variant: RouteTrackVariant; id: string } | null>(null);
    const hasSelection = selected !== null;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !hasSelection) return;

        const sourceId = `routetrack-${variant}-source`;
        const lineId = `routetrack-${variant}-line`;
        const glowId = `routetrack-${variant}-glow`;
        const style = VARIANT_STYLE[variant];
        let startMarker: mapboxgl.Marker | null = null;
        let endMarker: mapboxgl.Marker | null = null;
        let lastPoints: RouteOrTrack['points'] | null = null;
        let lastSource: mapboxgl.GeoJSONSource | null = null;

        const clear = () => {
            try {
                if (map.getLayer(lineId)) map.removeLayer(lineId);
            } catch {
                /* missing */
            }
            try {
                if (map.getLayer(glowId)) map.removeLayer(glowId);
            } catch {
                /* missing */
            }
            try {
                if (map.getSource(sourceId)) map.removeSource(sourceId);
            } catch {
                /* missing */
            }
            startMarker?.remove();
            startMarker = null;
            endMarker?.remove();
            endMarker = null;
            lastPoints = null;
            lastSource = null;
        };

        // Late ENC/imagery can bury either line. Route and track form one
        // foreground group: ignoring the sibling avoids two idle handlers
        // continuously promoting their own line above one another.
        const ensureOnTop = () => {
            const order = (map.getStyle()?.layers ?? []).map((layer) => layer.id);
            const glowAt = order.indexOf(glowId);
            const lineAt = order.indexOf(lineId);
            if (glowAt < 0 || lineAt < 0) return;
            const buried = order.slice(glowAt + 1).some((id) => !/^routetrack-(route|track)-(glow|line)$/.test(id));
            if (!buried && lineAt > glowAt) return;
            map.moveLayer(glowId);
            map.moveLayer(lineId);
        };

        const sync = () => {
            const item = selectedRef.current;
            if (!item || item.points.length < 2) {
                clear();
                return;
            }
            // A style swap removes canvas sources/layers but leaves DOM
            // markers. Keep those markers and restore from the latest points.
            if (!map.isStyleLoaded()) return;
            try {
                let source = map.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
                const geometryChanged = source !== lastSource || item.points !== lastPoints;
                if (!source || geometryChanged) {
                    const feature: GeoJSON.Feature<GeoJSON.LineString> = {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'LineString',
                            coordinates: item.points.map((point) => [point.lon, point.lat]),
                        },
                    };
                    if (source) source.setData(feature);
                    else {
                        map.addSource(sourceId, { type: 'geojson', data: feature });
                        source = map.getSource(sourceId) as mapboxgl.GeoJSONSource;
                    }
                }
                if (!map.getLayer(glowId)) {
                    map.addLayer({
                        id: glowId,
                        type: 'line',
                        source: sourceId,
                        paint: {
                            'line-color': style.glowColor,
                            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 10, 14, 16, 20],
                            'line-blur': 4,
                            'line-opacity': 0.85,
                        },
                    });
                }
                if (!map.getLayer(lineId)) {
                    map.addLayer({
                        id: lineId,
                        type: 'line',
                        source: sourceId,
                        paint: {
                            'line-color': style.color,
                            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.2, 16, 4.8],
                            'line-opacity': 0.95,
                        },
                    });
                }
                ensureOnTop();

                const start = item.points[0];
                const end = item.points[item.points.length - 1];
                if (!startMarker) {
                    startMarker = createEndpointMarker(style.color, style.startLabel)
                        .setLngLat([start.lon, start.lat])
                        .addTo(map);
                } else if (geometryChanged) startMarker.setLngLat([start.lon, start.lat]);
                if (!endMarker) {
                    endMarker = createEndpointMarker(style.color, style.endLabel)
                        .setLngLat([end.lon, end.lat])
                        .addTo(map);
                } else if (geometryChanged) endMarker.setLngLat([end.lon, end.lat]);
                lastPoints = item.points;
                lastSource = source ?? null;

                const fitted = fittedRef.current;
                if (fitted?.map !== map || fitted.variant !== variant || fitted.id !== item.id) {
                    // Look-ahead frames the remaining passage itself. Its
                    // route/track can arrive asynchronously afterwards; do
                    // not replace that view or defer a fit until look-ahead ends.
                    if (!getPassageLookAhead().on) {
                        const [w, s, e, n] = item.bbox;
                        map.fitBounds(
                            [
                                [w, s],
                                [e, n],
                            ],
                            { padding: 60, duration: 1200, maxZoom: 11, retainPadding: false },
                        );
                    }
                    fittedRef.current = { map, variant, id: item.id };
                }
            } catch {
                // A concurrent style swap can interrupt any mount step.
                // style.load/idle retries without registering more handlers.
            }
        };

        syncRef.current = sync;
        map.on('style.load', sync);
        map.on('idle', sync);
        sync();
        return () => {
            syncRef.current = null;
            map.off('style.load', sync);
            map.off('idle', sync);
            clear();
        };
    }, [mapRef, mapReady, variant, hasSelection]);

    useEffect(() => {
        if (!selected) fittedRef.current = null;
        syncRef.current?.();
    }, [selected]);
}

/** Build the small endpoint pill DOM element. */
function createEndpointMarker(color: string, label: string): mapboxgl.Marker {
    const el = document.createElement('div');
    el.style.cssText = `
        width: 22px; height: 22px;
        background: ${color};
        border: 2px solid #fff;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        color: #0f172a;
        font-size: 11px;
        font-weight: 800;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        pointer-events: none;
    `;
    el.textContent = label;
    return new mapboxgl.Marker({ element: el, anchor: 'center' });
}

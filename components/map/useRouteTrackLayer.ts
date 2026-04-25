/**
 * useRouteTrackLayer — render ONE selected route or track on the chart.
 *
 * Used twice in MapHub:
 *   - For the "Routes" Charts entry → green colour, dashed line
 *   - For the "Tracks" Charts entry → amber colour, solid line
 *
 * Both instances are independent so a user can have a planned route
 * AND a recorded track displayed at the same time without them
 * fighting over the same Mapbox source/layer ids.
 *
 * On select:
 *   1. Builds a GeoJSON LineString from the selected item's points
 *   2. Mounts the source + layer (line + glow + endpoint dots)
 *   3. fitBounds() to the item's bbox so the chart immediately frames
 *      the whole route — no panning required
 *
 * On clear (item === null):
 *   - Removes source + layer + endpoint markers
 */
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { RouteOrTrack } from '../../services/shiplog/RoutesAndTracks';

export type RouteTrackVariant = 'route' | 'track';

const VARIANT_STYLE: Record<
    RouteTrackVariant,
    { color: string; glowColor: string; dasharray: number[] | null; startLabel: string; endLabel: string }
> = {
    route: {
        // Violet (purple-500) — distinct from the active follow-route's
        // sky-blue so the user never confuses "I'm sailing this right
        // now" with "I'm reviewing a saved plan". Three semantically
        // separated colours total on the chart:
        //   sky-blue  = active live voyage (useFollowRouteMapbox)
        //   violet    = saved planned route (this layer)
        //   amber     = recorded track (useRouteTrackLayer track variant)
        color: '#a855f7',
        glowColor: 'rgba(168, 85, 247, 0.35)',
        dasharray: [2.2, 1.6], // dashed: this is a PLAN, not an actual path
        startLabel: 'A',
        endLabel: 'B',
    },
    track: {
        color: '#fbbf24', // amber-400 — actually-sailed
        glowColor: 'rgba(251, 191, 36, 0.35)',
        dasharray: null, // solid: this is what really happened
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
    const sourceId = `routetrack-${variant}-source`;
    const lineId = `routetrack-${variant}-line`;
    const glowId = `routetrack-${variant}-glow`;
    const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const endMarkerRef = useRef<mapboxgl.Marker | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const cleanup = () => {
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
            if (startMarkerRef.current) {
                startMarkerRef.current.remove();
                startMarkerRef.current = null;
            }
            if (endMarkerRef.current) {
                endMarkerRef.current.remove();
                endMarkerRef.current = null;
            }
        };

        if (!selected || selected.points.length < 2) {
            cleanup();
            return;
        }

        // Always rebuild from scratch — switching from one route to
        // another is just as much work as a fresh mount and avoids
        // setData edge cases when bounds change dramatically.
        cleanup();

        const coords: GeoJSON.Position[] = selected.points.map((p) => [p.lon, p.lat]);
        const feature: GeoJSON.Feature<GeoJSON.LineString> = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: coords },
        };

        map.addSource(sourceId, { type: 'geojson', data: feature });

        const style = VARIANT_STYLE[variant];

        // Insert beneath the first symbol layer so labels remain on top.
        const styleLayers = map.getStyle()?.layers ?? [];
        const beforeId = styleLayers.find((l) => l.type === 'symbol')?.id;

        // Glow underlay — soft halo so the line stays visible against
        // busy basemaps (satellite, weather rasters).
        map.addLayer(
            {
                id: glowId,
                type: 'line',
                source: sourceId,
                paint: {
                    'line-color': style.glowColor,
                    'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 10, 14, 16, 20],
                    'line-blur': 4,
                    'line-opacity': 0.85,
                },
            },
            beforeId,
        );
        // Main line.
        map.addLayer(
            {
                id: lineId,
                type: 'line',
                source: sourceId,
                paint: {
                    'line-color': style.color,
                    'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.2, 16, 4.8],
                    'line-opacity': 0.95,
                    ...(style.dasharray ? { 'line-dasharray': style.dasharray } : {}),
                },
            },
            beforeId,
        );

        // Endpoint dots — small labelled circles at A and B so the user
        // can read direction at a glance even when the line is dashed.
        const start = selected.points[0];
        const end = selected.points[selected.points.length - 1];
        startMarkerRef.current = createEndpointMarker(style.color, style.startLabel)
            .setLngLat([start.lon, start.lat])
            .addTo(map);
        endMarkerRef.current = createEndpointMarker(style.color, style.endLabel)
            .setLngLat([end.lon, end.lat])
            .addTo(map);

        // Auto-fit the map to the selected route — the user shouldn't
        // have to hunt for it.
        try {
            const [w, s, e, n] = selected.bbox;
            map.fitBounds(
                [
                    [w, s],
                    [e, n],
                ],
                { padding: 60, duration: 1200, maxZoom: 11 },
            );
        } catch {
            /* bbox might be invalid for a 1-point route — already filtered */
        }

        return cleanup;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, variant, selected?.id]);
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

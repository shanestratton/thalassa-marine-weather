/** Followed-route waypoint dots and numbers while the passage HUD is enabled. */
import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { RoutePoint } from '../../services/routeProgress';

const SOURCE = 'passage-waypoints';
const DOTS = 'passage-waypoint-dots';
const NUMBERS = 'passage-waypoint-numbers';

type WaypointProperties = { number: number };
type WaypointData = GeoJSON.FeatureCollection<GeoJSON.Point, WaypointProperties>;

/** Keep original indexes stable when a point moves; A/B already mark the endpoints. */
export function passageWaypointData(coords: readonly RoutePoint[]): WaypointData {
    const features: WaypointData['features'] = [];
    const first = coords[0];
    const last = coords[coords.length - 1];
    for (let i = 1; i < coords.length - 1; i++) {
        const point = coords[i];
        if (
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lon) ||
            Math.abs(point.lat) > 90 ||
            Math.abs(point.lon) > 180 ||
            (point.lat === first.lat && point.lon === first.lon) ||
            (point.lat === last.lat && point.lon === last.lon)
        ) {
            continue;
        }
        features.push({
            type: 'Feature',
            id: i,
            properties: { number: i + 1 },
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        });
    }
    return { type: 'FeatureCollection', features };
}

interface Args {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    enabled: boolean;
    /** The full followed geometry; pass [] when no longer following. */
    routeCoords: readonly RoutePoint[];
}

export function usePassageWaypointLayer({ mapRef, mapReady, enabled, routeCoords }: Args): void {
    const coordsRef = useRef(routeCoords);
    coordsRef.current = routeCoords;
    const syncRef = useRef<(() => void) | null>(null);
    const active = enabled && routeCoords.length > 2;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !active) return;

        let lastCoords: readonly RoutePoint[] | null = null;
        let lastSource: mapboxgl.GeoJSONSource | null = null;
        let syncing = false;
        const clear = () => {
            for (const id of [NUMBERS, DOTS]) {
                try {
                    if (map.getLayer(id)) map.removeLayer(id);
                } catch {
                    /* A basemap switch can remove the layer first. */
                }
            }
            try {
                if (map.getSource(SOURCE)) map.removeSource(SOURCE);
            } catch {
                /* The outgoing style has already discarded the source. */
            }
            lastCoords = null;
            lastSource = null;
        };

        const ensureVisible = () => {
            const order = (map.getStyle()?.layers ?? []).map((layer) => layer.id);
            const higherPriority = (id: string) =>
                /^routetrack-(route|track)-(glow|line)$/.test(id) ||
                id === 'passage-ghost-path-line' ||
                id === 'passage-ghost-join-path-line';
            const foreground = (id: string) => id === DOTS || id === NUMBERS || higherPriority(id);
            let lastBackground = -1;
            for (let i = 0; i < order.length; i++) {
                if (!foreground(order[i])) lastBackground = i;
            }
            const dotsAt = order.indexOf(DOTS);
            const numbersAt = order.indexOf(NUMBERS);
            if (dotsAt < 0 || numbersAt < 0) return;
            if (dotsAt > lastBackground && numbersAt > dotsAt) return;
            // Raise only when buried by imagery, underneath any passage
            // siblings already in the foreground. Their own promoters may
            // move later; they never cause us to promote again.
            const beforeId = order.slice(lastBackground + 1).find(higherPriority);
            map.moveLayer(DOTS, beforeId);
            map.moveLayer(NUMBERS, beforeId);
        };

        const sync = () => {
            if (syncing || !map.isStyleLoaded()) return;
            syncing = true;
            try {
                const coords = coordsRef.current;
                let source = map.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined;
                if (!source || source !== lastSource || coords !== lastCoords) {
                    const data = passageWaypointData(coords);
                    if (source) source.setData(data);
                    else {
                        map.addSource(SOURCE, { type: 'geojson', data });
                        source = map.getSource(SOURCE) as mapboxgl.GeoJSONSource;
                    }
                }
                if (!map.getLayer(DOTS)) {
                    map.addLayer({
                        id: DOTS,
                        type: 'circle',
                        source: SOURCE,
                        paint: {
                            'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 9, 2.5, 13, 4],
                            'circle-color': '#a855f7',
                            'circle-stroke-color': '#f3e8ff',
                            'circle-stroke-width': 0.75,
                        },
                    });
                }
                if (!map.getLayer(NUMBERS)) {
                    map.addLayer({
                        id: NUMBERS,
                        type: 'symbol',
                        source: SOURCE,
                        minzoom: 11,
                        layout: {
                            'text-field': ['to-string', ['get', 'number']],
                            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
                            'text-size': 12,
                            'text-offset': [0, -1.1],
                            'text-anchor': 'bottom',
                            'text-allow-overlap': false,
                            'text-ignore-placement': false,
                            'text-padding': 4,
                            'symbol-sort-key': ['get', 'number'],
                        },
                        paint: {
                            'text-color': '#e9d5ff',
                            'text-halo-color': '#0f172a',
                            'text-halo-width': 1.5,
                        },
                    });
                }
                ensureVisible();
                lastCoords = coords;
                lastSource = source ?? null;
            } catch {
                /* A style event or idle retries a partially restored layer. */
            } finally {
                syncing = false;
            }
        };

        syncRef.current = sync;
        map.on('style.load', sync);
        map.on('styledata', sync);
        map.on('idle', sync);
        sync();
        return () => {
            syncRef.current = null;
            map.off('style.load', sync);
            map.off('styledata', sync);
            map.off('idle', sync);
            clear();
        };
    }, [mapRef, mapReady, active]);

    useEffect(() => {
        syncRef.current?.();
    }, [routeCoords]);
}

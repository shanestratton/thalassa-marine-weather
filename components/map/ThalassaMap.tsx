import React, { useState, useCallback, useRef, useEffect } from 'react';
import Map, { ViewStateChangeEvent, NavigationControl, MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { WindParticleLayer } from './WindParticleLayer';
import { WindStore } from '../../stores/WindStore';
import { LocationStore } from '../../stores/LocationStore';
import type { LocationState } from '../../stores/LocationStore';

// ── Types ──────────────────────────────────────────────────────

export interface GribBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface ViewState {
    longitude: number;
    latitude: number;
    zoom: number;
    bearing?: number;
    pitch?: number;
}

interface ThalassaMapProps {
    longitude?: number;
    latitude?: number;
    zoom?: number;
    /** Wind forecast hour to render (0 = current) */
    windHour?: number;
    /** Called when map bounds change — passes extracted bounds for GRIB requests */
    onBoundsChange?: (bounds: GribBounds) => void;
}

// ── Bounds Extraction Utility ──────────────────────────────────

/**
 * Extract the current visible bounds from a MapRef for use in GRIB
 * file requests. Returns a strict {north, south, east, west} object
 * that maps directly to ResumableGribFetcher parameters.
 */
export function getGribBoundsFromMap(mapRef: MapRef): GribBounds {
    const bounds = mapRef.getMap().getBounds();
    return {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
    };
}

// ── Style ──────────────────────────────────────────────────────

const OFFLINE_STYLE: StyleSpecification = {
    version: 8,
    name: 'Thalassa Offline',
    sources: {
        'osm-raster': {
            type: 'raster',
            tiles: [
                'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
    },
    layers: [
        {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm-raster',
            minzoom: 0,
            maxzoom: 19,
        },
    ],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
};

function findFirstLabelLayerId(map: maplibregl.Map): string | undefined {
    const layers = map.getStyle()?.layers;
    if (!layers) return undefined;
    for (const layer of layers) {
        if (layer.type === 'symbol' || layer.id.includes('label')) {
            return layer.id;
        }
    }
    return undefined;
}

// ── Component ──────────────────────────────────────────────────

const ThalassaMap: React.FC<ThalassaMapProps> = ({
    longitude: initialLon,
    latitude: initialLat,
    zoom: initialZoom,
    windHour = 0,
    onBoundsChange,
}) => {
    // Controlled viewport state
    const loc = LocationStore.getState();
    const [viewState, setViewState] = useState<ViewState>({
        longitude: initialLon ?? loc.lon,
        latitude: initialLat ?? loc.lat,
        zoom: initialZoom ?? 8,
    });

    const mapRef = useRef<MapRef>(null);
    const windLayerRef = useRef<WindParticleLayer | null>(null);
    const windHourRef = useRef(windHour);
    windHourRef.current = windHour;

    // ── Controlled viewport handler ────────────────────────────

    const onMove = useCallback((evt: ViewStateChangeEvent) => {
        setViewState(evt.viewState);
    }, []);

    // Emit bounds on every move end
    const onMoveEnd = useCallback(() => {
        if (!mapRef.current || !onBoundsChange) return;
        onBoundsChange(getGribBoundsFromMap(mapRef.current));
    }, [onBoundsChange]);

    // ── Location sync: fly to new location when LocationStore changes ──

    useEffect(() => {
        const unsub = LocationStore.subscribe((newState: LocationState) => {
            const map = mapRef.current;
            if (!map) {
                // Fallback: just set viewState directly
                setViewState(prev => ({
                    ...prev,
                    longitude: newState.lon,
                    latitude: newState.lat,
                }));
                return;
            }

            // Smooth fly-to animation
            map.getMap().flyTo({
                center: [newState.lon, newState.lat],
                duration: 1500,
                essential: true,
            });
        });
        return unsub;
    }, []);

    // ── Wind data pipeline ─────────────────────────────────────

    const feedWindData = useCallback(() => {
        const layer = windLayerRef.current;
        if (!layer) return;

        const { grid } = WindStore.getState();
        if (!grid) return;

        const hour = Math.min(windHourRef.current, grid.totalHours - 1);
        const uData = grid.u[hour];
        const vData = grid.v[hour];
        if (!uData || !vData) return;

        layer.setWindData(uData, vData, grid.width, grid.height, {
            north: grid.north,
            south: grid.south,
            east: grid.east,
            west: grid.west,
        });
    }, []);

    const onLoad = useCallback(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;

        if (windLayerRef.current) {
            try { map.removeLayer(windLayerRef.current.id); } catch (_) { /* ok */ }
        }

        const windLayer = new WindParticleLayer('wind-particles');
        windLayerRef.current = windLayer;

        const beforeLayerId = findFirstLabelLayerId(map);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.addLayer(windLayer as any, beforeLayerId);
        } catch (e) {
            console.error('[ThalassaMap] Failed to add WindParticleLayer:', e);
        }

        feedWindData();

        // Emit initial bounds
        if (mapRef.current && onBoundsChange) {
            onBoundsChange(getGribBoundsFromMap(mapRef.current));
        }
    }, [feedWindData, onBoundsChange]);

    // Subscribe to WindStore changes
    useEffect(() => {
        return WindStore.subscribe(() => feedWindData());
    }, [feedWindData]);

    // Re-feed when windHour changes
    useEffect(() => {
        feedWindData();
    }, [windHour, feedWindData]);

    // Cleanup
    useEffect(() => {
        return () => {
            const map = mapRef.current?.getMap();
            if (map && windLayerRef.current) {
                try { map.removeLayer(windLayerRef.current.id); } catch (_) { /* ok */ }
                windLayerRef.current = null;
            }
        };
    }, []);

    return (
        <Map
            ref={mapRef}
            {...viewState}
            onMove={onMove}
            onMoveEnd={onMoveEnd}
            onLoad={onLoad}
            mapStyle={OFFLINE_STYLE}
            style={{ width: '100%', height: '100%' }}
            attributionControl={false}
        >
            <NavigationControl position="top-right" />
        </Map>
    );
};

export default ThalassaMap;

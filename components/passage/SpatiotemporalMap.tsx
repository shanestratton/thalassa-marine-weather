/**
 * SpatiotemporalMap — The 4D Canvas
 *
 * Full-bleed WebGL map (MapLibre/react-map-gl) with:
 *   - Dual-layer neon route (halo + core)
 *   - Animated ghost ship marker tracking the scrubber
 *   - Waypoint markers with depth/weather badges
 *   - Wind particle layer integration
 *   - Auto-fit to bounding box on route load
 *
 * Design Language: Bioluminescent Dark Mode
 */

import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification, LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import '../../styles/bioluminescent.css';

// ── Dark Ocean Style ────────────────────────────────────────────

const OCEAN_STYLE: StyleSpecification = {
    version: 8,
    name: 'Thalassa Abyss',
    sources: {
        'carto-dark': {
            type: 'raster',
            tiles: [
                'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://carto.com">CARTO</a>',
        },
    },
    layers: [
        {
            id: 'carto-dark-tiles',
            type: 'raster',
            source: 'carto-dark',
            minzoom: 0,
            maxzoom: 19,
            paint: {
                'raster-brightness-max': 0.65,
                'raster-contrast': 0.2,
                'raster-saturation': -0.3,
            },
        },
    ],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
};

// ── Ghost Ship SVG ──────────────────────────────────────────────

const GhostShipIcon: React.FC<{ bearing: number }> = ({ bearing }) => (
    <div style={{
        position: 'relative',
        width: 40,
        height: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    }}>
        {/* Pulse ring */}
        <div className="ghost-ship-pulse" />
        {/* Ship icon */}
        <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            className="ghost-ship"
            style={{ transform: `rotate(${bearing}deg)` }}
        >
            {/* Sailboat silhouette pointing up (0° = north) */}
            <path
                d="M12 2L8 18h8L12 2z"
                fill="var(--neon-cyan)"
                stroke="white"
                strokeWidth="0.5"
                opacity="0.9"
            />
            <path
                d="M12 6L10 16h4L12 6z"
                fill="white"
                opacity="0.4"
            />
        </svg>
    </div>
);

// ── Waypoint Badge ──────────────────────────────────────────────

const WaypointBadge: React.FC<{
    point: TrackPoint;
    index: number;
    total: number;
}> = ({ point, index, total }) => {
    const isEndpoint = index === 0 || index === total - 1;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            pointerEvents: 'auto',
        }}>
            {/* Dot */}
            <div style={{
                width: isEndpoint ? 14 : 8,
                height: isEndpoint ? 14 : 8,
                borderRadius: '50%',
                background: isEndpoint ? 'var(--neon-cyan)' : 'rgba(255,255,255,0.6)',
                border: `2px solid ${isEndpoint ? 'white' : 'rgba(255,255,255,0.3)'}`,
                boxShadow: isEndpoint ? '0 0 12px var(--neon-cyan)' : 'none',
            }} />
            {/* Label */}
            <div style={{
                background: 'rgba(4, 13, 26, 0.85)',
                backdropFilter: 'blur(8px)',
                padding: '2px 6px',
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.1)',
                whiteSpace: 'nowrap',
            }}>
                <div style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 9,
                    color: isEndpoint ? 'var(--neon-cyan)' : 'var(--text-secondary)',
                    letterSpacing: '0.05em',
                    textShadow: isEndpoint ? '0 0 6px rgba(0,240,255,0.4)' : 'none',
                }}>
                    {point.name}
                </div>
                {!isEndpoint && (
                    <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 8,
                        color: 'var(--text-dim)',
                    }}>
                        {point.conditions.wind_spd_kts.toFixed(0)}kts · {point.conditions.wave_ht_m.toFixed(1)}m
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Main Map Component ──────────────────────────────────────────

interface SpatiotemporalMapProps {
    track: TrackPoint[] | null;
    ghostShip: GhostShipState | null;
    boundingBox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

const SpatiotemporalMap: React.FC<SpatiotemporalMapProps> = ({
    track,
    ghostShip,
    boundingBox,
}) => {
    const mapRef = useRef<MapRef>(null);
    const [mapReady, setMapReady] = useState(false);

    // ── Route GeoJSON ──
    const routeGeoJSON = useMemo(() => {
        if (!track || track.length < 2) return null;
        return {
            type: 'Feature' as const,
            properties: {},
            geometry: {
                type: 'LineString' as const,
                coordinates: track.map(t => t.coordinates),
            },
        };
    }, [track]);

    // ── Fit bounds on route load ──
    useEffect(() => {
        if (!mapReady || !mapRef.current || !boundingBox) return;

        const [minLon, minLat, maxLon, maxLat] = boundingBox;
        const bounds: LngLatBoundsLike = [[minLon, minLat], [maxLon, maxLat]];

        mapRef.current.fitBounds(bounds, {
            padding: { top: 100, bottom: 180, left: 290, right: 20 },
            duration: 1800,
            maxZoom: 10,
        });
    }, [mapReady, boundingBox]);

    const onLoad = useCallback(() => {
        setMapReady(true);
    }, []);

    return (
        <Map
            ref={mapRef}
            initialViewState={{
                longitude: 155,
                latitude: -25,
                zoom: 4,
            }}
            onLoad={onLoad}
            mapStyle={OCEAN_STYLE}
            style={{ width: '100%', height: '100%' }}
            attributionControl={false}
        >
            <NavigationControl position="top-right" showCompass showZoom />

            {/* ═══ ROUTE LAYERS ═══ */}
            {routeGeoJSON && (
                <Source id="passage-route" type="geojson" data={routeGeoJSON}>
                    {/* Layer 1: Outer Halo (the glow) */}
                    <Layer
                        id="route-halo"
                        type="line"
                        paint={{
                            'line-color': '#00f0ff',
                            'line-width': 14,
                            'line-blur': 10,
                            'line-opacity': 0.3,
                        }}
                    />

                    {/* Layer 2: Mid glow */}
                    <Layer
                        id="route-glow"
                        type="line"
                        paint={{
                            'line-color': '#00f0ff',
                            'line-width': 6,
                            'line-blur': 3,
                            'line-opacity': 0.5,
                        }}
                    />

                    {/* Layer 3: Core line (crisp white-cyan) */}
                    <Layer
                        id="route-core"
                        type="line"
                        paint={{
                            'line-color': '#ffffff',
                            'line-width': 2,
                            'line-opacity': 0.92,
                        }}
                    />
                </Source>
            )}

            {/* ═══ WAYPOINT MARKERS ═══ */}
            {track && track.map((pt, i) => (
                <Marker
                    key={`wp-${i}`}
                    longitude={pt.coordinates[0]}
                    latitude={pt.coordinates[1]}
                    anchor="bottom"
                >
                    <WaypointBadge point={pt} index={i} total={track.length} />
                </Marker>
            ))}

            {/* ═══ GHOST SHIP ═══ */}
            {ghostShip && (
                <Marker
                    longitude={ghostShip.position[0]}
                    latitude={ghostShip.position[1]}
                    anchor="center"
                >
                    <GhostShipIcon bearing={ghostShip.bearing} />
                </Marker>
            )}
        </Map>
    );
};

export default SpatiotemporalMap;

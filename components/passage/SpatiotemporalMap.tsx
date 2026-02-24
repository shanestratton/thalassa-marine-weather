/**
 * SpatiotemporalMap — The 4D Canvas
 *
 * Full-bleed WebGL map (MapLibre/react-map-gl) with:
 *   - Wind particle animation synced to temporal scrubber
 *   - ±30 NM corridor polygon with semi-transparent fill
 *   - Triple-layer neon route (halo + glow + core)
 *   - Detailed vessel icon (sail/power) with bearing rotation
 *   - Waypoint markers with depth/weather badges
 *   - Auto-fit to bounding box on route load
 *
 * Design Language: Bioluminescent Dark Mode
 */

import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification, LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import { WindParticleLayer } from '../map/WindParticleLayer';
import { WindStore } from '../../stores/WindStore';
import '../../styles/bioluminescent.css';

// ── Dark Ocean Style ────────────────────────────────────────────

const OCEAN_STYLE: StyleSpecification = {
    version: 8,
    name: 'Thalassa Abyss',
    sources: {
        'carto-dark': {
            type: 'raster',
            tiles: [
                'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
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
                'raster-brightness-max': 1.0,
                'raster-contrast': 0.1,
                'raster-saturation': -0.05,
            },
        },
    ],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
};

// ── Detailed Vessel SVG Icons ───────────────────────────────────

const SailboatGhost: React.FC<{ bearing: number }> = ({ bearing }) => (
    <div style={{
        position: 'relative',
        width: 48,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    }}>
        {/* Pulse ring */}
        <div className="ghost-ship-pulse" style={{ width: 52, height: 52 }} />
        {/* Detailed sailboat — bow points up (0° = north) */}
        <svg
            width="36"
            height="36"
            viewBox="0 0 64 64"
            fill="none"
            className="ghost-ship"
            style={{ transform: `rotate(${bearing}deg)` }}
        >
            {/* Hull */}
            <path
                d="M18 48 C18 48 20 54 32 54 C44 54 46 48 46 48 L42 42 H22 Z"
                fill="rgba(0, 240, 255, 0.3)"
                stroke="rgba(0, 240, 255, 0.8)"
                strokeWidth="1"
            />
            {/* Keel line */}
            <line x1="32" y1="54" x2="32" y2="58" stroke="rgba(0, 240, 255, 0.4)" strokeWidth="1" />
            {/* Mast */}
            <line x1="32" y1="12" x2="32" y2="48" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" />
            {/* Main sail */}
            <path
                d="M32 14 L32 44 L46 40 Z"
                fill="rgba(0, 240, 255, 0.25)"
                stroke="rgba(0, 240, 255, 0.7)"
                strokeWidth="0.8"
            />
            {/* Inner sail highlight */}
            <path
                d="M32 18 L32 40 L42 37 Z"
                fill="rgba(255, 255, 255, 0.08)"
            />
            {/* Jib (headsail) */}
            <path
                d="M32 14 L32 36 L20 34 Z"
                fill="rgba(0, 200, 255, 0.2)"
                stroke="rgba(0, 240, 255, 0.5)"
                strokeWidth="0.6"
            />
            {/* Bow marker */}
            <circle cx="32" cy="10" r="2" fill="#00f0ff" opacity="0.9" />
        </svg>
    </div>
);

const PowerboatGhost: React.FC<{ bearing: number }> = ({ bearing }) => (
    <div style={{
        position: 'relative',
        width: 48,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    }}>
        <div className="ghost-ship-pulse" style={{ width: 52, height: 52 }} />
        <svg
            width="36"
            height="36"
            viewBox="0 0 64 64"
            fill="none"
            className="ghost-ship"
            style={{ transform: `rotate(${bearing}deg)` }}
        >
            {/* Hull — pointed bow */}
            <path
                d="M32 10 L22 36 L20 48 C20 52 24 54 32 54 C40 54 44 52 44 48 L42 36 Z"
                fill="rgba(0, 240, 255, 0.25)"
                stroke="rgba(0, 240, 255, 0.7)"
                strokeWidth="1"
            />
            {/* Cabin / superstructure */}
            <rect
                x="26" y="28" width="12" height="14" rx="2"
                fill="rgba(0, 240, 255, 0.15)"
                stroke="rgba(0, 240, 255, 0.5)"
                strokeWidth="0.8"
            />
            {/* Windshield */}
            <line x1="27" y1="30" x2="37" y2="30" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
            {/* Flybridge */}
            <rect
                x="28" y="25" width="8" height="4" rx="1"
                fill="rgba(0, 240, 255, 0.12)"
                stroke="rgba(0, 240, 255, 0.4)"
                strokeWidth="0.5"
            />
            {/* Wake lines */}
            <path d="M26 50 L22 58" stroke="rgba(0, 240, 255, 0.2)" strokeWidth="0.5" />
            <path d="M38 50 L42 58" stroke="rgba(0, 240, 255, 0.2)" strokeWidth="0.5" />
            {/* Bow marker */}
            <circle cx="32" cy="10" r="2" fill="#00f0ff" opacity="0.9" />
        </svg>
    </div>
);

// ── Corridor Polygon Generator ──────────────────────────────────

/**
 * Generate a GeoJSON Polygon from a track by offsetting each point
 * laterally by ±corridorNM along the perpendicular bearing.
 */
function generateCorridorPolygon(
    track: TrackPoint[],
    corridorNM: number,
): GeoJSON.Feature<GeoJSON.Polygon> | null {
    if (track.length < 2) return null;

    const NM_TO_DEG_LAT = 1 / 60; // 1 NM ≈ 1/60 degree latitude

    // Calculate perpendicular offsets for the port and starboard sides
    const portSide: [number, number][] = [];
    const starboardSide: [number, number][] = [];

    for (let i = 0; i < track.length; i++) {
        const [lng, lat] = track[i].coordinates;

        // Calculate bearing at this point
        let fwdBearing: number;
        if (i === 0) {
            fwdBearing = calcBearing(lat, lng, track[1].coordinates[1], track[1].coordinates[0]);
        } else if (i === track.length - 1) {
            fwdBearing = calcBearing(
                track[i - 1].coordinates[1], track[i - 1].coordinates[0],
                lat, lng,
            );
        } else {
            const bIn = calcBearing(
                track[i - 1].coordinates[1], track[i - 1].coordinates[0],
                lat, lng,
            );
            const bOut = calcBearing(lat, lng, track[i + 1].coordinates[1], track[i + 1].coordinates[0]);
            fwdBearing = (bIn + bOut) / 2;
        }

        // Perpendicular bearing (port = +90, starboard = -90)
        const perpRad = (fwdBearing + 90) * Math.PI / 180;
        const antiperpRad = (fwdBearing - 90) * Math.PI / 180;

        const cosLat = Math.cos(lat * Math.PI / 180);
        const dLat = corridorNM * NM_TO_DEG_LAT;
        const dLng = dLat / (cosLat || 0.001);

        // Port side (left of track when looking forward)
        portSide.push([
            lng + Math.sin(perpRad) * dLng,
            lat + Math.cos(perpRad) * dLat,
        ]);

        // Starboard side (right of track)
        starboardSide.push([
            lng + Math.sin(antiperpRad) * dLng,
            lat + Math.cos(antiperpRad) * dLat,
        ]);
    }

    // Build polygon: port side forward → starboard side reverse → close
    const ring = [
        ...portSide,
        ...starboardSide.reverse(),
        portSide[0], // Close the ring
    ];

    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [ring],
        },
    };
}

/** Simple forward bearing calculation (degrees) */
function calcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

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
    boundingBox?: [number, number, number, number];
    corridorWidthNM?: number;
    vesselType?: 'sail' | 'power';
    /** Current time from scrubber — used to sync wind particles */
    currentTimeHours?: number;
}

const SpatiotemporalMap: React.FC<SpatiotemporalMapProps> = ({
    track,
    ghostShip,
    boundingBox,
    corridorWidthNM = 30,
    vesselType = 'sail',
    currentTimeHours = 0,
}) => {
    const mapRef = useRef<MapRef>(null);
    const windLayerRef = useRef<WindParticleLayer | null>(null);
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

    // ── Corridor Polygon GeoJSON ──
    const corridorGeoJSON = useMemo(() => {
        if (!track || track.length < 2) return null;
        return generateCorridorPolygon(track, corridorWidthNM);
    }, [track, corridorWidthNM]);

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

    // ── Wind Particle Layer ──
    const onLoad = useCallback(() => {
        setMapReady(true);

        const map = mapRef.current?.getMap();
        if (!map) return;

        // Add wind particle layer
        const windLayer = new WindParticleLayer('passage-wind-particles');
        windLayerRef.current = windLayer;

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.addLayer(windLayer as any);
        } catch (e) {
            console.warn('[SpatiotemporalMap] WindParticleLayer unavailable:', e);
        }

        // Feed initial wind data from WindStore (if available)
        feedWindData();
    }, []);

    // Feed wind data from WindStore
    const feedWindData = useCallback(() => {
        const layer = windLayerRef.current;
        if (!layer) return;

        const { grid } = WindStore.getState();
        if (!grid) return;

        layer.setGrid(grid, currentTimeHours);
    }, [currentTimeHours]);

    // Subscribe to WindStore changes
    useEffect(() => {
        return WindStore.subscribe(() => feedWindData());
    }, [feedWindData]);

    // Sync wind forecast hour with temporal scrubber
    useEffect(() => {
        const layer = windLayerRef.current;
        if (!layer) return;

        const { grid } = WindStore.getState();
        if (!grid) return;

        // Map passage time to wind forecast hour
        // The wind grid may have fewer hours than the passage duration
        const maxWindHour = grid.totalHours - 1;
        const clampedHour = Math.min(currentTimeHours, maxWindHour);
        layer.setForecastHour(clampedHour);
    }, [currentTimeHours]);

    // Cleanup wind layer on unmount
    useEffect(() => {
        return () => {
            const map = mapRef.current?.getMap();
            if (map && windLayerRef.current) {
                try { map.removeLayer(windLayerRef.current.id); } catch { /* ok */ }
                windLayerRef.current = null;
            }
        };
    }, []);

    // Choose vessel icon
    const VesselIcon = vesselType === 'power' ? PowerboatGhost : SailboatGhost;

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

            {/* ═══ CORRIDOR POLYGON (behind route) ═══ */}
            {corridorGeoJSON && (
                <Source id="corridor-area" type="geojson" data={corridorGeoJSON}>
                    {/* Corridor fill */}
                    <Layer
                        id="corridor-fill"
                        type="fill"
                        paint={{
                            'fill-color': '#00f0ff',
                            'fill-opacity': 0.04,
                        }}
                    />
                    {/* Corridor border */}
                    <Layer
                        id="corridor-border"
                        type="line"
                        paint={{
                            'line-color': '#00f0ff',
                            'line-width': 1,
                            'line-opacity': 0.15,
                            'line-dasharray': [4, 4],
                        }}
                    />
                </Source>
            )}

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
                    <VesselIcon bearing={ghostShip.bearing} />
                </Marker>
            )}
        </Map>
    );
};

export default SpatiotemporalMap;

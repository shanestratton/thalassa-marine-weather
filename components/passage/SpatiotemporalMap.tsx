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
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SpatiotemporalMap');
import Map, { Source, Layer, Marker, MapRef } from 'react-map-gl/mapbox';
import type { StyleSpecification, LngLatBoundsLike, LineLayerSpecification } from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { TrackPoint, GhostShipState } from '../../types/spatiotemporal';
import { WindParticleLayer } from '../map/WindParticleLayer';
import { WindStore } from '../../stores/WindStore';
import { FONT, SIZE } from '../../styles/typeScale';
import '../../styles/bioluminescent.css';

// ── Dark Ocean Style ────────────────────────────────────────────

const OCEAN_STYLE: StyleSpecification = {
    version: 8,
    name: 'Thalassa Abyss',
    sources: {
        'carto-dark': {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
            tileSize: 256,
            maxzoom: 20,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer" referrerpolicy="no-referrer">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions" rel="noopener noreferrer" referrerpolicy="no-referrer">CARTO</a>',
        },
        'gebco-bathymetry': {
            type: 'raster',
            tiles: ['https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 7,
            attribution:
                '&copy; <a href="https://emodnet.ec.europa.eu/bathymetry" rel="noopener noreferrer" referrerpolicy="no-referrer">EMODnet Bathymetry</a>',
        },
        openseamap: {
            type: 'raster',
            tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 18,
            attribution:
                'Map data: &copy; <a href="https://www.openseamap.org" rel="noopener noreferrer" referrerpolicy="no-referrer">OpenSeaMap</a> contributors',
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
        {
            id: 'gebco-bathymetry-tiles',
            type: 'raster',
            source: 'gebco-bathymetry',
            minzoom: 0,
            maxzoom: 10,
            paint: {
                'raster-opacity': 0.35,
                'raster-saturation': -0.3,
                'raster-brightness-max': 0.7,
            },
        },
        {
            id: 'openseamap-tiles',
            type: 'raster',
            source: 'openseamap',
            minzoom: 8,
            maxzoom: 18,
            paint: {
                'raster-opacity': 0.85,
            },
        },
    ],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
};

// ── Detailed Vessel SVG Icons ───────────────────────────────────

const SailboatGhost: React.FC<{ bearing: number }> = ({ bearing }) => (
    <div
        style={{
            position: 'relative',
            width: 48,
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        }}
    >
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
            <path d="M32 18 L32 40 L42 37 Z" fill="rgba(255, 255, 255, 0.08)" />
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
    <div
        style={{
            position: 'relative',
            width: 48,
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        }}
    >
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
                x="26"
                y="28"
                width="12"
                height="14"
                rx="2"
                fill="rgba(0, 240, 255, 0.15)"
                stroke="rgba(0, 240, 255, 0.5)"
                strokeWidth="0.8"
            />
            {/* Windshield */}
            <line x1="27" y1="30" x2="37" y2="30" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
            {/* Flybridge */}
            <rect
                x="28"
                y="25"
                width="8"
                height="4"
                rx="1"
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

// ── Waypoint Badge ──────────────────────────────────────────────

const WaypointBadge: React.FC<{
    point: TrackPoint;
    index: number;
    total: number;
}> = ({ point, index, total }) => {
    const isEndpoint = index === 0 || index === total - 1;

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                pointerEvents: 'auto',
            }}
        >
            {/* Dot */}
            <div
                style={{
                    width: isEndpoint ? 14 : 8,
                    height: isEndpoint ? 14 : 8,
                    borderRadius: '50%',
                    background: isEndpoint ? 'var(--neon-cyan)' : 'rgba(255,255,255,0.6)',
                    border: `2px solid ${isEndpoint ? 'white' : 'rgba(255,255,255,0.3)'}`,
                    boxShadow: isEndpoint ? '0 0 12px var(--neon-cyan)' : 'none',
                }}
            />
            {/* Label */}
            <div
                style={{
                    background: 'rgba(4, 13, 26, 0.85)',

                    padding: '2px 6px',
                    borderRadius: 4,
                    border: '1px solid rgba(255,255,255,0.1)',
                    whiteSpace: 'nowrap',
                }}
            >
                <div
                    style={{
                        fontFamily: FONT.data,
                        fontSize: SIZE.xs,
                        color: isEndpoint ? 'var(--neon-cyan)' : 'var(--text-secondary)',
                        letterSpacing: '0.05em',
                        textShadow: isEndpoint ? '0 0 6px rgba(56,189,248,0.4)' : 'none',
                    }}
                >
                    {point.name}
                </div>
                {!isEndpoint && (
                    <div
                        style={{
                            fontFamily: FONT.data,
                            fontSize: SIZE.xs,
                            color: 'var(--text-dim)',
                        }}
                    >
                        {point.conditions.wind_spd_kts.toFixed(0)}kts · {point.conditions.wave_ht_m.toFixed(1)}m
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Layer paint (module constants) ──────────────────────────────
// react-map-gl deep-compares `paint` on every render to decide whether to
// call setPaintProperty; this map re-renders on every scrubber tick, so the
// literals were compared 7 layers × N keys at up to 20 Hz. Stable references
// short-circuit on identity. Values are unchanged.
type LinePaint = NonNullable<LineLayerSpecification['paint']>;
const HARBOUR_GLOW_PAINT: LinePaint = {
    'line-color': '#1a1a1a',
    'line-width': 4,
    'line-blur': 3,
    'line-opacity': 0.15,
};
const HARBOUR_LINE_PAINT: LinePaint = {
    'line-color': '#1a1a1a',
    'line-width': 1.5,
    'line-opacity': 0.9,
    'line-dasharray': [3, 4],
};
const ROUTE_HALO_PAINT: LinePaint = {
    'line-color': '#00f0ff',
    'line-width': 14,
    'line-blur': 10,
    'line-opacity': 0.3,
};
const ROUTE_GLOW_PAINT: LinePaint = {
    'line-color': '#00f0ff',
    'line-width': 6,
    'line-blur': 3,
    'line-opacity': 0.5,
};
const ROUTE_CORE_PAINT: LinePaint = {
    'line-color': '#ffffff',
    'line-width': 2,
    'line-opacity': 0.92,
};

// ── Main Map Component ──────────────────────────────────────────

interface SpatiotemporalMapProps {
    track: TrackPoint[] | null;
    ghostShip: GhostShipState | null;
    boundingBox?: [number, number, number, number];
    vesselType?: 'sail' | 'power';
    /** Current time from scrubber — used to sync wind particles */
    currentTimeHours?: number;
    /** Callback when map is fully loaded and ready */
    onMapReady?: () => void;
}

const SpatiotemporalMap: React.FC<SpatiotemporalMapProps> = ({
    track,
    ghostShip,
    boundingBox,
    vesselType = 'sail',
    currentTimeHours = 0,
    onMapReady,
}) => {
    const mapRef = useRef<MapRef>(null);
    const windLayerRef = useRef<WindParticleLayer | null>(null);
    const [mapReady, setMapReady] = useState(false);
    // ── Route GeoJSON — split into harbour legs (dashed) and ocean route (solid) ──
    const { oceanRouteGeoJSON, departureHarbourGeoJSON, arrivalHarbourGeoJSON } = useMemo(() => {
        if (!track || track.length < 2)
            return { oceanRouteGeoJSON: null, departureHarbourGeoJSON: null, arrivalHarbourGeoJSON: null };

        // Find harbour/ocean boundaries using leg_type from route-weather
        const hasLegTypes = track.some((t) => t.leg_type);

        if (!hasLegTypes) {
            // No leg_type data (fallback track) — render full route as solid
            return {
                oceanRouteGeoJSON: {
                    type: 'Feature' as const,
                    properties: {},
                    geometry: { type: 'LineString' as const, coordinates: track.map((t) => t.coordinates) },
                },
                departureHarbourGeoJSON: null,
                arrivalHarbourGeoJSON: null,
            };
        }

        // Find transition points
        const firstOceanIdx = track.findIndex((t) => t.leg_type === 'ocean');
        const lastOceanIdx = track.length - 1 - [...track].reverse().findIndex((t) => t.leg_type === 'ocean');

        // Departure harbour leg (dashed)
        const depCoords = firstOceanIdx > 0 ? track.slice(0, firstOceanIdx + 1).map((t) => t.coordinates) : null;

        // Arrival harbour leg (dashed)
        const arrCoords = lastOceanIdx < track.length - 1 ? track.slice(lastOceanIdx).map((t) => t.coordinates) : null;

        // Ocean route (solid) — from first ocean point to last ocean point
        const oceanCoords = track.slice(Math.max(0, firstOceanIdx), lastOceanIdx + 1).map((t) => t.coordinates);

        return {
            oceanRouteGeoJSON:
                oceanCoords.length >= 2
                    ? {
                          type: 'Feature' as const,
                          properties: {},
                          geometry: { type: 'LineString' as const, coordinates: oceanCoords },
                      }
                    : null,
            departureHarbourGeoJSON:
                depCoords && depCoords.length >= 2
                    ? {
                          type: 'Feature' as const,
                          properties: {},
                          geometry: { type: 'LineString' as const, coordinates: depCoords },
                      }
                    : null,
            arrivalHarbourGeoJSON:
                arrCoords && arrCoords.length >= 2
                    ? {
                          type: 'Feature' as const,
                          properties: {},
                          geometry: { type: 'LineString' as const, coordinates: arrCoords },
                      }
                    : null,
        };
    }, [track]);

    // ── Fit bounds on route load ──
    useEffect(() => {
        if (!mapReady || !mapRef.current || !boundingBox) {
            return;
        }

        const [minLon, minLat, maxLon, maxLat] = boundingBox;
        const bounds: LngLatBoundsLike = [
            [minLon, minLat],
            [maxLon, maxLat],
        ];

        mapRef.current.fitBounds(bounds, {
            padding: { top: 80, bottom: 160, left: 20, right: 20 },
            duration: 1800,
            maxZoom: 13,
        });
    }, [mapReady, boundingBox]);

    // ── Wind Particle Layer ──
    const onLoad = useCallback(() => {
        setMapReady(true);
        onMapReady?.();

        const map = mapRef.current?.getMap();
        if (!map) return;

        // Add wind particle layer
        const windLayer = new WindParticleLayer('passage-wind-particles');
        windLayerRef.current = windLayer;

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.addLayer(windLayer as any);
            log.info(' Wind particle layer added to map');
        } catch (e) {
            log.error(' Failed to add wind layer:', e);
        }

        // Feed initial wind data from WindStore (if available)
        feedWindData();

        // Seamarks now rendered via React <Source>/<Layer> JSX (not imperatively)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Latest scrubber hour for the feeder below — read at call time so the
    // callback identity is stable and WindStore.subscribe runs once per mount
    // instead of unsubscribing/resubscribing on every scrubber tick.
    const hourRef = useRef(currentTimeHours);
    useEffect(() => {
        hourRef.current = currentTimeHours;
    }, [currentTimeHours]);

    const feedWindData = useCallback(() => {
        const layer = windLayerRef.current;
        if (!layer) {
            return;
        }

        const { grid } = WindStore.getState();
        if (!grid) {
            return;
        }

        log.info(
            `[SpatiotemporalMap] Feeding wind data: ${grid.width}×${grid.height} to layer at hour=${hourRef.current}`,
        );
        layer.setGrid(grid, hourRef.current);
    }, []);

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
        const mapInstance = mapRef.current;
        return () => {
            const map = mapInstance?.getMap();
            if (map && windLayerRef.current) {
                try {
                    map.removeLayer(windLayerRef.current.id);
                } catch (e) {
                    log.warn(' ok:', e);
                }
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
                longitude: 153.108,
                latitude: -27.207,
                zoom: 14,
            }}
            onLoad={onLoad}
            mapStyle={OCEAN_STYLE}
            style={{ width: '100%', height: '100%' }}
            attributionControl
        >
            {/* Corridor polygons removed — Trip Sandwich uses simple direct lines */}

            {/* ═══ HARBOUR STITCHING LEGS (dashed sky-blue) ═══ */}
            {departureHarbourGeoJSON && (
                <Source id="departure-harbour" type="geojson" data={departureHarbourGeoJSON}>
                    <Layer id="dep-harbour-glow" type="line" paint={HARBOUR_GLOW_PAINT} />
                    <Layer id="dep-harbour-line" type="line" paint={HARBOUR_LINE_PAINT} />
                </Source>
            )}
            {arrivalHarbourGeoJSON && (
                <Source id="arrival-harbour" type="geojson" data={arrivalHarbourGeoJSON}>
                    <Layer id="arr-harbour-glow" type="line" paint={HARBOUR_GLOW_PAINT} />
                    <Layer id="arr-harbour-line" type="line" paint={HARBOUR_LINE_PAINT} />
                </Source>
            )}

            {/* ═══ OCEAN ROUTE (solid glowing line) ═══ */}
            {oceanRouteGeoJSON && (
                <Source id="passage-route" type="geojson" data={oceanRouteGeoJSON}>
                    {/* Layer 1: Outer Halo (the glow) */}
                    <Layer id="route-halo" type="line" paint={ROUTE_HALO_PAINT} />

                    {/* Layer 2: Mid glow */}
                    <Layer id="route-glow" type="line" paint={ROUTE_GLOW_PAINT} />

                    {/* Layer 3: Core line (crisp white-cyan) */}
                    <Layer id="route-core" type="line" paint={ROUTE_CORE_PAINT} />
                </Source>
            )}

            {/* ═══ WAYPOINT MARKERS — Departure + Arrival ═══ */}
            {track &&
                track.length > 0 && [
                    <Marker
                        key="wp-dep"
                        longitude={track[0].coordinates[0]}
                        latitude={track[0].coordinates[1]}
                        anchor="top"
                    >
                        <div style={{ transform: 'translateX(20px)' }}>
                            <WaypointBadge point={track[0]} index={0} total={track.length} />
                        </div>
                    </Marker>,
                    <Marker
                        key="wp-arr"
                        longitude={track[track.length - 1].coordinates[0]}
                        latitude={track[track.length - 1].coordinates[1]}
                        anchor="bottom"
                    >
                        <div style={{ transform: 'translateX(20px)' }}>
                            <WaypointBadge
                                point={track[track.length - 1]}
                                index={track.length - 1}
                                total={track.length}
                            />
                        </div>
                    </Marker>,
                ]}

            {/* ═══ GHOST SHIP ═══ */}
            {ghostShip && (
                <Marker longitude={ghostShip.position[0]} latitude={ghostShip.position[1]} anchor="center">
                    <VesselIcon bearing={ghostShip.bearing} />
                </Marker>
            )}
        </Map>
    );
};

export default SpatiotemporalMap;

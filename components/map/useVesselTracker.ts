/**
 * useVesselTracker — Live vessel position layer using BgGeoManager.
 *
 * Shows a rotatable vessel icon on the map that updates in real-time
 * from the BackgroundGeolocation plugin. Includes heading indicator,
 * SOG display, accuracy ring, and a fading wake trail.
 *
 * Falls back to GpsService.watchPosition on web (no BgGeo).
 */
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import { BgGeoManager, type CachedPosition } from '../../services/BgGeoManager';
import { GpsService } from '../../services/GpsService';
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('VesselTracker');

// ── Trail config ──
const MAX_TRAIL_POINTS = 500; // Trim beyond this to keep memory in check
const MIN_TRAIL_DISTANCE_M = 5; // Don't add points closer than 5m (noise filter)

/**
 * Haversine distance in metres between two lat/lon pairs.
 */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Source/layer IDs ──
const TRAIL_SOURCE = 'vessel-trail';
const TRAIL_LAYER = 'vessel-trail-line';
const TRAIL_GLOW_LAYER = 'vessel-trail-glow';

/**
 * Build the vessel marker DOM element.
 * Directional arrow + accuracy ring + SOG badge.
 */
function createVesselElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'vessel-tracker-marker';
    el.style.cssText = `
        width: 48px; height: 48px;
        position: relative;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
    `;

    // Accuracy ring (outer pulse)
    const ring = document.createElement('div');
    ring.className = 'vessel-accuracy-ring';
    ring.style.cssText = `
        position: absolute; inset: -8px;
        border-radius: 50%;
        border: 2px solid rgba(56, 189, 248, 0.2);
        background: rgba(56, 189, 248, 0.06);
        animation: vesselPulse 3s ease-in-out infinite;
    `;
    el.appendChild(ring);

    // Vessel arrow (rotates with heading)
    const arrow = document.createElement('div');
    arrow.className = 'vessel-arrow';
    arrow.style.cssText = `
        width: 28px; height: 28px;
        position: relative; z-index: 2;
        transition: transform 0.5s ease-out;
    `;
    arrow.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L4 20L12 16L20 20L12 2Z" fill="url(#vesselGrad)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
            <defs>
                <linearGradient id="vesselGrad" x1="12" y1="2" x2="12" y2="20" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#38bdf8"/>
                    <stop offset="1" stop-color="#0284c7"/>
                </linearGradient>
            </defs>
        </svg>
    `;
    el.appendChild(arrow);

    // SOG badge (bottom)
    const badge = document.createElement('div');
    badge.className = 'vessel-sog-badge';
    badge.style.cssText = `
        position: absolute; bottom: -16px; left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 8px;
        padding: 1px 6px;
        font-size: 9px; font-weight: 800;
        color: #38bdf8;
        white-space: nowrap;
        letter-spacing: 0.05em;
        backdrop-filter: blur(8px);
        z-index: 3;
    `;
    badge.textContent = '0.0 kts';
    el.appendChild(badge);

    return el;
}

// ── Trail layer setup ──

function ensureTrailLayers(map: mapboxgl.Map) {
    if (map.getSource(TRAIL_SOURCE)) return;

    map.addSource(TRAIL_SOURCE, {
        type: 'geojson',
        lineMetrics: true,
        data: { type: 'FeatureCollection', features: [] },
    });

    // Glow layer (wide, soft, behind the main line)
    map.addLayer({
        id: TRAIL_GLOW_LAYER,
        type: 'line',
        source: TRAIL_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#38bdf8',
            'line-width': 8,
            'line-opacity': 0.15,
            'line-blur': 6,
        },
    });

    // Main trail line
    map.addLayer({
        id: TRAIL_LAYER,
        type: 'line',
        source: TRAIL_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#38bdf8',
            'line-width': 2.5,
            'line-opacity': [
                'interpolate',
                ['linear'],
                ['line-progress'],
                0,
                0.1, // oldest point — nearly transparent
                1,
                0.8, // newest point — solid
            ],
        },
    });
}

function removeTrailLayers(map: mapboxgl.Map) {
    if (map.getLayer(TRAIL_LAYER)) map.removeLayer(TRAIL_LAYER);
    if (map.getLayer(TRAIL_GLOW_LAYER)) map.removeLayer(TRAIL_GLOW_LAYER);
    if (map.getSource(TRAIL_SOURCE)) map.removeSource(TRAIL_SOURCE);
}

function updateTrailData(map: mapboxgl.Map, coords: [number, number][]) {
    const src = map.getSource(TRAIL_SOURCE) as mapboxgl.GeoJSONSource;
    if (!src || coords.length < 2) return;

    src.setData({
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: coords,
                },
            },
        ],
    });
}

// ── Hook ──

export function useVesselTracker(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean) {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const elementRef = useRef<HTMLDivElement | null>(null);
    const lastHeadingRef = useRef<number>(0);
    const trailCoordsRef = useRef<[number, number][]>([]);

    const updateMarker = useCallback(
        (pos: CachedPosition) => {
            const map = mapRef.current;
            if (!map || !visible) return;

            const { latitude, longitude, heading, speed } = pos;

            // ── Marker ──
            if (!markerRef.current) {
                const el = createVesselElement();
                elementRef.current = el;
                markerRef.current = new mapboxgl.Marker({
                    element: el,
                    anchor: 'center',
                    rotationAlignment: 'map',
                    pitchAlignment: 'map',
                })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
                log.info('Vessel marker created');
            } else {
                markerRef.current.setLngLat([longitude, latitude]);
            }

            // Heading
            const arrowEl = elementRef.current?.querySelector('.vessel-arrow') as HTMLElement;
            if (arrowEl) {
                const h = heading ?? lastHeadingRef.current;
                if (heading !== null) lastHeadingRef.current = heading;
                arrowEl.style.transform = `rotate(${h}deg)`;
            }

            // SOG badge
            const badgeEl = elementRef.current?.querySelector('.vessel-sog-badge') as HTMLElement;
            if (badgeEl) {
                const sogKts = (speed ?? 0) * 1.94384;
                badgeEl.textContent = sogKts < 0.3 ? 'Anchored' : `${sogKts.toFixed(1)} kts`;
                badgeEl.style.color = sogKts < 0.3 ? '#94a3b8' : '#38bdf8';
            }

            // ── Trail ──
            const trail = trailCoordsRef.current;
            const newPt: [number, number] = [longitude, latitude];

            // Noise filter: skip if too close to last point
            if (trail.length > 0) {
                const last = trail[trail.length - 1];
                const dist = haversineM(last[1], last[0], latitude, longitude);
                if (dist < MIN_TRAIL_DISTANCE_M) return;
            }

            trail.push(newPt);

            // Trim old points
            if (trail.length > MAX_TRAIL_POINTS) {
                trail.splice(0, trail.length - MAX_TRAIL_POINTS);
            }

            // Ensure trail source exists
            ensureTrailLayers(map);
            updateTrailData(map, trail);
        },
        [mapRef, visible],
    );

    useEffect(() => {
        if (!mapReady || !visible) {
            // Remove marker + trail when layer is toggled off
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            const map = mapRef.current;
            if (map) removeTrailLayers(map);
            // Keep trail coords in memory so they reappear on re-toggle
            return;
        }

        let unsub: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            BgGeoManager.ensureReady()
                .then(() => {
                    const cached = BgGeoManager.getLastPosition();
                    if (cached) updateMarker(cached);

                    unsub = BgGeoManager.subscribeLocation((pos) => {
                        updateMarker(pos);
                    });
                })
                .catch((e) => log.warn('BgGeo not available:', e));
        } else {
            unsub = GpsService.watchPosition((pos) => {
                updateMarker({
                    latitude: pos.latitude,
                    longitude: pos.longitude,
                    accuracy: pos.accuracy ?? 50,
                    altitude: null,
                    heading: null,
                    speed: 0,
                    timestamp: Date.now(),
                    receivedAt: Date.now(),
                });
            });
        }

        return () => {
            unsub?.();
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            const map = mapRef.current;
            if (map) removeTrailLayers(map);
        };
    }, [mapReady, visible, updateMarker]);

    // Fly-to-vessel
    const flyToVessel = useCallback(() => {
        const map = mapRef.current;
        if (!map) return;

        const pos = BgGeoManager.getLastPosition();
        if (pos) {
            map.flyTo({
                center: [pos.longitude, pos.latitude],
                zoom: 14,
                duration: 1200,
                essential: true,
            });
        } else {
            GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then((p) => {
                if (p) {
                    map.flyTo({
                        center: [p.longitude, p.latitude],
                        zoom: 14,
                        duration: 1200,
                        essential: true,
                    });
                }
            });
        }
    }, [mapRef]);

    // Clear the trail history
    const clearTrail = useCallback(() => {
        trailCoordsRef.current = [];
        const map = mapRef.current;
        if (map) {
            const src = map.getSource(TRAIL_SOURCE) as mapboxgl.GeoJSONSource;
            if (src) src.setData({ type: 'FeatureCollection', features: [] });
        }
    }, [mapRef]);

    return { flyToVessel, clearTrail };
}

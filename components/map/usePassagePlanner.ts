/**
 * usePassagePlanner — Passage route computation and UI state.
 *
 * Encapsulates:
 *   - Departure / arrival / speed / departure time state
 *   - Route computation (great-circle → isochrone upgrade)
 *   - Trip Sandwich GeoJSON rendering
 *   - Sea buoy gate finding
 *   - Waypoint detection
 *   - GPX export
 *   - Clear route
 */

import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('usePassagePlanner');
import mapboxgl from 'mapbox-gl';
import { computeRoute, type RouteWaypoint, type RouteAnalysis } from '../../services/WeatherRoutingService';
import {
    computeIsochrones,
    isochroneToGeoJSON,
    detectTurnWaypoints,
    type IsochroneResult,
    type TurnWaypoint,
} from '../../services/IsochroneRouter';
import { preloadBathymetry } from '../../services/BathymetryCache';
import { createWindFieldFromGrid } from '../../services/weather/WindFieldAdapter';
import { DEFAULT_CRUISING_POLAR } from '../../services/defaultPolar';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { findSeaBuoy } from '../../services/seaBuoyFinder';
import { SeamarkService } from '../../services/SeamarkService';
import { routeChannel, type ChannelRouteResult } from '../../services/ChannelRouter';
import { WindStore } from '../../stores/WindStore';
import { WindDataController } from '../../services/weather/WindDataController';
import { triggerHaptic } from '../../utils/system';
import { Preferences } from '@capacitor/preferences';
import type { ComfortParams } from '../../types/settings';
import { generateComfortZoneOverlay, hasActiveComfortLimits } from '../../services/ComfortZoneEngine';

// ── Helper: Convert channel route to depth-coloured GeoJSON features ──

function buildChannelLegFeatures(
    channelRoute: ChannelRouteResult | null,
    start: { lat: number; lon: number },
    end: { lat: number; lon: number },
    _label: 'departure' | 'arrival',
): any[] {
    // Fallback: straight dashed line (legacy behaviour)
    if (!channelRoute || !channelRoute.seamarkAssisted || channelRoute.waypoints.length < 2) {
        return [
            {
                type: 'Feature',
                properties: { safety: 'harbour', dashed: true },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [start.lon, start.lat],
                        [end.lon, end.lat],
                    ],
                },
            },
        ];
    }

    // Build depth-coloured segments — group consecutive waypoints by safety class
    const features: any[] = [];
    const wps = channelRoute.waypoints;
    let segStart = 0;

    for (let i = 1; i <= wps.length; i++) {
        const prevSafety = wps[i - 1].safety;
        const currSafety = i < wps.length ? wps[i].safety : null;

        if (currSafety !== prevSafety || i === wps.length) {
            // End of a segment — emit GeoJSON feature
            const coords = wps.slice(segStart, i).map((wp) => [wp.lon, wp.lat]);
            // Need at least 2 points for a LineString
            if (coords.length >= 2) {
                features.push({
                    type: 'Feature',
                    properties: {
                        safety: prevSafety === 'land' ? 'danger' : prevSafety,
                        channelRouted: true,
                    },
                    geometry: { type: 'LineString', coordinates: coords },
                });
            }
            segStart = i > 0 ? i - 1 : 0; // Overlap by 1 point for continuity
        }
    }

    // If no features were generated, fall back to straight line
    if (features.length === 0) {
        return [
            {
                type: 'Feature',
                properties: { safety: 'harbour', dashed: true },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [start.lon, start.lat],
                        [end.lon, end.lat],
                    ],
                },
            },
        ];
    }

    return features;
}

export interface PassageState {
    departure: { lat: number; lon: number; name: string } | null;
    arrival: { lat: number; lon: number; name: string } | null;
    departureTime: string;
    speed: number;
    routeAnalysis: RouteAnalysis | null;
    settingPoint: 'departure' | 'arrival' | null;
    showPassage: boolean;
}

export function usePassagePlanner(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean) {
    const [departure, setDeparture] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [arrival, setArrival] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [departureTime, setDepartureTime] = useState('');
    const [speed, setSpeed] = useState(6);
    const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysis | null>(null);
    const [settingPoint, setSettingPoint] = useState<'departure' | 'arrival' | null>(null);
    const [showPassage, setShowPassage] = useState(false);
    const isoResultRef = useRef<IsochroneResult | null>(null);
    const turnWaypointsRef = useRef<TurnWaypoint[]>([]);
    const computeGenRef = useRef(0); // generation counter — prevents stale writes

    // ── Passage mode activation (from Ship's Office / RoutePlanner → MAP tab) ──
    useEffect(() => {
        const handlePassageMode = (e: Event) => {
            setShowPassage(true);
            const detail = (e as CustomEvent)?.detail;
            if (detail?.departure) {
                setDeparture(detail.departure);
            } else {
                setDeparture(null);
            }
            if (detail?.arrival) {
                setArrival(detail.arrival);
            } else {
                setArrival(null);
            }
            setRouteAnalysis(null);
        };
        window.addEventListener('thalassa:passage-mode', handlePassageMode);
        return () => window.removeEventListener('thalassa:passage-mode', handlePassageMode);
    }, []);

    // ── Helper: project a point along bearing by distance ──
    const project = (lat: number, lon: number, bearingDeg: number, distNM: number) => {
        const R = 3440.065;
        const d = distNM / R;
        const brng = (bearingDeg * Math.PI) / 180;
        const φ1 = (lat * Math.PI) / 180;
        const λ1 = (lon * Math.PI) / 180;
        const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(brng));
        const λ2 =
            λ1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
        return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
    };

    // ── Passage Route Computation ──
    const computePassage = useCallback(async () => {
        if (!departure || !arrival) return;
        triggerHaptic('medium');

        // Increment generation — invalidates any previous in-flight computation
        const gen = ++computeGenRef.current;

        // Clear previous results immediately so stale data isn't displayed
        isoResultRef.current = null;
        turnWaypointsRef.current = [];

        const map = mapRef.current;
        if (!map) {
            log.warn('[Passage] No map ref');
            return;
        }

        // Forward / reverse bearings (needed for both short and long route paths)
        const dLon = ((arrival.lon - departure.lon) * Math.PI) / 180;
        const φ1 = (departure.lat * Math.PI) / 180;
        const φ2 = (arrival.lat * Math.PI) / 180;
        const fwdBearing =
            (Math.atan2(
                Math.sin(dLon) * Math.cos(φ2),
                Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon),
            ) *
                180) /
            Math.PI;
        const dLonRev = ((departure.lon - arrival.lon) * Math.PI) / 180;
        const revBearing =
            (Math.atan2(
                Math.sin(dLonRev) * Math.cos(φ1),
                Math.cos(φ2) * Math.sin(φ1) - Math.sin(φ2) * Math.cos(φ1) * Math.cos(dLonRev),
            ) *
                180) /
            Math.PI;

        // ── Short route detection: skip sea buoy gates for < 100 NM ──
        const R_NM = 3440.065;
        const straightLineNM = (() => {
            const dLat = ((arrival.lat - departure.lat) * Math.PI) / 180;
            const dLonH = ((arrival.lon - departure.lon) * Math.PI) / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLonH / 2) ** 2;
            return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        })();
        const isShortRoute = straightLineNM < 100;
        const VESSEL_DRAFT_M = 2.5; // IsochroneConfig default
        const minDepthM = isShortRoute ? VESSEL_DRAFT_M + 1 : null;

        log.info(
            `[Passage] Distance: ${Math.round(straightLineNM)} NM — ${isShortRoute ? 'SHORT (coastal mode, minDepth=' + minDepthM + 'm)' : 'LONG (ocean mode, trip sandwich)'}`,
        );

        // Find deep-water gates (skip for short routes)
        let depGate: { lat: number; lon: number };
        let arrGate: { lat: number; lon: number };

        if (isShortRoute) {
            // Short route: use departure/arrival directly (no sea buoy gates)
            depGate = { lat: departure.lat, lon: departure.lon };
            arrGate = { lat: arrival.lat, lon: arrival.lon };
        } else {
            const FALLBACK_NM = 5;
            const SEA_BUOY_TIMEOUT_MS = 10_000; // 10s max for sea buoy search
            try {
                const seaBuoyPromise = Promise.all([
                    findSeaBuoy(departure.lat, departure.lon, arrival.lat, arrival.lon),
                    findSeaBuoy(arrival.lat, arrival.lon, departure.lat, departure.lon),
                ]);
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('SeaBuoy search timeout')), SEA_BUOY_TIMEOUT_MS),
                );
                const [depBuoy, arrBuoy] = await Promise.race([seaBuoyPromise, timeoutPromise]);
                console.info(
                    `[SeaBuoy] Dep: ${depBuoy.alreadyDeep ? 'already deep' : depBuoy.offsetNM > 0 ? `${depBuoy.offsetNM}NM → ${depBuoy.depth_m}m` : 'FAILED'}`,
                    `| Arr: ${arrBuoy.alreadyDeep ? 'already deep' : arrBuoy.offsetNM > 0 ? `${arrBuoy.offsetNM}NM → ${arrBuoy.depth_m}m` : 'FAILED'}`,
                );
                depGate =
                    depBuoy.offsetNM > 0 || depBuoy.alreadyDeep
                        ? { lat: depBuoy.lat, lon: depBuoy.lon }
                        : project(departure.lat, departure.lon, fwdBearing, FALLBACK_NM);
                arrGate =
                    arrBuoy.offsetNM > 0 || arrBuoy.alreadyDeep
                        ? { lat: arrBuoy.lat, lon: arrBuoy.lon }
                        : project(arrival.lat, arrival.lon, revBearing, FALLBACK_NM);
            } catch (err) {
                log.warn('[SeaBuoy] Search failed or timed out, using geometric fallback:', err);
                // Project 50NM in 3 directions: perpendicular left, perpendicular right, and reverse.
                // Pick the one farthest from the coast (farthest from BOTH departure and arrival).
                const FALLBACK_DIST_NM = 50;
                const findOffshoreGate = (
                    lat: number,
                    lon: number,
                    routeBearing: number,
                    otherLat: number,
                    otherLon: number,
                ) => {
                    const candidates = [
                        { ...project(lat, lon, (routeBearing - 90 + 360) % 360, FALLBACK_DIST_NM), dir: 'perp-left' },
                        { ...project(lat, lon, (routeBearing + 90) % 360, FALLBACK_DIST_NM), dir: 'perp-right' },
                        { ...project(lat, lon, (routeBearing + 180) % 360, FALLBACK_DIST_NM), dir: 'reverse' },
                    ];
                    // Pick the candidate farthest from the OTHER end (most likely open ocean)
                    let best = candidates[0],
                        bestDist = 0;
                    for (const c of candidates) {
                        const dLat = c.lat - otherLat;
                        const dLon = c.lon - otherLon;
                        const dist = dLat * dLat + dLon * dLon;
                        if (dist > bestDist) {
                            bestDist = dist;
                            best = c;
                        }
                    }
                    log.info(`[SeaBuoy] Geometric fallback: ${best.dir} at ${FALLBACK_DIST_NM}NM`);
                    return { lat: best.lat, lon: best.lon };
                };
                depGate = findOffshoreGate(departure.lat, departure.lon, fwdBearing, arrival.lat, arrival.lon);
                arrGate = findOffshoreGate(arrival.lat, arrival.lon, revBearing, departure.lat, departure.lon);
            }
        }

        log.info(`[Passage] Departure gate: ${depGate.lat.toFixed(3)}, ${depGate.lon.toFixed(3)}`);
        log.info(`[Passage] Arrival gate: ${arrGate.lat.toFixed(3)}, ${arrGate.lon.toFixed(3)}`);

        // ── Smart Harbour Approach: Channel routing for harbour legs ──
        let depChannelRoute: ChannelRouteResult | null = null;
        let arrChannelRoute: ChannelRouteResult | null = null;
        const seamarkFeaturesRef: { dep: any[]; arr: any[] } = { dep: [], arr: [] };

        if (!isShortRoute) {
            const CHANNEL_TIMEOUT_MS = 15_000;
            try {
                log.info('[ChannelRouter] Fetching seamarks for harbour approaches...');
                const channelPromise = (async () => {
                    // Fetch seamarks for departure and arrival areas in parallel
                    const [depMarks, arrMarks] = await Promise.all([
                        SeamarkService.fetchNearby(departure.lat, departure.lon, 5),
                        SeamarkService.fetchNearby(arrival.lat, arrival.lon, 5),
                    ]);
                    seamarkFeaturesRef.dep = depMarks.features;
                    seamarkFeaturesRef.arr = arrMarks.features;

                    log.info(
                        `[ChannelRouter] Dep seamarks: ${depMarks.features.length}, Arr seamarks: ${arrMarks.features.length}`,
                    );

                    // Run channel routing for both legs in parallel
                    const [depRoute, arrRoute] = await Promise.all([
                        depMarks.features.length > 0
                            ? routeChannel(
                                  departure.lat,
                                  departure.lon,
                                  depGate.lat,
                                  depGate.lon,
                                  VESSEL_DRAFT_M,
                                  depMarks,
                              )
                            : null,
                        arrMarks.features.length > 0
                            ? routeChannel(arrGate.lat, arrGate.lon, arrival.lat, arrival.lon, VESSEL_DRAFT_M, arrMarks)
                            : null,
                    ]);

                    return { depRoute, arrRoute };
                })();

                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Channel routing timeout')), CHANNEL_TIMEOUT_MS),
                );

                const result = await Promise.race([channelPromise, timeoutPromise]);
                depChannelRoute = result.depRoute;
                arrChannelRoute = result.arrRoute;

                if (depChannelRoute?.seamarkAssisted) {
                    log.info(
                        `[ChannelRouter] Dep channel: ${depChannelRoute.waypoints.length} waypoints, ${depChannelRoute.totalDistanceNM.toFixed(1)} NM, min depth ${depChannelRoute.minDepth_m}m`,
                    );
                }
                if (arrChannelRoute?.seamarkAssisted) {
                    log.info(
                        `[ChannelRouter] Arr channel: ${arrChannelRoute.waypoints.length} waypoints, ${arrChannelRoute.totalDistanceNM.toFixed(1)} NM, min depth ${arrChannelRoute.minDepth_m}m`,
                    );
                }
            } catch (err) {
                log.warn('[ChannelRouter] Channel routing failed, using straight-line harbour legs:', err);
                // Graceful degradation — straight lines still work
            }

            // Add seamark data to map (non-blocking)
            try {
                const seamarkSrc = map.getSource('harbour-seamarks') as mapboxgl.GeoJSONSource;
                if (seamarkSrc && (seamarkFeaturesRef.dep.length > 0 || seamarkFeaturesRef.arr.length > 0)) {
                    const allMarks = [...seamarkFeaturesRef.dep, ...seamarkFeaturesRef.arr];
                    seamarkSrc.setData({ type: 'FeatureCollection', features: allMarks } as any);
                }
            } catch {
                /* seamark source may not exist yet */
            }
        }

        // Great-circle passage
        const gcCoords: number[][] = [];
        const NUM_POINTS = 80;
        for (let i = 0; i <= NUM_POINTS; i++) {
            const f = i / NUM_POINTS;
            const lat1R = (depGate.lat * Math.PI) / 180;
            const lon1R = (depGate.lon * Math.PI) / 180;
            const lat2R = (arrGate.lat * Math.PI) / 180;
            const lon2R = (arrGate.lon * Math.PI) / 180;
            const d = Math.acos(
                Math.sin(lat1R) * Math.sin(lat2R) + Math.cos(lat1R) * Math.cos(lat2R) * Math.cos(lon2R - lon1R),
            );
            if (d < 1e-10) {
                gcCoords.push([depGate.lon, depGate.lat]);
                continue;
            }
            const A = Math.sin((1 - f) * d) / Math.sin(d);
            const B = Math.sin(f * d) / Math.sin(d);
            const x = A * Math.cos(lat1R) * Math.cos(lon1R) + B * Math.cos(lat2R) * Math.cos(lon2R);
            const y = A * Math.cos(lat1R) * Math.sin(lon1R) + B * Math.cos(lat2R) * Math.sin(lon2R);
            const z = A * Math.sin(lat1R) + B * Math.sin(lat2R);
            const lat = (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI;
            const lon = (Math.atan2(y, x) * 180) / Math.PI;
            gcCoords.push([lon, lat]);
        }

        // Route stats
        const waypoints: RouteWaypoint[] = [
            { id: 'dep', lat: departure.lat, lon: departure.lon, name: departure.name },
            { id: 'arr', lat: arrival.lat, lon: arrival.lon, name: arrival.name },
        ];
        const result = computeRoute(waypoints, {
            speed,
            departureTime: departureTime ? new Date(departureTime) : new Date(),
        });
        setRouteAnalysis(result);

        // Build Trip Sandwich GeoJSON (or single-feature for short routes)
        const buildFeatures = (
            passageCoords: number[][],
            shallowFlags?: boolean[],
        ): GeoJSON.Feature<GeoJSON.LineString>[] => {
            // ── Short route: depth-aware per-segment coloring ──
            if (isShortRoute && shallowFlags && shallowFlags.length === passageCoords.length) {
                const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
                let segStart = 0;
                let wasShallow = shallowFlags[0] || false;

                for (let i = 1; i < passageCoords.length; i++) {
                    const nowShallow = shallowFlags[i] || false;
                    if (nowShallow !== wasShallow || i === passageCoords.length - 1) {
                        // Close the current segment
                        const endIdx = i === passageCoords.length - 1 ? i + 1 : i + 1;
                        features.push({
                            type: 'Feature',
                            properties: { safety: wasShallow ? 'danger' : 'safe' },
                            geometry: { type: 'LineString', coordinates: passageCoords.slice(segStart, endIdx) },
                        });
                        segStart = i;
                        wasShallow = nowShallow;
                    }
                }

                // Ensure at least one feature
                if (features.length === 0) {
                    features.push({
                        type: 'Feature',
                        properties: { safety: 'safe' },
                        geometry: { type: 'LineString', coordinates: passageCoords },
                    });
                }
                return features;
            }

            // ── Short route without depth data yet: single safe feature ──
            if (isShortRoute) {
                return [
                    {
                        type: 'Feature',
                        properties: { safety: 'safe' },
                        geometry: { type: 'LineString', coordinates: passageCoords },
                    },
                ];
            }

            // ── Long route: Trip Sandwich (harbour → safe → harbour) ──
            // Build harbour legs — use channel-routed legs if available, else straight lines
            const depLegFeatures = buildChannelLegFeatures(depChannelRoute, departure, depGate, 'departure');
            const arrLegFeatures = buildChannelLegFeatures(
                arrChannelRoute,
                { lat: arrGate.lat, lon: arrGate.lon },
                { lat: arrival.lat, lon: arrival.lon },
                'arrival',
            );

            return [
                ...depLegFeatures,
                {
                    type: 'Feature',
                    properties: { safety: 'safe' },
                    geometry: { type: 'LineString', coordinates: passageCoords },
                },
                ...arrLegFeatures,
            ];
        };

        // Only show great-circle line for short-ish routes where it's likely ocean-only.
        // For very long routes (> 500 NM) the great-circle may go through continents — hide it.
        const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSrc) {
            if (straightLineNM < 500) {
                routeSrc.setData({ type: 'FeatureCollection', features: buildFeatures(gcCoords) } as any);
                log.info(`[Passage] Trip Sandwich rendered (great-circle)`);
            } else {
                routeSrc.setData({ type: 'FeatureCollection', features: [] } as any);
            }
        }

        // Waypoint markers
        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) {
            wpSource.setData({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature' as const,
                        properties: { name: departure.name || 'Departure', color: '#10b981' },
                        geometry: { type: 'Point' as const, coordinates: [departure.lon, departure.lat] },
                    },
                    {
                        type: 'Feature' as const,
                        properties: { name: arrival.name || 'Arrival', color: '#ef4444' },
                        geometry: { type: 'Point' as const, coordinates: [arrival.lon, arrival.lat] },
                    },
                ],
            });
        }

        // Fit bounds
        const bounds = new mapboxgl.LngLatBounds();
        bounds.extend([departure.lon, departure.lat]);
        bounds.extend([arrival.lon, arrival.lat]);
        map.fitBounds(bounds, { padding: 80, duration: 1000 });

        // Background: isochrone weather routing upgrade
        setTimeout(async () => {
            log.info('[Isochrone BG] ── Background isochrone task started ──');
            try {
                // ── Check precompute cache first (fired from CTA press) ──
                try {
                    const { getPrecomputedRoute } = await import('../../services/IsochronePrecomputeCache');
                    const cached = getPrecomputedRoute(depGate.lat, depGate.lon, arrGate.lat, arrGate.lon);
                    if (cached && cached.routeCoordinates.length >= 2) {
                        if (computeGenRef.current !== gen) return;
                        log.info(`[Isochrone BG] ✓ Using pre-computed route: ${cached.totalDistanceNM} NM`);
                        isoResultRef.current = cached;
                        const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                        if (src) {
                            src.setData({
                                type: 'FeatureCollection',
                                features: buildFeatures(cached.routeCoordinates, cached.shallowFlags),
                            } as any);
                        }
                        const depTimeStr2 = departureTime || new Date().toISOString();
                        const { detectTurnWaypoints } = await import('../../services/IsochroneRouter');
                        const wps = detectTurnWaypoints(cached.route, depTimeStr2);
                        turnWaypointsRef.current = wps;
                        const wpSource2 = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
                        if (wpSource2) {
                            wpSource2.setData({
                                type: 'FeatureCollection',
                                features: wps.map((wp) => ({
                                    type: 'Feature' as const,
                                    properties: {
                                        name: wp.id,
                                        distanceNM: wp.distanceNM,
                                        bearing: wp.bearing,
                                        eta: wp.eta,
                                        color: wp.id === 'DEP' ? '#10b981' : wp.id === 'ARR' ? '#ef4444' : '#f59e0b',
                                    },
                                    geometry: { type: 'Point' as const, coordinates: [wp.lon, wp.lat] },
                                })),
                            });
                        }
                        const updatedResult2 = { ...result };
                        updatedResult2.totalDistance = cached.totalDistanceNM;
                        updatedResult2.estimatedDuration = cached.totalDurationHours;
                        setRouteAnalysis(updatedResult2);
                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } }),
                            );
                        } catch (_) {}
                        return; // Done — skip fresh computation
                    }
                } catch {
                    /* Cache not available — continue with fresh computation */
                }

                // Emit initial progress so UI shows something immediately
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-progress', {
                            detail: {
                                step: 0,
                                closestNM: Math.round(straightLineNM),
                                totalDistNM: Math.round(straightLineNM),
                                elapsed: 0,
                                frontSize: 0,
                                phase: 'loading-wind',
                            },
                        }),
                    );
                } catch (_) {}

                const windState = WindStore.getState();
                let windGrid = windState.grid;

                if (!windGrid && map) {
                    log.info('[Isochrone BG] Loading wind data...');
                    await WindDataController.activate(map);
                    await new Promise((r) => setTimeout(r, 500));
                    windGrid = WindStore.getState().grid;
                }

                // Check if existing grid covers the full route bounding box.
                // For long passages (e.g. Newport→Perth), the viewport-based grid
                // won't cover areas the wavefront needs to explore.
                const routeMinLat = Math.min(depGate.lat, arrGate.lat);
                const routeMaxLat = Math.max(depGate.lat, arrGate.lat);
                const routeMinLon = Math.min(depGate.lon, arrGate.lon);
                const routeMaxLon = Math.max(depGate.lon, arrGate.lon);
                const gridCoversRoute =
                    windGrid &&
                    windGrid.south <= routeMinLat - 10 &&
                    windGrid.north >= routeMaxLat + 5 &&
                    windGrid.west <= routeMinLon - 5 &&
                    windGrid.east >= routeMaxLon + 5;

                if (!gridCoversRoute) {
                    log.info('[Isochrone BG] Wind grid does not cover full route — fetching route-covering grid...');
                    try {
                        const supabaseUrl =
                            (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL) || '';
                        const supabaseKey =
                            (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_KEY) || '';
                        if (supabaseUrl) {
                            // Pad generously: 15° south (wavefront goes around continents), 5° other dirs
                            const fetchBounds = {
                                north: Math.min(90, routeMaxLat + 10),
                                south: Math.max(-90, routeMinLat - 15),
                                east: Math.min(180, routeMaxLon + 10),
                                west: Math.max(-180, routeMinLon - 10),
                            };
                            const resp = await fetch(`${supabaseUrl}/functions/v1/fetch-wind-grid`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    ...(supabaseKey
                                        ? { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
                                        : {}),
                                },
                                body: JSON.stringify(fetchBounds),
                            });
                            if (resp.ok) {
                                const buffer = await resp.arrayBuffer();
                                if (buffer.byteLength > 200) {
                                    const { decodeGrib2Wind } = await import('../../services/weather/decodeGrib2Wind');
                                    const grib = decodeGrib2Wind(buffer);
                                    const size = grib.width * grib.height;
                                    const speedArr = new Float32Array(size);
                                    for (let i = 0; i < size; i++)
                                        speedArr[i] = Math.sqrt(grib.u[i] ** 2 + grib.v[i] ** 2);
                                    const uniqueLats: number[] = [];
                                    const uniqueLons: number[] = [];
                                    const latStep = (grib.north - grib.south) / (grib.height - 1);
                                    const lonStep = (grib.east - grib.west) / (grib.width - 1);
                                    for (let r = 0; r < grib.height; r++) uniqueLats.push(grib.south + r * latStep);
                                    for (let c = 0; c < grib.width; c++) uniqueLons.push(grib.west + c * lonStep);
                                    windGrid = {
                                        u: [grib.u],
                                        v: [grib.v],
                                        speed: [speedArr],
                                        width: grib.width,
                                        height: grib.height,
                                        lats: uniqueLats,
                                        lons: uniqueLons,
                                        north: grib.north,
                                        south: grib.south,
                                        west: grib.west,
                                        east: grib.east,
                                        totalHours: 1,
                                    };
                                    WindStore.setGrid(windGrid);
                                    log.info(
                                        `[Isochrone BG] Route-covering GFS GRIB loaded: ${grib.width}×${grib.height}`,
                                    );
                                }
                            }
                        }
                    } catch (err) {
                        log.warn(
                            '[Isochrone BG] Route-covering wind fetch failed, continuing with available data:',
                            err,
                        );
                    }
                }

                if (!windGrid) {
                    log.info('[Isochrone BG] No wind data — keeping great-circle');
                    return;
                }

                const windField = createWindFieldFromGrid(windGrid);
                const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;
                const depTimeStr = departureTime || new Date().toISOString();

                log.info('[Isochrone BG] Preloading bathymetry grid...');
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-progress', {
                            detail: {
                                step: 0,
                                closestNM: Math.round(straightLineNM),
                                totalDistNM: Math.round(straightLineNM),
                                elapsed: 0,
                                frontSize: 0,
                                phase: 'loading-bathy',
                            },
                        }),
                    );
                } catch (_) {}
                // Use coarser 0.25° grid (stride=15) for the engine — fine 0.1° traps
                // wavefronts in reef-enclosed areas like Townsville/GBR.
                // pushRouteOffshore post-processing still catches land clips via 2NM sampling.
                const bathyGrid = await preloadBathymetry(depGate, arrGate, 15);

                log.info('[Isochrone BG] Running isochrone engine...');
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-progress', {
                            detail: {
                                step: 0,
                                closestNM: Math.round(straightLineNM),
                                totalDistNM: Math.round(straightLineNM),
                                elapsed: 0,
                                frontSize: 0,
                                phase: 'computing',
                            },
                        }),
                    );
                } catch (_) {}

                // ── Read comfort params from persisted settings ──
                let comfortParams: ComfortParams | undefined;
                try {
                    const { value } = await Preferences.get({ key: 'thalassa_settings' });
                    if (value) {
                        const parsed = JSON.parse(value);
                        if (parsed.comfortParams && hasActiveComfortLimits(parsed.comfortParams)) {
                            comfortParams = parsed.comfortParams;
                            log.info(
                                `[Isochrone BG] Comfort Zone active — wind:${comfortParams!.maxWindKts ?? 'off'} wave:${comfortParams!.maxWaveM ?? 'off'} gust:${comfortParams!.maxGustKts ?? 'off'}`,
                            );
                        }
                    }
                } catch {
                    /* Settings read failed — proceed without comfort limits */
                }

                const isoConfig = {
                    ...(minDepthM != null ? { minDepthM } : {}),
                    ...(comfortParams ? { comfortParams } : {}),
                };
                let isoResult = await computeIsochrones(
                    depGate,
                    arrGate,
                    depTimeStr,
                    polar,
                    windField,
                    isoConfig,
                    bathyGrid,
                );

                if (isoResult && isoResult.routeCoordinates.length >= 2) {
                    // Stale guard: only apply if this is still the current computation
                    if (computeGenRef.current !== gen) {
                        log.info('[Isochrone BG] Stale computation (gen mismatch) — discarding');
                        return;
                    }
                    log.info(
                        `[Isochrone BG] ✓ Route: ${isoResult.totalDistanceNM} NM, ${isoResult.totalDurationHours}h, ${isoResult.routeCoordinates.length} waypoints`,
                    );
                    isoResultRef.current = isoResult;

                    const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                    if (src) {
                        src.setData({
                            type: 'FeatureCollection',
                            features: buildFeatures(isoResult.routeCoordinates, isoResult.shallowFlags),
                        } as any);
                    }

                    const depTimeStr2 = departureTime || new Date().toISOString();
                    const wps = detectTurnWaypoints(isoResult.route, depTimeStr2);
                    turnWaypointsRef.current = wps;
                    log.info(`[Waypoints] Detected ${wps.length} waypoints (incl. DEP/ARR)`);

                    const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
                    if (wpSource) {
                        wpSource.setData({
                            type: 'FeatureCollection',
                            features: wps.map((wp) => ({
                                type: 'Feature' as const,
                                properties: {
                                    name: wp.id,
                                    distanceNM: wp.distanceNM,
                                    bearing: wp.bearing,
                                    eta: wp.eta,
                                    color: wp.id === 'DEP' ? '#10b981' : wp.id === 'ARR' ? '#ef4444' : '#f59e0b',
                                },
                                geometry: { type: 'Point' as const, coordinates: [wp.lon, wp.lat] },
                            })),
                        });
                    }

                    const updatedResult = { ...result };
                    updatedResult.totalDistance = isoResult.totalDistanceNM;
                    updatedResult.estimatedDuration = isoResult.totalDurationHours;
                    setRouteAnalysis(updatedResult);

                    // ── Render Decision Fan (isochrone wavefront rings) ──
                    if (isoResult.isochrones.length > 0) {
                        try {
                            const geoData = isochroneToGeoJSON(isoResult);

                            // Remove previous fan layers/sources
                            if (map.getLayer('isochrone-fan-layer')) map.removeLayer('isochrone-fan-layer');
                            if (map.getLayer('isochrone-time-labels')) map.removeLayer('isochrone-time-labels');
                            if (map.getSource('isochrone-fan')) map.removeSource('isochrone-fan');
                            if (map.getSource('isochrone-labels')) map.removeSource('isochrone-labels');

                            // Wavefront rings: thin white streamlines
                            map.addSource('isochrone-fan', { type: 'geojson', data: geoData.wavefronts });
                            map.addLayer(
                                {
                                    id: 'isochrone-fan-layer',
                                    type: 'line',
                                    source: 'isochrone-fan',
                                    paint: {
                                        'line-color': '#ffffff',
                                        'line-opacity': 0.12,
                                        'line-width': 1,
                                        'line-dasharray': [2, 4],
                                    },
                                },
                                'route-line-layer',
                            ); // Below route

                            // Time labels at key intervals (12h, 24h, 48h, etc.)
                            const timeLabels = geoData.wavefronts.features
                                .filter((f: any) => {
                                    const h = f.properties?.timeHours;
                                    return (
                                        h === 12 ||
                                        h === 24 ||
                                        h === 48 ||
                                        h === 72 ||
                                        h === 96 ||
                                        h === 120 ||
                                        h === 168
                                    );
                                })
                                .map((f: any) => {
                                    // Place label at the midpoint of each wavefront ring
                                    const coords = f.geometry.coordinates;
                                    const midIdx = Math.floor(coords.length / 2);
                                    const h = f.properties.timeHours;
                                    const label = h < 24 ? `${h}H` : `${Math.round(h / 24)}D`;
                                    return {
                                        type: 'Feature' as const,
                                        properties: { label, timeHours: h },
                                        geometry: { type: 'Point' as const, coordinates: coords[midIdx] },
                                    };
                                });

                            if (timeLabels.length > 0) {
                                map.addSource('isochrone-labels', {
                                    type: 'geojson',
                                    data: { type: 'FeatureCollection', features: timeLabels },
                                });
                                map.addLayer({
                                    id: 'isochrone-time-labels',
                                    type: 'symbol',
                                    source: 'isochrone-labels',
                                    layout: {
                                        'text-field': ['get', 'label'],
                                        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                                        'text-size': 11,
                                        'text-anchor': 'center',
                                        'text-allow-overlap': true,
                                    },
                                    paint: {
                                        'text-color': 'rgba(255, 255, 255, 0.5)',
                                        'text-halo-color': 'rgba(0, 0, 0, 0.6)',
                                        'text-halo-width': 1,
                                    },
                                });
                            }
                            log.info(
                                `[DecisionFan] Rendered ${geoData.wavefronts.features.length} wavefronts, ${timeLabels.length} time labels`,
                            );
                        } catch (fanErr) {
                            log.warn('[DecisionFan] Rendering failed:', fanErr);
                        }
                    }

                    // ── Render Comfort Zone overlay (red glow on dangerous areas) ──
                    if (windGrid && comfortParams && hasActiveComfortLimits(comfortParams)) {
                        try {
                            const czResult = generateComfortZoneOverlay(windGrid, comfortParams);
                            if (czResult) {
                                // Remove existing comfort zone layer/source
                                if (map.getLayer('comfort-zone-layer')) map.removeLayer('comfort-zone-layer');
                                if (map.getSource('comfort-zone')) map.removeSource('comfort-zone');

                                map.addSource('comfort-zone', {
                                    type: 'image',
                                    url: czResult.imageDataUrl,
                                    coordinates: [
                                        [czResult.bounds[0], czResult.bounds[3]], // top-left
                                        [czResult.bounds[2], czResult.bounds[3]], // top-right
                                        [czResult.bounds[2], czResult.bounds[1]], // bottom-right
                                        [czResult.bounds[0], czResult.bounds[1]], // bottom-left
                                    ],
                                });
                                map.addLayer(
                                    {
                                        id: 'comfort-zone-layer',
                                        type: 'raster',
                                        source: 'comfort-zone',
                                        paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 300 },
                                    },
                                    'route-line-layer',
                                ); // Insert BELOW route line
                                log.info(
                                    `[ComfortZone] Rendered overlay — ${czResult.dangerPercent}% breach, max ${czResult.maxBreachWindKts} kts`,
                                );
                            }
                        } catch (czErr) {
                            log.warn('[ComfortZone] Overlay rendering failed:', czErr);
                        }
                    }
                    // ── Multi-Model Confidence Braid ──
                    // Run a second route through ECMWF and compare with the GFS route
                    if (isoResult && isoResult.routeCoordinates.length >= 2 && !isShortRoute) {
                        try {
                            log.info('[ConfidenceBraid] Starting multi-model comparison...');
                            try {
                                window.dispatchEvent(
                                    new CustomEvent('thalassa:isochrone-progress', {
                                        detail: { phase: 'multi-model' },
                                    }),
                                );
                            } catch (_) {}

                            const { fetchModelWindGrid } = await import('../../services/weather/OpenMeteoWindFetcher');

                            // Compute route bbox with padding for alternative paths
                            const routeBounds = {
                                north: Math.min(90, Math.max(depGate.lat, arrGate.lat) + 10),
                                south: Math.max(-90, Math.min(depGate.lat, arrGate.lat) - 10),
                                east: Math.min(180, Math.max(depGate.lon, arrGate.lon) + 10),
                                west: Math.max(-180, Math.min(depGate.lon, arrGate.lon) - 10),
                            };

                            // Fetch ECMWF wind grid (GFS route already computed above)
                            const ecmwfGrid = await fetchModelWindGrid('ecmwf', routeBounds, 168);

                            if (ecmwfGrid && computeGenRef.current === gen) {
                                const { createWindFieldFromGrid } =
                                    await import('../../services/weather/WindFieldAdapter');
                                const ecmwfWind = createWindFieldFromGrid(ecmwfGrid);

                                // Run ECMWF route
                                const ecmwfRoute = await computeIsochrones(
                                    depGate,
                                    arrGate,
                                    depTimeStr,
                                    polar,
                                    ecmwfWind,
                                    isoConfig,
                                    bathyGrid,
                                );

                                if (
                                    ecmwfRoute &&
                                    ecmwfRoute.routeCoordinates.length >= 2 &&
                                    computeGenRef.current === gen
                                ) {
                                    log.info(
                                        `[ConfidenceBraid] ECMWF route: ${ecmwfRoute.totalDistanceNM}NM vs GFS: ${isoResult.totalDistanceNM}NM`,
                                    );

                                    // ── Compare routes using closest-point matching ──
                                    // For each ECMWF waypoint, find the closest GFS waypoint.
                                    // If that distance > threshold, the routes diverge there.
                                    // Uses ORIGINAL coordinates (not resampled) to avoid
                                    // creating straight-line shortcuts that cross land.
                                    const R_NM2 = 3440.065;
                                    const toRad2 = (d: number) => (d * Math.PI) / 180;
                                    const hav = (la1: number, lo1: number, la2: number, lo2: number) => {
                                        const dLat = toRad2(la2 - la1),
                                            dLon = toRad2(lo2 - lo1);
                                        const a =
                                            Math.sin(dLat / 2) ** 2 +
                                            Math.cos(toRad2(la1)) * Math.cos(toRad2(la2)) * Math.sin(dLon / 2) ** 2;
                                        return R_NM2 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                                    };

                                    const DIVERGE_NM = 5;
                                    const ecmwfCoords = ecmwfRoute.routeCoordinates;
                                    const gfsCoords = isoResult.routeCoordinates;

                                    // Render: show the FULL ECMWF route as magenta
                                    // Where routes agree, lines overlap (natural braid)
                                    // Where routes diverge, lines split apart visually
                                    const ecmwfSrc = map.getSource('confidence-route-ecmwf') as mapboxgl.GeoJSONSource;
                                    const gfsSrc = map.getSource('confidence-route-gfs') as mapboxgl.GeoJSONSource;

                                    if (ecmwfSrc) {
                                        ecmwfSrc.setData({
                                            type: 'FeatureCollection',
                                            features: [
                                                {
                                                    type: 'Feature' as const,
                                                    properties: { model: 'ECMWF' },
                                                    geometry: { type: 'LineString' as const, coordinates: ecmwfCoords },
                                                },
                                            ],
                                        });
                                    }
                                    // Clear GFS source — primary gold route already shows GFS path
                                    if (gfsSrc) {
                                        gfsSrc.setData({ type: 'FeatureCollection', features: [] });
                                    }

                                    // Count divergent points for logging
                                    let divergentCount = 0;
                                    for (let i = 0; i < ecmwfCoords.length; i++) {
                                        let minDist = Infinity;
                                        for (let j = 0; j < gfsCoords.length; j++) {
                                            const d = hav(
                                                ecmwfCoords[i][1],
                                                ecmwfCoords[i][0],
                                                gfsCoords[j][1],
                                                gfsCoords[j][0],
                                            );
                                            if (d < minDist) minDist = d;
                                            if (d < DIVERGE_NM) break;
                                        }
                                        if (minDist > DIVERGE_NM) divergentCount++;
                                    }
                                    const totalDivergentPct =
                                        ecmwfCoords.length > 0
                                            ? Math.round((divergentCount / ecmwfCoords.length) * 100)
                                            : 0;
                                    log.info(
                                        `[ConfidenceBraid] ✓ ECMWF full route rendered, ${totalDivergentPct}% divergent`,
                                    );
                                } else {
                                    log.info('[ConfidenceBraid] ECMWF route failed — showing GFS only');
                                }
                            }
                        } catch (braidErr) {
                            log.warn('[ConfidenceBraid] Multi-model comparison failed:', braidErr);
                        }
                    }

                    try {
                        window.dispatchEvent(
                            new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } }),
                        );
                    } catch (_) {}
                } else {
                    // ── Multi-leg split: try routing via an intermediate point ──
                    log.info('[Isochrone BG] Direct route failed — attempting multi-leg split...');
                    try {
                        window.dispatchEvent(
                            new CustomEvent('thalassa:isochrone-progress', {
                                detail: {
                                    step: 0,
                                    closestNM: Math.round(straightLineNM),
                                    totalDistNM: Math.round(straightLineNM),
                                    elapsed: 0,
                                    frontSize: 0,
                                    phase: 'multi-leg',
                                },
                            }),
                        );
                    } catch (_) {}

                    // Find intermediate: go well south (or north) of both points for open ocean
                    const southernMost = Math.min(depGate.lat, arrGate.lat);
                    const intermediateLat = southernMost - 8; // 8° south of southernmost point
                    const intermediateLon = (depGate.lon + arrGate.lon) / 2;
                    const intermediate = { lat: intermediateLat, lon: intermediateLon };
                    log.info(
                        `[Isochrone BG] Multi-leg intermediate: ${intermediateLat.toFixed(1)}°, ${intermediateLon.toFixed(1)}°`,
                    );

                    // Load separate bathy grids for each leg
                    const bathyGrid1 = await preloadBathymetry(depGate, intermediate, 15);
                    const bathyGrid2 = await preloadBathymetry(intermediate, arrGate, 15);

                    // Run Leg 1: departure → intermediate
                    log.info('[Isochrone BG] Running Leg 1...');
                    const leg1 = await computeIsochrones(
                        depGate,
                        intermediate,
                        depTimeStr,
                        polar,
                        windField,
                        isoConfig,
                        bathyGrid1,
                    );

                    // Run Leg 2: intermediate → arrival
                    log.info('[Isochrone BG] Running Leg 2...');
                    const leg2DepTime = leg1?.arrivalTime || depTimeStr;
                    const leg2 = await computeIsochrones(
                        intermediate,
                        arrGate,
                        leg2DepTime,
                        polar,
                        windField,
                        isoConfig,
                        bathyGrid2,
                    );

                    if (leg1 && leg2 && leg1.routeCoordinates.length >= 2 && leg2.routeCoordinates.length >= 2) {
                        log.info(
                            `[Isochrone BG] ✓ Multi-leg route: Leg1=${leg1.totalDistanceNM}NM + Leg2=${leg2.totalDistanceNM}NM`,
                        );
                        // Stitch the two legs together
                        const combinedCoords = [...leg1.routeCoordinates, ...leg2.routeCoordinates.slice(1)];
                        const combinedFlags = [...leg1.shallowFlags, ...leg2.shallowFlags.slice(1)];
                        const combinedRoute = [...leg1.route, ...leg2.route.slice(1)];

                        isoResult = {
                            route: combinedRoute,
                            isochrones: [...leg1.isochrones, ...leg2.isochrones],
                            totalDistanceNM: Math.round((leg1.totalDistanceNM + leg2.totalDistanceNM) * 10) / 10,
                            totalDurationHours:
                                Math.round((leg1.totalDurationHours + leg2.totalDurationHours) * 10) / 10,
                            arrivalTime: leg2.arrivalTime,
                            routeCoordinates: combinedCoords,
                            shallowFlags: combinedFlags,
                        };

                        // Display the stitched route
                        if (computeGenRef.current === gen) {
                            isoResultRef.current = isoResult;
                            const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                            if (src) {
                                src.setData({
                                    type: 'FeatureCollection',
                                    features: buildFeatures(combinedCoords, combinedFlags),
                                } as any);
                            }
                            const updatedResult = { ...result };
                            updatedResult.totalDistance = isoResult.totalDistanceNM;
                            updatedResult.estimatedDuration = isoResult.totalDurationHours;
                            setRouteAnalysis(updatedResult);
                        }
                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } }),
                            );
                        } catch (_) {}
                    } else {
                        log.warn('[Isochrone BG] Multi-leg also failed — clearing route line');
                        const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                        if (src) {
                            src.setData({ type: 'FeatureCollection', features: [] } as any);
                        }
                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } }),
                            );
                        } catch (_) {}
                    }
                }
            } catch (err) {
                log.warn('[Isochrone BG] Failed — keeping great-circle:', err);
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } }),
                    );
                } catch (_) {}
            }
        }, 100);
    }, [departure, arrival, speed, departureTime]);

    // Auto-compute when both points set + map ready
    useEffect(() => {
        if (mapReady && showPassage && departure && arrival) {
            computePassage().catch((err) => {
                log.error('[Passage] computePassage failed:', err);
                setRouteAnalysis(null);
            });
        }
    }, [mapReady, showPassage, departure, arrival, computePassage]);

    // Listen for route nudge events (via-point drag from useRouteNudge)
    useEffect(() => {
        const handleNudge = (e: Event) => {
            const detail = (e as CustomEvent).detail as { lat: number; lon: number };
            if (!detail || !departure || !arrival) return;
            log.info(`[Nudge] Via-point received: ${detail.lat.toFixed(4)}, ${detail.lon.toFixed(4)} — recomputing`);

            // Recompute passage with via-point as intermediate arrival/departure
            // Strategy: compute DEP→VIA then VIA→ARR and stitch
            const viaName = `Via ${detail.lat.toFixed(2)}°, ${detail.lon.toFixed(2)}°`;
            const viaPoint = { lat: detail.lat, lon: detail.lon, name: viaName };

            // Set arrival to via-point temporarily, then chain to final arrival
            // Simplest approach: just set arrival to via-point, which triggers recompute
            // For true multi-leg, we'd need a waypoints array — for now, nudge resets arrival
            // to the via-point and the user can re-set the final destination.
            // Better approach: fire a custom recompute that routes DEP → VIA → ARR
            // For MVP, we'll just trigger a recompute with the user's nudge creating
            // a new arrival, letting them adjust from there.

            // Actually, the best UX: recompute the full route but add the via-point
            // as a required waypoint. Since we don't have full via-point support yet,
            // we'll insert it as the new departure (shifting original dep to stored state).
            // For now, trigger a clean recomputation:
            setArrival(viaPoint);
            // After recompute settles, the user sees the route to the via-point
            // and can reset their actual destination.
        };

        window.addEventListener('thalassa:route-nudge', handleNudge);
        return () => window.removeEventListener('thalassa:route-nudge', handleNudge);
    }, [departure, arrival]);

    // Clear route
    const clearRoute = useCallback(() => {
        setDeparture(null);
        setArrival(null);
        setRouteAnalysis(null);
        setDepartureTime('');
        isoResultRef.current = null;
        turnWaypointsRef.current = [];
        computeGenRef.current++; // Invalidate any running computation

        const map = mapRef.current;
        if (!map) return;

        const routeSource = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSource) routeSource.setData({ type: 'FeatureCollection', features: [] });

        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) wpSource.setData({ type: 'FeatureCollection', features: [] });

        // Clean up comfort zone overlay
        if (map.getLayer('comfort-zone-layer')) map.removeLayer('comfort-zone-layer');
        if (map.getSource('comfort-zone')) map.removeSource('comfort-zone');

        // Clean up Decision Fan layers
        if (map.getLayer('isochrone-fan-layer')) map.removeLayer('isochrone-fan-layer');
        if (map.getLayer('isochrone-time-labels')) map.removeLayer('isochrone-time-labels');
        if (map.getSource('isochrone-fan')) map.removeSource('isochrone-fan');
        if (map.getSource('isochrone-labels')) map.removeSource('isochrone-labels');
    }, []);

    return {
        departure,
        setDeparture,
        arrival,
        setArrival,
        departureTime,
        setDepartureTime,
        speed,
        setSpeed,
        routeAnalysis,
        setRouteAnalysis,
        settingPoint,
        setSettingPoint,
        showPassage,
        setShowPassage,
        isoResultRef,
        turnWaypointsRef,
        computePassage,
        clearRoute,
    };
}

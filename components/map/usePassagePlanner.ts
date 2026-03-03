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
import mapboxgl from 'mapbox-gl';
import {
    computeRoute,
    type RouteWaypoint,
    type RouteAnalysis,
} from '../../services/WeatherRoutingService';
import { computeIsochrones, isochroneToGeoJSON, detectTurnWaypoints, type IsochroneResult, type TurnWaypoint } from '../../services/IsochroneRouter';
import { preloadBathymetry } from '../../services/BathymetryCache';
import { createWindFieldFromGrid } from '../../services/weather/WindFieldAdapter';
import { DEFAULT_CRUISING_POLAR } from '../../services/defaultPolar';
import { SmartPolarStore } from '../../services/SmartPolarStore';
import { findSeaBuoy } from '../../services/seaBuoyFinder';
import { WindStore } from '../../stores/WindStore';
import { WindDataController } from '../../services/weather/WindDataController';
import { triggerHaptic } from '../../utils/system';

export interface PassageState {
    departure: { lat: number; lon: number; name: string } | null;
    arrival: { lat: number; lon: number; name: string } | null;
    departureTime: string;
    speed: number;
    routeAnalysis: RouteAnalysis | null;
    settingPoint: 'departure' | 'arrival' | null;
    showPassage: boolean;
}

export function usePassagePlanner(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
) {
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
        const λ2 = λ1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
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
        if (!map) { console.warn('[Passage] No map ref'); return; }

        // Forward / reverse bearings (needed for both short and long route paths)
        const dLon = ((arrival.lon - departure.lon) * Math.PI) / 180;
        const φ1 = (departure.lat * Math.PI) / 180;
        const φ2 = (arrival.lat * Math.PI) / 180;
        const fwdBearing = (Math.atan2(
            Math.sin(dLon) * Math.cos(φ2),
            Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon)
        ) * 180) / Math.PI;
        const dLonRev = ((departure.lon - arrival.lon) * Math.PI) / 180;
        const revBearing = (Math.atan2(
            Math.sin(dLonRev) * Math.cos(φ1),
            Math.cos(φ2) * Math.sin(φ1) - Math.sin(φ2) * Math.cos(φ1) * Math.cos(dLonRev)
        ) * 180) / Math.PI;

        // ── Short route detection: skip sea buoy gates for < 100 NM ──
        const R_NM = 3440.065;
        const straightLineNM = (() => {
            const dLat = ((arrival.lat - departure.lat) * Math.PI) / 180;
            const dLonH = ((arrival.lon - departure.lon) * Math.PI) / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLonH / 2) ** 2;
            return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        })();
        const isShortRoute = straightLineNM < 100;
        const VESSEL_DRAFT_M = 2.5; // IsochroneConfig default
        const minDepthM = isShortRoute ? VESSEL_DRAFT_M + 1 : null;

        console.info(`[Passage] Distance: ${Math.round(straightLineNM)} NM — ${isShortRoute ? 'SHORT (coastal mode, minDepth=' + minDepthM + 'm)' : 'LONG (ocean mode, trip sandwich)'}`);

        // Find deep-water gates (skip for short routes)
        let depGate: { lat: number; lon: number };
        let arrGate: { lat: number; lon: number };

        if (isShortRoute) {
            // Short route: use departure/arrival directly (no sea buoy gates)
            depGate = { lat: departure.lat, lon: departure.lon };
            arrGate = { lat: arrival.lat, lon: arrival.lon };
        } else {
            const FALLBACK_NM = 5;
            try {
                const [depBuoy, arrBuoy] = await Promise.all([
                    findSeaBuoy(departure.lat, departure.lon, arrival.lat, arrival.lon),
                    findSeaBuoy(arrival.lat, arrival.lon, departure.lat, departure.lon),
                ]);
                console.info(
                    `[SeaBuoy] Dep: ${depBuoy.alreadyDeep ? 'already deep' : depBuoy.offsetNM > 0 ? `${depBuoy.offsetNM}NM → ${depBuoy.depth_m}m` : 'FAILED'}`,
                    `| Arr: ${arrBuoy.alreadyDeep ? 'already deep' : arrBuoy.offsetNM > 0 ? `${arrBuoy.offsetNM}NM → ${arrBuoy.depth_m}m` : 'FAILED'}`,
                );
                depGate = depBuoy.offsetNM > 0 || depBuoy.alreadyDeep
                    ? { lat: depBuoy.lat, lon: depBuoy.lon }
                    : project(departure.lat, departure.lon, fwdBearing, FALLBACK_NM);
                arrGate = arrBuoy.offsetNM > 0 || arrBuoy.alreadyDeep
                    ? { lat: arrBuoy.lat, lon: arrBuoy.lon }
                    : project(arrival.lat, arrival.lon, revBearing, FALLBACK_NM);
            } catch (err) {
                console.warn('[SeaBuoy] Search failed, using geometric fallback:', err);
                depGate = project(departure.lat, departure.lon, fwdBearing, FALLBACK_NM);
                arrGate = project(arrival.lat, arrival.lon, revBearing, FALLBACK_NM);
            }
        }

        console.info(`[Passage] Departure gate: ${depGate.lat.toFixed(3)}, ${depGate.lon.toFixed(3)}`);
        console.info(`[Passage] Arrival gate: ${arrGate.lat.toFixed(3)}, ${arrGate.lon.toFixed(3)}`);

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
                Math.sin(lat1R) * Math.sin(lat2R) +
                Math.cos(lat1R) * Math.cos(lat2R) * Math.cos(lon2R - lon1R)
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
                        const endIdx = (i === passageCoords.length - 1) ? i + 1 : i + 1;
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
                return [{
                    type: 'Feature',
                    properties: { safety: 'safe' },
                    geometry: { type: 'LineString', coordinates: passageCoords },
                }];
            }

            // ── Long route: Trip Sandwich (harbour → safe → harbour) ──
            return [
                {
                    type: 'Feature',
                    properties: { safety: 'harbour', dashed: true },
                    geometry: { type: 'LineString', coordinates: [[departure.lon, departure.lat], [depGate.lon, depGate.lat]] },
                },
                {
                    type: 'Feature',
                    properties: { safety: 'safe' },
                    geometry: { type: 'LineString', coordinates: passageCoords },
                },
                {
                    type: 'Feature',
                    properties: { safety: 'harbour', dashed: true },
                    geometry: { type: 'LineString', coordinates: [[arrGate.lon, arrGate.lat], [arrival.lon, arrival.lat]] },
                },
            ];
        };

        // Render immediately with great-circle
        const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSrc) {
            routeSrc.setData({ type: 'FeatureCollection', features: buildFeatures(gcCoords) } as any);
            console.info(`[Passage] Trip Sandwich rendered (great-circle)`);
        }

        // Waypoint markers
        const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
        if (wpSource) {
            wpSource.setData({
                type: 'FeatureCollection',
                features: [
                    { type: 'Feature' as const, properties: { name: departure.name || 'Departure', color: '#10b981' }, geometry: { type: 'Point' as const, coordinates: [departure.lon, departure.lat] } },
                    { type: 'Feature' as const, properties: { name: arrival.name || 'Arrival', color: '#ef4444' }, geometry: { type: 'Point' as const, coordinates: [arrival.lon, arrival.lat] } },
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
            try {
                // ── Check precompute cache first (fired from CTA press) ──
                try {
                    const { getPrecomputedRoute } = await import('../../services/IsochronePrecomputeCache');
                    const cached = getPrecomputedRoute(depGate.lat, depGate.lon, arrGate.lat, arrGate.lon);
                    if (cached && cached.routeCoordinates.length >= 2) {
                        if (computeGenRef.current !== gen) return;
                        console.info(`[Isochrone BG] ✓ Using pre-computed route: ${cached.totalDistanceNM} NM`);
                        isoResultRef.current = cached;
                        const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                        if (src) {
                            src.setData({ type: 'FeatureCollection', features: buildFeatures(cached.routeCoordinates, cached.shallowFlags) } as any);
                        }
                        const depTimeStr2 = departureTime || new Date().toISOString();
                        const { detectTurnWaypoints } = await import('../../services/IsochroneRouter');
                        const wps = detectTurnWaypoints(cached.route, depTimeStr2);
                        turnWaypointsRef.current = wps;
                        const wpSource2 = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
                        if (wpSource2) {
                            wpSource2.setData({
                                type: 'FeatureCollection',
                                features: wps.map(wp => ({
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
                        try { window.dispatchEvent(new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } })); } catch (_) { }
                        return; // Done — skip fresh computation
                    }
                } catch { /* Cache not available — continue with fresh computation */ }

                const windState = WindStore.getState();
                let windGrid = windState.grid;

                if (!windGrid && map) {
                    console.info('[Isochrone BG] Loading wind data...');
                    await WindDataController.activate(map);
                    await new Promise(r => setTimeout(r, 500));
                    windGrid = WindStore.getState().grid;
                }

                if (!windGrid) {
                    console.info('[Isochrone BG] No wind data — keeping great-circle');
                    return;
                }

                const windField = createWindFieldFromGrid(windGrid);
                const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;
                const depTimeStr = departureTime || new Date().toISOString();

                console.info('[Isochrone BG] Preloading bathymetry grid...');
                const bathyGrid = await preloadBathymetry(depGate, arrGate);

                console.info('[Isochrone BG] Running isochrone engine...');
                const isoConfig = minDepthM != null ? { minDepthM } : {};
                const isoResult = await computeIsochrones(
                    depGate, arrGate, depTimeStr, polar, windField, isoConfig, bathyGrid,
                );

                if (isoResult && isoResult.routeCoordinates.length >= 2) {
                    // Stale guard: only apply if this is still the current computation
                    if (computeGenRef.current !== gen) {
                        console.info('[Isochrone BG] Stale computation (gen mismatch) — discarding');
                        return;
                    }
                    console.info(`[Isochrone BG] ✓ Route: ${isoResult.totalDistanceNM} NM, ${isoResult.totalDurationHours}h, ${isoResult.routeCoordinates.length} waypoints`);
                    isoResultRef.current = isoResult;

                    const src = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                    if (src) {
                        src.setData({ type: 'FeatureCollection', features: buildFeatures(isoResult.routeCoordinates, isoResult.shallowFlags) } as any);
                    }

                    const depTimeStr2 = departureTime || new Date().toISOString();
                    const wps = detectTurnWaypoints(isoResult.route, depTimeStr2);
                    turnWaypointsRef.current = wps;
                    console.info(`[Waypoints] Detected ${wps.length} waypoints (incl. DEP/ARR)`);

                    const wpSource = map.getSource('waypoints') as mapboxgl.GeoJSONSource;
                    if (wpSource) {
                        wpSource.setData({
                            type: 'FeatureCollection',
                            features: wps.map(wp => ({
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
                    try { window.dispatchEvent(new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } })); } catch (_) { }
                } else {
                    console.warn('[Isochrone BG] No route found — keeping great-circle');
                    try { window.dispatchEvent(new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } })); } catch (_) { }
                }
            } catch (err) {
                console.warn('[Isochrone BG] Failed — keeping great-circle:', err);
                try { window.dispatchEvent(new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } })); } catch (_) { }
            }
        }, 100);
    }, [departure, arrival, speed, departureTime]);

    // Auto-compute when both points set + map ready
    useEffect(() => {
        if (mapReady && showPassage && departure && arrival) {
            computePassage().catch(err => {
                console.error('[Passage] computePassage failed:', err);
                setRouteAnalysis(null);
            });
        }
    }, [mapReady, showPassage, departure, arrival, computePassage]);

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
    }, []);

    return {
        departure, setDeparture,
        arrival, setArrival,
        departureTime, setDepartureTime,
        speed, setSpeed,
        routeAnalysis, setRouteAnalysis,
        settingPoint, setSettingPoint,
        showPassage, setShowPassage,
        isoResultRef, turnWaypointsRef,
        computePassage,
        clearRoute,
    };
}

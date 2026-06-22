/**
 * @filesize-justified Single hook managing tightly-coupled passage planning state (route, waypoints, weather, timing).
 */
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
import { withDeadline, withTimeout } from '../../utils/deadline';

const log = createLogger('usePassagePlanner');
import mapboxgl from 'mapbox-gl';
import {
    computeRoute,
    type RouteWaypoint,
    type RouteAnalysis,
    type RouteSegment,
} from '../../services/WeatherRoutingService';
import {
    computeIsochrones,
    isochroneToGeoJSON,
    detectTurnWaypoints,
    type IsochroneResult,
    type TurnWaypoint,
} from '../../services/IsochroneRouter';
import type { IsochroneNode } from '../../services/isochrone/types';
import { preloadBathymetry } from '../../services/BathymetryCache';
import { createWindFieldFromGrid } from '../../services/weather/WindFieldAdapter';
import { DEFAULT_CRUISING_POLAR } from '../../services/defaultPolar';
import { SmartPolarStore } from '../../services/SmartPolarStore';

import { WindStore } from '../../stores/WindStore';
import { PassageStore, type PassageLeg } from '../../stores/PassageStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindDataController } from '../../services/weather/WindDataController';
import { triggerHaptic } from '../../utils/system';
import { Preferences } from '@capacitor/preferences';
import type { ComfortParams } from '../../types/settings';
import { generateComfortZoneOverlay, hasActiveComfortLimits } from '../../services/ComfortZoneEngine';
import { vesselDraftMetres } from '../../services/units';

export interface PassageState {
    departure: { lat: number; lon: number; name: string } | null;
    arrival: { lat: number; lon: number; name: string } | null;
    viaWaypoints: { lat: number; lon: number; name: string }[];
    departureTime: string;
    speed: number;
    routeAnalysis: RouteAnalysis | null;
    settingPoint: 'departure' | 'arrival' | null;
    showPassage: boolean;
}

/** Status/notice band content rendered by PassageBanner. */
export interface PassageNotice {
    severity: 'info' | 'warn';
    title: string;
    message: string;
}

/**
 * Every inshore outcome must be user-visible (field bug 2026-06-12:
 * strict-mode refusals and the too-short bail produced a blank map with
 * no feedback — indistinguishable from a hang). MapHub listens and
 * PassageBanner renders; null clears the band.
 */
function dispatchPassageNotice(notice: PassageNotice | null): void {
    try {
        window.dispatchEvent(new CustomEvent('thalassa:passage-notice', { detail: notice }));
    } catch {
        /* not fatal */
    }
}

/** Push computed route data to the global PassageStore for the Nav Station page */
function pushToPassageStore(
    isoResult: IsochroneResult,
    wps: TurnWaypoint[],
    dep: { lat: number; lon: number; name: string },
    arr: { lat: number; lon: number; name: string },
    analysis: RouteAnalysis,
    depTime: string,
    speedKts: number,
) {
    const routeMaxWindKt = analysis.maxWindSpeed ?? 0;
    const routeMaxWaveM = analysis.maxWaveHeight ?? 0;

    // Build legs from consecutive turn waypoints
    const legs: PassageLeg[] = [];
    for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        const legMaxWind = Math.max(a.tws, b.tws);
        // Estimate wave height proportional to wind strength relative to route max
        const windRatio = routeMaxWindKt > 0 ? legMaxWind / routeMaxWindKt : 0;
        const legMaxWave = Math.round(routeMaxWaveM * Math.min(1, windRatio * 1.2) * 10) / 10;

        legs.push({
            from: a.id === 'DEP' ? dep.name : a.id,
            to: b.id === 'ARR' ? arr.name : b.id,
            bearing: b.bearing,
            distanceNM: Math.round((b.distanceNM - a.distanceNM) * 10) / 10,
            durationHours: Math.round((b.timeHours - a.timeHours) * 10) / 10,
            avgWindKt: Math.round((a.tws + b.tws) / 2),
            maxWindKt: Math.round(legMaxWind),
            avgWaveM: Math.round(legMaxWave * 0.7 * 10) / 10,
            maxWaveM: legMaxWave,
            difficulty: 'easy', // Auto-computed by setFromRoute
            difficultyReason: '',
        });
    }

    PassageStore.setFromRoute({
        routeName: `${dep.name} \u2192 ${arr.name}`,
        departPort: dep.name,
        destPort: arr.name,
        departLat: dep.lat,
        departLon: dep.lon,
        arriveLat: arr.lat,
        arriveLon: arr.lon,
        routeCoordinates: isoResult.routeCoordinates,
        turnWaypoints: wps.map((wp) => ({
            id: wp.id,
            name: wp.id === 'DEP' ? dep.name : wp.id === 'ARR' ? arr.name : `Turn ${wp.id.replace('WP', '')}`,
            lat: wp.lat,
            lon: wp.lon,
            bearing: wp.bearing,
            distanceNM: wp.distanceNM,
            timeHours: wp.timeHours,
            eta: wp.eta,
            tws: wp.tws,
            twa: wp.twa,
        })),
        legs,
        totalDistanceNM: isoResult.totalDistanceNM,
        totalDurationHours: isoResult.totalDurationHours,
        departureTime: depTime,
        arrivalTime: isoResult.arrivalTime,
        maxWindKt: analysis.maxWindSpeed,
        maxWaveM: analysis.maxWaveHeight,
        avgSpeedKts: analysis.averageSpeed || speedKts,
    });

    log.info(
        `[PassageStore] Pushed route: ${dep.name} \u2192 ${arr.name}, ${isoResult.totalDistanceNM}NM, ${wps.length} waypoints, ${legs.length} legs`,
    );
}

export function usePassagePlanner(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean) {
    const [departure, setDeparture] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [arrival, setArrival] = useState<{ lat: number; lon: number; name: string } | null>(null);
    const [viaWaypoints, setViaWaypoints] = useState<{ lat: number; lon: number; name: string }[]>([]);
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

            // ── Kill Follow Route layers IMMEDIATELY on passage activation ──
            // Must happen synchronously before React re-renders — the Follow
            // Route uses identical dashed sky-blue styling and hooks have timing gaps.
            const map = mapRef.current;
            if (map) {
                const ids = [
                    'follow-route-markers-labels',
                    'follow-route-markers-circle',
                    'follow-route-active-line',
                    'follow-route-previous-line',
                ];
                const srcs = ['follow-route-active', 'follow-route-previous', 'follow-route-markers'];
                for (const id of ids) {
                    try {
                        if (map.getLayer(id)) map.removeLayer(id);
                    } catch {
                        /* */
                    }
                }
                for (const id of srcs) {
                    try {
                        if (map.getSource(id)) map.removeSource(id);
                    } catch {
                        /* */
                    }
                }
            }

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
            // Accept intermediate waypoints from GPX import
            if (detail?.via && Array.isArray(detail.via)) {
                setViaWaypoints(detail.via);
                log.info(`[Passage] Received ${detail.via.length} via waypoints from GPX import`);
            } else {
                setViaWaypoints([]);
            }
            setRouteAnalysis(null);
        };
        window.addEventListener('thalassa:passage-mode', handlePassageMode);
        return () => window.removeEventListener('thalassa:passage-mode', handlePassageMode);
    }, []);

    // ── Helper: project a point along bearing by distance ──
    const _project = (lat: number, lon: number, bearingDeg: number, distNM: number) => {
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

        // ── Kill Follow Route overlay IMMEDIATELY ──
        // The Follow Route hook uses identical dashed sky-blue styling.
        // Remove its layers imperatively — React hook cleanup has timing gaps.
        const FR_LAYERS = [
            'follow-route-markers-labels',
            'follow-route-markers-circle',
            'follow-route-active-line',
            'follow-route-previous-line',
        ];
        const FR_SOURCES = ['follow-route-active', 'follow-route-previous', 'follow-route-markers'];
        for (const id of FR_LAYERS) {
            try {
                if (map.getLayer(id)) map.removeLayer(id);
            } catch {
                /* */
            }
        }
        for (const id of FR_SOURCES) {
            try {
                if (map.getSource(id)) map.removeSource(id);
            } catch {
                /* */
            }
        }

        // Forward / reverse bearings (needed for both short and long route paths)
        const dLon = ((arrival.lon - departure.lon) * Math.PI) / 180;
        const φ1 = (departure.lat * Math.PI) / 180;
        const φ2 = (arrival.lat * Math.PI) / 180;
        const _fwdBearing =
            (Math.atan2(
                Math.sin(dLon) * Math.cos(φ2),
                Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon),
            ) *
                180) /
            Math.PI;
        const dLonRev = ((departure.lon - arrival.lon) * Math.PI) / 180;
        const _revBearing =
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
        // ── Inshore router (NEW — Phase 13): handle short coastal/river/harbor passages ──
        // Before bailing on short routes, try the Pi-side ENC inshore
        // router. It's specifically designed for the routes the deep-
        // water passage planner refuses (city-to-city via river,
        // marina-to-marina across a harbor, etc.) and only fires when
        // the user has imported an ENC for the area.
        //
        // If the router succeeds, render its polyline directly and
        // return — the rest of the deep-water pipeline is irrelevant
        // for a 6-NM trip up the Savannah River.
        dispatchPassageNotice(null); // fresh compute, clear any stale band
        try {
            const { tryInshoreRoute } = await import('../../services/InshoreRouter');
            // tryInshoreRoute / the engine work in metres but vessel.draft
            // is stored in FEET (see services/units.ts). A Tayana 55's
            // 7.87 ft draft becoming 7.87 m means safetyM=0.2 + draft
            // gives an 8.07 m navigability cutoff, blocking every DEPARE
            // band below 8 m — which is why Newport→Brisbane kept
            // failing with destination-disconnected even though the
            // chart was healthy.
            const vesselDraftM = vesselDraftMetres(useSettingsStore.getState().settings.vessel);
            dispatchPassageNotice({
                severity: 'info',
                title: 'Computing inshore route…',
                message: 'Checking charted channels for this passage — up to a minute on device.',
            });
            // Yield a frame so the notice paints before routeInshore
            // blocks the main thread (synchronous A*, 20–47 s measured
            // on iPhone — without this the map looks frozen).
            await new Promise((r) => setTimeout(r, 80));
            if (gen !== computeGenRef.current) return;
            // 90 s wall-clock bound: tryInshoreRoute awaits network
            // fetches (nav markers) that can stall indefinitely on
            // marine LTE and wedge every retry via the in-flight cache.
            // Must exceed worst-case legitimate A* compute (~47 s).
            const inshoreRes = await withTimeout(
                tryInshoreRoute(
                    { lat: departure.lat, lon: departure.lon },
                    { lat: arrival.lat, lon: arrival.lon },
                    vesselDraftM,
                ),
                {
                    error: 'Inshore routing timed out — a chart-data download may have stalled on this connection.',
                    code: 'timeout',
                },
                90_000,
            );
            if (gen !== computeGenRef.current) return; // user moved on, abort
            if (inshoreRes && 'polyline' in inshoreRes) {
                log.info(
                    `[Passage] inshore route ${inshoreRes.distanceNM.toFixed(2)} NM via ENC ` +
                        `(cells: ${inshoreRes.cellsUsed.join(',')}, ${inshoreRes.elapsedMs} ms)`,
                );

                // LAND BACKSTOP (2026-06-12 Newport→Mooloolaba field bug):
                // uncharted space is engine-navigable, so a mid-corridor
                // chart gap can yield a confident route across an island.
                // Reject and fall through to the offshore pipeline; fails
                // open when GEBCO is unreachable.
                const { inshoreRouteCrossesLand } = await import('../../services/routing/landBackstop');
                const backstop = await inshoreRouteCrossesLand(inshoreRes.polyline);
                if (gen !== computeGenRef.current) return; // user moved on, abort
                if (backstop.crossesLand) {
                    log.warn(
                        `[Passage] inshore route REJECTED by land backstop (${backstop.runs.length} land run(s)) — falling back`,
                    );
                    dispatchPassageNotice({
                        severity: 'warn',
                        title: 'Inshore route rejected — possible chart gap',
                        message:
                            'The charted route crossed land on satellite bathymetry. Sync ENC cells from Pi Cache for full coverage. Falling back to offshore planning.',
                    });
                } else {
                    // Build a RouteAnalysis from the polyline so the rest of
                    // the UI (save/export/banner buttons) lights up. Save
                    // and Export are gated on routeAnalysis !== null — without
                    // this they stay hidden after an inshore-only route.
                    const inshoreSpeed = speed > 0 ? speed : 6;
                    const departureDate = departureTime ? new Date(departureTime) : new Date();
                    const inshoreSegments: RouteSegment[] = [];
                    let cumDist = 0;
                    for (let i = 1; i < inshoreRes.polyline.length; i++) {
                        const [aLon, aLat] = inshoreRes.polyline[i - 1];
                        const [bLon, bLat] = inshoreRes.polyline[i];
                        // Haversine in NM
                        const R_NM_LOC = 3440.065;
                        const dLatR = ((bLat - aLat) * Math.PI) / 180;
                        const dLonR = ((bLon - aLon) * Math.PI) / 180;
                        const lat1R = (aLat * Math.PI) / 180;
                        const lat2R = (bLat * Math.PI) / 180;
                        const hh =
                            Math.sin(dLatR / 2) ** 2 + Math.cos(lat1R) * Math.cos(lat2R) * Math.sin(dLonR / 2) ** 2;
                        const segNM = R_NM_LOC * 2 * Math.atan2(Math.sqrt(hh), Math.sqrt(1 - hh));
                        cumDist += segNM;
                        // Bearing
                        const y = Math.sin(dLonR) * Math.cos(lat2R);
                        const x =
                            Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLonR);
                        const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
                        inshoreSegments.push({
                            startLat: aLat,
                            startLon: aLon,
                            endLat: bLat,
                            endLon: bLon,
                            bearing,
                            distance: segNM,
                            cumulativeDistance: cumDist,
                        });
                    }
                    const inshoreDuration = inshoreRes.distanceNM / inshoreSpeed; // hours
                    const arrivalDate = new Date(departureDate.getTime() + inshoreDuration * 3600_000);
                    setRouteAnalysis({
                        waypoints: [
                            { id: 'dep', lat: departure.lat, lon: departure.lon, name: departure.name },
                            { id: 'arr', lat: arrival.lat, lon: arrival.lon, name: arrival.name },
                        ],
                        segments: inshoreSegments,
                        totalDistance: inshoreRes.distanceNM,
                        estimatedDuration: inshoreDuration,
                        departureTime: departureDate.toISOString(),
                        arrivalTime: arrivalDate.toISOString(),
                        averageSpeed: inshoreSpeed,
                        fuelEstimate: null,
                        maxWindSpeed: null,
                        maxWaveHeight: null,
                        headwindPercentage: 0,
                        favorablePercentage: 0,
                        minDepth: null,
                        shallowSegments: 0,
                        routeCoordinates: inshoreRes.polyline,
                    });

                    // Render the polyline as a single safe-water route line.
                    // No sea buoy gates, no harbour legs, no isochrone — the
                    // ENC chart already encoded all the channel knowledge we
                    // need. The line goes straight on the channel.
                    // Split the polyline into runs of consecutive segments
                    // that share the same caution state. Each run becomes one
                    // LineString feature: normal water keeps safety:'green'
                    // (the cyan inshore-route default), caution water — water
                    // our coarse bathymetry reads as too shallow for this
                    // vessel but which is NOT land/hazard — gets
                    // safety:'danger' so the route-line layer draws it red.
                    // The skipper verifies depth on those red stretches.
                    const inshorePoly = inshoreRes.polyline;
                    const segCount = inshorePoly.length - 1;
                    const hasMask = (m?: boolean[]): m is boolean[] => !!m && m.length === segCount;
                    // Per-segment colour, Shane's INNER→OUTER scheme. Precedence:
                    //   1. canal centre-line → RED ('danger')  — the marina basin (innermost).
                    //   2. tier-4 marked channel → YELLOW ('channel') — and this BEATS caution:
                    //      a buoyed channel is pilotage water, the marks ARE the depth authority,
                    //      so it must read yellow even where the 50 m grid calls it shallow/
                    //      uncharted (d-1). (Was caution>channel, which reddened the marked
                    //      channel wherever it crossed an uncharted cell — the "red not yellow"
                    //      bug.) The cautionMask is still computed for the safety scorecard.
                    //   3. caution (shallow/uncharted OPEN water, NOT a marked channel) → RED.
                    //   4. offshore → DARK BLUE; else inshore A* → TEAL ('green' default).
                    const cautionMask = inshoreRes.cautionMask;
                    const canalMask = inshoreRes.canalMask;
                    const tier4Mask = inshoreRes.tier4Mask;
                    const offshoreMask = inshoreRes.offshoreMask;
                    const anyMask =
                        hasMask(cautionMask) || hasMask(canalMask) || hasMask(tier4Mask) || hasMask(offshoreMask);
                    const stateMask: ('danger' | 'channel' | 'offshore' | 'green')[] | null =
                        inshorePoly.length < 2 || !anyMask
                            ? null
                            : Array.from({ length: segCount }, (_, i) => {
                                  if (canalMask?.[i] ?? false) return 'danger'; // canal/marina RED
                                  if (tier4Mask?.[i]) return 'channel'; // marked channel YELLOW (beats caution)
                                  if (cautionMask?.[i] ?? false) return 'danger'; // shallow OPEN water RED
                                  return offshoreMask?.[i] ? 'offshore' : 'green';
                              });
                    const inshoreFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
                    if (!stateMask) {
                        // No (or mismatched) safety data — single green line.
                        inshoreFeatures.push({
                            type: 'Feature',
                            properties: { safety: 'green', source: 'inshore-router' },
                            geometry: { type: 'LineString', coordinates: inshorePoly },
                        });
                    } else {
                        let runStart = 0;
                        for (let i = 0; i <= stateMask.length; i++) {
                            const atEnd = i === stateMask.length;
                            if (atEnd || stateMask[i] !== stateMask[runStart]) {
                                inshoreFeatures.push({
                                    type: 'Feature',
                                    properties: {
                                        safety: stateMask[runStart],
                                        source: 'inshore-router',
                                    },
                                    // run = segments [runStart, i) → points [runStart, i]
                                    geometry: {
                                        type: 'LineString',
                                        coordinates: inshorePoly.slice(runStart, i + 1),
                                    },
                                });
                                runStart = i;
                            }
                        }
                    }
                    // TEMP RENDER DIAGNOSTIC — which path wins route-line + what it draws.
                    log.warn(
                        `[render] route-line ← INSHORE (${inshoreFeatures.length}): ${inshoreFeatures
                            .map((f) => f.properties?.safety)
                            .join(',')}`,
                    );
                    const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                    if (routeSrc) {
                        routeSrc.setData({ type: 'FeatureCollection', features: inshoreFeatures });
                    }
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

                    // Fit bounds to the route extent.
                    const bounds = new mapboxgl.LngLatBounds();
                    for (const [lon, lat] of inshoreRes.polyline) bounds.extend([lon, lat]);
                    map.fitBounds(bounds, { padding: 80, duration: 1000 });

                    // Surface a route-summary event so PassageBanner can show
                    // distance/cells used. Same shape as deep-water route, just
                    // sourced from the ENC router.
                    try {
                        window.dispatchEvent(
                            new CustomEvent('thalassa:passage-inshore-route', {
                                detail: {
                                    distanceNM: inshoreRes.distanceNM,
                                    cellsUsed: inshoreRes.cellsUsed,
                                    elapsedMs: inshoreRes.elapsedMs,
                                    pointCount: inshoreRes.polyline.length,
                                },
                            }),
                        );
                    } catch (_) {
                        /* not fatal */
                    }

                    dispatchPassageNotice(null); // route rendered — clear the computing band
                    return; // skip the rest of the deep-water compute
                } // end land-backstop else (rejected routes fall through to deep-water compute)
            } else if (inshoreRes && 'error' in inshoreRes) {
                log.warn(
                    `[Passage] inshore router could not produce a route: ${inshoreRes.error} (${inshoreRes.code ?? 'no code'})`,
                );
                // The engine's error strings are skipper-readable
                // ("Inshore charts don't cover the full passage yet —
                // sync the missing cells via Pi Cache"). Surface them;
                // a silent refusal reads as a hang in the field.
                dispatchPassageNotice({
                    severity: 'warn',
                    title: 'Inshore routing unavailable',
                    message: inshoreRes.error + (straightLineNM >= 15 ? ' Planning an offshore route instead.' : ''),
                });
                // Fall through — for short routes this means the
                // too-short check will bail with the friendly message.
            }
        } catch (err) {
            log.warn(`[Passage] inshore routing threw — falling through`, err);
            dispatchPassageNotice({
                severity: 'warn',
                title: 'Inshore routing failed',
                message: 'Continuing with offshore planning.',
            });
        }

        // ── Too-short route detection: passage planning is for deep water only ──
        const TOO_SHORT_NM = 15;
        if (straightLineNM < TOO_SHORT_NM) {
            log.info(
                `[Passage] Route too short (${Math.round(straightLineNM)} NM) — not suitable for passage planning`,
            );
            try {
                window.dispatchEvent(
                    new CustomEvent('thalassa:passage-too-short', {
                        detail: {
                            distanceNM: Math.round(straightLineNM),
                            message:
                                'This route is too short for passage planning. Check Community Routes for local harbour exits and coastal routes. (Tip: import an ENC for this area to enable inshore river/harbor routing.)',
                        },
                    }),
                );
            } catch (_) {
                log.warn(``, _);
            }
            return;
        }

        const isShortRoute = straightLineNM < 100;
        const VESSEL_DRAFT_M = 2.5; // IsochroneConfig default
        const minDepthM = isShortRoute ? VESSEL_DRAFT_M + 1 : null;

        log.info(
            `[Passage] Distance: ${Math.round(straightLineNM)} NM — ${isShortRoute ? 'SHORT (coastal, minDepth=' + minDepthM + 'm)' : 'LONG (ocean)'}`,
        );

        // ── Sea Buoy Gate Finder: find NEAREST ≥50m depth in any direction ──
        // The harbour leg represents "navigate to deep water at your discretion."
        // For Brisbane→Perth, the ocean is EAST even though Perth is WEST.
        // So we search ALL 360° and pick the CLOSEST 50m water point.
        const SAFE_WATER_DEPTH_M = -50; // 50m below sea level (GEBCO uses negative = ocean)
        const GATE_BEARINGS = 12; // Every 30° = full 360° coverage
        const GATE_DISTANCES = [15, 25, 35, 45, 55]; // NM — skip <15 NM (harbour channels)

        const findSeaBuoyGate = async (from: { lat: number; lon: number }): Promise<{ lat: number; lon: number }> => {
            // Build search grid: 12 bearings × 5 distances = 60 points
            const bearings: number[] = [];
            for (let b = 0; b < 360; b += 360 / GATE_BEARINGS) {
                bearings.push(b);
            }

            // Build flat array: nearest ring first so we find closest 50m first
            const allPoints: { lat: number; lon: number; distNM: number; brg: number }[] = [];
            for (const distNM of GATE_DISTANCES) {
                for (const brg of bearings) {
                    const pt = _project(from.lat, from.lon, brg, distNM);
                    allPoints.push({ ...pt, distNM, brg });
                }
            }

            log.info(
                `[SeaBuoy] Searching ALL 360° from ${from.lat.toFixed(3)}, ${from.lon.toFixed(3)} ` +
                    `(${allPoints.length} points: ${GATE_BEARINGS} bearings × ${GATE_DISTANCES.length} distances)`,
            );

            const { GebcoDepthService } = await import('../../services/GebcoDepthService');

            try {
                const allDepths = await GebcoDepthService.queryDepths(
                    allPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
                );

                // Scan nearest ring first → finds closest 50m water
                for (let i = 0; i < allPoints.length; i++) {
                    const d = allDepths[i]?.depth_m;
                    if (d !== null && d !== undefined && d <= SAFE_WATER_DEPTH_M) {
                        const pt = allPoints[i];
                        log.info(
                            `[SeaBuoy] ✓ Gate at ${pt.lat.toFixed(3)}, ${pt.lon.toFixed(3)} ` +
                                `(${pt.distNM} NM, bearing ${Math.round(pt.brg)}°, depth ${Math.round(d)}m)`,
                        );
                        console.warn(
                            `[SeaBuoy] Gate: ${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)} (${pt.distNM} NM, ${Math.round(pt.brg)}°, ${Math.round(d)}m)`,
                        );
                        return { lat: pt.lat, lon: pt.lon };
                    }
                }
            } catch (err) {
                log.warn(`[SeaBuoy] Depth query failed:`, err);
            }

            // Fallback: project 25 NM toward nearest ocean based on longitude
            // East coast AU (lon > 140) → go east (90°)
            // West coast AU (lon < 125) → go west (270°)
            // South coast → go south (180°)
            const oceanBrg = from.lon > 140 ? 90 : from.lon < 125 ? 270 : 180;
            log.warn(`[SeaBuoy] No 50m gate found — fallback ${oceanBrg}° (ocean side)`);
            console.warn(`[SeaBuoy] Fallback: 25 NM at ${oceanBrg}°`);
            return _project(from.lat, from.lon, oceanBrg, 25);
        };

        // For short routes (<100 NM), skip sea buoy gates — route directly
        let depGate: { lat: number; lon: number };
        let arrGate: { lat: number; lon: number };

        if (isShortRoute) {
            depGate = { lat: departure.lat, lon: departure.lon };
            arrGate = { lat: arrival.lat, lon: arrival.lon };
            log.info(`[Passage] Short route — skipping sea buoy gates`);
        } else {
            // Find deep water gates — 30s timeout with ocean-side fallback
            const oceanFallback = (from: { lat: number; lon: number }) => {
                const brg = from.lon > 140 ? 90 : from.lon < 125 ? 270 : 180;
                log.warn(`[SeaBuoy] Timeout — fallback ${brg}° at 25 NM`);
                return _project(from.lat, from.lon, brg, 25);
            };
            [depGate, arrGate] = await Promise.all([
                withTimeout(findSeaBuoyGate(departure), oceanFallback(departure), 30_000),
                withTimeout(findSeaBuoyGate(arrival), oceanFallback(arrival), 30_000),
            ]);
        }

        // Loud logging so gate coordinates are visible in any debug context
        console.warn(
            `[Passage] DEP gate: ${depGate.lat.toFixed(4)}, ${depGate.lon.toFixed(4)} | ARR gate: ${arrGate.lat.toFixed(4)}, ${arrGate.lon.toFixed(4)}`,
        );
        log.info(`[Passage] Departure gate: ${depGate.lat.toFixed(3)}, ${depGate.lon.toFixed(3)}`);
        log.info(`[Passage] Arrival gate: ${arrGate.lat.toFixed(3)}, ${arrGate.lon.toFixed(3)}`);

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

        // ── Water-aware great-circle: detect land crossings & insert bypass waypoints ──
        // Uses a simple lat/lon bounding box check for major landmasses.
        // This ensures the preview line never cuts through continents.
        const CONTINENTAL_BYPASS_REGIONS: {
            name: string;
            latMin: number;
            latMax: number;
            lonMin: number;
            lonMax: number;
            // Bypass waypoints: route either south or north around the landmass
            southRoute: [number, number][]; // [lon, lat]
            northRoute: [number, number][]; // [lon, lat]
        }[] = [
            {
                name: 'Australia',
                latMin: -44,
                latMax: -10,
                lonMin: 113,
                lonMax: 154,
                southRoute: [
                    [112, -36], // South of Cape Leeuwin
                    [117, -37], // Great Australian Bight approach
                    [130, -38], // Southern Ocean
                    [140, -40], // South of Tasmania
                    [150, -40], // Southeast approach
                ],
                northRoute: [
                    [142, -10], // Torres Strait
                    [136, -11], // North of Arnhem Land
                    [127, -13], // Timor Sea
                    [120, -14], // Northwest approach
                ],
            },
            {
                name: 'New Zealand',
                latMin: -47,
                latMax: -34,
                lonMin: 166,
                lonMax: 179,
                southRoute: [
                    [167, -48], // South of Stewart Island
                ],
                northRoute: [
                    [174, -33], // North of Auckland
                ],
            },
            {
                name: 'Papua New Guinea',
                latMin: -11,
                latMax: 0,
                lonMin: 140,
                lonMax: 156,
                southRoute: [
                    [147, -12], // South of PNG
                ],
                northRoute: [
                    [148, 1], // North of PNG
                ],
            },
        ];

        // Check if the GC arc crosses any continental region
        const waterAwareCoords = (() => {
            for (const region of CONTINENTAL_BYPASS_REGIONS) {
                // Check if any GC point falls inside the landmass bounding box
                const crossesLand = gcCoords.some(
                    ([lon, lat]) =>
                        lat >= region.latMin && lat <= region.latMax && lon >= region.lonMin && lon <= region.lonMax,
                );
                if (!crossesLand) continue;

                log.info(`[Passage] Great-circle crosses ${region.name} — inserting bypass waypoints`);

                // Decide south vs north: pick the route that's closer to the midpoint of dep/arr
                const midLat = (depGate.lat + arrGate.lat) / 2;
                const regionMidLat = (region.latMin + region.latMax) / 2;
                const useSouth = midLat <= regionMidLat;
                const bypassWaypoints = useSouth ? region.southRoute : region.northRoute;

                // Build water-aware path: depGate → bypass waypoints → arrGate
                const result: number[][] = [[depGate.lon, depGate.lat]];

                // Filter bypass waypoints to only include those between dep and arr longitudes
                const minLon = Math.min(depGate.lon, arrGate.lon) - 5;
                const maxLon = Math.max(depGate.lon, arrGate.lon) + 5;
                const relevantWaypoints = bypassWaypoints.filter(([lon]) => lon >= minLon && lon <= maxLon);

                // Sort bypass waypoints by longitude in the direction of travel
                const goingEast = arrGate.lon > depGate.lon;
                relevantWaypoints.sort((a, b) => (goingEast ? a[0] - b[0] : b[0] - a[0]));

                for (const wp of relevantWaypoints) {
                    result.push(wp);
                }
                result.push([arrGate.lon, arrGate.lat]);

                // Interpolate between waypoints for a smooth curve
                const interpolated: number[][] = [];
                for (let i = 0; i < result.length - 1; i++) {
                    const [lon1, lat1] = result[i];
                    const [lon2, lat2] = result[i + 1];
                    const segPoints = Math.max(5, Math.round(NUM_POINTS / result.length));
                    for (let j = 0; j <= segPoints; j++) {
                        const t = j / segPoints;
                        // Use great-circle interpolation for each sub-segment
                        const p1R = (lat1 * Math.PI) / 180;
                        const l1R = (lon1 * Math.PI) / 180;
                        const p2R = (lat2 * Math.PI) / 180;
                        const l2R = (lon2 * Math.PI) / 180;
                        const dd = Math.acos(
                            Math.sin(p1R) * Math.sin(p2R) + Math.cos(p1R) * Math.cos(p2R) * Math.cos(l2R - l1R),
                        );
                        if (dd < 1e-10) {
                            interpolated.push([lon1, lat1]);
                            continue;
                        }
                        const aa = Math.sin((1 - t) * dd) / Math.sin(dd);
                        const bb = Math.sin(t * dd) / Math.sin(dd);
                        const xx = aa * Math.cos(p1R) * Math.cos(l1R) + bb * Math.cos(p2R) * Math.cos(l2R);
                        const yy = aa * Math.cos(p1R) * Math.sin(l1R) + bb * Math.cos(p2R) * Math.sin(l2R);
                        const zz = aa * Math.sin(p1R) + bb * Math.sin(p2R);
                        interpolated.push([
                            (Math.atan2(yy, xx) * 180) / Math.PI,
                            (Math.atan2(zz, Math.sqrt(xx * xx + yy * yy)) * 180) / Math.PI,
                        ]);
                    }
                }
                return interpolated;
            }
            return gcCoords; // No land crossing detected — use original GC
        })();

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
        // For long routes: harbour legs connect departure↔depGate and arrGate↔arrival
        // For short routes: fixed 5 NM interpolation from each end
        const buildFeatures = (
            passageCoords: number[][],
            shallowFlags?: boolean[],
        ): GeoJSON.Feature<GeoJSON.LineString>[] => {
            const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];

            // Helper: create a dashed harbour-leg feature
            const makeLandLeg = (coords: number[][]): GeoJSON.Feature<GeoJSON.LineString> => ({
                type: 'Feature',
                properties: { safety: 'harbour', dashed: true },
                geometry: { type: 'LineString', coordinates: coords },
            });

            // Haversine distance between two [lon, lat] coords in NM
            const distNM = (a: number[], b: number[]): number => {
                const R = 3440.065;
                const dLat2 = ((b[1] - a[1]) * Math.PI) / 180;
                const dLon2 = ((b[0] - a[0]) * Math.PI) / 180;
                const lat1 = (a[1] * Math.PI) / 180;
                const lat2 = (b[1] * Math.PI) / 180;
                const sinDLat = Math.sin(dLat2 / 2);
                const sinDLon = Math.sin(dLon2 / 2);
                const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
                return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
            };

            // Interpolate a point exactly maxNM along the polyline from one end
            const interpolatePoint = (
                coords: number[][],
                maxNM: number,
                fromEnd: boolean,
            ): { point: number[]; index: number } => {
                const ordered = fromEnd ? [...coords].reverse() : coords;
                let accum = 0;
                for (let i = 1; i < ordered.length; i++) {
                    const segDist = distNM(ordered[i - 1], ordered[i]);
                    if (accum + segDist >= maxNM) {
                        const frac = segDist > 0 ? (maxNM - accum) / segDist : 0;
                        const origIdx = fromEnd ? coords.length - 1 - i : i;
                        return {
                            point: [
                                ordered[i - 1][0] + frac * (ordered[i][0] - ordered[i - 1][0]),
                                ordered[i - 1][1] + frac * (ordered[i][1] - ordered[i - 1][1]),
                            ],
                            index: origIdx,
                        };
                    }
                    accum += segDist;
                }
                const lastIdx = fromEnd ? 0 : coords.length - 1;
                return { point: ordered[ordered.length - 1], index: lastIdx };
            };

            // ── Long routes: straight harbour legs to sea buoy gates ──
            // The gate finder places gates directly seaward (toward open ocean).
            // The dashed line is allowed to visually cross islands/land — it
            // represents "navigate harbour exit at your own discretion."
            if (!isShortRoute) {
                const depCoord = [departure.lon, departure.lat];
                const depGateCoord = [depGate.lon, depGate.lat];
                const arrGateCoord = [arrGate.lon, arrGate.lat];
                const arrCoord = [arrival.lon, arrival.lat];

                // Departure harbour leg (dashed): departure → depGate
                features.push(makeLandLeg([depCoord, depGateCoord]));
                // Arrival harbour leg (dashed): arrGate → arrival
                features.push(makeLandLeg([arrGateCoord, arrCoord]));

                // Ocean portion: the passage coords (gate-to-gate)
                features.push({
                    type: 'Feature',
                    properties: { safety: 'safe' },
                    geometry: { type: 'LineString', coordinates: passageCoords },
                });
            } else if (passageCoords.length >= 4) {
                // Short route: use fixed 5 NM interpolation from each end
                const HARBOUR_NM = 5;

                const depCut = interpolatePoint(passageCoords, HARBOUR_NM, false).point;
                const arrCut = interpolatePoint(passageCoords, HARBOUR_NM, true).point;

                // Departure harbour leg (dashed)
                features.push(makeLandLeg([passageCoords[0], depCut]));
                // Arrival harbour leg (dashed)
                features.push(makeLandLeg([arrCut, passageCoords[passageCoords.length - 1]]));

                // Ocean portion: depCut → all intermediate points → arrCut
                const oceanCoords = [depCut, ...passageCoords.slice(1, -1), arrCut];
                const oceanShallows = shallowFlags?.slice(1, -1);

                // Short route: depth-aware per-segment coloring
                if (isShortRoute && oceanShallows && oceanShallows.length === oceanCoords.length) {
                    let segStart = 0;
                    let wasShallow = oceanShallows[0] || false;
                    for (let i = 1; i < oceanCoords.length; i++) {
                        const nowShallow = oceanShallows[i] || false;
                        if (nowShallow !== wasShallow || i === oceanCoords.length - 1) {
                            features.push({
                                type: 'Feature',
                                properties: { safety: wasShallow ? 'danger' : 'safe' },
                                geometry: {
                                    type: 'LineString',
                                    coordinates: oceanCoords.slice(segStart, i + 1),
                                },
                            });
                            segStart = i;
                            wasShallow = nowShallow;
                        }
                    }
                    if (features.length === 2) {
                        features.push({
                            type: 'Feature',
                            properties: { safety: 'safe' },
                            geometry: { type: 'LineString', coordinates: oceanCoords },
                        });
                    }
                } else {
                    features.push({
                        type: 'Feature',
                        properties: { safety: 'safe' },
                        geometry: { type: 'LineString', coordinates: oceanCoords },
                    });
                }
            } else {
                // Too few points — render entire route as safe
                features.push({
                    type: 'Feature',
                    properties: { safety: 'safe' },
                    geometry: { type: 'LineString', coordinates: passageCoords },
                });
            }

            return features;
        };

        // Always show great-circle line immediately as a preview.
        // For long routes, the isochrone engine will replace it once computed.
        const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
        if (routeSrc) {
            const passageFeats = buildFeatures(waterAwareCoords);
            // TEMP RENDER DIAGNOSTIC — passage path setting route-line (may RACE the inshore path).
            log.warn(
                `[render] route-line ← PASSAGE (${passageFeats.length}): ${passageFeats
                    .map((f) => `${f.properties?.safety}${f.properties?.dashed ? 'D' : ''}`)
                    .join(',')}`,
            );
            routeSrc.setData({ type: 'FeatureCollection', features: passageFeats });
            log.info(
                `[Passage] Trip Sandwich rendered (${waterAwareCoords !== gcCoords ? 'water-aware bypass' : 'great-circle'} preview: ${Math.round(straightLineNM)} NM)`,
            );
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

            // ── Short-route bypass ──
            // For coastal hops < 100 NM (e.g. Nouméa → Île des Pins,
            // 60 NM) the isochrone wavefront propagation produces
            // wildly off-route geometry: it's allowed up to 25 hours
            // of expansion (motoringSpeed × 2.5 cap) and treats every
            // reef/island as a hard obstacle, so for routes through
            // reef-strewn coastal waters it ends up routing far
            // offshore into deep water (see WP1 at -25°S in the
            // user's report — 200+ NM south of Nouméa to "escape" the
            // New Caledonia lagoon, then back northeast). The result
            // was an 861 NM route for a 60 NM passage.
            //
            // Short coastal routes don't need weather routing — the
            // forecast is reliable across a 12-hour passage and the
            // skipper relies on local pilotage anyway. Keep the
            // great-circle (water-aware bypass) preview as the final
            // route, push it to the PassageStore, and bail out.
            if (isShortRoute) {
                log.info('[Passage] Short route — keeping great-circle, skipping isochrone propagation');
                try {
                    // Build a minimal IsochroneResult-shaped payload
                    // from the great-circle so pushToPassageStore can
                    // round-trip. cruisingSpeed defaulted to 6 kn
                    // matches the rest of the app's fallback.
                    const cruisingKt = (typeof speed === 'number' && speed > 0 ? speed : 6) as number;

                    // ── Land + depth avoidance for short routes ──
                    // The water-aware preview is just a great-circle;
                    // for routes through reef-strewn coastal waters
                    // (Nouméa → Île des Pins is the canonical example)
                    // it cuts straight across Île Ouen and the Récif
                    // de Sainte-Marie. validateRouteSegments samples
                    // every segment, queries GEBCO depths, and inserts
                    // detour waypoints around any sample shallower
                    // than the vessel-draft buffer. Same routine the
                    // long-route isochrone path runs, just on the
                    // straight-line input instead of an isochrone-
                    // optimised one. Race against a 12s ceiling so a
                    // slow GEBCO endpoint doesn't keep the user
                    // staring at the great-circle preview indefinitely.
                    let validatedRoute: { lat: number; lon: number }[] = waterAwareCoords.map(([lon, lat]) => ({
                        lat,
                        lon,
                    }));
                    try {
                        const { validateRouteSegments } = await import('../../services/isochrone/landAvoidance');
                        // Feed the validator just the [origin, destination]
                        // pair — NOT the 80-point great-circle interpolation.
                        // sampleSegment uses 0.5 NM resolution; an 80-point
                        // GC for a 60 NM route means ~0.76 NM segments and
                        // only ~1 GEBCO query per segment. With endpoints
                        // alone the validator densely samples ~120 points
                        // along the whole arc, catches every land crossing,
                        // and findDetourAroundIsland gets the full segment
                        // midpoint to push from — much more likely to clear
                        // a complex obstacle (Île Ouen + reef belts) than
                        // pushing perpendicular off a 0.76 NM stub.
                        const firstPt = validatedRoute[0];
                        const lastPt = validatedRoute[validatedRoute.length - 1];
                        const seedNodes = [firstPt, lastPt].map((p) => ({
                            lat: p.lat,
                            lon: p.lon,
                            timeHours: 0,
                            bearing: 0,
                            speed: cruisingKt,
                            tws: 0,
                            twa: 0,
                            parentIndex: null,
                            distance: 0,
                        })) as unknown as IsochroneNode[];
                        // validateRouteSegments wants METRES; vessel.draft is FEET
                        // (see services/units.ts).
                        const vesselDraftM = vesselDraftMetres(useSettingsStore.getState().settings.vessel);
                        const departureTimeMs = departureTime ? new Date(departureTime).getTime() : undefined;
                        const validated = await Promise.race([
                            validateRouteSegments(seedNodes, { vesselDraftM, departureTimeMs }),
                            // 30s ceiling (was 12s). Multi-pass detour
                            // search across reef-strewn coastal waters
                            // can take ~15-20s — 12s was killing the
                            // validator mid-fix and leaving a polyline
                            // that still crossed land.
                            new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
                        ]);
                        if (validated && validated.length >= 2) {
                            validatedRoute = validated.map((n) => ({ lat: n.lat, lon: n.lon }));
                            if (validated.length !== seedNodes.length) {
                                log.info(
                                    `[Passage] Short route validated: ${seedNodes.length} → ${validated.length} points (land/reef detours added)`,
                                );
                            }
                        } else {
                            log.info('[Passage] Short route: GEBCO validation timed out or empty — using great-circle');
                        }
                    } catch (e) {
                        log.warn('[Passage] Short route: GEBCO validation failed — using great-circle:', e);
                    }

                    // Recompute distance from the validated polyline so
                    // the user's reported total reflects the actual
                    // sea-distance (with detours), not the dot-to-dot
                    // great-circle.
                    const validatedDistanceNm = (() => {
                        const R = 3440.065;
                        let total = 0;
                        for (let i = 1; i < validatedRoute.length; i++) {
                            const a = validatedRoute[i - 1];
                            const b = validatedRoute[i];
                            const dLat = ((b.lat - a.lat) * Math.PI) / 180;
                            const dLon = ((b.lon - a.lon) * Math.PI) / 180;
                            const φa = (a.lat * Math.PI) / 180;
                            const φb = (b.lat * Math.PI) / 180;
                            const aa = Math.sin(dLat / 2) ** 2 + Math.cos(φa) * Math.cos(φb) * Math.sin(dLon / 2) ** 2;
                            total += R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
                        }
                        return total;
                    })();
                    const totalDurationHours = validatedDistanceNm / cruisingKt;
                    const depTimeStr = departureTime || new Date().toISOString();
                    const arrIso = new Date(
                        new Date(depTimeStr).getTime() + totalDurationHours * 3_600_000,
                    ).toISOString();

                    const validatedCoords: [number, number][] = validatedRoute.map((p) => [p.lon, p.lat]);

                    // Re-render the route line with the validated
                    // detour-aware geometry.
                    const srcShort = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                    if (srcShort) {
                        srcShort.setData({ type: 'FeatureCollection', features: buildFeatures(validatedCoords) });
                    }

                    const minimalIsoResult: IsochroneResult = {
                        route: validatedRoute.map((p) => ({
                            lat: p.lat,
                            lon: p.lon,
                            timeHours: 0,
                            tws: 0,
                            twa: 0,
                            sog: cruisingKt,
                        })) as unknown as IsochroneResult['route'],
                        routeCoordinates: validatedCoords,
                        shallowFlags: [],
                        totalDistanceNM: Math.round(validatedDistanceNm * 10) / 10,
                        totalDurationHours: Math.round(totalDurationHours * 10) / 10,
                        arrivalTime: arrIso,
                        isochrones: [],
                        engineFlags: { stallRecovery: false, finalApproach: false },
                    } as unknown as IsochroneResult;
                    const minimalWps: TurnWaypoint[] = [
                        {
                            id: 'DEP',
                            lat: departure.lat,
                            lon: departure.lon,
                            bearing: 0,
                            distanceNM: 0,
                            timeHours: 0,
                            eta: depTimeStr,
                            tws: 0,
                            twa: 0,
                        } as unknown as TurnWaypoint,
                        {
                            id: 'ARR',
                            lat: arrival.lat,
                            lon: arrival.lon,
                            bearing: ((_fwdBearing % 360) + 360) % 360,
                            distanceNM: Math.round(validatedDistanceNm * 10) / 10,
                            timeHours: Math.round(totalDurationHours * 10) / 10,
                            eta: arrIso,
                            tws: 0,
                            twa: 0,
                        } as unknown as TurnWaypoint,
                    ];
                    turnWaypointsRef.current = minimalWps;
                    isoResultRef.current = minimalIsoResult;

                    const updatedResultShort = { ...result };
                    updatedResultShort.totalDistance = minimalIsoResult.totalDistanceNM;
                    updatedResultShort.estimatedDuration = minimalIsoResult.totalDurationHours;
                    setRouteAnalysis(updatedResultShort);

                    pushToPassageStore(
                        minimalIsoResult,
                        minimalWps,
                        departure,
                        arrival,
                        updatedResultShort,
                        depTimeStr,
                        cruisingKt,
                    );

                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-complete', { detail: { success: true, short: true } }),
                    );
                } catch (e) {
                    log.warn('[Passage] Short-route bypass push failed:', e);
                }
                return;
            }

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
                            });
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

                        // Push pre-computed route to global PassageStore for Nav Station
                        pushToPassageStore(
                            cached,
                            wps,
                            departure,
                            arrival,
                            updatedResult2,
                            departureTime || new Date().toISOString(),
                            speed,
                        );

                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } }),
                            );
                        } catch (_) {
                            log.warn(``, _);
                        }
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
                } catch (_) {
                    log.warn(``, _);
                }

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
                            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
                        const supabaseKey =
                            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
                        if (supabaseUrl) {
                            // Pad generously: 15° south (wavefront goes around continents), 5° other dirs
                            const fetchBounds = {
                                north: Math.min(90, routeMaxLat + 10),
                                south: Math.max(-90, routeMinLat - 15),
                                east: Math.min(180, routeMaxLon + 10),
                                west: Math.max(-180, routeMinLon - 10),
                            };
                            // withDeadline, not AbortSignal — the CapacitorHttp
                            // fetch patch ignores signals on device (see
                            // utils/deadline.ts). Multi-MB GRIB on marine LTE
                            // is exactly where this stalls.
                            const resp = await withDeadline(
                                fetch(`${supabaseUrl}/functions/v1/fetch-wind-grid`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        ...(supabaseKey
                                            ? { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
                                            : {}),
                                    },
                                    body: JSON.stringify(fetchBounds),
                                }),
                                30_000,
                                'route-wind-grib',
                            );
                            if (resp.ok) {
                                const buffer = await withDeadline(resp.arrayBuffer(), 60_000, 'route-wind-grib body');
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
                    // MUST dispatch complete: the first progress event
                    // already raised the "Loading wind data…" band, and
                    // PassageBanner hides stats/Save/Export while it
                    // shows. Returning silently left it spinning forever
                    // (field bug 2026-06-12, offline/marine LTE).
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-complete', { detail: { success: false, noWind: true } }),
                    );
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
                } catch (_) {
                    log.warn(``, _);
                }
                // Use base 0.1° grid (stride=6) for maximum land detection accuracy.
                // Combined with isNearShore coastal buffer in the engine + directional
                // seeder stall recovery, this provides the best land avoidance.
                // 15s timeout — if GEBCO is slow, proceed without bathymetry grid.
                let bathyGrid: Awaited<ReturnType<typeof preloadBathymetry>> = null;
                try {
                    bathyGrid = await Promise.race([
                        preloadBathymetry(depGate, arrGate, 6),
                        new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
                    ]);
                    if (!bathyGrid)
                        log.warn('[Isochrone BG] Bathymetry preload timed out — routing without land avoidance');
                } catch (bathyErr) {
                    log.warn('[Isochrone BG] Bathymetry preload failed:', bathyErr);
                }

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
                } catch (_) {
                    log.warn(``, _);
                }

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
                        });
                    }

                    // ── Deferred: GEBCO island validation (runs AFTER route is visible) ──
                    // The route renders immediately; this background pass detects and
                    // fixes small island crossings the coarse 0.1° grid missed.
                    (async () => {
                        try {
                            const { validateRouteSegments } = await import('../../services/isochrone/landAvoidance');
                            // validateRouteSegments wants METRES; vessel.draft is FEET
                            // (see services/units.ts).
                            const vesselDraftM = vesselDraftMetres(useSettingsStore.getState().settings.vessel);
                            const departureTimeMs = departureTime ? new Date(departureTime).getTime() : undefined;
                            const validated = await Promise.race([
                                validateRouteSegments(isoResult.route, { vesselDraftM, departureTimeMs }),
                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
                            ]);
                            if (!validated || computeGenRef.current !== gen) return; // stale or timed out

                            // Check if validation actually changed anything
                            if (validated.length !== isoResult.route.length) {
                                const newCoords = validated.map((n) => [n.lon, n.lat] as [number, number]);
                                isoResult.route = validated;
                                isoResult.routeCoordinates = newCoords;

                                const routeSrc = map.getSource('route-line') as mapboxgl.GeoJSONSource;
                                if (routeSrc) {
                                    const newShallowFlags = validated.map(() => false);
                                    routeSrc.setData({
                                        type: 'FeatureCollection',
                                        features: buildFeatures(newCoords, newShallowFlags),
                                    });
                                }
                                log.info(
                                    `[IslandValidation] Route updated: ${isoResult.routeCoordinates.length} → ${newCoords.length} points`,
                                );
                            }
                        } catch (err) {
                            log.warn('[IslandValidation] Non-critical failure:', err);
                        }
                    })();

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

                    // Push isochrone route to global PassageStore for Nav Station
                    pushToPassageStore(
                        isoResult,
                        wps,
                        departure,
                        arrival,
                        updatedResult,
                        departureTime || new Date().toISOString(),
                        speed,
                    );

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
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                                        paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
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
                            } catch (_) {
                                log.warn(``, _);
                            }

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

                                    // ── Post-process ECMWF route to remove zig-zags ──
                                    // Apply the same smoothing/crossing/land avoidance as the primary route
                                    let ecmwfCoords = ecmwfRoute.routeCoordinates;
                                    if (bathyGrid && ecmwfRoute.route.length > 3) {
                                        const { smoothRoute } = await import('../../services/isochrone/smoothing');
                                        const { eliminateCrossings: elimCross, pushRouteOffshore } =
                                            await import('../../services/isochrone/landAvoidance');
                                        let ecmwfSmoothed = smoothRoute(ecmwfRoute.route, bathyGrid);
                                        ecmwfSmoothed = pushRouteOffshore(ecmwfSmoothed, bathyGrid);
                                        ecmwfSmoothed = elimCross(ecmwfSmoothed, bathyGrid, arrGate);
                                        ecmwfCoords = ecmwfSmoothed.map((n) => [n.lon, n.lat] as [number, number]);
                                    }

                                    // Shane (2026-06-22): hide the GFS/ECMWF model-comparison braid over
                                    // the INSHORE leg. On a short/coastal route depGate=departure (see
                                    // ~line 687), so the braid is computed from the marina and overlays
                                    // the buoyed channel where the tier route is authoritative — Shane's
                                    // "zigzag at the gates". Drop braid points within INSHORE_BRAID_CLIP_NM
                                    // of EITHER endpoint so it only draws on the open-water middle, where
                                    // forecast divergence actually matters. Empty (fully-inshore hop) ⇒ no braid.
                                    const INSHORE_BRAID_CLIP_NM = 3;
                                    ecmwfCoords = ecmwfCoords.filter(
                                        (c) =>
                                            hav(departure.lat, departure.lon, c[1], c[0]) > INSHORE_BRAID_CLIP_NM &&
                                            hav(arrival.lat, arrival.lon, c[1], c[0]) > INSHORE_BRAID_CLIP_NM,
                                    );

                                    // Deferred GEBCO fine-resolution validation (same as primary route)
                                    (async () => {
                                        try {
                                            const { validateRouteSegments } =
                                                await import('../../services/isochrone/landAvoidance');
                                            const ecmwfNodes = ecmwfCoords.map(
                                                ([lon, lat]) =>
                                                    ({
                                                        lat,
                                                        lon,
                                                        timeHours: 0,
                                                        bearing: 0,
                                                        speed: 0,
                                                        tws: 0,
                                                        twa: 0,
                                                        parentIndex: null,
                                                        distance: 0,
                                                    }) as IsochroneNode,
                                            );
                                            // validateRouteSegments wants METRES; vessel.draft is FEET
                                            // (see services/units.ts).
                                            const vesselDraftM = vesselDraftMetres(
                                                useSettingsStore.getState().settings.vessel,
                                            );
                                            const departureTimeMs = departureTime
                                                ? new Date(departureTime).getTime()
                                                : undefined;
                                            const validated = await Promise.race([
                                                validateRouteSegments(ecmwfNodes, { vesselDraftM, departureTimeMs }),
                                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
                                            ]);
                                            if (!validated || computeGenRef.current !== gen) return;
                                            if (validated.length !== ecmwfNodes.length) {
                                                const newCoords = validated.map(
                                                    (n) => [n.lon, n.lat] as [number, number],
                                                );
                                                const ecmwfSrc2 = map.getSource(
                                                    'confidence-route-ecmwf',
                                                ) as mapboxgl.GeoJSONSource;
                                                if (ecmwfSrc2) {
                                                    ecmwfSrc2.setData({
                                                        type: 'FeatureCollection',
                                                        features: [
                                                            {
                                                                type: 'Feature' as const,
                                                                properties: { model: 'ECMWF' },
                                                                geometry: {
                                                                    type: 'LineString' as const,
                                                                    coordinates: newCoords,
                                                                },
                                                            },
                                                        ],
                                                    });
                                                }
                                                log.info(
                                                    `[ConfidenceBraid] GEBCO validated ECMWF: ${ecmwfNodes.length} → ${validated.length} points`,
                                                );
                                            }
                                        } catch (err) {
                                            log.warn('[ConfidenceBraid] GEBCO ECMWF validation failed:', err);
                                        }
                                    })();

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
                                    const DIVERGE_NM = 5;
                                    const gfsCoords = isoResult.routeCoordinates;
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
                    } catch (_) {
                        log.warn(``, _);
                    }
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
                    } catch (_) {
                        log.warn(``, _);
                    }

                    // Find intermediate: go well south (or north) of both points for open ocean
                    const southernMost = Math.min(depGate.lat, arrGate.lat);
                    const intermediateLat = southernMost - 8; // 8° south of southernmost point
                    const intermediateLon = (depGate.lon + arrGate.lon) / 2;
                    const intermediate = { lat: intermediateLat, lon: intermediateLon };
                    log.info(
                        `[Isochrone BG] Multi-leg intermediate: ${intermediateLat.toFixed(1)}°, ${intermediateLon.toFixed(1)}°`,
                    );

                    // Load separate bathy grids for each leg (15s timeout each)
                    const bathyGrid1 = await Promise.race([
                        preloadBathymetry(depGate, intermediate, 15),
                        new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
                    ]);
                    const bathyGrid2 = await Promise.race([
                        preloadBathymetry(intermediate, arrGate, 15),
                        new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
                    ]);

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
                                });
                            }
                            const updatedResult = { ...result };
                            updatedResult.totalDistance = isoResult.totalDistanceNM;
                            updatedResult.estimatedDuration = isoResult.totalDurationHours;
                            setRouteAnalysis(updatedResult);

                            // Push stitched multi-leg route to global PassageStore for Nav Station
                            const multiDepTime = departureTime || new Date().toISOString();
                            const multiWps = detectTurnWaypoints(isoResult.route, multiDepTime);
                            turnWaypointsRef.current = multiWps;
                            pushToPassageStore(
                                isoResult,
                                multiWps,
                                departure,
                                arrival,
                                updatedResult,
                                multiDepTime,
                                speed,
                            );
                        }
                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: true } }),
                            );
                        } catch (_) {
                            log.warn(``, _);
                        }
                    } else {
                        log.warn('[Isochrone BG] Multi-leg also failed — keeping great-circle preview');
                        try {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } }),
                            );
                        } catch (_) {
                            log.warn(``, _);
                        }
                    }
                }
            } catch (err) {
                log.warn('[Isochrone BG] Failed — keeping great-circle:', err);
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:isochrone-complete', { detail: { success: false } }),
                    );
                } catch (_) {
                    log.warn(``, _);
                }
            }
        }, 100);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [departure, arrival, departureTime, speed, showPassage]);

    // Auto-compute when both points set + map ready
    useEffect(() => {
        if (mapReady && showPassage && departure && arrival) {
            computePassage().catch((err) => {
                log.error('[Passage] computePassage failed:', err);
                setRouteAnalysis(null);
            });
        }
    }, [mapReady, showPassage, departure, arrival, computePassage]);

    // Route-nudge listener removed 2026-05-05.
    // The drag-to-nudge interaction in useRouteNudge was half-implemented —
    // the via-point hack here just clobbered `arrival` with the dragged
    // point, dropping the actual destination and forcing the user to
    // re-set it. Net result: more confusing than useful. Removed both
    // sides (dispatcher + listener). Real waypoint-aware route editing
    // belongs in the route planner, not as a finger-drag on the chart.

    // Clear route
    const clearRoute = useCallback(() => {
        setDeparture(null);
        setArrival(null);
        setRouteAnalysis(null);
        setDepartureTime('');
        isoResultRef.current = null;
        turnWaypointsRef.current = [];
        computeGenRef.current++; // Invalidate any running computation
        PassageStore.clear();

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setDeparture, setArrival, setRouteAnalysis, setDepartureTime]);

    return {
        departure,
        setDeparture,
        arrival,
        setArrival,
        viaWaypoints,
        setViaWaypoints,
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

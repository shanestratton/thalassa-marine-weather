/**
 * isochroneEnhancer.ts — Wires the IsochroneRouter into the voyage planning
 * pipeline.
 *
 * The corridor-based weather router (services/weatherRouter.ts → route-weather
 * edge function) builds a 30 NM-wide corridor along a centerline and runs an
 * A* search through it. That's correct for many coastal passages but it's not
 * what bluewater customers expect from a "weather router" — PredictWind,
 * Expedition, qtVlm, Squid all use **isochrone** routing, where wavefronts
 * propagate from the departure point and the optimal path is whichever node
 * reaches the destination first.
 *
 * Thalassa already has a fully-implemented isochrone engine in
 * services/IsochroneRouter.ts (stall detection, directional seeders, land
 * avoidance, DP smoothing) — it just wasn't wired into the main routing
 * pipeline. This module bridges the two.
 *
 * Pipeline position:
 *   1. computeVoyagePlan        → seed plan (origin/dest coords, GC distance)
 *   2. bathymetricRouter        → routeGeoJSON for coastal channel-following
 *   3. THIS                     → isochrone-optimised route through wind field
 *   4. weatherRouter (corridor) → fallback if isochrone returns null
 *
 * Returns null on any failure so the caller can fall through to the corridor
 * router. Common failure modes: no wind grid cached, polar lookup empty,
 * bathymetry unavailable, route too short for isochrone to differ from a
 * great-circle.
 */

import type { VoyagePlan, VesselProfile } from '../types';
import { createLogger } from '../utils/createLogger';

const log = createLogger('IsoEnhancer');

/**
 * Decimate a polyline by along-track sampling — used for the
 * spatiotemporal payload track field which shouldn't carry 1000s of
 * isochrone nodes (the renderer can't keep up).
 */
function decimateTrack<T>(arr: T[], maxLen: number): T[] {
    if (arr.length <= maxLen) return arr;
    const step = (arr.length - 1) / (maxLen - 1);
    const out: T[] = [];
    for (let i = 0; i < maxLen; i++) {
        out.push(arr[Math.round(i * step)]);
    }
    return out;
}

/**
 * Format a duration in hours to "Xh" / "Xd Yh" / "X days" matching the
 * shape PassagePlanSave's `parseFloat(durationApprox)` and the summary
 * cards expect.
 */
function formatDuration(hours: number): string {
    if (hours < 24) return `${Math.round(hours)} hours`;
    const days = Math.floor(hours / 24);
    const rem = Math.round(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days} days`;
}

/**
 * Ensure wind grid coverage for the route's bounding box.
 *
 * The IsochroneRouter expects WindStore.getState().grid to be populated.
 * If the user is opening the planner without having visited the map (which
 * is the normal "Plan a passage from the dashboard" flow), the wind grid
 * will be null. This function fetches one synchronously so isochrone has
 * data to work with.
 *
 * Mirrors WindDataController.fetchOnline but:
 *   - takes an explicit bounding box (we don't have a Mapbox map here)
 *   - skips the bounds-changed/staleness checks (we always want fresh)
 *   - skips the move-listener registration (we're not on a map)
 */
async function ensureWindGridForRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
): Promise<boolean> {
    const { WindStore } = await import('../stores/WindStore');
    if (WindStore.getState().grid) return true; // already loaded

    // Bounding box around the route + 30% padding so isochrones can deviate
    // outside the great-circle without leaving the grid.
    const minLat = Math.min(origin.lat, destination.lat);
    const maxLat = Math.max(origin.lat, destination.lat);
    const minLon = Math.min(origin.lon, destination.lon);
    const maxLon = Math.max(origin.lon, destination.lon);
    const latPad = Math.max((maxLat - minLat) * 0.3, 2);
    const lonPad = Math.max((maxLon - minLon) * 0.3, 2);
    const north = Math.min(maxLat + latPad, 85);
    const south = Math.max(minLat - latPad, -85);
    const west = minLon - lonPad;
    const east = maxLon + lonPad;

    try {
        const supabaseUrl =
            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
            'https://pcisdplnodrphauixcau.supabase.co';
        const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
        const { piCache } = await import('./PiCacheService');
        const usePi = piCache.isAvailable();
        const url = usePi ? `${piCache.baseUrl}/api/grib/wind-grid` : `${supabaseUrl}/functions/v1/fetch-wind-grid`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(usePi || !supabaseKey ? {} : { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }),
            },
            body: JSON.stringify({ north, south, east, west }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
            log.warn(`wind grid fetch failed: HTTP ${res.status}`);
            return false;
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 200) {
            log.warn('wind grid fetch returned empty payload');
            return false;
        }
        const { decodeGrib2WindMultiHour } = await import('./weather/decodeGrib2Wind');
        const grid = decodeGrib2WindMultiHour(buf);
        WindStore.setGrid(grid);
        log.info(`wind grid loaded: ${grid.width}×${grid.height}, ${grid.totalHours}h`);
        return true;
    } catch (e) {
        log.warn('wind grid fetch threw:', e);
        return false;
    }
}

/**
 * Run isochrone routing on a VoyagePlan. Returns the enhanced plan with
 * isochrone-optimised route, distance, duration, and turn waypoints — or
 * null on any failure so the caller can fall back to the corridor router.
 */
export async function enhanceVoyagePlanWithIsochrone(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
    departureTime: string,
): Promise<VoyagePlan | null> {
    if (!voyagePlan.originCoordinates || !voyagePlan.destinationCoordinates) {
        return null;
    }

    const origin = voyagePlan.originCoordinates;
    const destination = voyagePlan.destinationCoordinates;

    try {
        // ── 1. Try the precompute cache first ──
        // useVoyageForm fires precomputeIsochrone() the moment Calculate is
        // pressed — by the time the bathymetric step finishes, there's a
        // good chance an isochrone result is already sitting in the cache.
        // Hitting the cache saves the 30-60s recompute.
        const { getPrecomputedRoute } = await import('./IsochronePrecomputeCache');
        let isoResult = getPrecomputedRoute(origin.lat, origin.lon, destination.lat, destination.lon);

        if (isoResult) {
            log.info('hit precompute cache — skipping fresh compute');
        } else {
            // ── 2. Fresh compute ──
            const ok = await ensureWindGridForRoute(origin, destination);
            if (!ok) {
                log.warn('no wind grid available — falling through to corridor router');
                return null;
            }

            const { WindStore } = await import('../stores/WindStore');
            const { createWindFieldFromGrid } = await import('./weather/WindFieldAdapter');
            const { SmartPolarStore } = await import('./SmartPolarStore');
            const { DEFAULT_CRUISING_POLAR } = await import('./defaultPolar');
            const { preloadBathymetry } = await import('./BathymetryCache');
            const { computeIsochrones } = await import('./IsochroneRouter');

            const windGrid = WindStore.getState().grid;
            if (!windGrid) {
                log.warn('wind grid unset after fetch — bailing');
                return null;
            }
            const windField = createWindFieldFromGrid(windGrid);
            const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;

            // ── 3. Bathymetry preload ──
            // Without this the IsochroneRouter falls back to per-step HTTP
            // depth queries (slow and rate-limited). preloadBathymetry pulls
            // the GEBCO grid for the route bbox once.
            const bathyGrid = await preloadBathymetry(origin, destination);

            // ── 4. Short-route shortcut ──
            // Coastal hops (<100 NM) want the bathymetric channel-following
            // geometry, not isochrone. Isochrone on a 20 NM hop just produces
            // a near-straight-line that loses the channel detail. Skip and
            // let the corridor router (or just the bathymetric routeGeoJSON)
            // carry the day.
            const R_NM = 3440.065;
            const dLat = ((destination.lat - origin.lat) * Math.PI) / 180;
            const dLon = ((destination.lon - origin.lon) * Math.PI) / 180;
            const φ1 = (origin.lat * Math.PI) / 180;
            const φ2 = (destination.lat * Math.PI) / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLon / 2) ** 2;
            const straightNM = R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            if (straightNM < 100) {
                log.info(
                    `route only ${Math.round(straightNM)} NM — skipping isochrone, deferring to bathymetric/corridor`,
                );
                return null;
            }

            // ── 4a. Tropical cyclone exclusion zones ──
            // Active hurricanes/typhoons/cyclones become hard no-go areas
            // along their NHC-forecast tracks, with safety radii scaled
            // to Saffir-Simpson intensity (50 NM for TD up to 250 NM for
            // Cat 5). The isochrone engine drops candidates inside these
            // zones, forcing the route to detour around the storm.
            //
            // Non-blocking on failure — if ATCF/NHC is down we route
            // without exclusion zones (the user is presumably checking
            // weather separately and wouldn't depart blind into a
            // hurricane anyway). Better to have a route that doesn't
            // know about a storm than to refuse to give a route.
            let exclusionField = null;
            try {
                const { buildCycloneExclusionField } = await import('./cycloneAvoidance');
                exclusionField = await buildCycloneExclusionField(departureTime, {
                    north: Math.max(origin.lat, destination.lat),
                    south: Math.min(origin.lat, destination.lat),
                    east: Math.max(origin.lon, destination.lon),
                    west: Math.min(origin.lon, destination.lon),
                });
                if (exclusionField) {
                    log.info('cyclone exclusion zones loaded — wavefront will avoid storms');
                }
            } catch (e) {
                log.warn('cyclone exclusion build failed — routing without storm avoidance:', e);
            }

            // ── 4c. Wave field via Open-Meteo Marine ──
            // Sparse 5×5 grid of wave height + direction + period over
            // the route bbox. The IsochroneRouter applies a polar-with-
            // waves slowdown factor at each candidate based on the
            // wave height/period and relative angle to the boat heading.
            //
            // Non-blocking on failure — engine routes without wave
            // penalty if Open-Meteo Marine is down (raw polar speed,
            // matches behaviour before this upgrade).
            let waveField = null;
            try {
                const { fetchWaveField } = await import('./weather/waveField');
                const { createWaveFieldFromSamples } = await import('./weather/WaveFieldAdapter');
                const data = await fetchWaveField(
                    {
                        north: Math.max(origin.lat, destination.lat) + 1,
                        south: Math.min(origin.lat, destination.lat) - 1,
                        east: Math.max(origin.lon, destination.lon) + 1,
                        west: Math.min(origin.lon, destination.lon) - 1,
                    },
                    departureTime,
                );
                waveField = createWaveFieldFromSamples(data);
                if (waveField) {
                    log.info('wave field loaded — polar-with-waves slowdown active');
                }
            } catch (e) {
                log.warn('wave field fetch failed — routing on raw polar:', e);
            }

            // ── 4b. Ocean currents via OSCAR ──
            // For ocean passages currents shift ETA by ±20% on routes
            // aligned with major systems (Gulf Stream, Agulhas, Kuroshio,
            // East Australian Current, Antarctic Circumpolar). Fetching
            // a sparse OSCAR field lets the engine advect each candidate
            // by set/drift, producing a true SOG-based wavefront.
            //
            // Non-blocking on failure — if OSCAR / ERDDAP is down, the
            // engine routes on STW alone (same behaviour as before this
            // upgrade). Better to ship a route without currents than no
            // route at all.
            let currentField = null;
            try {
                const { OceanCurrentService } = await import('./OceanCurrentService');
                const { createCurrentFieldFromVectors } = await import('./weather/CurrentFieldAdapter');
                const courseBearing =
                    (Math.atan2(
                        Math.sin(dLon) * Math.cos(φ2),
                        Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon),
                    ) *
                        180) /
                    Math.PI;
                // Read user's NRT preference from settingsStore (loaded
                // separately from the React settings context here because
                // we're outside React). NRT = OSCAR's near-real-time
                // 5-day-old data (actual eddies / meanders); when off
                // we use monthly climatology (steady-state averages,
                // always-available, good enough for most routes).
                let useNrt = false;
                try {
                    const { useSettingsStore } = await import('../stores/settingsStore');
                    useNrt = useSettingsStore.getState().settings.currentNrtEnabled === true;
                } catch (_) {
                    /* fall back to climatology */
                }
                const briefing = await OceanCurrentService.fetchCurrents(
                    {
                        north: Math.max(origin.lat, destination.lat) + 1,
                        south: Math.min(origin.lat, destination.lat) - 1,
                        east: Math.max(origin.lon, destination.lon) + 1,
                        west: Math.min(origin.lon, destination.lon) - 1,
                    },
                    ((courseBearing % 360) + 360) % 360,
                    straightNM,
                    vessel.cruisingSpeed || 6,
                    useNrt,
                );
                currentField = createCurrentFieldFromVectors(briefing.vectors);
                if (currentField) {
                    log.info(
                        `OSCAR currents loaded: ${briefing.vectors.length} vectors, max ${briefing.maxSpeedKts} kts, source=${briefing.source}`,
                    );
                }
            } catch (e) {
                log.warn('current fetch failed — routing on STW only:', e);
            }

            // ── 5. Comfort params: blend vessel hard limits with user prefs ──
            // The vessel profile carries the boat's HARD MECHANICAL caps
            // (maxWindSpeed/maxWaveHeight) — what the boat can survive.
            // settings.comfortParams carries the user's CHOSEN comfort
            // ceiling — what the user is willing to put up with on this
            // particular trip. We pass both into the engine; whichever
            // is tighter wins per metric (Math.min on the caps).
            //
            // preferredAngles comes only from settings.comfortParams —
            // it's purely a user preference, not a hardware property.
            let comfortParams: import('./isochrone/types').IsochroneConfig['comfortParams'] | undefined;
            try {
                const { useSettingsStore } = await import('../stores/settingsStore');
                const userComfort = useSettingsStore.getState().settings.comfortParams ?? {};
                const vMaxWind = vessel.maxWindSpeed;
                const vMaxWave = vessel.maxWaveHeight;
                const uMaxWind = userComfort.maxWindKts;
                const uMaxWave = userComfort.maxWaveM;
                const uMaxGust = userComfort.maxGustKts;
                const tightestWind =
                    vMaxWind != null && uMaxWind != null ? Math.min(vMaxWind, uMaxWind) : (vMaxWind ?? uMaxWind);
                const tightestWave =
                    vMaxWave != null && uMaxWave != null ? Math.min(vMaxWave, uMaxWave) : (vMaxWave ?? uMaxWave);
                if (tightestWind != null || tightestWave != null || uMaxGust != null || userComfort.preferredAngles) {
                    comfortParams = {
                        maxWindKts: tightestWind,
                        maxWaveM: tightestWave,
                        maxGustKts: uMaxGust,
                        preferredAngles: userComfort.preferredAngles,
                    };
                }
            } catch (_) {
                // Fall back to vessel-only caps if settings store unavailable
                if (vessel.maxWindSpeed || vessel.maxWaveHeight) {
                    comfortParams = {
                        maxWindKts: vessel.maxWindSpeed,
                        maxWaveM: vessel.maxWaveHeight,
                    };
                }
            }

            // ── 6. Run the isochrone engine ──
            isoResult = await computeIsochrones(
                origin,
                destination,
                departureTime,
                polar,
                windField,
                {
                    vesselDraft: vessel.draft || 2.5,
                    motoringSpeed: vessel.cruisingSpeed || 6,
                    // No minDepthM for ocean passages — the engine still
                    // checks reef rejection and isLand from the bathy grid.
                    minDepthM: null,
                    comfortParams,
                },
                bathyGrid,
                currentField,
                exclusionField,
                waveField,
            );
        }

        if (!isoResult || isoResult.routeCoordinates.length < 2) {
            log.warn('isochrone returned no route');
            return null;
        }

        // ── 6. Map isochrone result back to VoyagePlan ──
        const merged: VoyagePlan = { ...voyagePlan };

        merged.routeGeoJSON = {
            type: 'Feature',
            properties: {
                source: 'isochrone',
                totalNM: isoResult.totalDistanceNM,
                durationHours: isoResult.totalDurationHours,
            },
            geometry: {
                type: 'LineString',
                coordinates: isoResult.routeCoordinates,
            },
        };

        merged.distanceApprox = `${Math.round(isoResult.totalDistanceNM)} nautical miles`;
        merged.durationApprox = formatDuration(isoResult.totalDurationHours);

        // ── 7. Turn waypoints from isochrone path ──
        const { detectTurnWaypoints } = await import('./IsochroneRouter');
        // 25° threshold (default is 15°) — at 15° even a routine wind
        // shift on a long bluewater leg generates a "turn waypoint",
        // producing 14-20 named WPs that clutter the chart and don't
        // represent actionable course changes. 25° catches genuine
        // strategic turns (rounding a headland, hooking around a
        // weather feature) while ignoring sub-strategic wiggles.
        const turns = detectTurnWaypoints(isoResult.route, departureTime, 25);
        merged.waypoints = turns.map((t) => ({
            name: t.id,
            coordinates: { lat: t.lat, lon: t.lon },
            windSpeed: Math.round(t.tws),
        }));

        merged.routeReasoning =
            (merged.routeReasoning ? merged.routeReasoning + ' ' : '') +
            `Isochrone-optimised: ${Math.round(isoResult.totalDistanceNM)} NM in ${merged.durationApprox} ` +
            `via ${turns.length} turn waypoints. Wavefront propagation through GFS wind field with vessel polar performance.`;

        // ── 8. Build a spatiotemporal payload from the isochrone result ──
        // The 4D Passage Canvas expects __spatiotemporalPayload to render.
        // We don't have wind/wave per-node from isochrone (yet — that's
        // Tier 2 work), so populate what we can and let the canvas show
        // the route geometry without per-point conditions.
        const trackPoints = decimateTrack(isoResult.route, 100).map((n) => ({
            coordinates: [n.lon, n.lat] as [number, number],
            distance_from_start_nm: Math.round(n.distance * 10) / 10,
            time_offset_hours: Math.round(n.timeHours * 10) / 10,
            // Intermediate waypoints have no name; first/last get
            // overwritten with origin/destination below. TrackPoint
            // declares `name: string` so we use empty string, not
            // undefined.
            name: '',
            lateral_offset_nm: 0,
            conditions: {
                depth_m: n.depth_m ?? null,
                wind_spd_kts: Math.round(n.tws),
                wind_dir_deg: 0, // unknown without storing wind direction per node
                wave_ht_m: 0, // wave field not consulted by isochrone (yet)
                swell_period_s: null,
            },
        }));
        if (trackPoints.length > 0) {
            trackPoints[0].name = voyagePlan.origin;
            trackPoints[trackPoints.length - 1].name = voyagePlan.destination;
        }
        const lons = isoResult.routeCoordinates.map((c) => c[0]);
        const lats = isoResult.routeCoordinates.map((c) => c[1]);
        merged.__spatiotemporalPayload = {
            summary: {
                total_distance_nm: isoResult.totalDistanceNM,
                total_duration_hours: isoResult.totalDurationHours,
                cost_score: 0,
                computation_ms: 0,
                routing_mode: 'isochrone',
                vessel_type: vessel.type === 'observer' ? 'power' : vessel.type,
                departure_time: departureTime,
            },
            bounding_box: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
            track: trackPoints,
            mesh_stats: {
                total_nodes: isoResult.isochrones.reduce((sum, iso) => sum + iso.nodes.length, 0),
                rows: isoResult.isochrones.length,
                cols: 0,
                corridor_width_nm: 0,
                weather_grid_points: 0,
                forecast_hours: 0,
            },
        };

        return merged;
    } catch (e) {
        log.warn('isochrone enhancement threw:', e);
        return null;
    }
}

import { maxOf, minOf } from '../utils/extremes';
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
import { vesselDraftMetres, vesselDraftIsAssumed } from './units';
import { loadIsochroneEnvironment, type IsochroneEnvironment } from './routing/isochroneEnvironment';
import { vesselIsochroneConfig, isochroneRoutingContext } from './routing/isochronePolicy';
import { useSettingsStore } from '../stores/settingsStore';
import { routingComfortConfig } from './routing/isochronePolicy';
import { estimateRouteFuel } from './isochrone/routeStats';
import { verifiedIsochroneRoute } from './routing/verifiedIsochroneRoute';
import { inspectRouteEnvironment } from './isochrone/routeComfort';
import { RoutingExclusionFailure, isRoutingExclusionFailure } from './routing/passageExclusions';
import { routingExclusionContextKey } from './routing/routingExclusions';

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
        // One implementation, shared with WindDataController and the passage
        // planner. Two hand-copies of this block missed the pinned-transport
        // migration; see services/weather/fetchWindGrid.ts.
        const { fetchWindGridBuffer } = await import('./weather/fetchWindGrid');
        const { status, buf } = await fetchWindGridBuffer({ north, south, east, west }, { timeoutMs: 20_000 });
        if (status < 200 || status >= 300) {
            log.warn(`wind grid fetch failed: HTTP ${status}`);
            return false;
        }
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
 * null when no enhancement is available. Structured route-area failures
 * propagate so callers must hold rather than bypass an enabled no-go policy.
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
        // Hitting the cache saves the 30-60s recompute. The cache is keyed on
        // the routing polar too, so resolve it first (services/routingPolar).
        const { resolveRoutingPolar } = await import('./routingPolar');
        const routingPolar = await resolveRoutingPolar({ vessel });
        const { getPrecomputedRoute } = await import('./IsochronePrecomputeCache');
        const routingSettings = useSettingsStore.getState().settings;
        let routingEnvironment: IsochroneEnvironment | null = null;
        let isoResult = getPrecomputedRoute(
            origin.lat,
            origin.lon,
            destination.lat,
            destination.lon,
            routingPolar.signature,
            undefined,
            isochroneRoutingContext(departureTime, { ...routingSettings, vessel }),
        );

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
            const { preloadBathymetry } = await import('./BathymetryCache');
            const { computeComfortIsochrones: computeIsochrones } = await import('./routing/comfortRoute');

            const windGrid = WindStore.getState().grid;
            if (!windGrid) {
                log.warn('wind grid unset after fetch — bailing');
                return null;
            }
            const windField = createWindFieldFromGrid(windGrid);
            const polar = routingPolar.polar;

            // ── 3. Bathymetry preload ──
            // Without this the IsochroneRouter falls back to per-step HTTP
            // depth queries (slow and rate-limited). preloadBathymetry pulls
            // the coarse NOAA ETOPO grid for the route bbox once.
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

            const environment = await loadIsochroneEnvironment({
                origin,
                destination,
                departureTime,
                speedKts: vesselIsochroneConfig(vessel, straightNM).motoringSpeed,
                currentNrtEnabled: routingSettings.currentNrtEnabled,
                satelliteMode: routingSettings.satelliteMode,
            });
            routingEnvironment = environment;
            const { currentField, exclusionField, waveField } = environment;

            // ── 6. Run the isochrone engine ──
            isoResult = await computeIsochrones(
                origin,
                destination,
                departureTime,
                polar,
                windField,
                {
                    // Isochrone options take METRES; vessel.draft is FEET
                    // (see services/units.ts).
                    vesselDraft: vesselDraftMetres(vessel),
                    ...vesselIsochroneConfig(vessel, straightNM),
                    // No minDepthM for ocean passages — the engine still
                    // checks reef rejection and isLand from the bathy grid.
                    minDepthM: null,
                    ...routingComfortConfig(vessel, routingSettings.comfortParams),
                },
                bathyGrid,
                currentField,
                exclusionField,
                waveField,
            );
            if (isoResult) isoResult.environmentNotes = environment.notes;
        }

        if (!isoResult || isoResult.routeCoordinates.length < 2) {
            log.warn('isochrone returned no route');
            return null;
        }

        // ── 5b. Exact ENC + coarse ETOPO route validation ──
        // The IsochroneRouter does multi-pass land avoidance against the
        // local 0.1° bathymetry grid (~6 NM resolution). That catches
        // major coastlines but can miss small islands, reefs, and shoals
        // sitting between waypoints — especially in places like the
        // Coral Sea, Bahamas, or Indonesian archipelago.
        //
        // validateRouteSegments checks exact ENC feature intersections and
        // samples NOAA ETOPO global relief as a coarse backstop, then inserts
        // perpendicular detour waypoints around detected island/reef/shoal
        // crossings the local grid missed. ETOPO is not chart verification.
        //
        // Same logic the inline-map passage planner already runs — we
        // were just not invoking it from the form pipeline. Without
        // this step, the form-calculated route renders before the
        // user with potentially-island-clipping geometry.
        //
        // Capped at 15s (matches usePassagePlanner). An unfinished final
        // private-policy check holds the route; it cannot adopt an old line.
        let acceptedAreaKey: string | undefined;
        let acceptedSourceCurrent: (() => boolean) | undefined;
        const validationAbort = new AbortController();
        let validationTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const { validateRouteSegments } = await import('./isochrone/landAvoidance');
            const departureTimeMs = departureTime ? new Date(departureTime).getTime() : undefined;
            // Report-race guard + loud timeout (2026-07-17 audit): the
            // timed-out validator must not later overwrite the live report
            // for a line we shipped un-verified — and the shipping itself
            // must be announced, not buried in a prod-silenced log.
            let enhancerStale = false;
            let areaCaveats: readonly string[] = [];
            const validationAreaKey = routingExclusionContextKey();
            const validated = await Promise.race([
                validateRouteSegments(isoResult.route, {
                    // The field name says M — vessel.draft is FEET. Raw
                    // feet here was the "bathymetry is sometimes off" bug.
                    vesselDraftM: vesselDraftMetres(vessel),
                    // Assumed default draft (no draft set) → surface the caution (audit #2).
                    draftAssumed: vesselDraftIsAssumed(vessel),
                    departureTimeMs,
                    stillCurrent: () => !enhancerStale,
                    signal: validationAbort.signal,
                    onRouteAreaCaveats: (notes, sourceCurrent) => {
                        areaCaveats = notes;
                        acceptedSourceCurrent = sourceCurrent;
                    },
                }),
                new Promise<null>(
                    (resolve) =>
                        (validationTimer = setTimeout(() => {
                            enhancerStale = true;
                            validationAbort.abort();
                            resolve(null);
                        }, 15_000)),
                ),
            ]);
            if (!validated) {
                const { publishRouteNotValidated } = await import('./enc/EncHazardReportService');
                publishRouteNotValidated('depth validation timed out (15 s)');
                throw new RoutingExclusionFailure(
                    'exclusion-unavailable',
                    'Final passage area verification timed out. Review the route again.',
                );
            }
            if (validated) {
                if (routingExclusionContextKey() !== validationAreaKey || acceptedSourceCurrent?.() === false)
                    throw new RoutingExclusionFailure(
                        'exclusion-unavailable',
                        'The passage area policy changed before acceptance. Review the route again.',
                    );
                acceptedAreaKey = validationAreaKey;
                const checked = verifiedIsochroneRoute(
                    isoResult,
                    validated,
                    departureTime,
                    vesselIsochroneConfig(vessel, isoResult.totalDistanceNM).motoringSpeed,
                );
                if (checked.routeCoordinates !== isoResult.routeCoordinates && !routingEnvironment) return null;
                if (routingEnvironment) {
                    const checkedEnvironment = inspectRouteEnvironment(
                        checked.route,
                        routingEnvironment.waveField,
                        routingEnvironment.exclusionField,
                        isoResult.comfort?.usedLimitM ??
                            routingComfortConfig(vessel, routingSettings.comfortParams).comfortParams?.maxWaveM,
                        routingComfortConfig(vessel, routingSettings.comfortParams).comfortVessel,
                    );
                    if (checkedEnvironment.rejected) return null;
                    checked.comfort = {
                        ...checkedEnvironment.comfort,
                        ...(isoResult.comfort?.relaxedFromM !== undefined
                            ? { relaxedFromM: isoResult.comfort.relaxedFromM, usedLimitM: isoResult.comfort.usedLimitM }
                            : {}),
                    };
                }
                isoResult = {
                    ...checked,
                    environmentNotes: [...new Set([...(checked.environmentNotes ?? []), ...areaCaveats])],
                };
            }
        } catch (e) {
            validationAbort.abort();
            if (isRoutingExclusionFailure(e)) throw e;
            // Cancellation/unknown validation failure supplies no private-policy proof.
            throw new RoutingExclusionFailure(
                'exclusion-unavailable',
                'Final passage area verification could not complete. Review the route again.',
            );
        } finally {
            clearTimeout(validationTimer);
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

        merged.sailingStats = isoResult.sailingStats;
        merged.routeComfort = isoResult.comfort;
        merged.routeFuel = estimateRouteFuel(isoResult.motorHours, isoResult.totalDurationHours, vessel);
        merged.routeReasoning =
            (merged.routeReasoning ? merged.routeReasoning + ' ' : '') +
            `Isochrone-optimised: ${Math.round(isoResult.totalDistanceNM)} NM in ${merged.durationApprox} ` +
            `via ${turns.length} turn waypoints. Wavefront propagation through GFS wind field with vessel polar performance. ` +
            (isoResult.environmentNotes ?? []).join(' ');

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
            bounding_box: [minOf(lons), minOf(lats), maxOf(lons), maxOf(lats)],
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

        if (!acceptedAreaKey || routingExclusionContextKey() !== acceptedAreaKey || acceptedSourceCurrent?.() === false)
            throw new RoutingExclusionFailure(
                'exclusion-unavailable',
                'The passage area policy changed before acceptance. Review the route again.',
            );
        return merged;
    } catch (e) {
        if (isRoutingExclusionFailure(e)) throw e;
        log.warn('isochrone enhancement threw:', e);
        return null;
    }
}

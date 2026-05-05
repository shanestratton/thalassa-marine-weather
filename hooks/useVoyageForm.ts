import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
// geminiService dynamically imported at call sites
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { DeepAnalysisReport } from '../types';
import { LocationStore } from '../stores/LocationStore';
import { getErrorMessage } from '../utils/logger';
import { generateSeaRoute } from '../utils/seaRoute';
import { GpsService } from '../services/GpsService';

export const LOADING_PHASES = [
    'Querying Hydrographic Data...',
    'Analyzing Tidal Streams...',
    'Checking Notices to Mariners...',
    'Plotting Waypoints...',
    'Calculating ETAs...',
    'Checking Depth Clearances...',
    'Verifying Air Draft...',
    'Route Optimization...',
    'Weather Routing...',
    'Checking Safety Constraints...',
    'Reviewing Pilotage Notes...',
    'Generating Passage Plan...',
    'Finalizing Route...',
    'Completing Analysis...',
];

export const useVoyageForm = (onTriggerUpgrade: () => void) => {
    const { settings } = useSettings();
    const { weatherData, voyagePlan, saveVoyagePlan } = useWeather();
    const { vessel, vesselUnits, units: generalUnits, isPro, mapboxToken } = settings;

    // Form State
    const [origin, setOrigin] = useState('');
    const [destination, setDestination] = useState('');
    const [via, setVia] = useState('');
    const [departureDate, setDepartureDate] = useState(
        voyagePlan?.departureDate || new Date().toLocaleDateString('en-CA'),
    );

    // UI State
    const [isMapOpen, setIsMapOpen] = useState(false);
    const [mapSelectionTarget, setMapSelectionTarget] = useState<'origin' | 'destination' | 'via' | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingStep, setLoadingStep] = useState(0);
    const [error, setError] = useState<string | null>(null);

    // Deep Analysis State
    const [analyzingDeep, setAnalyzingDeep] = useState(false);
    const [deepReport, setDeepReport] = useState<DeepAnalysisReport | null>(null);

    // Departure-Window Planner State
    const [planningWindow, setPlanningWindow] = useState(false);
    const [windowScenarios, setWindowScenarios] = useState<import('../services/departureWindow').DepartureScenario[]>(
        [],
    );
    const [showWindowSheet, setShowWindowSheet] = useState(false);
    const [windowProgress, setWindowProgress] = useState<string | undefined>(undefined);

    // Checklist State
    const [checklistState, setChecklistState] = useState<Record<string, boolean>>({});
    const [activeChecklistTab, setActiveChecklistTab] = useState('safety');

    // Session ID — bumped on each new calculate or explicit reset. The
    // background enhancement pipeline captures this at start and only
    // commits its progressive saveVoyagePlan() calls if the session is
    // still current. This is what stops a previous route's enhancements
    // from re-populating WeatherContext.voyagePlan after the user has
    // returned to RoutePlanner expecting a clean form.
    const sessionIdRef = useRef(0);

    // Reset Deep Report on param change
    useEffect(() => {
        if (voyagePlan?.origin !== origin || voyagePlan?.destination !== destination) {
            setDeepReport(null);
        }
    }, [voyagePlan, origin, destination]);

    // Sync the date input from voyagePlan.departureDate when it loads.
    // The useState initializer above only fires once on mount — if
    // voyagePlan is still loading from WeatherContext at that point,
    // departureDate defaults to today and stays there even after
    // voyagePlan loads with the user's actual saved date. The user
    // then re-hits Calculate, today's date flows back into the new
    // voyage record, and the Passage Summary card displays today
    // instead of the date the user picked. This effect keeps the form
    // in sync with the loaded plan.
    useEffect(() => {
        if (voyagePlan?.departureDate && voyagePlan.departureDate !== departureDate) {
            setDepartureDate(voyagePlan.departureDate);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voyagePlan?.departureDate]);

    /**
     * Setting the departure date in the form should also push the new
     * date through to the active voyage record so the Passage Summary
     * card and the Crew Management dropdown both reflect it
     * immediately. Without this the user changes the date, navigates
     * to Crew Management, and still sees the old date because the
     * voyage record was only ever updated at Calculate-time.
     *
     * Match strategy: trimCountrySuffix on the active plan's origin /
     * destination, look up the matching draft voyage by name, update
     * its departure_time + recompute eta (preserving the original
     * duration delta). Mirrors WeatherWindowCard.acceptWindow.
     *
     * Non-blocking — if the voyage update fails (no Supabase auth, no
     * matching voyage, network error), we still update the form
     * state. The user can still re-Calculate to force a save.
     */
    const handleDateChange = useCallback(
        async (newDate: string) => {
            setDepartureDate(newDate);
            if (!voyagePlan?.origin || !voyagePlan?.destination) return;

            try {
                // Build the expected voyage_name the same way
                // PassagePlanSave.createVoyage did:
                //   "{trimCountrySuffix(origin)} → {trimCountrySuffix(destination)}"
                // Inline the trim so we don't take a service dependency.
                const trim = (name: string) => {
                    const parts = name
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (parts.length === 0) return name;
                    if (parts.length === 1) return parts[0];
                    const last = parts[parts.length - 1];
                    if (/^[A-Z]{2,4}$/.test(last)) return parts.slice(0, -1).join(', ');
                    if (parts.length >= 3) return parts.slice(0, -1).join(', ');
                    return parts.join(', ');
                };
                const expectedName = `${trim(voyagePlan.origin)} → ${trim(voyagePlan.destination)}`;

                const { getDraftVoyages, updateVoyage } = await import('../services/VoyageService');
                const drafts = await getDraftVoyages();
                const match = drafts.find((v) => v.voyage_name === expectedName);
                if (!match) return;

                // Compute new departure_time as midnight UTC of the
                // selected date. Preserve duration: if the existing
                // voyage has a valid (departure_time, eta) pair, the
                // new eta = new departure + (oldEta - oldDeparture).
                const newDepartureIso = new Date(`${newDate}T00:00:00Z`).toISOString();
                const patch: { departure_time: string; eta?: string } = {
                    departure_time: newDepartureIso,
                };
                if (match.departure_time && match.eta) {
                    const oldDep = new Date(match.departure_time).getTime();
                    const oldEta = new Date(match.eta).getTime();
                    if (!isNaN(oldDep) && !isNaN(oldEta) && oldEta > oldDep) {
                        const durationMs = oldEta - oldDep;
                        patch.eta = new Date(new Date(newDepartureIso).getTime() + durationMs).toISOString();
                    }
                }
                await updateVoyage(match.id, patch);

                // Update voyagePlan in WeatherContext so the form +
                // any other consumers see the new date without a
                // remount.
                saveVoyagePlan({ ...voyagePlan, departureDate: newDate });

                // Notify any open PassageSummaryCard / banner / etc.
                // to re-read the new departure time. Same event the
                // WeatherWindowCard fires on accept.
                try {
                    window.dispatchEvent(
                        new CustomEvent('thalassa:departure-time-updated', {
                            detail: {
                                voyageId: match.id,
                                hhmm: '00:00',
                                iso: newDepartureIso,
                            },
                        }),
                    );
                } catch {
                    /* SSR safety */
                }
            } catch (e) {
                // Non-critical — user can still re-Calculate to force
                // a save. Form state already updated by setDepartureDate
                // above.
                console.warn('[useVoyageForm] handleDateChange voyage sync failed:', e);
            }
        },
        [voyagePlan, saveVoyagePlan],
    );

    // Loading Animation Loop
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | undefined;
        if (loading) {
            setLoadingStep(0);
            interval = setInterval(() => {
                setLoadingStep((s) => {
                    if (s >= LOADING_PHASES.length - 1)
                        return LOADING_PHASES.length - 3 + ((s - (LOADING_PHASES.length - 3) + 1) % 3);
                    return s + 1;
                });
            }, 1800);
        }
        return () => clearInterval(interval);
    }, [loading]);

    // HANDLERS

    const handleCalculate = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        // PAYWALL INTERCEPTION
        if (!isPro) {
            onTriggerUpgrade();
            return;
        }

        if (!origin || !destination) return;

        // SAFEGUARD: Ensure vessel profile exists before calculation
        if (!vessel) {
            setError('Vessel profile missing. Please configure in settings.');
            return;
        }

        // Auto-Format inputs before submission
        const fmtOrigin = formatLocationInput(origin);
        const fmtDest = formatLocationInput(destination);
        const fmtVia = via ? formatLocationInput(via) : '';

        setOrigin(fmtOrigin);
        setDestination(fmtDest);
        setVia(fmtVia);

        // Bump session: this is a NEW route plan. Any pending enhancement
        // pipeline writes from a previous calculate are now stale and
        // will be dropped by saveIfActive below.
        sessionIdRef.current += 1;
        const mySession = sessionIdRef.current;
        const saveIfActive = (plan: import('../types').VoyagePlan) => {
            if (sessionIdRef.current !== mySession) return; // stale — user reset / re-calculated
            saveVoyagePlan(plan);
        };

        setLoading(true);
        setError(null);
        setDeepReport(null);
        try {
            // ── DETERMINISTIC route compute (replaces Gemini) ──
            //
            // Gemini was hallucinating every safety-relevant field:
            //   - origin/destination: rewrote "Newport QLD" → "QLD",
            //     "Port Moselle NC" → "South Province" (the
            //     administrative region of Nouméa)
            //   - distanceApprox: claimed "1.9 days" for an 870 NM
            //     passage at 6 kn (actually ~7 days)
            //   - durationApprox: was a free-text LLM string, not math
            //   - waypoints: zigzag patterns that inflated summed leg
            //     distances 2× over the real sailable path
            //   - departureDate: sometimes echoed today instead of the
            //     user's pick
            //
            // We were already overriding all of those after the call —
            // paying real Gemini latency + tokens + hallucination risk
            // for fields we threw away. The deterministic compute below
            // does exactly what we kept, with no LLM in the loop.
            //
            // The enhancement pipeline that runs after this (bathymetric
            // router → weather router → depth analysis → multi-model
            // comparison) is what produces the safety-critical outputs:
            // depth-safe sea-following geometry, corridor-optimised ETA,
            // wind/wave conditions per waypoint. Those services use
            // GEBCO bathymetry + ECMWF/GFS forecasts + cost-optimal
            // graph search — not an LLM.
            //
            // The origin-only fetchFastWeather "weatherContext" peek that
            // used to feed Gemini's prompt is gone — the bathymetric and
            // weather routers fetch their own forecast coverage across
            // the full route via the route-weather edge function. No
            // consumer left for an origin-only context blob.
            //
            // userLocation is captured but currently unused by
            // computeVoyagePlan — disambiguation is handled by
            // parseLocation's Mapbox forward geocode, which already
            // accepts coordinate-suffixed inputs ("Port Moselle
            // (-22.2765, 166.4377)") for precise matching. Kept on the
            // signature for any future enrichment hook.
            const { computeVoyagePlan } = await import('../services/voyageCompute');
            const userLoc = LocationStore.getState();
            const userLocation =
                userLoc.lat !== 0 || userLoc.lon !== 0 ? { lat: userLoc.lat, lon: userLoc.lon } : undefined;
            const result = await computeVoyagePlan(
                fmtOrigin,
                fmtDest,
                vessel,
                departureDate,
                vesselUnits,
                generalUnits,
                fmtVia,
                undefined,
                userLocation,
            );

            // ── Show the plan IMMEDIATELY — don't wait for enhancements ──
            saveIfActive(result);
            setLoading(false);

            // ── Enhancement Pipeline (runs in background, progressively updates) ──
            // Each step saves the enhanced plan as it completes, so the UI updates incrementally.
            //
            // Emit window events around the pipeline so any visible-on-screen
            // surface (PassageBanner, MapHub overlay, etc.) can show the
            // "Refining route..." chip without prop-drilling. The basic
            // plan landed already; the user is likely navigated to MapHub
            // by now, but the route geometry is still being progressively
            // optimized for the next 10-30s.
            window.dispatchEvent(new CustomEvent('thalassa:passage-enhancement-start'));
            setTimeout(async () => {
                let enhancedPlan = result;

                // Step 1: Bathymetric routing — depth-safe waypoints
                try {
                    const { enhanceVoyagePlanWithBathymetry } = await import('../services/bathymetricRouter');
                    enhancedPlan = await enhanceVoyagePlanWithBathymetry(result, vessel);
                    saveIfActive(enhancedPlan);
                } catch (_) {
                    console.warn(`[useVoyageForm]`, _);
                }

                // Step 1b: Detect direction-change bends in the curved
                // bathymetric polyline and surface them as waypoints.
                // The router only emits the high-level named WPs from
                // Gemini; the actual sea-following geometry has bends at
                // every shoal/headland avoidance that the user expects to
                // see as named turn-points in the saved logbook route.
                try {
                    if (enhancedPlan.routeGeoJSON?.geometry?.coordinates) {
                        const { detectBends } = await import('../services/passage/detectBends');
                        const existingWps: Array<{ lat: number; lon: number }> = [];
                        if (enhancedPlan.originCoordinates) existingWps.push(enhancedPlan.originCoordinates);
                        if (enhancedPlan.destinationCoordinates) existingWps.push(enhancedPlan.destinationCoordinates);
                        for (const wp of enhancedPlan.waypoints || []) {
                            if (wp.coordinates) existingWps.push(wp.coordinates);
                        }
                        const coords = enhancedPlan.routeGeoJSON.geometry.coordinates as Array<[number, number]>;
                        const bends = detectBends(coords, { existingWaypoints: existingWps });
                        if (bends.length > 0) {
                            const bendWps = bends.map((b, i) => ({
                                name: `Bend ${i + 1} (${Math.round(b.bendDeg)}°)`,
                                coordinates: b.coordinates,
                            }));
                            // Merge in passage order — bend waypoints sort
                            // by their position along the route, then the
                            // Gemini-named WPs interleave naturally on
                            // distance-from-origin.
                            const merged = [...(enhancedPlan.waypoints || []), ...bendWps].sort((a, b) => {
                                if (!enhancedPlan.originCoordinates || !a.coordinates || !b.coordinates) return 0;
                                const oLat = enhancedPlan.originCoordinates.lat;
                                const oLon = enhancedPlan.originCoordinates.lon;
                                const da = (a.coordinates.lat - oLat) ** 2 + (a.coordinates.lon - oLon) ** 2;
                                const db = (b.coordinates.lat - oLat) ** 2 + (b.coordinates.lon - oLon) ** 2;
                                return da - db;
                            });
                            enhancedPlan = { ...enhancedPlan, waypoints: merged };
                            saveIfActive(enhancedPlan);
                        }
                    }
                } catch (_) {
                    console.warn(`[useVoyageForm] bend detection failed`, _);
                }

                // Step 2a: Isochrone routing — wavefront propagation (PRIMARY).
                // This is the same routing approach PredictWind, Expedition,
                // qtVlm, Squid all use. Wavefronts propagate from departure
                // every timeStep hours, weighted by polar performance at the
                // local wind/wave conditions; the optimal path is whichever
                // node reaches destination first.
                //
                // Returns null when:
                //   - route is < 100 NM (coastal — bathymetric channel
                //     geometry is more useful than isochrone)
                //   - no wind grid available
                //   - polar lookup empty
                //   - engine fails or times out
                // In those cases the corridor router below picks up the slack.
                let isochroneSucceeded = false;
                try {
                    const { enhanceVoyagePlanWithIsochrone } = await import('../services/isochroneEnhancer');
                    const isoResult = await enhanceVoyagePlanWithIsochrone(enhancedPlan, vessel, departureDate);
                    if (isoResult) {
                        enhancedPlan = isoResult;
                        isochroneSucceeded = true;
                        saveIfActive(enhancedPlan);
                    }
                } catch (_) {
                    console.warn(`[useVoyageForm] isochrone enhancement failed`, _);
                }

                // Step 2b: Weather routing — corridor optimisation (FALLBACK).
                // Runs only when the isochrone engine couldn't produce a
                // route. Builds a 30 NM-wide corridor along the centerline
                // and runs A* through it. Less optimal than isochrone for
                // bluewater but still benefits coastal short hops where the
                // bathymetric routeGeoJSON is the real workhorse.
                if (!isochroneSucceeded) {
                    try {
                        const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                        enhancedPlan = await enhanceVoyagePlanWithWeather(enhancedPlan, vessel, departureDate);
                        saveIfActive(enhancedPlan);
                    } catch (_) {
                        console.warn(`[useVoyageForm]`, _);
                    }
                }

                // Steps 3 & 4 can run in parallel (both read from enhancedPlan, write to separate fields)
                const step3 = (async () => {
                    try {
                        const { enhanceRouteWithDepth } = await import('../services/WeatherRoutingService');
                        const { computeRoute: computeRt } = await import('../services/WeatherRoutingService');

                        const depthWaypoints = [];
                        if (enhancedPlan.originCoordinates) {
                            depthWaypoints.push({
                                id: 'dep',
                                lat: enhancedPlan.originCoordinates.lat,
                                lon: enhancedPlan.originCoordinates.lon,
                                name: enhancedPlan.origin || 'Departure',
                            });
                        }
                        for (const wp of enhancedPlan.waypoints || []) {
                            if (wp.coordinates) {
                                depthWaypoints.push({
                                    id: wp.name || 'wp',
                                    lat: wp.coordinates.lat,
                                    lon: wp.coordinates.lon,
                                    name: wp.name || 'WP',
                                });
                            }
                        }
                        if (enhancedPlan.destinationCoordinates) {
                            depthWaypoints.push({
                                id: 'arr',
                                lat: enhancedPlan.destinationCoordinates.lat,
                                lon: enhancedPlan.destinationCoordinates.lon,
                                name: enhancedPlan.destination || 'Arrival',
                            });
                        }

                        if (depthWaypoints.length >= 2) {
                            const routeAnalysis = computeRt(depthWaypoints, {
                                speed: vessel.cruisingSpeed || 6,
                                vesselDraft: vessel.draft || 2.5,
                            });
                            const depthEnhanced = await enhanceRouteWithDepth(routeAnalysis, vessel.draft || 2.5);
                            enhancedPlan.__depthSummary = {
                                minDepth: depthEnhanced.minDepth,
                                shallowSegments: depthEnhanced.shallowSegments,
                                totalSegments: depthEnhanced.segments.length,
                                segments: depthEnhanced.segments.map((s) => ({
                                    depth_m: s.depth_m ?? null,
                                    safety: s.depthSafety ?? 'unknown',
                                    costMultiplier: s.depthCostMultiplier ?? 1,
                                })),
                            };
                        }
                    } catch (_) {
                        console.warn(`[useVoyageForm]`, _);
                    }
                })();

                const step4 = (async () => {
                    try {
                        const { queryMultiModel, recommendModels } =
                            await import('../services/weather/MultiModelWeatherService');

                        const comparisonPoints: { lat: number; lon: number; name?: string }[] = [];
                        if (enhancedPlan.originCoordinates) {
                            comparisonPoints.push({
                                lat: enhancedPlan.originCoordinates.lat,
                                lon: enhancedPlan.originCoordinates.lon,
                                name: enhancedPlan.origin,
                            });
                        }
                        for (const wp of enhancedPlan.waypoints || []) {
                            if (wp.coordinates) {
                                comparisonPoints.push({
                                    lat: wp.coordinates.lat,
                                    lon: wp.coordinates.lon,
                                    name: wp.name,
                                });
                            }
                        }
                        if (enhancedPlan.destinationCoordinates) {
                            comparisonPoints.push({
                                lat: enhancedPlan.destinationCoordinates.lat,
                                lon: enhancedPlan.destinationCoordinates.lon,
                                name: enhancedPlan.destination,
                            });
                        }

                        if (comparisonPoints.length >= 2) {
                            const midpoint = comparisonPoints[Math.floor(comparisonPoints.length / 2)];
                            const modelIds = recommendModels(midpoint.lat, midpoint.lon);
                            const multiModelResult = await queryMultiModel(comparisonPoints, modelIds);
                            if (multiModelResult) {
                                enhancedPlan.__multiModelComparison = multiModelResult;
                            }
                        }
                    } catch (_) {
                        console.warn(`[useVoyageForm]`, _);
                    }
                })();

                // Wait for both parallel steps, then save final enhanced plan
                await Promise.allSettled([step3, step4]);
                saveIfActive({ ...enhancedPlan });
                // Pipeline complete — let any visible "Refining route…"
                // chip dismiss itself. Emit even if session was bumped
                // mid-flight so the chip never gets stuck visible.
                window.dispatchEvent(new CustomEvent('thalassa:passage-enhancement-end'));
            }, 50);

            // ── Background: pre-compute isochrone so the map route is ready ──
            if (result.originCoordinates && result.destinationCoordinates) {
                import('../services/IsochronePrecomputeCache')
                    .then(({ precomputeIsochrone }) => {
                        precomputeIsochrone(
                            result.originCoordinates!,
                            result.destinationCoordinates!,
                            departureDate || new Date().toISOString(),
                        );
                    })
                    .catch(() => {
                        /* Non-critical */
                    });
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Calculation Systems Failure');
            // If the pipeline aborted before kicking off enhancements
            // we never emit the start event; if it failed mid-way the
            // setTimeout owner is responsible for emitting :end. This
            // catch covers the case where the basic Gemini call itself
            // threw — no enhancement chip should be lingering.
            window.dispatchEvent(new CustomEvent('thalassa:passage-enhancement-end'));
        } finally {
            setLoading(false);
        }
    };

    /**
     * Open the departure-window sheet and run planDepartureWindow().
     *
     * Loads the same engine fields the main pipeline uses (wind grid,
     * polar, bathymetry, OSCAR currents, cyclone exclusions), then
     * iterates ~14 candidate departure times across the next 7 days
     * and ranks them by ETA + gale exposure.
     *
     * Streams partial results via 'thalassa:departure-window-progress'
     * so the sheet populates live as each scenario lands.
     */
    const handlePlanWindow = useCallback(async () => {
        if (!isPro) {
            onTriggerUpgrade();
            return;
        }
        if (!origin || !destination || !vessel) {
            setError('Origin, destination, and vessel profile required.');
            return;
        }

        const fmtOrigin = formatLocationInput(origin);
        const fmtDest = formatLocationInput(destination);

        setShowWindowSheet(true);
        setPlanningWindow(true);
        setWindowScenarios([]);
        setError(null);

        // Live-update the sheet as scenarios complete
        const progressHandler = ((e: CustomEvent) => {
            const detail = e.detail as { completed: number; total: number; scenarios: unknown };
            setWindowProgress(`Computing ${detail.completed} of ${detail.total}…`);
            if (Array.isArray(detail.scenarios)) {
                setWindowScenarios([
                    ...(detail.scenarios as import('../services/departureWindow').DepartureScenario[]),
                ]);
            }
        }) as EventListener;
        window.addEventListener('thalassa:departure-window-progress', progressHandler);

        try {
            // 1. Resolve coordinates
            const { parseLocation } = await import('../services/weather/api/geocoding');
            const [originGeo, destGeo] = await Promise.all([parseLocation(fmtOrigin), parseLocation(fmtDest)]);
            if (originGeo.lat === 0 || destGeo.lat === 0) {
                throw new Error('Could not geocode origin or destination.');
            }
            const o = { lat: originGeo.lat, lon: originGeo.lon };
            const d = { lat: destGeo.lat, lon: destGeo.lon };

            // 2. Load engine fields (mirrors isochroneEnhancer)
            const { WindStore } = await import('../stores/WindStore');
            const { createWindFieldFromGrid } = await import('../services/weather/WindFieldAdapter');
            const { SmartPolarStore } = await import('../services/SmartPolarStore');
            const { DEFAULT_CRUISING_POLAR } = await import('../services/defaultPolar');
            const { preloadBathymetry } = await import('../services/BathymetryCache');

            // Wind: ensure grid is loaded for the route bbox
            if (!WindStore.getState().grid) {
                // Same fetch logic as isochroneEnhancer.ensureWindGridForRoute
                const minLat = Math.min(o.lat, d.lat);
                const maxLat = Math.max(o.lat, d.lat);
                const minLon = Math.min(o.lon, d.lon);
                const maxLon = Math.max(o.lon, d.lon);
                const latPad = Math.max((maxLat - minLat) * 0.3, 2);
                const lonPad = Math.max((maxLon - minLon) * 0.3, 2);
                const bbox = {
                    north: Math.min(maxLat + latPad, 85),
                    south: Math.max(minLat - latPad, -85),
                    west: minLon - lonPad,
                    east: maxLon + lonPad,
                };
                const supabaseUrl =
                    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
                    'https://pcisdplnodrphauixcau.supabase.co';
                const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
                const { piCache } = await import('../services/PiCacheService');
                const usePi = piCache.isAvailable();
                const url = usePi
                    ? `${piCache.baseUrl}/api/grib/wind-grid`
                    : `${supabaseUrl}/functions/v1/fetch-wind-grid`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(usePi || !supabaseKey
                            ? {}
                            : { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }),
                    },
                    body: JSON.stringify(bbox),
                    signal: AbortSignal.timeout(20_000),
                });
                if (res.ok) {
                    const buf = await res.arrayBuffer();
                    if (buf.byteLength > 200) {
                        const { decodeGrib2WindMultiHour } = await import('../services/weather/decodeGrib2Wind');
                        WindStore.setGrid(decodeGrib2WindMultiHour(buf));
                    }
                }
            }
            const windGrid = WindStore.getState().grid;
            if (!windGrid) {
                throw new Error('Wind data unavailable for this route.');
            }
            const windField = createWindFieldFromGrid(windGrid);
            const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;
            const bathyGrid = await preloadBathymetry(o, d);

            // Currents (non-blocking on failure)
            let currentField = null;
            try {
                const { OceanCurrentService } = await import('../services/OceanCurrentService');
                const { createCurrentFieldFromVectors } = await import('../services/weather/CurrentFieldAdapter');
                const briefing = await OceanCurrentService.fetchCurrents(
                    {
                        north: Math.max(o.lat, d.lat) + 1,
                        south: Math.min(o.lat, d.lat) - 1,
                        east: Math.max(o.lon, d.lon) + 1,
                        west: Math.min(o.lon, d.lon) - 1,
                    },
                    0,
                    0,
                    vessel.cruisingSpeed || 6,
                    settings.currentNrtEnabled === true,
                );
                currentField = createCurrentFieldFromVectors(briefing.vectors);
            } catch (_) {
                /* non-critical */
            }

            // Cyclone exclusions (non-blocking on failure)
            let exclusionField = null;
            try {
                const { buildCycloneExclusionField } = await import('../services/cycloneAvoidance');
                exclusionField = await buildCycloneExclusionField(new Date().toISOString(), {
                    north: Math.max(o.lat, d.lat),
                    south: Math.min(o.lat, d.lat),
                    east: Math.max(o.lon, d.lon),
                    west: Math.min(o.lon, d.lon),
                });
            } catch (_) {
                /* non-critical */
            }

            // Wave field (non-blocking on failure)
            let waveField = null;
            try {
                const { fetchWaveField } = await import('../services/weather/waveField');
                const { createWaveFieldFromSamples } = await import('../services/weather/WaveFieldAdapter');
                const data = await fetchWaveField(
                    {
                        north: Math.max(o.lat, d.lat) + 1,
                        south: Math.min(o.lat, d.lat) - 1,
                        east: Math.max(o.lon, d.lon) + 1,
                        west: Math.min(o.lon, d.lon) - 1,
                    },
                    new Date().toISOString(),
                );
                waveField = createWaveFieldFromSamples(data);
            } catch (_) {
                /* non-critical */
            }

            // Comfort params: blend vessel mechanical caps + user prefs +
            // preferredAngles. Mirrors the same logic isochroneEnhancer
            // uses so departure-window scenarios apply the same filter
            // as the full-resolution route compute.
            const userComfort = settings.comfortParams ?? {};
            const tightestWind =
                vessel.maxWindSpeed != null && userComfort.maxWindKts != null
                    ? Math.min(vessel.maxWindSpeed, userComfort.maxWindKts)
                    : (vessel.maxWindSpeed ?? userComfort.maxWindKts);
            const tightestWave =
                vessel.maxWaveHeight != null && userComfort.maxWaveM != null
                    ? Math.min(vessel.maxWaveHeight, userComfort.maxWaveM)
                    : (vessel.maxWaveHeight ?? userComfort.maxWaveM);
            const blendedComfort =
                tightestWind != null ||
                tightestWave != null ||
                userComfort.maxGustKts != null ||
                userComfort.preferredAngles
                    ? {
                          maxWindKts: tightestWind,
                          maxWaveM: tightestWave,
                          maxGustKts: userComfort.maxGustKts,
                          preferredAngles: userComfort.preferredAngles,
                      }
                    : undefined;

            // 3. Run the planner
            const { planDepartureWindow } = await import('../services/departureWindow');
            // Window starts now (or at the user's picked date if it's later
            // than now). We anchor at midnight UTC of that day.
            const baseDateIso = departureDate
                ? new Date(`${departureDate}T00:00:00Z`).toISOString()
                : new Date().toISOString();
            const final = await planDepartureWindow(
                o,
                d,
                vessel,
                windField,
                polar,
                bathyGrid,
                currentField,
                exclusionField,
                waveField,
                blendedComfort,
                baseDateIso,
            );
            setWindowScenarios(final);
        } catch (err) {
            setError(getErrorMessage(err) || 'Departure window planning failed.');
        } finally {
            window.removeEventListener('thalassa:departure-window-progress', progressHandler);
            setPlanningWindow(false);
            setWindowProgress(undefined);
        }
    }, [isPro, origin, destination, vessel, departureDate, onTriggerUpgrade]);

    /**
     * Apply a chosen scenario from the departure-window sheet:
     * update the form's departureDate to the scenario's date, close
     * the sheet, and let the user re-run Calculate at the new time.
     */
    const acceptWindowScenario = useCallback((scenario: import('../services/departureWindow').DepartureScenario) => {
        // Set departureDate to the YYYY-MM-DD of the scenario's UTC departure
        const dateOnly = scenario.departureTime.split('T')[0];
        setDepartureDate(dateOnly);
        setShowWindowSheet(false);
    }, []);

    const handleDeepAnalysis = async () => {
        if (!voyagePlan || !vessel) return;
        setAnalyzingDeep(true);
        try {
            const { fetchDeepVoyageAnalysis } = await import('../services/geminiService');
            const report = await fetchDeepVoyageAnalysis(voyagePlan, vessel);
            setDeepReport(report);
        } catch (err: unknown) {
            setError('Deep analysis unavailable. Please retry.');
        } finally {
            setAnalyzingDeep(false);
        }
    };

    const handleOriginLocation = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        GpsService.getCurrentPosition({ staleLimitMs: 30_000 }).then(async (pos) => {
            if (!pos) return;
            const { latitude, longitude } = pos;
            const name = await reverseGeocode(latitude, longitude);
            const coordSuffix = `(${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
            setOrigin(name ? `${name} ${coordSuffix}` : `WP ${coordSuffix}`);
        });
    };

    const toggleCheck = useCallback((item: string) => setChecklistState((p) => ({ ...p, [item]: !p[item] })), []);

    /**
     * Wipe the planner back to a pristine state:
     *   - Bump the session id so any in-flight enhancement-pipeline
     *     `saveVoyagePlan(...)` calls from a previous calculate are
     *     dropped (saveIfActive guard above).
     *   - Clear the WeatherContext voyagePlan (so the inline map
     *     reverts to the empty placeholder).
     *   - Reset local form fields (origin / destination / via / error
     *     / deepReport).
     *
     * Called from RoutePlanner on mount so each visit starts fresh,
     * even if the previous session's enhancement pipeline is still
     * grinding away in the background.
     */
    const clearVoyagePlan = useCallback(() => {
        sessionIdRef.current += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        saveVoyagePlan(null as any);
        setOrigin('');
        setDestination('');
        setVia('');
        setError(null);
        setDeepReport(null);
        // Make sure any stuck "Refining route…" chip dismisses too —
        // session bump alone doesn't dispatch the end event.
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('thalassa:passage-enhancement-end'));
        }
    }, [saveVoyagePlan]);

    const handleMapSelect = async (lat: number, lon: number, name: string) => {
        // Attempt reverse geocode for a friendly name if only coords provided
        let resolvedName = name;
        if (!name || name.startsWith('WP ') || /^-?\d/.test(name)) {
            try {
                const geoName = await reverseGeocode(lat, lon);
                if (geoName) resolvedName = geoName;
            } catch (e) {
                // Fallback to WP format
            }
        }

        // CRITICAL: Always embed exact coordinates in the display string
        // This ensures the routing pipeline (Gemini + bathymetric + weather)
        // uses the precise GPS position, not a vague name lookup.
        const coordSuffix = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;
        const displayName = resolvedName ? `${resolvedName} ${coordSuffix}` : `WP ${coordSuffix}`;

        if (mapSelectionTarget === 'origin') {
            setOrigin(displayName);
        } else if (mapSelectionTarget === 'destination') {
            setDestination(displayName);
        } else if (mapSelectionTarget === 'via') {
            setVia(displayName);
        }
        setIsMapOpen(false);
        setMapSelectionTarget(null);
    };

    const openMap = useCallback((target: 'origin' | 'destination' | 'via') => {
        setMapSelectionTarget(target);
        setIsMapOpen(true);
    }, []);

    // Computed properties
    const routeCoords = useMemo(() => {
        if (!voyagePlan) return [];
        const waypoints: { lat: number; lon: number }[] = [];
        if (voyagePlan.originCoordinates) waypoints.push(voyagePlan.originCoordinates);
        if (voyagePlan.waypoints && Array.isArray(voyagePlan.waypoints)) {
            voyagePlan.waypoints.forEach((wp) => {
                if (wp && wp.coordinates) waypoints.push(wp.coordinates);
            });
        }
        if (voyagePlan.destinationCoordinates) waypoints.push(voyagePlan.destinationCoordinates);

        if (waypoints.length < 2) return waypoints;

        // Generate a sea route that avoids land masses
        try {
            return generateSeaRoute(waypoints);
        } catch (err) {
            return waypoints;
        }
    }, [voyagePlan]);

    const distVal = useMemo(
        () =>
            voyagePlan && typeof voyagePlan.distanceApprox === 'string'
                ? parseInt(voyagePlan.distanceApprox.match(/(\d+)/)?.[0] || '0', 10)
                : 0,
        [voyagePlan],
    );
    const isShortTrip = distVal < 20;

    return {
        // State
        origin,
        setOrigin,
        destination,
        setDestination,
        via,
        setVia,
        departureDate,
        setDepartureDate,
        handleDateChange,
        isMapOpen,
        setIsMapOpen,
        mapSelectionTarget,
        setMapSelectionTarget,
        loading,
        loadingStep,
        error,
        setError,
        analyzingDeep,
        deepReport,
        checklistState,
        toggleCheck,

        // Handlers
        handleCalculate,
        handleDeepAnalysis,
        handlePlanWindow,
        acceptWindowScenario,
        clearVoyagePlan,
        handleOriginLocation,
        handleMapSelect,
        openMap,

        // Departure-window planner
        planningWindow,
        windowScenarios,
        showWindowSheet,
        setShowWindowSheet,
        windowProgress,

        // Computed
        routeCoords,
        isShortTrip,
        activeChecklistTab,
        setActiveChecklistTab,
        minDate: useMemo(() => new Date().toLocaleDateString('en-CA'), []),

        // Context
        voyagePlan,
        vessel,
        isPro,
        mapboxToken,
        hourlyForecasts: useMemo(() => weatherData?.hourly || [], [weatherData?.hourly]),
    };
};

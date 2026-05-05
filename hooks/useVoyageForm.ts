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

                // Step 2: Weather routing — corridor optimization (depends on Step 1)
                try {
                    const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                    enhancedPlan = await enhanceVoyagePlanWithWeather(enhancedPlan, vessel, departureDate);
                    saveIfActive(enhancedPlan);
                } catch (_) {
                    console.warn(`[useVoyageForm]`, _);
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
        clearVoyagePlan,
        handleOriginLocation,
        handleMapSelect,
        openMap,

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

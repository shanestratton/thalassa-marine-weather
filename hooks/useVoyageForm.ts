import { useState, useEffect, useMemo, useCallback } from 'react';
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

        setLoading(true);
        setError(null);
        setDeepReport(null);
        try {
            // ENHANCED INTELLIGENCE: Try to get weather context for the origin
            let weatherContext: Record<string, unknown> | undefined = undefined;
            try {
                // Check if origin contains coordinates (e.g. "WP 32.5, -117.2" or just raw coords)
                const coordMatch = fmtOrigin.match(/([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)/);
                if (coordMatch) {
                    const lat = parseFloat(coordMatch[1]);
                    const lon = parseFloat(coordMatch[2]);
                    // Lazy import to avoid circular dependency issues if any
                    const { fetchFastWeather } = await import('../services/weatherService');
                    // Use Fast Weather to get context quickly without burning premium API credits just for context
                    const wx = await fetchFastWeather('Origin-Context', { lat, lon });
                    if (wx) {
                        weatherContext = {
                            current: wx.current,
                            tides: wx.tides?.slice(0, 4), // Next 4 tide events
                            forecastSample: wx.hourly?.slice(0, 24).map((h) => ({
                                // First 24h
                                time: h.time,
                                wind: h.windSpeed,
                                gust: h.windGust,
                                wave: h.waveHeight,
                                dir: h.windDirection,
                            })),
                        };
                    }
                }
            } catch (err) {
                // Silently ignored — non-critical failure
            }

            const { fetchVoyagePlan } = await import('../services/geminiService');
            // Pass user's current GPS position for proximity-based disambiguation
            const userLoc = LocationStore.getState();
            const userLocation =
                userLoc.lat !== 0 || userLoc.lon !== 0 ? { lat: userLoc.lat, lon: userLoc.lon } : undefined;
            const result = await fetchVoyagePlan(
                fmtOrigin,
                fmtDest,
                vessel,
                departureDate,
                vesselUnits,
                generalUnits,
                fmtVia,
                weatherContext,
                userLocation,
            );

            // ── Show the plan IMMEDIATELY — don't wait for enhancements ──
            saveVoyagePlan(result);
            setLoading(false);

            // ── Enhancement Pipeline (runs in background, progressively updates) ──
            // Each step saves the enhanced plan as it completes, so the UI updates incrementally.
            setTimeout(async () => {
                let enhancedPlan = result;

                // Step 1: Bathymetric routing — depth-safe waypoints
                try {
                    const { enhanceVoyagePlanWithBathymetry } = await import('../services/bathymetricRouter');
                    enhancedPlan = await enhanceVoyagePlanWithBathymetry(result, vessel);
                    saveVoyagePlan(enhancedPlan);
                } catch (_) {
                    console.warn(`[useVoyageForm]`, _);
                }

                // Step 2: Weather routing — corridor optimization (depends on Step 1)
                try {
                    const { enhanceVoyagePlanWithWeather } = await import('../services/weatherRouter');
                    enhancedPlan = await enhanceVoyagePlanWithWeather(enhancedPlan, vessel, departureDate);
                    saveVoyagePlan(enhancedPlan);
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
                saveVoyagePlan({ ...enhancedPlan });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clearVoyagePlan = useCallback(() => saveVoyagePlan(null as any), [saveVoyagePlan]);

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

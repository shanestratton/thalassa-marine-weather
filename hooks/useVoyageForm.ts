
import { useState, useEffect, useMemo } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
// geminiService dynamically imported at call sites
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { DeepAnalysisReport } from '../types';
import { getErrorMessage } from '../utils/logger';

export const LOADING_PHASES = [
    "Querying Hydrographic Data...",
    "Analyzing Tidal Streams...",
    "Checking Notices to Mariners...",
    "Plotting Waypoints...",
    "Calculating ETAs...",
    "Checking Depth Clearances...",
    "Verifying Air Draft...",
    "Route Optimization...",
    "Weather Routing...",
    "Checking Safety Constraints...",
    "Reviewing Pilotage Notes...",
    "Generating Passage Plan...",
    "Finalizing Route...",
    "Completing Analysis..."
];

export const useVoyageForm = (onTriggerUpgrade: () => void) => {
    const { settings } = useSettings();
    const { weatherData, voyagePlan, saveVoyagePlan } = useWeather();
    const { vessel, vesselUnits, units: generalUnits, isPro, mapboxToken } = settings;

    // Form State
    const [origin, setOrigin] = useState('');
    const [destination, setDestination] = useState('');
    const [via, setVia] = useState('');
    const [departureDate, setDepartureDate] = useState(voyagePlan?.departureDate || new Date().toISOString().split('T')[0]);

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
                setLoadingStep(s => {
                    if (s >= LOADING_PHASES.length - 1) return LOADING_PHASES.length - 3 + ((s - (LOADING_PHASES.length - 3) + 1) % 3);
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
            setError("Vessel profile missing. Please configure in settings.");
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
                    const wx = await fetchFastWeather("Origin-Context", { lat, lon });
                    if (wx) {
                        weatherContext = {
                            current: wx.current,
                            tides: wx.tides?.slice(0, 4), // Next 4 tide events
                            forecastSample: wx.hourly?.slice(0, 24).map((h) => ({ // First 24h
                                time: h.time,
                                wind: h.windSpeed,
                                gust: h.windGust,
                                wave: h.waveHeight,
                                dir: h.windDirection
                            }))
                        };
                    }
                }
            } catch (err) {
            }

            const { fetchVoyagePlan } = await import('../services/geminiService');
            const result = await fetchVoyagePlan(fmtOrigin, fmtDest, vessel, departureDate, vesselUnits, generalUnits, fmtVia, weatherContext);
            saveVoyagePlan(result);
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
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(async (position) => {
                const name = await reverseGeocode(position.coords.latitude, position.coords.longitude);
                setOrigin(name || `WP ${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`);
            });
        }
    };

    const toggleCheck = (item: string) => setChecklistState(p => ({ ...p, [item]: !p[item] }));

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
        const displayName = resolvedName || `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`;

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

    const openMap = (target: 'origin' | 'destination' | 'via') => {
        setMapSelectionTarget(target);
        setIsMapOpen(true);
    };

    // Computed properties
    const routeCoords = useMemo(() => {
        if (!voyagePlan) return [];
        const coords = [];
        if (voyagePlan.originCoordinates) coords.push(voyagePlan.originCoordinates);
        if (voyagePlan.waypoints && Array.isArray(voyagePlan.waypoints)) {
            voyagePlan.waypoints.forEach(wp => {
                if (wp && wp.coordinates) coords.push(wp.coordinates);
            });
        }
        if (voyagePlan.destinationCoordinates) coords.push(voyagePlan.destinationCoordinates);
        return coords;
    }, [voyagePlan]);

    const distVal = (voyagePlan && typeof voyagePlan.distanceApprox === 'string')
        ? parseInt(voyagePlan.distanceApprox.match(/(\d+)/)?.[0] || '0', 10)
        : 0;
    const isShortTrip = distVal < 20;

    return {
        // State
        origin, setOrigin,
        destination, setDestination,
        via, setVia,
        departureDate, setDepartureDate,
        isMapOpen, setIsMapOpen,
        mapSelectionTarget, setMapSelectionTarget,
        loading, loadingStep,
        error, setError,
        analyzingDeep, deepReport,
        checklistState, toggleCheck,

        // Handlers
        handleCalculate,
        handleDeepAnalysis,
        handleOriginLocation,
        handleMapSelect,
        openMap,

        // Computed
        routeCoords,
        isShortTrip,
        activeChecklistTab, setActiveChecklistTab,
        minDate: new Date().toLocaleDateString('en-CA'),

        // Context
        voyagePlan,
        vessel,
        isPro,
        mapboxToken,
        hourlyForecasts: weatherData?.hourly || []
    };
};

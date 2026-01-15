
import { useState, useEffect, useMemo } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
import { fetchVoyagePlan, fetchDeepVoyageAnalysis } from '../services/geminiService';
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { DeepAnalysisReport } from '../types';

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
        let interval: any;
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
            const result = await fetchVoyagePlan(fmtOrigin, fmtDest, vessel, departureDate, vesselUnits, generalUnits, fmtVia);
            saveVoyagePlan(result);
        } catch (err: any) {
            setError(err.message || 'Calculation Systems Failure');
        } finally {
            setLoading(false);
        }
    };

    const handleDeepAnalysis = async () => {
        if (!voyagePlan || !vessel) return;
        setAnalyzingDeep(true);
        try {
            const report = await fetchDeepVoyageAnalysis(voyagePlan, vessel);
            setDeepReport(report);
        } catch (err: any) {
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

    const handleMapSelect = (lat: number, lon: number, name: string) => {
        if (mapSelectionTarget === 'origin') {
            setOrigin(name || `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        } else if (mapSelectionTarget === 'destination') {
            setDestination(name || `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        } else if (mapSelectionTarget === 'via') {
            setVia(name || `WP ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
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
        minDate: new Date().toISOString().split('T')[0],

        // Context
        voyagePlan,
        vessel,
        isPro,
        mapboxToken
    };
};

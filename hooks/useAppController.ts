import React, { useState, useEffect, useCallback } from 'react';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { useUI } from '../context/UIContext';
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput, getSunTimes, formatCoordinate } from '../utils';
import { DisplayMode, WeatherConditionKey, UserSettings } from '../types';

const DEFAULT_BACKGROUNDS = {
    sunny: "https://images.unsplash.com/photo-1566371486490-560ded23b5e4?q=80&w=1080&fm=jpg&fit=crop",
    cloudy: "https://images.unsplash.com/photo-1534008753122-a83776b29f6c?q=80&w=1080&fm=jpg&fit=crop",
    rain: "https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?q=80&w=1080&fm=jpg&fit=crop",
    storm: "https://images.unsplash.com/photo-1505672675380-4d329615699c?q=80&w=1080&fm=jpg&fit=crop",
    fog: "https://images.unsplash.com/photo-1485230905346-71acb9518d9c?q=80&w=1080&fm=jpg&fit=crop",
    night: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?q=80&w=1080&fm=jpg&fit=crop",
    default: "https://images.unsplash.com/photo-1478359844494-1092259d93e4?q=80&w=1080&fm=jpg&fit=crop"
};

const mapConditionToKey = (cond: string): WeatherConditionKey => {
    if (!cond) return 'default';
    const c = cond.toLowerCase();
    if (c.includes('rain') || c.includes('drizzle') || c.includes('wet')) return 'rain';
    if (c.includes('storm') || c.includes('thunder') || c.includes('lightning') || c.includes('gale')) return 'storm';
    if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return 'fog';
    if (c.includes('cloud') || c.includes('overcast') || c.includes('grey')) return 'cloudy';
    if (c.includes('night') || c.includes('dark') || c.includes('moon')) return 'night';
    if (c.includes('sun') || c.includes('clear') || c.includes('fair')) return 'sunny';
    return 'default';
};

export const useAppController = () => {
    const { weatherData, loading, fetchWeather, selectLocation } = useWeather();
    const { settings, updateSettings } = useSettings();
    const { setPage, isOffline, currentView } = useUI();

    const [query, setQuery] = useState('');
    const [bgImage, setBgImage] = useState(DEFAULT_BACKGROUNDS.default);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    // UI Local State
    const [sheetData, setSheetData] = useState<any>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
    const [isMobileLandscape, setIsMobileLandscape] = useState(false);

    // 1. Initial Load
    useEffect(() => {
        const onboarded = localStorage.getItem('thalassa_v3_onboarded');
        if (!onboarded) {
            setShowOnboarding(true);
        } else if (!weatherData && !loading && settings.defaultLocation) {
            setPage('dashboard');
            fetchWeather(settings.defaultLocation);
        }
    }, [settings.defaultLocation]);

    // 2. Background Image Sync
    useEffect(() => {
        if (weatherData) {
            const raw = weatherData.current.condition || weatherData.current.description;
            const bg = DEFAULT_BACKGROUNDS[mapConditionToKey(raw)];
            if (bg) setBgImage(bg);
        }
    }, [weatherData]);

    // 3. Query Sync
    // 3. Query Sync
    useEffect(() => {
        if (weatherData && weatherData.locationName && !loading) {
            let targetName = weatherData.locationName;

            // WAYPOINT LOGIC: Unconditional check for Coordinate-like names
            if (weatherData.coordinates) {
                // Safe Regex to detect coordinates WITHOUT matching "Newport, 4020"
                // 1. Starts with "Location", "WP", "Waypoint"
                // 2. Starts with a Number or Minus (e.g. "-23.5", "23.5")
                // 3. Contains strict Degree symbol (e.g. "23°S")
                // 4. Contains Water Body terms (Ocean, Sea, Reef) -> Force WP style
                const isSafeCoord = /^(Location|WP|waypoint)|^-?[0-9]|[0-9]+°|\b(Ocean|Sea|Reef)\b/i.test(weatherData.locationName);
                const isOceanPoint = weatherData.locationName.includes("Ocean Point");
                const isOffshore = weatherData.locationType === 'offshore';

                // 2. Only force WP naming if it's a raw coordinate or a generic "Ocean" point
                // REMOVED: || isOffshore (This was too aggressive and overwrote valid island names like "Townsville")
                if (isSafeCoord || isOceanPoint) {
                    const latStr = formatCoordinate(weatherData.coordinates.lat, 'lat');
                    const lonStr = formatCoordinate(weatherData.coordinates.lon, 'lon');
                    targetName = `WP ${latStr} ${lonStr}`;
                }
            }

            if (query !== targetName) {
                setQuery(targetName);
            }
        }
    }, [weatherData, loading]);

    // 4. Mobile Landscape Detection
    useEffect(() => {
        const checkOrientation = () => {
            const isLandscape = window.matchMedia('(orientation: landscape)').matches;
            const isShort = window.innerHeight < 500; // Typical mobile landscape height
            setIsMobileLandscape(isLandscape && isShort);
        };
        checkOrientation();
        window.addEventListener('resize', checkOrientation);
        return () => window.removeEventListener('resize', checkOrientation);
    }, []);

    // Handlers
    const showToast = useCallback((msg: string) => {
        setToastMessage(msg);
        setTimeout(() => setToastMessage(null), 3000);
    }, []);

    const handleSearchSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!query || query.length < 2) return;
        const formatted = formatLocationInput(query);
        setQuery(formatted);
        setPage('dashboard');
        // FIX: Use selectLocation to ensure persistence & optimistic UI
        selectLocation(formatted);
    };

    const handleLocate = () => {
        if (isOffline) { alert("GPS requires network."); return; }
        setQuery("Locating...");
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            const coordStr = `WP ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
            let searchTarget = coordStr;
            try {
                const name = await reverseGeocode(latitude, longitude);
                if (name) searchTarget = name;
            } catch (e) {

            }
            setQuery(searchTarget);
            setPage('dashboard');
            // FIX: Use selectLocation with coords for persistence & precision
            selectLocation(searchTarget, { lat: latitude, lon: longitude });
        }, (err) => {
            showToast("GPS Error: " + err.message);
            setQuery("");
        });
    };

    const handleOnboardingComplete = (newSettings: Partial<UserSettings>) => {
        updateSettings(newSettings);
        setShowOnboarding(false);
        if (newSettings.defaultLocation) {
            setQuery(newSettings.defaultLocation);
            setTimeout(() => fetchWeather(newSettings.defaultLocation!, true), 100);
        }
    };

    const toggleFavorite = useCallback(() => {
        if (!weatherData) return;
        const loc = weatherData.locationName;
        const isFav = settings.savedLocations.includes(loc);
        let newLocs;
        if (isFav) {
            newLocs = settings.savedLocations.filter(l => l !== loc);
            showToast(`Removed ${loc} from favorites`);
        } else {
            newLocs = [loc, ...settings.savedLocations];
            showToast(`Saved ${loc} to favorites`);
        }
        updateSettings({ savedLocations: newLocs });
    }, [weatherData, settings.savedLocations, showToast, updateSettings]);

    const handleMapTargetSelect = useCallback((lat: number, lon: number, name?: string) => {
        // Normalize Longitude (-180 to 180)
        // Map libraries sometimes return wrapped coords (e.g. 190, 370 etc)
        let normalizedLon = lon;
        while (normalizedLon > 180) normalizedLon -= 360;
        while (normalizedLon < -180) normalizedLon += 360;

        const locationQuery = name || `WP ${lat.toFixed(4)}, ${normalizedLon.toFixed(4)}`;

        // Pass normalized coords
        const finalCoords = { lat, lon: normalizedLon };

        setQuery(locationQuery);
        setSheetOpen(false);

        // NAVIGATION FIRST (Optimistic UI)
        setPage('dashboard');

        // Fire-and-forget fetch
        selectLocation(locationQuery, finalCoords).catch(e => {
            showToast("Location update failed, check network.");
        });
    }, [setQuery, selectLocation, setPage, showToast]);

    const handleFavoriteSelect = useCallback((loc: string) => {
        setQuery(loc);
        const oceanMatch = loc.match(/Ocean Point\s+(\d+\.\d+)([NS])\s+(\d+\.\d+)([EW])/);
        if (oceanMatch) {
            const rawLat = parseFloat(oceanMatch[1]);
            const latDir = oceanMatch[2];
            const rawLon = parseFloat(oceanMatch[3]);
            const lonDir = oceanMatch[4];
            const lat = latDir === 'S' ? -rawLat : rawLat;
            const lon = lonDir === 'W' ? -rawLon : rawLon;
            selectLocation(loc, { lat, lon });
        } else {
            selectLocation(loc);
        }
        setPage('dashboard');
    }, [setQuery, selectLocation, setPage]);

    // Navigation Handlers (Encapsulate DOM/Window logic)
    const handleTabDashboard = useCallback(() => {
        if (currentView !== 'dashboard') {
            setPage('dashboard');
        } else {
            // "Pull to Refresh" feel for tab click
            setTimeout(() => window.dispatchEvent(new Event('hero-reset-scroll')), 10);
        }
    }, [currentView, setPage]);

    const handleTabMetrics = useCallback(() => {
        setPage('details');
        // Encapsulate the scroll reset
        document.getElementById('app-scroll-container')?.scrollTo({ top: 0, behavior: 'smooth' });
    }, [setPage]);

    const handleTabPassage = useCallback(() => setPage('voyage'), [setPage]);
    const handleTabMap = useCallback(() => setPage('map'), [setPage]);
    const handleTabSettings = useCallback(() => setPage('settings'), [setPage]);


    // Calculate Display Mode
    let effectiveMode: DisplayMode = settings.displayMode;
    if (settings.displayMode === 'auto') {
        const now = new Date();
        let isNight = false;
        if (weatherData && weatherData.coordinates) {
            const times = getSunTimes(now, weatherData.coordinates.lat, weatherData.coordinates.lon);
            if (times) {
                isNight = now < times.sunrise || now >= times.sunset;
            } else {
                const currentHour = now.getHours();
                isNight = currentHour < 6 || currentHour >= 18;
            }
        } else {
            const currentHour = now.getHours();
            isNight = currentHour < 6 || currentHour >= 18;
        }
        effectiveMode = isNight ? 'night' : 'high-contrast';
    }

    return {
        query, setQuery, bgImage, showOnboarding, setShowOnboarding, toastMessage, showToast,
        handleSearchSubmit, handleLocate, effectiveMode,

        // Extracted Handlers & State
        toggleFavorite,
        handleMapTargetSelect,
        handleFavoriteSelect,
        handleOnboardingComplete,

        sheetData, setSheetData,
        sheetOpen, setSheetOpen,
        isUpgradeOpen, setIsUpgradeOpen,
        isMobileLandscape,

        // Navigation
        handleTabDashboard,
        handleTabMetrics,
        handleTabPassage,
        handleTabMap,
        handleTabSettings
    };
};

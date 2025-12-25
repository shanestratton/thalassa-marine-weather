
import React, { useState, useEffect } from 'react';
import { useWeather } from '../context/WeatherContext';
import { useSettings } from '../context/SettingsContext';
import { useUI } from '../context/UIContext';
import { reverseGeocode } from '../services/weatherService';
import { formatLocationInput } from '../utils';
import { DisplayMode, WeatherConditionKey } from '../types';

const DEFAULT_BACKGROUNDS = {
  sunny: "https://images.unsplash.com/photo-1566371486490-560ded23b5e4?q=80&w=2070&auto=format&fit=crop", 
  cloudy: "https://images.unsplash.com/photo-1534008753122-a83776b29f6c?q=80&w=2070&auto=format&fit=crop", 
  rain: "https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?q=80&w=2070&auto=format&fit=crop", 
  storm: "https://images.unsplash.com/photo-1505672675380-4d329615699c?q=80&w=2070&auto=format&fit=crop", 
  fog: "https://images.unsplash.com/photo-1485230905346-71acb9518d9c?q=80&w=2070&auto=format&fit=crop", 
  night: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?q=80&w=2070&auto=format&fit=crop", 
  default: "https://images.unsplash.com/photo-1478359844494-1092259d93e4?q=80&w=2070&auto=format&fit=crop" 
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
    // Optimization: Use specific hooks instead of monolithic useThalassa
    const { weatherData, loading, fetchWeather } = useWeather();
    const { settings, updateSettings } = useSettings();
    const { setPage, isOffline, currentView } = useUI();

    const [query, setQuery] = useState('');
    const [bgImage, setBgImage] = useState(DEFAULT_BACKGROUNDS.default);
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);

    // 1. Initial Load
    useEffect(() => {
        const onboarded = localStorage.getItem('thalassa_has_onboarded');
        if (!onboarded) {
            setShowOnboarding(true);
        } else if (!weatherData && !loading && settings.defaultLocation) {
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
    useEffect(() => {
        if (weatherData && weatherData.locationName && !loading) {
             if (query !== weatherData.locationName) {
                 setQuery(weatherData.locationName);
             }
        }
    }, [weatherData, loading]);

    // Handlers
    const showToast = (msg: string) => {
        setToastMessage(msg);
        setTimeout(() => setToastMessage(null), 3000);
    }

    const handleSearchSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!query || query.length < 2) return; 
        const formatted = formatLocationInput(query);
        setQuery(formatted);
        setPage('dashboard');
        fetchWeather(formatted);
    };

    const handleLocate = () => {
        if (isOffline) { alert("GPS requires network."); return; }
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            const coordStr = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
            setQuery(coordStr);
            setPage('dashboard');
            fetchWeather(coordStr);
            try {
                const name = await reverseGeocode(latitude, longitude);
                if (name) setQuery(name);
            } catch {}
        });
    };

    // Calculate Display Mode
    let effectiveMode: DisplayMode = settings.displayMode;
    if (settings.displayMode === 'auto') {
        let isNight = false;
        const currentHour = new Date().getHours();
        isNight = currentHour < 6 || currentHour >= 18;
        
        if (weatherData?.current?.sunrise && weatherData?.current?.sunset && weatherData.current.sunrise !== '--:--') {
            try {
                const now = new Date();
                const currentMins = now.getHours() * 60 + now.getMinutes();
                const parseToMins = (tStr: string) => {
                    const [t, m] = tStr.split(' ');
                    let [hrs, mins] = t.split(':').map(Number);
                    if (m === 'PM' && hrs !== 12) hrs += 12;
                    if (m === 'AM' && hrs === 12) hrs = 0;
                    return hrs * 60 + mins;
                };
                const riseMins = parseToMins(weatherData.current.sunrise);
                const setMins = parseToMins(weatherData.current.sunset);
                isNight = currentMins < riseMins || currentMins > setMins;
            } catch (e) {}
        }
        effectiveMode = isNight ? 'night' : 'high-contrast';
    }

    return {
        query, setQuery, bgImage, showOnboarding, setShowOnboarding, toastMessage, showToast,
        handleSearchSubmit, handleLocate, effectiveMode
    };
};

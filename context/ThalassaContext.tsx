
import React from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import { SettingsProvider, useSettings } from './SettingsContext';
import { UIProvider, useUI } from './UIContext';
import { WeatherProvider, useWeather } from './WeatherContext';

// Re-export types for consumers
export type { UserSettings, MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';

/**
 * ThalassaProvider: The root provider that composes all domain-specific providers.
 * Order matters: Auth -> Settings -> UI -> Weather
 */
export const ThalassaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <AuthProvider>
            <SettingsProvider>
                <UIProvider>
                    <WeatherProvider>
                        {children}
                    </WeatherProvider>
                </UIProvider>
            </SettingsProvider>
        </AuthProvider>
    );
};

/**
 * useThalassa: A legacy aggregation hook that combines all contexts.
 * 
 * WARNING: Using this hook binds the component to updates from ALL contexts (Auth, Weather, Settings, UI).
 * To improve performance and reduce re-renders, migrate components to use specific hooks:
 * - useAuth()
 * - useSettings()
 * - useUI()
 * - useWeather()
 */
export const useThalassa = () => {
    const auth = useAuth();
    const settings = useSettings();
    const ui = useUI();
    const weather = useWeather();

    return {
        // Auth
        user: auth.user,
        logout: auth.logout,

        // Settings
        settings: settings.settings,
        updateSettings: settings.updateSettings,
        resetSettings: settings.resetSettings,
        togglePro: settings.togglePro,
        quotaLimit: settings.quotaLimit,

        // UI
        currentView: ui.currentView,
        setPage: ui.setPage,
        isOffline: ui.isOffline,

        // Weather
        weatherData: weather.weatherData,
        voyagePlan: weather.voyagePlan,
        loading: weather.loading,
        error: weather.error,
        debugInfo: weather.debugInfo,
        quotaUsed: weather.quotaUsed,
        backgroundUpdating: weather.backgroundUpdating,
        nextUpdate: weather.nextUpdate,
        fetchWeather: weather.fetchWeather,
        refreshData: weather.refreshData,
        saveVoyagePlan: weather.saveVoyagePlan,
        incrementQuota: weather.incrementQuota,
    };
};

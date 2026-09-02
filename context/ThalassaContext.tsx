import React from 'react';
import { AuthProvider } from './AuthContext';
import { SettingsProvider } from './SettingsContext';
import { UIProvider } from './UIContext';
import { WeatherProvider } from './WeatherContext';
import { ThemeProvider } from './ThemeContext';
import { FollowRouteProvider } from './FollowRouteContext';

// Re-export types for consumers
export type { UserSettings, MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';

/**
 * ThalassaProvider: The root provider that composes all domain-specific providers.
 * Order matters: Auth -> Settings -> UI -> Weather -> Theme
 * Theme is innermost because it depends on weather data (for environment detection).
 */
export const ThalassaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <AuthProvider>
            <UIProvider>
                <SettingsProvider>
                    <WeatherProvider>
                        <FollowRouteProvider>
                            <ThemeProvider>{children}</ThemeProvider>
                        </FollowRouteProvider>
                    </WeatherProvider>
                </SettingsProvider>
            </UIProvider>
        </AuthProvider>
    );
};

// The legacy `useThalassa()` aggregator (Auth + Settings + UI + Weather in one
// subscription) is gone: every consumer now reads the one context it needs —
// useAuth() / useSettings() / useUI() / useWeather().

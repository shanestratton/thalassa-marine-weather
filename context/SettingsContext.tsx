import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { UserSettings } from '../types';
import { getSystemUnits } from '../utils';
import { useAuth } from './AuthContext';
import { useUI } from './UIContext';
import { supabase } from '../services/supabase';

const CACHE_VERSION = 'v1.3.14-WIDGET-REFRESH';
const DAILY_STORMGLASS_LIMIT = 100;

import { KeepAwake } from '@capacitor-community/keep-awake';
import { Capacitor } from '@capacitor/core';
// ... (keep imports)

export const DEFAULT_SETTINGS: UserSettings = {
    isPro: true,
    alwaysOn: false,
    notifications: {
        wind: { enabled: false, threshold: 20 },
        gusts: { enabled: false, threshold: 30 },
        waves: { enabled: false, threshold: 5 },
        swellPeriod: { enabled: false, threshold: 10 },
        visibility: { enabled: false, threshold: 1 },
        uv: { enabled: false, threshold: 8 },
        tempHigh: { enabled: false, threshold: 35 },
        tempLow: { enabled: false, threshold: 5 },
        precipitation: { enabled: false }
    },
    units: { ...getSystemUnits(), waveHeight: 'm' },
    defaultLocation: undefined,
    savedLocations: [],
    vessel: undefined,
    timeDisplay: 'location',
    displayMode: 'auto',
    preferredModel: 'best_match',
    aiPersona: 50, // Default to Pro (Professional/Concise) instead of Salty
    heroWidgets: ['wind', 'wave', 'pressure'],
    detailsWidgets: ['score', 'pressure', 'humidity', 'precip', 'cloud', 'visibility', 'chill', 'swell'],
    rowOrder: ['beaufort', 'details', 'tides', 'sunMoon', 'vessel', 'advice', 'forecastChart', 'hourly', 'daily', 'map'],
    mapboxToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN,
    dynamicHeaderMetrics: false, // Default to static header (current behavior)
    dashboardMode: 'full', // 'essential' = simplified, 'full' = all widgets (default)
    screenOrientation: 'auto' // 'auto' | 'portrait' | 'landscape' - in-app orientation lock
};

interface SettingsContextType {
    settings: UserSettings;
    loading: boolean;
    quotaLimit: number;
    updateSettings: (newSettings: Partial<UserSettings>) => void;
    togglePro: () => void;
    resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

import { Preferences } from '@capacitor/preferences';

// ... (keep imports)

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const { addDebugLog } = useUI();
    const [loading, setLoading] = useState(true);

    // Start with DEFAULTS (Sync) - avoid blocking render
    const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);

    // --- EFFECT: Manage Screen Awake State ---
    useEffect(() => {
        const manageScreen = async () => {
            if (!Capacitor.isNativePlatform()) return; // Skip on Web to avoid errors

            try {
                if (settings.alwaysOn) {
                    await KeepAwake.keepAwake();
                } else {
                    await KeepAwake.allowSleep();
                }
            } catch (e: any) {
                // Suppress "UNIMPLEMENTED" warnings on Web/Dev
                if (e?.code !== 'UNIMPLEMENTED' && !JSON.stringify(e).includes('UNIMPLEMENTED')) {
                }
            }
        };
        manageScreen();
    }, [settings.alwaysOn]);

    // --- EFFECT: Manage Screen Orientation Lock ---
    useEffect(() => {
        const manageOrientation = async () => {
            if (!Capacitor.isNativePlatform()) return; // Skip on Web

            try {
                // Dynamically import to avoid errors on web
                const { ScreenOrientation } = await import('@capacitor/screen-orientation');

                switch (settings.screenOrientation) {
                    case 'portrait':
                        await ScreenOrientation.lock({ orientation: 'portrait' });
                        break;
                    case 'landscape':
                        await ScreenOrientation.lock({ orientation: 'landscape' });
                        break;
                    case 'auto':
                    default:
                        await ScreenOrientation.unlock();
                        break;
                }
            } catch (e: any) {
                // Suppress errors on platforms that don't support this
                if (e?.code !== 'UNIMPLEMENTED' && !JSON.stringify(e).includes('UNIMPLEMENTED')) {
                }
            }
        };
        manageOrientation();
    }, [settings.screenOrientation]);

    // Initial Load from Native Storage (Async)
    useEffect(() => {
        const loadNativeSettings = async () => {
            try {
                const { value } = await Preferences.get({ key: 'thalassa_settings' });
                if (value) {
                    const parsed = JSON.parse(value);
                    const validHeroWidgets = Array.isArray(parsed.heroWidgets) && parsed.heroWidgets.length > 0 ? parsed.heroWidgets : DEFAULT_SETTINGS.heroWidgets;

                    setSettings(prev => ({
                        ...DEFAULT_SETTINGS,
                        ...parsed,
                        notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications || {}) },
                        units: {
                            ...DEFAULT_SETTINGS.units,
                            ...(parsed.units || {}),
                            waveHeight: parsed.units?.waveHeight || parsed.units?.length || 'm'
                        },
                        vessel: { ...DEFAULT_SETTINGS.vessel, ...(parsed.vessel || {}) },
                        heroWidgets: validHeroWidgets,
                        rowOrder: (() => {
                            const saved = Array.isArray(parsed.rowOrder) ? [...parsed.rowOrder] : [...(DEFAULT_SETTINGS.rowOrder || [])];

                            // Migration: Split 'charts' into individual widgets
                            const chartsIdx = saved.indexOf('charts');
                            if (chartsIdx !== -1) {
                                saved.splice(chartsIdx, 1, 'forecastChart', 'hourly', 'daily');
                            }

                            // Migration: Ensure new widgets exist
                            if (!saved.includes('sunMoon')) {
                                const tidesIdx = saved.indexOf('tides');
                                if (tidesIdx !== -1) saved.splice(tidesIdx + 1, 0, 'sunMoon');
                                else saved.push('sunMoon');
                            }
                            if (!saved.includes('vessel')) {
                                const sunIdx = saved.indexOf('sunMoon');
                                if (sunIdx !== -1) saved.splice(sunIdx + 1, 0, 'vessel');
                                else saved.push('vessel');
                            }

                            // Clean up duplicates just in case
                            return [...new Set(saved)];
                        })(),
                        isPro: true
                    }));
                    const order = validHeroWidgets.join(', ');
                    addDebugLog(`LOADED: [${order}] from Disk.`);
                } else {
                    addDebugLog(`INIT: No Settings Found (Starting Defaults)`);
                }
            } catch (e) {
                addDebugLog(`ERROR: Native Load Failed`);
            } finally {
                setLoading(false);
            }
        };
        loadNativeSettings();
    }, []);

    const syncUp = async (userId: string, newSettings: UserSettings) => {
        if (!supabase) return;
        await supabase.from('profiles').upsert({ id: userId, settings: newSettings, updated_at: new Date().toISOString() });
    };

    const updateSettings = useCallback(async (newSettings: Partial<UserSettings>) => {
        if (loading) {
            return;
        }

        let updatedState: UserSettings | undefined;

        setSettings(prev => {
            const temp = { ...prev, ...newSettings };
            updatedState = temp;
            return temp;
        });

        // Effect: Persist to Storage (Outside Reducer)
        if (updatedState) {
            try {
                await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(updatedState) });

                if (newSettings.heroWidgets) {
                    const order = newSettings.heroWidgets.join(', ');
                    addDebugLog(`SAVE OK: [${order}]`);
                } else {
                    addDebugLog(`SAVE OK: Settings Updated`);
                }
            } catch (err: any) {
                addDebugLog(`SAVE FAIL: ${err.message}`);
            }

            if (user && user.id) syncUp(user.id, updatedState);
        }
    }, [user, addDebugLog, loading]);

    const resetSettings = useCallback(() => {
        if (window.confirm("Factory Reset: Restore all settings to default? This cannot be undone.")) {
            setSettings(DEFAULT_SETTINGS);
            localStorage.setItem('thalassa_settings', JSON.stringify(DEFAULT_SETTINGS));
            window.location.reload();
        }
    }, []);

    const togglePro = useCallback(() => updateSettings({ isPro: true }), [updateSettings]);

    return (
        <SettingsContext.Provider value={{
            settings,
            loading,
            quotaLimit: DAILY_STORMGLASS_LIMIT,
            updateSettings,
            togglePro,
            resetSettings
        }}>
            {children}
        </SettingsContext.Provider>
    );
};

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (context === undefined) {
        throw new Error('useSettings must be used within an SettingsProvider');
    }
    return context;
};

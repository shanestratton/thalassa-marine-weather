
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { UserSettings } from '../types';
import { getSystemUnits } from '../utils';
import { useAuth } from './AuthContext';
import { supabase } from '../services/supabase';

const CACHE_VERSION = 'v11.7-SETTINGS-SPLIT';
const DAILY_STORMGLASS_LIMIT = 100;

export const DEFAULT_SETTINGS: UserSettings = {
  isPro: true, 
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
  units: getSystemUnits(),
  defaultLocation: undefined, 
  savedLocations: [],
  vessel: undefined,
  timeDisplay: 'location',
  displayMode: 'auto',
  preferredModel: 'STORMGLASS',
  aiPersona: 50, // Default to Pro (Professional/Concise) instead of Salty
  heroWidgets: ['wind', 'wave', 'pressure'],
  detailsWidgets: ['score', 'pressure', 'humidity', 'precip', 'cloud', 'visibility', 'chill', 'swell']
};

interface SettingsContextType {
    settings: UserSettings;
    quotaLimit: number;
    updateSettings: (newSettings: Partial<UserSettings>) => void;
    togglePro: () => void;
    resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();

    const [settings, setSettings] = useState<UserSettings>(() => {
        try {
            const ver = localStorage.getItem('thalassa_cache_version');
            // Version check handled primarily in WeatherContext for data, 
            // but we ensure settings integrity here.
            const saved = localStorage.getItem('thalassa_settings');
            if (!saved) return DEFAULT_SETTINGS;
            
            const parsed = JSON.parse(saved) || {};
            
            // Merge deep objects to ensure integrity
            return {
                ...DEFAULT_SETTINGS,
                ...parsed,
                notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications || {}) },
                units: { ...DEFAULT_SETTINGS.units, ...(parsed.units || {}) },
                vessel: { ...DEFAULT_SETTINGS.vessel, ...(parsed.vessel || {}) },
                heroWidgets: parsed.heroWidgets || DEFAULT_SETTINGS.heroWidgets,
                detailsWidgets: parsed.detailsWidgets || DEFAULT_SETTINGS.detailsWidgets,
                aiPersona: parsed.aiPersona !== undefined ? parsed.aiPersona : DEFAULT_SETTINGS.aiPersona,
                isPro: true
            };
        } catch (e) {
            return DEFAULT_SETTINGS;
        }
    });

    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    const syncUp = async (userId: string, newSettings: UserSettings) => {
        if (!supabase) return;
        await supabase.from('profiles').upsert({ id: userId, settings: newSettings, updated_at: new Date().toISOString() });
    };

    const updateSettings = useCallback((newSettings: Partial<UserSettings>) => {
        setSettings(prev => {
            const updated = { ...prev, ...newSettings };
            localStorage.setItem('thalassa_settings', JSON.stringify(updated));
            if (user) syncUp(user.id, updated);
            return updated;
        });
    }, [user]);

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

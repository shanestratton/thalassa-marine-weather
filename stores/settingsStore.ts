/**
 * Settings Store — Zustand replacement for SettingsContext.
 *
 * Manages user preferences with:
 *  - Capacitor Preferences persistence (async load on init)
 *  - Supabase cloud sync for authenticated users
 *  - Screen keep-awake and orientation lock effects
 *  - Migration logic for legacy rowOrder formats
 */

import { create } from 'zustand';
import type { UserSettings } from '../types';
import { getSystemUnits } from '../utils';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { piCache } from '../services/PiCacheService';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { supabase } from '../services/supabase';
import { getErrorMessage } from '../utils/logger';
import { tierIsPro } from '../services/SubscriptionService';

const DAILY_STORMGLASS_LIMIT = 100;

export const DEFAULT_SETTINGS: UserSettings = {
    subscriptionTier: 'owner', // Default to owner for development
    isPro: true, // Backward compat — derived from subscriptionTier
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
        precipitation: { enabled: false },
    },
    units: { ...getSystemUnits(), waveHeight: 'm' },
    defaultLocation: undefined,
    savedLocations: [],
    vessel: undefined,
    timeDisplay: 'location',
    displayMode: 'dark',
    preferredModel: 'best_match',
    offshoreModel: 'sg',
    aiPersona: 50,
    heroWidgets: ['wind', 'wave', 'pressure'],
    detailsWidgets: ['score', 'pressure', 'humidity', 'precip', 'cloud', 'visibility', 'chill', 'swell'],
    rowOrder: ['beaufort', 'details', 'tides', 'sunMoon', 'vessel', 'advice', 'hourly', 'daily', 'map'],
    mapboxToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN,
    dynamicHeaderMetrics: false,
    dashboardMode: 'full',
    screenOrientation: 'auto',
};

interface SettingsState {
    settings: UserSettings;
    /** Backward-compat: true if tier is crew or owner */
    isPro: boolean;
    loading: boolean;
    quotaLimit: number;
    updateSettings: (patch: Partial<UserSettings>) => void;
    setTier: (tier: UserSettings['subscriptionTier']) => void;
    togglePro: () => void;
    resetSettings: () => void;
    /** @internal — called once by init to wire up auth-based cloud sync */
    _setUserId: (id: string | null) => void;
}

// Internal ref to avoid circular store deps
let _userId: string | null = null;
let _addDebugLog: (msg: string) => void = () => {};

/** Wire the debug log sink from uiStore (called once from ThalassaContext bridge) */
export function setSettingsDebugSink(fn: (msg: string) => void) {
    _addDebugLog = fn;
}

async function syncToCloud(userId: string, s: UserSettings) {
    if (!supabase) return;
    await supabase.from('profiles').upsert({ id: userId, settings: s, updated_at: new Date().toISOString() });
}

async function manageScreenEffects(s: UserSettings) {
    if (!Capacitor.isNativePlatform()) return;

    try {
        if (s.alwaysOn) {
            await KeepAwake.keepAwake();
        } else {
            await KeepAwake.allowSleep();
        }
    } catch {
        /* best effort */
    }

    try {
        const { ScreenOrientation } = await import('@capacitor/screen-orientation');
        switch (s.screenOrientation) {
            case 'portrait':
                await ScreenOrientation.lock({ orientation: 'portrait' });
                break;
            case 'landscape':
                await ScreenOrientation.lock({ orientation: 'landscape' });
                break;
            default:
                await ScreenOrientation.unlock();
                break;
        }
    } catch {
        /* best effort */
    }
}

function migrateRowOrder(saved: string[]): string[] {
    const order = [...saved];
    const chartsIdx = order.indexOf('charts');
    if (chartsIdx !== -1) order.splice(chartsIdx, 1, 'hourly', 'daily');
    const fcIdx = order.indexOf('forecastChart');
    if (fcIdx !== -1) order.splice(fcIdx, 1);
    if (!order.includes('sunMoon')) {
        const tidesIdx = order.indexOf('tides');
        if (tidesIdx !== -1) order.splice(tidesIdx + 1, 0, 'sunMoon');
        else order.push('sunMoon');
    }
    if (!order.includes('vessel')) {
        const sunIdx = order.indexOf('sunMoon');
        if (sunIdx !== -1) order.splice(sunIdx + 1, 0, 'vessel');
        else order.push('vessel');
    }
    return [...new Set(order)];
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
    settings: DEFAULT_SETTINGS,
    isPro: tierIsPro(DEFAULT_SETTINGS.subscriptionTier),
    loading: true,
    quotaLimit: DAILY_STORMGLASS_LIMIT,

    _setUserId: (id) => {
        _userId = id;
    },

    updateSettings: async (patch) => {
        if (get().loading) return;

        const updated = { ...get().settings, ...patch };
        // Keep isPro in sync with subscriptionTier
        updated.isPro = tierIsPro(updated.subscriptionTier);
        set({ settings: updated, isPro: tierIsPro(updated.subscriptionTier) });

        try {
            await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(updated) });
            if (patch.heroWidgets) {
                _addDebugLog(`SAVE OK: [${patch.heroWidgets.join(', ')}]`);
            } else {
                _addDebugLog('SAVE OK: Settings Updated');
            }
        } catch (err: unknown) {
            _addDebugLog(`SAVE FAIL: ${getErrorMessage(err)}`);
        }

        if (_userId) syncToCloud(_userId, updated);
        manageScreenEffects(updated);
    },

    togglePro: () => get().updateSettings({ subscriptionTier: 'owner', isPro: true }),

    setTier: (tier) => get().updateSettings({ subscriptionTier: tier, isPro: tierIsPro(tier) }),

    resetSettings: async () => {
        set({ settings: DEFAULT_SETTINGS });
        await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(DEFAULT_SETTINGS) });
        window.location.reload();
    },
}));

// ── Load settings from disk on init ──────────────────────────────
async function loadSettings() {
    try {
        const { value } = await Preferences.get({ key: 'thalassa_settings' });
        if (value) {
            const parsed = JSON.parse(value);
            const validHeroWidgets =
                Array.isArray(parsed.heroWidgets) && parsed.heroWidgets.length > 0
                    ? parsed.heroWidgets
                    : DEFAULT_SETTINGS.heroWidgets;

            const merged: UserSettings = {
                ...DEFAULT_SETTINGS,
                ...parsed,
                notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications || {}) },
                units: {
                    ...DEFAULT_SETTINGS.units,
                    ...(parsed.units || {}),
                    waveHeight: parsed.units?.waveHeight || parsed.units?.length || 'm',
                },
                vessel: { ...DEFAULT_SETTINGS.vessel, ...(parsed.vessel || {}) },
                heroWidgets: validHeroWidgets,
                rowOrder: migrateRowOrder(
                    Array.isArray(parsed.rowOrder) ? parsed.rowOrder : [...(DEFAULT_SETTINGS.rowOrder || [])],
                ),
                // Tier migration: legacy isPro users → owner tier
                subscriptionTier: parsed.subscriptionTier || (parsed.isPro !== false ? 'owner' : 'free'),
                isPro: tierIsPro(parsed.subscriptionTier || (parsed.isPro !== false ? 'owner' : 'free')),
            };

            useSettingsStore.setState({ settings: merged, isPro: tierIsPro(merged.subscriptionTier), loading: false });
            _addDebugLog(`LOADED: [${validHeroWidgets.join(', ')}] from Disk.`);
            manageScreenEffects(merged);

            // Boot Pi Cache from saved settings (no UI dependency)
            piCache.boot({
                piCacheEnabled: merged.piCacheEnabled,
                piCacheHost: merged.piCacheHost,
                piCachePort: merged.piCachePort,
            });
        } else {
            useSettingsStore.setState({ loading: false });
            _addDebugLog('INIT: No Settings Found (Starting Defaults)');
        }
    } catch {
        useSettingsStore.setState({ loading: false });
        _addDebugLog('ERROR: Native Load Failed');
    }
}

loadSettings();

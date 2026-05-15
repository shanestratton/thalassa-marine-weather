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
import type { VesselProfile } from '../types/vessel';
import { getSystemUnits } from '../utils';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { piCache } from '../services/PiCacheService';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { supabase } from '../services/supabase';
import { getErrorMessage } from '../utils/logger';
import { tierIsPro } from '../services/SubscriptionService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsStore');

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
    heroMetric: 'temp',
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

/**
 * Pull cloud preferences for the just-signed-in user and merge into
 * local settings. Cloud values win for any key the cloud has set —
 * the use case is "Shane reinstalls, signs in, his metric units +
 * home port + vessel name come back automatically". Local-only keys
 * (anything the cloud row doesn't carry) stay untouched.
 *
 * Also reads `vessel_identity` for vessel name/model/reg — those
 * live in their own table because onboarding (and the new
 * onboarding-after-auth flow) writes them there, and they are NOT
 * mirrored into profiles.settings on the legacy path.
 *
 * Idempotent — running twice is harmless. Also tolerant of the
 * profiles row not existing yet (fresh account).
 */
async function pullFromCloud(userId: string): Promise<void> {
    if (!supabase) {
        log.warn(`[pullFromCloud] BAIL: supabase client is null for userId=${userId.slice(0, 8)}`);
        return;
    }
    log.warn(`[pullFromCloud] STARTING for userId=${userId.slice(0, 8)}`);
    try {
        // 1. profiles.settings — the JSONB blob carrying everything
        // the user has changed via updateSettings.
        log.warn('[pullFromCloud] querying profiles…');
        const { data: profile } = await supabase.from('profiles').select('settings').eq('id', userId).maybeSingle();
        log.warn(`[pullFromCloud] profiles result: ${profile?.settings ? 'has-settings' : 'no-settings'}`);

        const cloudSettings = (profile?.settings ?? null) as Partial<UserSettings> | null;

        // 2. vessel_identity — first-class name/type/model columns.
        // The wider dimensions (draft, beam, length) live in
        // profiles.settings.vessel because that's where onboarding
        // writes them today.
        const { data: vessel } = await supabase
            .from('vessel_identity')
            .select('vessel_name, vessel_type, model')
            .eq('owner_id', userId)
            .maybeSingle();

        // Nothing to merge? Bail.
        if (!cloudSettings && !vessel) return;

        const current = useSettingsStore.getState().settings;

        // Vessel merge needs care — VesselProfile.name is required,
        // so we only construct a vessel object when we have at least
        // one source AND can produce a usable name. Otherwise leave
        // current.vessel alone (might be undefined for fresh users,
        // and that's a state the rest of the app handles).
        let mergedVessel = current.vessel;
        const cloudVessel = cloudSettings?.vessel;
        if (cloudVessel || vessel) {
            const name = vessel?.vessel_name ?? cloudVessel?.name ?? current.vessel?.name;
            const type =
                (vessel?.vessel_type as VesselProfile['type'] | undefined) ?? cloudVessel?.type ?? current.vessel?.type;
            if (name && type) {
                mergedVessel = {
                    ...(current.vessel ?? ({} as Partial<UserSettings['vessel']>)),
                    ...(cloudVessel ?? {}),
                    name,
                    type,
                    model: vessel?.model ?? cloudVessel?.model ?? current.vessel?.model,
                } as UserSettings['vessel'];
            }
        }

        const merged: UserSettings = {
            ...current,
            ...(cloudSettings ?? {}),
            notifications: {
                ...current.notifications,
                ...(cloudSettings?.notifications ?? {}),
            },
            units: {
                ...current.units,
                ...(cloudSettings?.units ?? {}),
            },
            vessel: mergedVessel,
            isPro: tierIsPro(cloudSettings?.subscriptionTier ?? current.subscriptionTier),
        };

        // Fallback: if neither cloud nor local has a defaultLocation
        // we'd hand the weather flow nothing to fetch, and the Glass
        // page spins forever. Returning users whose profiles row was
        // never populated (common after multiple reinstalls that
        // bypass onboarding via the boats-row check) hit this.
        // Default to 'Current Location' — we already requested GPS
        // permission in the boats-found path, and the orchestrator's
        // existing GPS branch picks it up. User can change later in
        // Settings.
        if (!merged.defaultLocation) {
            log.warn(
                '[pullFromCloud] No defaultLocation found locally or in cloud — defaulting to Current Location for GPS-based weather',
            );
            merged.defaultLocation = 'Current Location';
        }

        useSettingsStore.setState({ settings: merged, isPro: merged.isPro });

        // Persist back to Capacitor Preferences so next cold boot is
        // already correct without waiting for the cloud round-trip.
        await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(merged) });
        _addDebugLog('CLOUD PULL OK: settings merged from profiles + vessel_identity');
        manageScreenEffects(merged);

        // Notify WeatherContext that settings just landed. The
        // orchestrator's normal init useEffect may have ALREADY fired
        // before this completed (with no defaultLocation, then
        // setLoading(false) and returned). On fresh-install +
        // sign-in, that race left Shane staring at a spinning Glass
        // page because useAppController's effect re-firing on
        // settings.defaultLocation change wasn't reliably re-fetching.
        // A direct event removes that indirection — WeatherContext
        // listens and triggers fetchWeather as soon as it sees a
        // location lands.
        if (typeof window !== 'undefined' && merged.defaultLocation) {
            log.warn(`[pullFromCloud] dispatching settings-restored event: defaultLocation=${merged.defaultLocation}`);
            window.dispatchEvent(
                new CustomEvent('thalassa:settings-restored', {
                    detail: {
                        defaultLocation: merged.defaultLocation,
                        defaultLocationCoords: merged.defaultLocationCoords,
                    },
                }),
            );
        } else {
            log.warn(
                `[pullFromCloud] NO defaultLocation in merged settings — not dispatching event. cloudSettings=${cloudSettings ? 'present' : 'null'}`,
            );
        }
    } catch (err) {
        log.warn(`[pullFromCloud] EXCEPTION: ${getErrorMessage(err)}`);
        _addDebugLog(`CLOUD PULL FAIL: ${getErrorMessage(err)}`);
    }
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
        const wasSignedOut = _userId === null;
        _userId = id;
        // Cross-device sync: when a user signs in (transition from
        // no-user → user), pull their saved settings + vessel info
        // from cloud and merge into the local store. Solves the
        // "reinstall, sign in, lose all my prefs" bug. Fires once
        // per sign-in event; subsequent settings changes go through
        // the normal updateSettings → syncToCloud path.
        if (id && wasSignedOut) {
            void pullFromCloud(id);
        }
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

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
import { Geolocation } from '@capacitor/geolocation';

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
/**
 * True if loadSettings() found existing `thalassa_settings` data in
 * Capacitor Preferences at cold boot. Used by pullFromCloud to decide
 * whether to fire the welcome-back modal — we only want it on a TRUE
 * fresh-device restore (reinstall + sign-in or first sign-in on a new
 * device), not every time someone signs out and back in on the same
 * phone where their settings already live locally.
 */
let _localHadPriorData = false;
/**
 * Promise that resolves once loadSettings() has finished its disk
 * read and committed its `setState({ ..., loading: false })`.
 *
 * pullFromCloud awaits this BEFORE reading the store's current state,
 * which removes a subtle cold-boot race: if Supabase's getSession()
 * happened to resolve before Capacitor Preferences.get() did (rare
 * but possible — both are native bridges), pullFromCloud would read
 * DEFAULT_SETTINGS as `current`, merge cloud onto it, setState, and
 * THEN loadSettings would land its own setState and silently roll
 * the merge back. With this gate the order is enforced: local disk
 * first, cloud merge second, both setStates land in the right order
 * regardless of which native promise resolves first.
 */
let _loadSettingsPromise: Promise<void> | null = null;

/** Wire the debug log sink from uiStore (called once from ThalassaContext bridge) */
export function setSettingsDebugSink(fn: (msg: string) => void) {
    _addDebugLog = fn;
}

/**
 * Returns a promise that resolves once the initial disk-load of
 * settings has completed (or failed — the promise resolves either
 * way so callers don't hang on a broken Preferences plugin).
 *
 * Exported so tests can synchronise against the init boundary.
 */
export function awaitSettingsLoaded(): Promise<void> {
    return _loadSettingsPromise ?? Promise.resolve();
}

async function syncToCloud(userId: string, s: UserSettings) {
    if (!supabase) return;
    await supabase.from('profiles').upsert({ id: userId, settings: s, updated_at: new Date().toISOString() });
}

/**
 * Build the summary object surfaced to the welcome-back modal. Pulls
 * the user-visible fields that confirm "yes, your stuff came back":
 * vessel name + a short type/length descriptor, units flavour,
 * default location, subscription tier, count of armed notifications,
 * count of saved locations. Greeting name prefers nickname → first
 * name → null (caller falls back to a generic greeting).
 */
export interface RestoredSummary {
    greetingName: string | null;
    vesselName: string | null;
    vesselDescriptor: string | null;
    unitsFlavour: 'metric' | 'imperial' | 'mixed';
    defaultLocation: string | null;
    subscriptionTier: string;
    armedNotifications: number;
    savedLocationCount: number;
}

/**
 * Merge a cloud-side settings payload onto the current local state.
 *
 * Top-level cloud keys win (so polarData, polarBoatModel, etc. come
 * back whole), but the four "compound" objects get sub-key-preserving
 * deep merges so a partial cloud version can't clobber local sub-keys
 * the cloud row hasn't heard about yet:
 *
 *   - notifications   — per-alert enable + threshold
 *   - units           — speed / length / temp / etc.
 *   - comfortParams   — maxWindKts / maxGustKts / maxWaveM / angles
 *   - vessel          — handled by the caller (depends on vessel_identity
 *                       row too), passed in pre-merged
 *
 * Exported for testability.
 */
export function mergeCloudSettings(
    current: UserSettings,
    cloudSettings: Partial<UserSettings> | null,
    mergedVessel: UserSettings['vessel'],
): UserSettings {
    return {
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
        comfortParams: {
            ...(current.comfortParams ?? {}),
            ...(cloudSettings?.comfortParams ?? {}),
        },
        vessel: mergedVessel,
        isPro: tierIsPro(cloudSettings?.subscriptionTier ?? current.subscriptionTier),
    };
}

export function buildRestoredSummary(s: UserSettings): RestoredSummary {
    const greetingName = s.nickname?.trim() || s.firstName?.trim() || null;

    const vesselName = s.vessel?.name?.trim() || null;
    let vesselDescriptor: string | null = null;
    if (s.vessel) {
        const parts: string[] = [];
        if (s.vessel.type)
            parts.push(s.vessel.type === 'sail' ? 'Sail' : s.vessel.type === 'power' ? 'Power' : 'Observer');
        if (s.vessel.length) {
            // settings.vessel.length is stored in feet (see vessel_draft_is_feet memory note)
            parts.push(`${Math.round(s.vessel.length)}ft`);
        }
        if (parts.length) vesselDescriptor = parts.join(' · ');
    }

    // Units flavour — sample length + temp (the most "I notice
    // immediately if these are wrong" knobs). "mixed" covers Aussie
    // boats that set wind=kts (imperial) + everything-else metric —
    // a common preference, not a bug.
    const length = s.units?.length;
    const temp = s.units?.temp;
    const metricLength = length === 'm';
    const metricTemp = temp === 'C';
    let unitsFlavour: 'metric' | 'imperial' | 'mixed';
    if (metricLength && metricTemp) unitsFlavour = 'metric';
    else if (!metricLength && !metricTemp) unitsFlavour = 'imperial';
    else unitsFlavour = 'mixed';

    const armedNotifications = s.notifications
        ? Object.values(s.notifications).filter((n) => (n as { enabled?: boolean })?.enabled).length
        : 0;

    return {
        greetingName,
        vesselName,
        vesselDescriptor,
        unitsFlavour,
        defaultLocation: s.defaultLocation || null,
        subscriptionTier: s.subscriptionTier,
        armedNotifications,
        savedLocationCount: Array.isArray(s.savedLocations) ? s.savedLocations.length : 0,
    };
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
    // Wait for the local disk read to finish committing its setState
    // before we read `current` and merge cloud on top. Without this
    // gate, a fast cloud round-trip + slow disk read would have us
    // merging cloud onto DEFAULT_SETTINGS, only to have loadSettings'
    // own setState land afterwards and silently roll the merge back.
    // The await is a no-op once loadSettings has already resolved
    // (the common case) — it's cheap insurance for the cold-boot edge.
    if (_loadSettingsPromise) {
        try {
            await _loadSettingsPromise;
        } catch {
            // loadSettings already catches its own errors; this catch
            // exists purely to keep us moving if the promise rejects.
        }
    }
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

        const merged = mergeCloudSettings(current, cloudSettings, mergedVessel);

        // Fallback: if neither cloud nor local has a defaultLocation
        // we'd hand the weather flow nothing to fetch, and the Glass
        // page spins forever.
        //
        // Default to 'Current Location' — the orchestrator's existing
        // GPS branch picks it up. But CRITICAL: await location
        // permission FIRST. Without this wait, the orchestrator's
        // GPS lookup fires immediately on the settings-restored
        // event we're about to dispatch, before iOS has shown the
        // user the location prompt; Transistorsoft's
        // BackgroundGeolocation then fails with kCLErrorDomain
        // Code=1 (denied) and the orchestrator gives up. By the
        // time the user grants permission, no one re-tries.
        // Awaiting requestPermissions here blocks pullFromCloud
        // until the user has dismissed the iOS sheet, so the
        // downstream GPS lookup happens with permission already
        // granted. Denial returns the same shape with status='denied'
        // — we still dispatch the event, the orchestrator's GPS
        // call will fail, but at least it fails for a reason the
        // user can fix in iOS Settings.
        if (!merged.defaultLocation) {
            log.warn(
                '[pullFromCloud] No defaultLocation found locally or in cloud — awaiting location permission before defaulting to Current Location',
            );
            try {
                const perm = await Geolocation.requestPermissions();
                log.warn(`[pullFromCloud] Geolocation permission result: ${perm.location}`);
            } catch (err) {
                log.warn(`[pullFromCloud] Geolocation permission threw: ${getErrorMessage(err)}`);
            }
            merged.defaultLocation = 'Current Location';
        }

        useSettingsStore.setState({ settings: merged, isPro: merged.isPro });

        // Persist back to Capacitor Preferences so next cold boot is
        // already correct without waiting for the cloud round-trip — and
        // mirror it so the synchronous warm-boot seed reflects the restore.
        writeSettingsMirror(merged);
        await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(merged) });
        _addDebugLog('CLOUD PULL OK: settings merged from profiles + vessel_identity');
        manageScreenEffects(merged);

        // ── Welcome-back modal ─────────────────────────────────────
        // Fire ONCE per user per device, ONLY on a fresh-device
        // restore (local Preferences was empty at boot). Otherwise
        // users would see the modal every time they sign out and
        // back in on their primary phone, which would be noise.
        try {
            if (!_localHadPriorData) {
                const seenKey = `thalassa_restored_modal_seen_${userId}`;
                const { value: alreadySeen } = await Preferences.get({ key: seenKey });
                if (!alreadySeen) {
                    const summary = buildRestoredSummary(merged);
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(
                            new CustomEvent('thalassa:settings-restored-modal', {
                                detail: { summary },
                            }),
                        );
                    }
                    await Preferences.set({ key: seenKey, value: '1' });
                }
            }
        } catch (modalErr) {
            // Non-fatal — modal is celebratory polish, not core data
            log.warn(`[pullFromCloud] modal dispatch skipped: ${getErrorMessage(modalErr)}`);
        }

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

// ── Synchronous settings mirror (instant warm-boot paint) ──────────
//
// Capacitor Preferences (the durable source of truth) is ASYNC, so on a
// warm boot the whole app sat behind a splash while it loaded — even
// though the cached weather was already paintable. We mirror settings to
// localStorage (synchronous) on every write and seed the store from it
// at module-eval, so `loading` starts false and the Glass screen paints
// on the first frame. Preferences still wins reconciliation (localStorage
// can be evicted by iOS under storage pressure — if the mirror is missing
// we fall back to the async load, i.e. today's behaviour). Mirrors the
// weather cache's loadLargeDataSync pattern (services/nativeStorage.ts).
export const SETTINGS_MIRROR_KEY = 'thalassa_settings_mirror';

/** Write-safety gate, distinct from the paint `loading` flag: updates are
 *  refused until the authoritative async load has run, exactly as the old
 *  `if (get().loading) return` did before the sync seed made loading=false
 *  early. Preserves the cold-boot race fix. */
let _fullyHydrated = false;

export function writeSettingsMirror(s: UserSettings): void {
    try {
        localStorage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify(s));
    } catch {
        /* localStorage full/unavailable — Preferences remains the truth */
    }
}

/** Merge a parsed settings blob onto DEFAULT_SETTINGS. Shared by the sync
 *  mirror seed and the async Preferences load so both produce identical
 *  state — no drift between the instant-paint and the authoritative load. */
export function mergeSettings(parsed: Record<string, unknown>): UserSettings {
    const p = parsed as Partial<UserSettings> & Record<string, unknown>;
    const validHeroWidgets =
        Array.isArray(p.heroWidgets) && p.heroWidgets.length > 0 ? p.heroWidgets : DEFAULT_SETTINGS.heroWidgets;
    const tier = p.subscriptionTier || (p.isPro !== false ? 'owner' : 'free');
    return {
        ...DEFAULT_SETTINGS,
        ...p,
        notifications: { ...DEFAULT_SETTINGS.notifications, ...(p.notifications || {}) },
        units: {
            ...DEFAULT_SETTINGS.units,
            ...(p.units || {}),
            waveHeight: p.units?.waveHeight || p.units?.length || 'm',
        },
        vessel: { ...DEFAULT_SETTINGS.vessel, ...(p.vessel || {}) },
        heroWidgets: validHeroWidgets,
        rowOrder: migrateRowOrder(Array.isArray(p.rowOrder) ? p.rowOrder : [...(DEFAULT_SETTINGS.rowOrder || [])]),
        subscriptionTier: tier,
        isPro: tierIsPro(tier),
    } as UserSettings;
}

/** Synchronous warm-boot seed from the localStorage mirror, or null. */
export function readSettingsMirrorSync(): UserSettings | null {
    try {
        const raw = localStorage.getItem(SETTINGS_MIRROR_KEY);
        if (!raw) return null;
        return mergeSettings(JSON.parse(raw));
    } catch {
        return null;
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

// Seed synchronously from the mirror so a warm boot paints immediately
// (loading=false, real settings). First-ever launch (no mirror) keeps the
// old loading=true → splash → async-load path. Writes stay gated on
// _fullyHydrated until the authoritative load runs.
const _seed = readSettingsMirrorSync();

export const useSettingsStore = create<SettingsState>()((set, get) => ({
    settings: _seed ?? DEFAULT_SETTINGS,
    isPro: tierIsPro((_seed ?? DEFAULT_SETTINGS).subscriptionTier),
    loading: _seed === null,
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
        // Gate on hydration, not the paint `loading` flag — the sync seed
        // makes loading=false early, but writes must still wait for the
        // authoritative load so they can't be clobbered by it (the
        // cold-boot race this guard has always protected).
        if (!_fullyHydrated) return;

        const updated = { ...get().settings, ...patch };
        // Keep isPro in sync with subscriptionTier
        updated.isPro = tierIsPro(updated.subscriptionTier);
        set({ settings: updated, isPro: tierIsPro(updated.subscriptionTier) });
        // Mirror first (synchronous) so the very next boot paints this change.
        writeSettingsMirror(updated);

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
        // Update the sync mirror BEFORE the reload, or the warm-boot seed
        // would paint the pre-reset settings for a frame.
        writeSettingsMirror(DEFAULT_SETTINGS);
        await Preferences.set({ key: 'thalassa_settings', value: JSON.stringify(DEFAULT_SETTINGS) });
        window.location.reload();
    },
}));

// ── Load settings from disk on init ──────────────────────────────
async function loadSettings() {
    try {
        const { value } = await Preferences.get({ key: 'thalassa_settings' });
        if (value) {
            // Mark that this device had its own settings on disk
            // before any cloud pull — gates the welcome-back modal so
            // it only fires on true fresh-device restores.
            _localHadPriorData = true;
            const merged = mergeSettings(JSON.parse(value));

            useSettingsStore.setState({ settings: merged, isPro: tierIsPro(merged.subscriptionTier), loading: false });
            // Refresh the sync mirror with the authoritative (migrated)
            // settings so the next warm boot seeds from the same shape.
            writeSettingsMirror(merged);
            _addDebugLog(`LOADED: [${(merged.heroWidgets ?? []).join(', ')}] from Disk.`);
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
    } finally {
        // Authoritative load is done (success, no-data, or error) — writes
        // are now safe to accept. Set in `finally` so a Preferences failure
        // can't leave updateSettings permanently dead.
        _fullyHydrated = true;
    }
}

_loadSettingsPromise = loadSettings();

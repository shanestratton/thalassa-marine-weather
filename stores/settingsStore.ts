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
import { getErrorMessage } from '../utils/createLogger';
import { tierIsPro } from '../services/SubscriptionService';
import { createLogger } from '../utils/createLogger';
import { Geolocation } from '@capacitor/geolocation';
import {
    createOwnedVesselProfile,
    defaultVesselProfile,
    discardQueuedVesselPatchesExcept,
    flushQueuedVesselPatches,
    getQueuedVesselPatches,
    loadCachedOwnedVesselFleet,
    loadOwnedVesselFleet,
    patchOwnedVesselProfile,
    persistCachedOwnedVesselFleet,
    archiveOwnedVessel,
    bootstrapOwnedVesselProfile,
    selectActiveOwnedVessel,
    setActiveOwnedVessel,
    type OwnedVesselProfile,
    type VesselFleet,
    type VesselProfilePatch,
} from '../services/VesselFleetService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const log = createLogger('SettingsStore');

const DAILY_STORMGLASS_LIMIT = 100;
const SETTINGS_KEY = 'thalassa_settings';
const SETTINGS_LEGACY_QUARANTINE_KEY = 'thalassa_settings_quarantine_v2';
const SETTINGS_ANONYMOUS_CLAIM_KEY = 'thalassa_settings_anonymous_claim_v1';

interface PersistedSettingsEnvelope {
    version: 2;
    owner_user_id: string | null;
    settings: UserSettings;
}

interface AnonymousSettingsClaim {
    owner_user_id: string;
    state: 'claiming' | 'completed';
    claimed_at: string;
}

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
    forecastModel: 'dwd_icon',
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
    /** Cloud-authoritative fleet. `settings.vessel` is the selected compatibility snapshot. */
    vesselFleet: OwnedVesselProfile[];
    activeVesselId: string | null;
    vesselFleetStatus: 'idle' | 'loading' | 'syncing' | 'saved' | 'offline' | 'error';
    updateSettings: (patch: Partial<UserSettings>) => void;
    /** Pull fleet + retry durable profile writes. Called on sign-in and reconnect. */
    syncVesselFleet: () => Promise<void>;
    /** Select the vessel used for the next route, diary entry, or voyage. */
    selectActiveVessel: (boatId: string) => Promise<void>;
    /** Add a new owned vessel; the server enforces the five-vessel ceiling. */
    createVesselProfile: (seed?: Partial<VesselProfile>) => Promise<void>;
    /** Archive rather than delete a vessel so prior voyages remain historically correct. */
    archiveVesselProfile: (boatId: string) => Promise<void>;
    /** Save a sparse update to the selected vessel, with an offline outbox fallback. */
    patchActiveVesselProfile: (patch: Partial<VesselProfile> | VesselProfilePatch) => Promise<void>;
    setTier: (tier: UserSettings['subscriptionTier']) => void;
    togglePro: () => void;
    resetSettings: () => void;
    /** @internal — called once by init to wire up auth-based cloud sync */
    _setUserId: (id: string | null) => void;
}

// Internal ref to avoid circular store deps. The synchronous auth scope is
// authoritative; this mirrors the SettingsProvider bridge only.
let _userId: string | null = getAuthIdentityScope().userId;
let _addDebugLog: (msg: string) => void = () => {};
/**
 * True if loadSettings() found existing `thalassa_settings` data in
 * Capacitor Preferences at cold boot. Used by pullFromCloud to decide
 * whether to fire the welcome-back modal — we only want it on a TRUE
 * fresh-device restore (reinstall + sign-in or first sign-in on a new
 * device), not every time someone signs out and back in on the same
 * phone where their settings already live locally.
 */
const _localHadPriorData = new Map<string, boolean>();
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
const _scopeLoadPromises = new Map<string, Promise<void>>();
const _anonymousAdoptedScopes = new Set<string>();
let _hydratedScopeKey: string | null = null;
let _lastCloudPullGeneration = -1;
let _scopeTransitionTail: Promise<void> = Promise.resolve();
/** Serialise fleet pulls per account so an older response cannot win a newer selection/edit. */
const _fleetSyncTails = new Map<string, Promise<void>>();
/**
 * Pulls may be slow (especially on a new device). Increment before every
 * deliberate fleet mutation so an older pull cannot repaint a newly selected
 * yacht over the top of the skipper's newer choice.
 */
const _fleetMutationGenerations = new Map<string, number>();

function beginFleetMutation(scope: AuthIdentityScope): number {
    const next = (_fleetMutationGenerations.get(scope.key) ?? 0) + 1;
    _fleetMutationGenerations.set(scope.key, next);
    return next;
}

function fleetMutationGeneration(scope: AuthIdentityScope): number {
    return _fleetMutationGenerations.get(scope.key) ?? 0;
}

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

/**
 * Vessel data used to be written as part of the generic settings blob. Keep
 * the compatibility copy locally, but never make it the cloud authority
 * again: a delayed whole-blob settings write is exactly how one device used
 * to overwrite another device's keel, capacity, or polar information.
 */
function settingsWithoutFleetFields(settings: UserSettings): UserSettings {
    const {
        vessel: _vessel,
        vesselUnits: _vesselUnits,
        comfortParams: _comfortParams,
        polarData: _polarData,
        polarBoatModel: _polarBoatModel,
        polarSource_type: _polarSourceType,
        ...globalSettings
    } = settings;
    return globalSettings as UserSettings;
}

async function syncToCloud(scope: AuthIdentityScope, s: UserSettings) {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const { error } = await supabase
        .from('profiles')
        .upsert({ id: scope.userId, settings: settingsWithoutFleetFields(s), updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message || 'Could not sync settings');
}

function activeFleetVessel(fleet: Pick<VesselFleet, 'vessels' | 'activeBoatId'>): OwnedVesselProfile | null {
    return fleet.vessels.find((vessel) => vessel.id === fleet.activeBoatId) ?? null;
}

/** Apply a selected cloud vessel as the existing app-wide compatibility view. */
function settingsWithFleetVessel(settings: UserSettings, vessel: OwnedVesselProfile): UserSettings {
    return {
        ...settings,
        vessel: vessel.profile,
        vesselUnits: vessel.vessel_units,
        comfortParams: vessel.comfort_params,
        polarData: vessel.polar_data ?? undefined,
        polarBoatModel: vessel.polar_boat_model ?? undefined,
        polarSource_type: vessel.polar_source_type ?? undefined,
    };
}

function profilePatchFromSettingsPatch(patch: Partial<UserSettings>): VesselProfilePatch | null {
    const profile: Partial<VesselProfile> | undefined = patch.vessel ? { ...patch.vessel } : undefined;
    const vesselUnits = patch.vesselUnits ? { ...patch.vesselUnits } : undefined;
    const comfortParams = patch.comfortParams ? { ...patch.comfortParams } : undefined;
    const hasPolarData = Object.prototype.hasOwnProperty.call(patch, 'polarData');
    const hasPolarBoatModel = Object.prototype.hasOwnProperty.call(patch, 'polarBoatModel');
    const hasPolarSource = Object.prototype.hasOwnProperty.call(patch, 'polarSource_type');
    if (!profile && !vesselUnits && !comfortParams && !hasPolarData && !hasPolarBoatModel && !hasPolarSource)
        return null;
    return {
        ...(profile ? { profile } : {}),
        ...(vesselUnits ? { vesselUnits } : {}),
        ...(comfortParams ? { comfortParams } : {}),
        ...(hasPolarData ? { polarData: patch.polarData ?? null, setPolarData: true } : {}),
        ...(hasPolarBoatModel ? { polarBoatModel: patch.polarBoatModel ?? null, setPolarBoatModel: true } : {}),
        ...(hasPolarSource ? { polarSourceType: patch.polarSource_type ?? null, setPolarSourceType: true } : {}),
    };
}

function isVesselProfilePatch(value: Partial<VesselProfile> | VesselProfilePatch): value is VesselProfilePatch {
    return (
        Object.prototype.hasOwnProperty.call(value, 'profile') ||
        Object.prototype.hasOwnProperty.call(value, 'vesselUnits') ||
        Object.prototype.hasOwnProperty.call(value, 'comfortParams') ||
        Object.prototype.hasOwnProperty.call(value, 'polarData') ||
        Object.prototype.hasOwnProperty.call(value, 'setPolarData') ||
        Object.prototype.hasOwnProperty.call(value, 'polarBoatModel') ||
        Object.prototype.hasOwnProperty.call(value, 'polarSourceType')
    );
}

/**
 * Fleet JSON patches use `null` as an explicit cloud-side delete marker.
 * Keep the device projection idiomatic (`undefined`/absent) so existing UI
 * consumers continue to read an OFF Comfort Zone as simply “no limit”.
 */
function applyNullableObjectPatch<T extends object>(current: T | undefined, patch: object): T {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) delete next[key];
        else next[key] = value;
    }
    return next as T;
}

function applyPatchLocally(settings: UserSettings, patch: VesselProfilePatch): UserSettings {
    return {
        ...settings,
        ...(patch.profile
            ? {
                  vessel: {
                      ...(settings.vessel ?? defaultVesselProfile()),
                      ...patch.profile,
                  } as VesselProfile,
              }
            : {}),
        ...(patch.vesselUnits
            ? { vesselUnits: { ...(settings.vesselUnits ?? {}), ...patch.vesselUnits } as UserSettings['vesselUnits'] }
            : {}),
        ...(patch.comfortParams
            ? {
                  comfortParams: applyNullableObjectPatch(settings.comfortParams, patch.comfortParams),
              }
            : {}),
        ...(patch.setPolarData ? { polarData: patch.polarData ?? undefined } : {}),
        ...(patch.setPolarBoatModel ? { polarBoatModel: patch.polarBoatModel ?? undefined } : {}),
        ...(patch.setPolarSourceType ? { polarSource_type: patch.polarSourceType ?? undefined } : {}),
    };
}

/** Keep the selected fleet row in step with the local compatibility view. */
function applyPatchToFleetVessel(vessel: OwnedVesselProfile, patch: VesselProfilePatch): OwnedVesselProfile {
    return {
        ...vessel,
        ...(patch.profile ? { profile: { ...vessel.profile, ...patch.profile } as VesselProfile } : {}),
        ...(patch.vesselUnits
            ? {
                  vessel_units: {
                      ...(vessel.vessel_units ?? {}),
                      ...patch.vesselUnits,
                  } as NonNullable<OwnedVesselProfile['vessel_units']>,
              }
            : {}),
        ...(patch.comfortParams
            ? {
                  comfort_params: applyNullableObjectPatch(vessel.comfort_params, patch.comfortParams),
              }
            : {}),
        ...(patch.setPolarData ? { polar_data: patch.polarData ?? null } : {}),
        ...(patch.setPolarBoatModel ? { polar_boat_model: patch.polarBoatModel ?? null } : {}),
        ...(patch.setPolarSourceType ? { polar_source_type: patch.polarSourceType ?? null } : {}),
    };
}

function fleetSnapshot(state: Pick<SettingsState, 'vesselFleet' | 'activeVesselId'>): VesselFleet {
    return {
        vessels: state.vesselFleet,
        activeBoatId: state.activeVesselId,
    };
}

/** Overlay still-queued local edits onto a freshly fetched cloud fleet. */
async function fleetWithQueuedLocalPatches(
    fleet: VesselFleet,
    scope: AuthIdentityScope,
): Promise<{ fleet: VesselFleet; pending: number }> {
    const queued = await getQueuedVesselPatches(scope);
    return {
        pending: queued.length,
        fleet: queued.reduce<VesselFleet>((currentFleet, entry) => {
            if (!currentFleet.vessels.some((vessel) => vessel.id === entry.boatId)) return currentFleet;
            return {
                ...currentFleet,
                vessels: currentFleet.vessels.map((vessel) =>
                    vessel.id === entry.boatId ? applyPatchToFleetVessel(vessel, entry.patch) : vessel,
                ),
            };
        }, fleet),
    };
}

function hasMeaningfulVesselProfile(profile: UserSettings['vessel']): profile is VesselProfile {
    if (!profile || !profile.name?.trim()) return false;
    return (
        profile.name.trim().toLowerCase() !== 'my boat' ||
        Number(profile.length) > 0 ||
        Number(profile.draft) > 0 ||
        Boolean(profile.model) ||
        Boolean(profile.registration) ||
        Boolean(profile.mmsi)
    );
}

function isTerminalVesselSelectionFailure(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    return /not found|not owned|archived|authentication is required|permission|forbidden|unavailable to this user/.test(
        message,
    );
}

async function persistFleetCompatibilitySettings(scope: AuthIdentityScope, settings: UserSettings): Promise<void> {
    writeSettingsMirror(settings, scope);
    await writeSettingsToPreferences(scope, settings);
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

function settingsPreferenceKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(SETTINGS_KEY, scope);
}

function persistedEnvelope(scope: AuthIdentityScope, settings: UserSettings): PersistedSettingsEnvelope {
    return {
        version: 2,
        owner_user_id: scope.userId,
        settings,
    };
}

function parseEnvelope(raw: string): {
    ownerKnown: boolean;
    ownerUserId: string | null;
    settings: UserSettings | null;
} {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ownerKnown: false, ownerUserId: null, settings: null };
    }
    const record = parsed as Record<string, unknown>;
    if (
        Object.prototype.hasOwnProperty.call(record, 'owner_user_id') &&
        (record.owner_user_id === null || typeof record.owner_user_id === 'string') &&
        record.settings &&
        typeof record.settings === 'object' &&
        !Array.isArray(record.settings)
    ) {
        return {
            ownerKnown: true,
            ownerUserId: typeof record.owner_user_id === 'string' ? record.owner_user_id.trim() || null : null,
            settings: mergeSettings(record.settings as Record<string, unknown>),
        };
    }
    return {
        ownerKnown: false,
        ownerUserId: null,
        settings: mergeSettings(record),
    };
}

async function writeSettingsToPreferences(scope: AuthIdentityScope, settings: UserSettings): Promise<void> {
    await Preferences.set({
        key: settingsPreferenceKey(scope),
        value: JSON.stringify(persistedEnvelope(scope, settings)),
    });
}

async function readSettingsFromPreferences(scope: AuthIdentityScope): Promise<UserSettings | null> {
    const { value } = await Preferences.get({ key: settingsPreferenceKey(scope) });
    if (!value) return null;
    const parsed = parseEnvelope(value);
    // Raw values inside an identity-scoped key came from the first scoped
    // release. The namespace itself proves their owner.
    if (!parsed.ownerKnown || parsed.ownerUserId === scope.userId) return parsed.settings;
    await Preferences.set({
        key: SETTINGS_LEGACY_QUARANTINE_KEY,
        value: JSON.stringify({
            reason: 'scoped settings owner mismatch',
            scoped_key: settingsPreferenceKey(scope),
            quarantined_at: new Date().toISOString(),
            value,
        }),
    });
    await Preferences.remove({ key: settingsPreferenceKey(scope) });
    return null;
}

/**
 * The historical Preferences key had no account namespace. Only an envelope
 * with an explicit matching owner can be adopted; raw legacy settings are
 * retained in quarantine and never guessed to belong to the next login.
 */
async function migrateLegacyPreferences(scope: AuthIdentityScope): Promise<void> {
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    if (!value) return;
    try {
        const parsed = parseEnvelope(value);
        if (parsed.ownerKnown && parsed.ownerUserId === scope.userId && parsed.settings) {
            const { value: existing } = await Preferences.get({ key: settingsPreferenceKey(scope) });
            if (!existing) await writeSettingsToPreferences(scope, parsed.settings);
            await Preferences.remove({ key: SETTINGS_KEY });
            return;
        }
        if (parsed.ownerKnown) return; // leave it for its explicit owner
    } catch {
        // Preserved below as opaque quarantine data.
    }
    await Preferences.set({
        key: SETTINGS_LEGACY_QUARANTINE_KEY,
        value: JSON.stringify({
            reason: 'unattributed legacy settings',
            quarantined_at: new Date().toISOString(),
            value,
        }),
    });
    await Preferences.remove({ key: SETTINGS_KEY });
}

/**
 * Assign anonymous onboarding once, to the first authenticated identity on
 * this installation. The durable claim is written before copying so another
 * account can never win a crash/interleaving race.
 */
async function adoptAnonymousSettingsIfSafe(
    scope: AuthIdentityScope,
    previous: AuthIdentityScope | null,
): Promise<void> {
    if (!scope.userId) return;
    const { value: claimValue } = await Preferences.get({ key: SETTINGS_ANONYMOUS_CLAIM_KEY });
    if (!isAuthIdentityScopeCurrent(scope)) return;

    let claim: AnonymousSettingsClaim | null = null;
    if (claimValue) {
        try {
            const parsed = JSON.parse(claimValue) as AnonymousSettingsClaim;
            if (parsed?.owner_user_id && (parsed.state === 'claiming' || parsed.state === 'completed')) claim = parsed;
        } catch {
            return; // corrupt claim is unsafe to guess through
        }
    }
    const canStart = !claim && previous?.userId === null;
    const canResume = claim?.state === 'claiming' && claim.owner_user_id === scope.userId;
    if (!canStart && !canResume) return;

    if (!claim) {
        claim = {
            owner_user_id: scope.userId,
            state: 'claiming',
            claimed_at: new Date().toISOString(),
        };
        await Preferences.set({ key: SETTINGS_ANONYMOUS_CLAIM_KEY, value: JSON.stringify(claim) });
        if (!isAuthIdentityScopeCurrent(scope)) return;
    }

    const anonymousScope: AuthIdentityScope = {
        key: 'anonymous',
        userId: null,
        generation: scope.generation,
    };
    const { value: destinationValue } = await Preferences.get({ key: settingsPreferenceKey(scope) });
    if (!isAuthIdentityScopeCurrent(scope)) return;
    if (!destinationValue) {
        const anonymousSettings = await readSettingsFromPreferences(anonymousScope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (anonymousSettings) {
            await writeSettingsToPreferences(scope, anonymousSettings);
            writeSettingsMirror(anonymousSettings, scope);
            _anonymousAdoptedScopes.add(scope.key);
        }
    }

    // Claimed anonymous state must not reappear in browse mode or be offered
    // to a later account.
    await Preferences.remove({ key: settingsPreferenceKey(anonymousScope) });
    removeSettingsMirror(anonymousScope);
    await Preferences.set({
        key: SETTINGS_ANONYMOUS_CLAIM_KEY,
        value: JSON.stringify({ ...claim, state: 'completed' } satisfies AnonymousSettingsClaim),
    });
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
async function pullFromCloud(scope: AuthIdentityScope): Promise<void> {
    const userId = scope.userId;
    if (!supabase || !userId || !isAuthIdentityScopeCurrent(scope)) {
        if (!supabase && userId) {
            log.warn(`[pullFromCloud] BAIL: supabase client is null for userId=${userId.slice(0, 8)}`);
        }
        return;
    }
    log.warn(`[pullFromCloud] STARTING for userId=${userId.slice(0, 8)}`);
    const pullFleetGeneration = fleetMutationGeneration(scope);
    // Wait for the local disk read to finish committing its setState
    // before we read `current` and merge cloud on top. Without this
    // gate, a fast cloud round-trip + slow disk read would have us
    // merging cloud onto DEFAULT_SETTINGS, only to have loadSettings'
    // own setState land afterwards and silently roll the merge back.
    // The await is a no-op once loadSettings has already resolved
    // (the common case) — it's cheap insurance for the cold-boot edge.
    const scopeLoad = _scopeLoadPromises.get(scope.key);
    if (scopeLoad) {
        try {
            await scopeLoad;
        } catch {
            // loadSettings already catches its own errors; this catch
            // exists purely to keep us moving if the promise rejects.
        }
    }
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        // 1. profiles.settings — the JSONB blob carrying everything
        // the user has changed via updateSettings.
        log.warn('[pullFromCloud] querying profiles…');
        const { data: profile } = await supabase.from('profiles').select('settings').eq('id', userId).maybeSingle();
        if (!isAuthIdentityScopeCurrent(scope)) return;
        log.warn(`[pullFromCloud] profiles result: ${profile?.settings ? 'has-settings' : 'no-settings'}`);

        const cloudSettings = (profile?.settings ?? null) as Partial<UserSettings> | null;

        // 2. The legacy active identity is retained as a compatibility
        // projection while the fleet rolls out. It must never override a
        // selected `boat_profiles` row below.
        const { data: vessel } = await supabase
            .from('vessel_identity')
            .select('vessel_name, vessel_type, model')
            .eq('owner_id', userId)
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(scope)) return;

        // 3. The fleet is the authority for full vessel specifications.
        // A failed lookup is deliberately non-fatal during the staged
        // migration: existing accounts still get their legacy settings, and
        // the next reconnect will promote them automatically.
        let fleet: VesselFleet = { vessels: [], activeBoatId: null };
        let fleetLoaded = false;
        try {
            fleet = await loadOwnedVesselFleet(scope);
            fleetLoaded = true;
        } catch (fleetError) {
            log.warn(`[pullFromCloud] fleet pull deferred: ${getErrorMessage(fleetError)}`);
        }
        if (!isAuthIdentityScopeCurrent(scope)) return;

        const current = useSettingsStore.getState().settings;

        // A normal empty account has nothing to reconcile. Anonymous
        // onboarding is the deliberate exception: its one-time claimed
        // settings must be pushed into this first account, not stranded only
        // on the device.
        if (
            !cloudSettings &&
            !vessel &&
            fleet.vessels.length === 0 &&
            !hasMeaningfulVesselProfile(current.vessel) &&
            !_anonymousAdoptedScopes.has(scope.key)
        ) {
            return;
        }

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

        let merged = mergeCloudSettings(current, cloudSettings, mergedVessel);

        // A real fleet profile wins over both legacy stores. This is the
        // crux of new-device restore: all dimensions, safety settings, and
        // polars arrive from the selected boat instead of a stale singleton
        // identity row.
        let activeFleet = activeFleetVessel(fleet);
        if (activeFleet) {
            merged = settingsWithFleetVessel(merged, activeFleet);
        } else if (hasMeaningfulVesselProfile(merged.vessel)) {
            // First authenticated connection for a legacy/local profile.
            // Create exactly one cloud vessel; subsequent edits use sparse
            // patches. If offline this simply stays local and retries on the
            // next fleet sync, never discarding the skipper's specs.
            try {
                const created = await bootstrapOwnedVesselProfile(
                    merged.vessel,
                    {
                        vesselUnits: merged.vesselUnits,
                        polarData: merged.polarData,
                        setPolarData: true,
                        polarBoatModel: merged.polarBoatModel,
                        setPolarBoatModel: true,
                        polarSourceType: merged.polarSource_type,
                        setPolarSourceType: true,
                        comfortParams: merged.comfortParams,
                    },
                    scope,
                );
                fleet = { vessels: [created], activeBoatId: created.id };
                fleetLoaded = true;
                activeFleet = created;
                merged = settingsWithFleetVessel(merged, created);
                _addDebugLog('VESSEL FLEET: migrated local vessel to cloud');
            } catch (fleetBootstrapError) {
                log.warn(`[pullFromCloud] fleet bootstrap deferred: ${getErrorMessage(fleetBootstrapError)}`);
            }
        }

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
            if (!isAuthIdentityScopeCurrent(scope)) return;
            merged.defaultLocation = 'Current Location';
        }

        if (!isAuthIdentityScopeCurrent(scope)) return;
        // A fleet action (selection, edit, archive or a manual sync) may
        // have completed while this slow pull was waiting on cloud/GPS work.
        // Preserve that newer in-memory fleet rather than repainting an older
        // server snapshot over the skipper's deliberate choice.
        const newerFleetMutation = fleetMutationGeneration(scope) !== pullFleetGeneration;
        const latestFleetState = useSettingsStore.getState();
        if (newerFleetMutation) {
            const latestFleet: VesselFleet = fleetSnapshot(latestFleetState);
            const latestActive = activeFleetVessel(latestFleet);
            if (latestActive) merged = settingsWithFleetVessel(merged, latestActive);
            fleet = latestFleet;
            activeFleet = latestActive;
            fleetLoaded = false;
        }
        useSettingsStore.setState({
            settings: merged,
            isPro: merged.isPro,
            vesselFleet: fleet.vessels,
            activeVesselId: fleet.activeBoatId,
            vesselFleetStatus: newerFleetMutation
                ? latestFleetState.vesselFleetStatus
                : activeFleet
                  ? 'saved'
                  : fleet.vessels.length > 0
                    ? 'saved'
                    : 'idle',
        });

        // Persist back to Capacitor Preferences so next cold boot is
        // already correct without waiting for the cloud round-trip — and
        // mirror it so the synchronous warm-boot seed reflects the restore.
        writeSettingsMirror(merged, scope);
        await writeSettingsToPreferences(scope, merged);
        if (fleetLoaded) await persistCachedOwnedVesselFleet(fleet, scope, null);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        _addDebugLog(
            activeFleet
                ? `CLOUD PULL OK: active vessel ${activeFleet.profile.name} restored from fleet`
                : 'CLOUD PULL OK: settings merged from legacy profile',
        );
        void manageScreenEffects(merged, scope);

        // ── TWO-WAY reconcile (Shane 2026-07-17: "ensure that when I log in on
        // another device, ALL of the vessel profile info transfers across") ──
        // The pull was ONE-WAY. A vessel onboarded locally while signed OUT —
        // the first-launch default, since onboarding runs before sign-in — went
        // to Capacitor Preferences + vessel_identity (name/type/model) but its
        // wider dimensions (draft, beam, displacement…) live in
        // profiles.settings.vessel, which is only written by syncToCloud on an
        // updateSettings WHILE SIGNED IN. So they never reached the cloud, and a
        // second device (or the web) pulled a draftless profile → routing fell
        // back to the default 2.5 m keel. Now: when the merge ENRICHED the cloud
        // — local carried a keel the cloud row lacked — push the merged settings
        // (which carry the FULL vessel + every other local-only key) back up, so
        // this device and every future one converge on the union. mergeCloudSettings
        // keeps cloud-set values winning, so the push-back can only ADD, never
        // regress a value the cloud already had.
        // Generic cloud settings are still reconciled here, but vessel specs
        // are intentionally excluded by syncToCloud. Fleet bootstrap/patch
        // above is the only authoritative vessel path.
        if (_anonymousAdoptedScopes.has(scope.key)) {
            void syncToCloud(scope, merged).catch((error) => {
                log.warn(`[pullFromCloud] anonymous settings push deferred: ${getErrorMessage(error)}`);
            });
        }
        _anonymousAdoptedScopes.delete(scope.key);

        // ── Welcome-back modal ─────────────────────────────────────
        // Fire ONCE per user per device, ONLY on a fresh-device
        // restore (local Preferences was empty at boot). Otherwise
        // users would see the modal every time they sign out and
        // back in on their primary phone, which would be noise.
        try {
            if (!_localHadPriorData.get(scope.key)) {
                const seenKey = authScopedStorageKey('thalassa_restored_modal_seen', scope);
                const { value: alreadySeen } = await Preferences.get({ key: seenKey });
                if (!isAuthIdentityScopeCurrent(scope)) return;
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
                    if (!isAuthIdentityScopeCurrent(scope)) return;
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
        if (isAuthIdentityScopeCurrent(scope) && typeof window !== 'undefined' && merged.defaultLocation) {
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

async function manageScreenEffects(s: UserSettings, scope: AuthIdentityScope = getAuthIdentityScope()) {
    if (!Capacitor.isNativePlatform() || !isAuthIdentityScopeCurrent(scope)) return;

    try {
        if (!isAuthIdentityScopeCurrent(scope)) return;
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
        if (!isAuthIdentityScopeCurrent(scope)) return;
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
const SETTINGS_MIRROR_QUARANTINE_KEY = `${SETTINGS_MIRROR_KEY}_quarantine_v2`;

function settingsMirrorKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(SETTINGS_MIRROR_KEY, scope);
}

function migrateLegacyMirror(scope: AuthIdentityScope): void {
    try {
        const raw = localStorage.getItem(SETTINGS_MIRROR_KEY);
        if (!raw) return;
        const parsed = parseEnvelope(raw);
        if (parsed.ownerKnown && parsed.ownerUserId === scope.userId && parsed.settings) {
            if (!localStorage.getItem(settingsMirrorKey(scope))) {
                localStorage.setItem(
                    settingsMirrorKey(scope),
                    JSON.stringify(persistedEnvelope(scope, parsed.settings)),
                );
            }
            localStorage.removeItem(SETTINGS_MIRROR_KEY);
            return;
        }
        if (parsed.ownerKnown) return;
        localStorage.setItem(
            SETTINGS_MIRROR_QUARANTINE_KEY,
            JSON.stringify({
                reason: 'unattributed legacy settings mirror',
                quarantined_at: new Date().toISOString(),
                value: raw,
            }),
        );
        localStorage.removeItem(SETTINGS_MIRROR_KEY);
    } catch {
        // A corrupt/unavailable mirror is never authoritative.
    }
}

export function writeSettingsMirror(s: UserSettings, scope: AuthIdentityScope = getAuthIdentityScope()): void {
    try {
        localStorage.setItem(settingsMirrorKey(scope), JSON.stringify(persistedEnvelope(scope, s)));
    } catch {
        /* localStorage full/unavailable — Preferences remains the truth */
    }
}

function removeSettingsMirror(scope: AuthIdentityScope): void {
    try {
        localStorage.removeItem(settingsMirrorKey(scope));
    } catch {
        /* unavailable */
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
export function readSettingsMirrorSync(scope: AuthIdentityScope = getAuthIdentityScope()): UserSettings | null {
    try {
        migrateLegacyMirror(scope);
        const raw = localStorage.getItem(settingsMirrorKey(scope));
        if (!raw) return null;
        const parsed = parseEnvelope(raw);
        if (parsed.ownerKnown && parsed.ownerUserId !== scope.userId) {
            localStorage.setItem(
                SETTINGS_MIRROR_QUARANTINE_KEY,
                JSON.stringify({
                    reason: 'scoped mirror owner mismatch',
                    scoped_key: settingsMirrorKey(scope),
                    value: raw,
                }),
            );
            localStorage.removeItem(settingsMirrorKey(scope));
            return null;
        }
        return parsed.settings;
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
// Writes stay gated by the current scope's authoritative hydration.
const _seedScope = getAuthIdentityScope();
const _seed = readSettingsMirrorSync(_seedScope);
_localHadPriorData.set(_seedScope.key, _seed !== null);

export const useSettingsStore = create<SettingsState>()((set, get) => ({
    settings: _seed ?? DEFAULT_SETTINGS,
    isPro: tierIsPro((_seed ?? DEFAULT_SETTINGS).subscriptionTier),
    loading: _seed === null,
    quotaLimit: DAILY_STORMGLASS_LIMIT,
    vesselFleet: [],
    activeVesselId: null,
    vesselFleetStatus: 'idle',

    syncVesselFleet: async () => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            set({ vesselFleet: [], activeVesselId: null, vesselFleetStatus: 'idle' });
            return;
        }
        const syncMutationGeneration = beginFleetMutation(scope);

        const previous = _fleetSyncTails.get(scope.key) ?? Promise.resolve();
        const run = previous
            .catch(() => undefined)
            .then(async () => {
                if (!isAuthIdentityScopeCurrent(scope)) return;
                set({ vesselFleetStatus: 'loading' });
                try {
                    let fleet = await loadOwnedVesselFleet(scope);
                    if (!isAuthIdentityScopeCurrent(scope)) return;

                    // An active-vessel switch made while offline is allowed
                    // locally (the profile is cached), but it must become the
                    // account-wide selection before any new online work is
                    // published. If that cached boat was archived elsewhere,
                    // the authoritative cloud fleet simply wins below.
                    const cachedFleet = await loadCachedOwnedVesselFleet(scope);
                    const pendingActiveBoatId = cachedFleet?.pendingActiveBoatId ?? null;
                    if (pendingActiveBoatId && fleet.vessels.some((vessel) => vessel.id === pendingActiveBoatId)) {
                        await setActiveOwnedVessel(pendingActiveBoatId, scope);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                        fleet = await loadOwnedVesselFleet(scope);
                        if (!isAuthIdentityScopeCurrent(scope)) return;
                    }

                    // A local/offline onboarding profile gets one safe
                    // bootstrap attempt when a signed-in cloud connection is
                    // available. We do not manufacture a blank boat merely
                    // because the app was opened before onboarding.
                    const local = get().settings;
                    if (fleet.vessels.length === 0 && hasMeaningfulVesselProfile(local.vessel)) {
                        const created = await bootstrapOwnedVesselProfile(
                            local.vessel,
                            {
                                vesselUnits: local.vesselUnits,
                                polarData: local.polarData,
                                setPolarData: true,
                                polarBoatModel: local.polarBoatModel,
                                setPolarBoatModel: true,
                                polarSourceType: local.polarSource_type,
                                setPolarSourceType: true,
                                comfortParams: local.comfortParams,
                            },
                            scope,
                        );
                        fleet = { vessels: [created], activeBoatId: created.id };
                    }

                    set({ vesselFleetStatus: 'syncing' });
                    // A vessel archived on another device can leave an old
                    // local patch behind. It is no longer a retryable edit,
                    // so remove it before FIFO delivery rather than letting
                    // it block every later vessel's update.
                    await discardQueuedVesselPatchesExcept(
                        fleet.vessels.map((vessel) => vessel.id),
                        scope,
                    );
                    await flushQueuedVesselPatches(scope);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    fleet = await loadOwnedVesselFleet(scope);
                    if (!isAuthIdentityScopeCurrent(scope)) return;

                    if (fleetMutationGeneration(scope) !== syncMutationGeneration) {
                        _addDebugLog('VESSEL FLEET: stale sync yielded to a newer vessel change');
                        return;
                    }

                    const queuedProjection = await fleetWithQueuedLocalPatches(fleet, scope);
                    const fleetForDisplay = queuedProjection.fleet;
                    const active = activeFleetVessel(fleetForDisplay);
                    const nextSettings = active ? settingsWithFleetVessel(get().settings, active) : get().settings;
                    set({
                        settings: nextSettings,
                        vesselFleet: fleetForDisplay.vessels,
                        activeVesselId: fleetForDisplay.activeBoatId,
                        vesselFleetStatus: queuedProjection.pending > 0 ? 'offline' : 'saved',
                    });
                    await persistFleetCompatibilitySettings(scope, nextSettings);
                    await persistCachedOwnedVesselFleet(fleetForDisplay, scope, null);
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                } catch (error) {
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
                    set({ vesselFleetStatus: online ? 'error' : 'offline' });
                    _addDebugLog(`VESSEL FLEET SYNC DEFERRED: ${getErrorMessage(error)}`);
                }
            });
        _fleetSyncTails.set(
            scope.key,
            run.catch(() => undefined),
        );
        await run;
    },

    selectActiveVessel: async (boatId) => {
        const scope = getAuthIdentityScope();
        const current = get();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw new Error('Sign in before selecting a vessel.');
        if (!current.vesselFleet.some((vessel) => vessel.id === boatId))
            throw new Error('That vessel is not in your fleet.');

        // A voyage is pinned at cast-off. Switching the default during a
        // live voyage is therefore prohibited rather than merely hidden in
        // the UI; this protects callers outside VesselTab as well.
        const { ShipLogService } = await import('../services/ShipLogService');
        if (ShipLogService.isTracking()) {
            throw new Error('Finish or pause the current voyage before switching vessels.');
        }
        const selectionMutationGeneration = beginFleetMutation(scope);

        const optimisticFleet = selectActiveOwnedVessel(fleetSnapshot(current), boatId);
        const optimisticActive = activeFleetVessel(optimisticFleet);
        if (!optimisticActive) throw new Error('That vessel is not in your fleet.');
        const optimisticSettings = settingsWithFleetVessel(current.settings, optimisticActive);

        // A cached fleet is enough to safely choose a different yacht while
        // offline. Do this before the RPC so the next passage, diary entry or
        // cast-off on this device uses the skipper's deliberate selection.
        set({
            settings: optimisticSettings,
            vesselFleet: optimisticFleet.vessels,
            activeVesselId: optimisticFleet.activeBoatId,
            vesselFleetStatus: 'syncing',
        });
        await persistFleetCompatibilitySettings(scope, optimisticSettings);
        await persistCachedOwnedVesselFleet(optimisticFleet, scope, boatId);
        try {
            await setActiveOwnedVessel(boatId, scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const fleet = await loadOwnedVesselFleet(scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (fleetMutationGeneration(scope) !== selectionMutationGeneration) return;
            const queuedProjection = await fleetWithQueuedLocalPatches(fleet, scope);
            if (fleetMutationGeneration(scope) !== selectionMutationGeneration) return;
            const active = activeFleetVessel(queuedProjection.fleet);
            if (!active) throw new Error('The selected vessel could not be restored.');
            const nextSettings = settingsWithFleetVessel(get().settings, active);
            set({
                settings: nextSettings,
                vesselFleet: queuedProjection.fleet.vessels,
                activeVesselId: queuedProjection.fleet.activeBoatId,
                vesselFleetStatus: queuedProjection.pending > 0 ? 'offline' : 'saved',
            });
            await persistFleetCompatibilitySettings(scope, nextSettings);
            await persistCachedOwnedVesselFleet(queuedProjection.fleet, scope, null);
        } catch (error) {
            // The local handoff above is already durable. Do not roll it back
            // to an older boat just because this device is temporarily below
            // deck; syncVesselFleet will promote it when cloud contact returns.
            if (isAuthIdentityScopeCurrent(scope) && fleetMutationGeneration(scope) === selectionMutationGeneration) {
                const online = typeof navigator === 'undefined' || navigator.onLine !== false;
                if (online && isTerminalVesselSelectionFailure(error)) {
                    // A cached target can have been archived/removed on
                    // another device. This is not an offline retry: converge
                    // back to the authoritative fleet and clear the pending
                    // selector so it cannot keep failing forever.
                    try {
                        const fleet = await loadOwnedVesselFleet(scope);
                        if (
                            !isAuthIdentityScopeCurrent(scope) ||
                            fleetMutationGeneration(scope) !== selectionMutationGeneration
                        ) {
                            return;
                        }
                        const queuedProjection = await fleetWithQueuedLocalPatches(fleet, scope);
                        const active = activeFleetVessel(queuedProjection.fleet);
                        const nextSettings = active ? settingsWithFleetVessel(get().settings, active) : get().settings;
                        set({
                            settings: nextSettings,
                            vesselFleet: queuedProjection.fleet.vessels,
                            activeVesselId: queuedProjection.fleet.activeBoatId,
                            vesselFleetStatus: 'error',
                        });
                        await persistFleetCompatibilitySettings(scope, nextSettings);
                        await persistCachedOwnedVesselFleet(queuedProjection.fleet, scope, null);
                    } catch {
                        set({ vesselFleetStatus: 'error' });
                    }
                } else {
                    set({ vesselFleetStatus: online ? 'error' : 'offline' });
                }
                _addDebugLog(`VESSEL SWITCH DEFERRED: ${getErrorMessage(error)}`);
            }
        }
    },

    createVesselProfile: async (seed = {}) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Sign in before adding a vessel.');
        }
        const { ShipLogService } = await import('../services/ShipLogService');
        if (ShipLogService.isTracking()) {
            throw new Error('Finish or pause the current voyage before adding another vessel.');
        }
        const createMutationGeneration = beginFleetMutation(scope);
        set({ vesselFleetStatus: 'syncing' });
        try {
            const profile: VesselProfile = { ...defaultVesselProfile(), ...seed };
            const created = await createOwnedVesselProfile(profile, {}, scope);
            await setActiveOwnedVessel(created.id, scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const fleet = await loadOwnedVesselFleet(scope);
            if (fleetMutationGeneration(scope) !== createMutationGeneration) return;
            const queuedProjection = await fleetWithQueuedLocalPatches(fleet, scope);
            if (fleetMutationGeneration(scope) !== createMutationGeneration) return;
            const active = activeFleetVessel(queuedProjection.fleet);
            if (!active) throw new Error('The new vessel could not be selected.');
            const nextSettings = settingsWithFleetVessel(get().settings, active);
            set({
                settings: nextSettings,
                vesselFleet: queuedProjection.fleet.vessels,
                activeVesselId: queuedProjection.fleet.activeBoatId,
                vesselFleetStatus: queuedProjection.pending > 0 ? 'offline' : 'saved',
            });
            await persistFleetCompatibilitySettings(scope, nextSettings);
            await persistCachedOwnedVesselFleet(queuedProjection.fleet, scope, null);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope) && fleetMutationGeneration(scope) === createMutationGeneration) {
                set({ vesselFleetStatus: 'error' });
            }
            throw error;
        }
    },

    archiveVesselProfile: async (boatId) => {
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw new Error('Sign in before archiving a vessel.');
        const { ShipLogService } = await import('../services/ShipLogService');
        if (ShipLogService.isTracking()) {
            throw new Error('Finish or pause the current voyage before archiving a vessel.');
        }
        const archiveMutationGeneration = beginFleetMutation(scope);
        set({ vesselFleetStatus: 'syncing' });
        try {
            await archiveOwnedVessel(boatId, scope);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            const fleet = await loadOwnedVesselFleet(scope);
            if (fleetMutationGeneration(scope) !== archiveMutationGeneration) return;
            const queuedProjection = await fleetWithQueuedLocalPatches(fleet, scope);
            if (fleetMutationGeneration(scope) !== archiveMutationGeneration) return;
            const active = activeFleetVessel(queuedProjection.fleet);
            const nextSettings = active ? settingsWithFleetVessel(get().settings, active) : get().settings;
            set({
                settings: nextSettings,
                vesselFleet: queuedProjection.fleet.vessels,
                activeVesselId: queuedProjection.fleet.activeBoatId,
                vesselFleetStatus: queuedProjection.pending > 0 ? 'offline' : 'saved',
            });
            await persistFleetCompatibilitySettings(scope, nextSettings);
            await persistCachedOwnedVesselFleet(queuedProjection.fleet, scope, null);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope) && fleetMutationGeneration(scope) === archiveMutationGeneration) {
                set({ vesselFleetStatus: 'error' });
            }
            throw error;
        }
    },

    patchActiveVesselProfile: async (input) => {
        const patch = isVesselProfilePatch(input) ? input : { profile: input };
        const scope = getAuthIdentityScope();
        if (scope.userId && isAuthIdentityScopeCurrent(scope)) beginFleetMutation(scope);
        const beforeEdit = get();
        const localSettings = applyPatchLocally(beforeEdit.settings, patch);
        const localActiveId = beforeEdit.activeVesselId;
        const locallyUpdatedFleet = localActiveId
            ? beforeEdit.vesselFleet.map((vessel) =>
                  vessel.id === localActiveId ? applyPatchToFleetVessel(vessel, patch) : vessel,
              )
            : beforeEdit.vesselFleet;
        // Local-first keeps the form responsive and protects a change made
        // below deck. The queue is scoped to the account, so this can never
        // replay into the next person who signs in on the same device.
        set({ settings: localSettings, vesselFleet: locallyUpdatedFleet, vesselFleetStatus: 'syncing' });
        await persistFleetCompatibilitySettings(scope, localSettings);
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            set({ vesselFleetStatus: 'offline' });
            return;
        }
        if (localActiveId) {
            await persistCachedOwnedVesselFleet({ vessels: locallyUpdatedFleet, activeBoatId: localActiveId }, scope);
        }

        // Pin this patch to the vessel that was selected when the skipper
        // made the edit. A selector tap while a debounced text save is in
        // flight must never redirect Boat A's draft/polars into Boat B.
        let activeId = localActiveId;
        if (!activeId) {
            await get().syncVesselFleet();
            activeId = get().activeVesselId;
        }

        // A first profile edit immediately after authenticated onboarding
        // may beat the initial pull. Bootstrap with the complete local
        // snapshot instead of dropping that edit or creating a partial boat.
        if (!activeId) {
            try {
                const created = await bootstrapOwnedVesselProfile(
                    localSettings.vessel ?? defaultVesselProfile(),
                    {
                        vesselUnits: localSettings.vesselUnits,
                        polarData: localSettings.polarData,
                        setPolarData: true,
                        polarBoatModel: localSettings.polarBoatModel,
                        setPolarBoatModel: true,
                        polarSourceType: localSettings.polarSource_type,
                        setPolarSourceType: true,
                        comfortParams: localSettings.comfortParams,
                    },
                    scope,
                );
                await setActiveOwnedVessel(created.id, scope);
                if (!isAuthIdentityScopeCurrent(scope)) return;
                const fleet = await loadOwnedVesselFleet(scope);
                const active = activeFleetVessel(fleet);
                const nextSettings = active ? settingsWithFleetVessel(localSettings, active) : localSettings;
                set({
                    settings: nextSettings,
                    vesselFleet: fleet.vessels,
                    activeVesselId: fleet.activeBoatId,
                    vesselFleetStatus: 'saved',
                });
                await persistFleetCompatibilitySettings(scope, nextSettings);
                await persistCachedOwnedVesselFleet(fleet, scope, null);
            } catch (error) {
                if (isAuthIdentityScopeCurrent(scope)) set({ vesselFleetStatus: 'offline' });
                _addDebugLog(`VESSEL FLEET BOOTSTRAP DEFERRED: ${getErrorMessage(error)}`);
            }
            return;
        }

        const active = get().vesselFleet.find((vessel) => vessel.id === activeId);
        const result = await patchOwnedVesselProfile(
            { boatId: activeId, patch, revision: active?.revision ?? null },
            scope,
        );
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (result.value) {
            const afterSave = get();
            const updatedFleet = afterSave.vesselFleet.map((vessel) =>
                vessel.id === activeId ? { ...result.value!, is_active: vessel.is_active } : vessel,
            );
            const selected =
                updatedFleet.find((vessel) => vessel.id === afterSave.activeVesselId) ??
                updatedFleet.find((vessel) => vessel.id === activeId) ??
                result.value;
            const nextSettings = settingsWithFleetVessel(afterSave.settings, selected);
            set({ settings: nextSettings, vesselFleet: updatedFleet, vesselFleetStatus: 'saved' });
            await persistFleetCompatibilitySettings(scope, nextSettings);
            await persistCachedOwnedVesselFleet(
                { vessels: updatedFleet, activeBoatId: afterSave.activeVesselId },
                scope,
            );
        } else {
            // The local snapshot is already durable. Keep the status honest
            // and let online/foreground synchronization replay the patch.
            if (result.queued) {
                // A selection/sync may have refreshed the cloud fleet while
                // this request was failing. Re-apply the queued edit to its
                // original boat so Boat A's offline draft is not visually or
                // durably lost merely because the skipper moved to Boat B.
                const afterQueue = get();
                const queuedFleet = afterQueue.vesselFleet.map((vessel) =>
                    vessel.id === activeId ? applyPatchToFleetVessel(vessel, patch) : vessel,
                );
                set({ vesselFleet: queuedFleet, vesselFleetStatus: 'offline' });
                await persistCachedOwnedVesselFleet(
                    { vessels: queuedFleet, activeBoatId: afterQueue.activeVesselId },
                    scope,
                );
            } else {
                set({ vesselFleetStatus: 'error' });
            }
            if (result.error) _addDebugLog(`VESSEL PROFILE QUEUED: ${getErrorMessage(result.error)}`);
        }
    },

    _setUserId: (id) => {
        _userId = id;
        const scope = getAuthIdentityScope();
        if (!id || scope.userId !== id || _lastCloudPullGeneration === scope.generation) return;
        _lastCloudPullGeneration = scope.generation;
        const localLoad = _scopeLoadPromises.get(scope.key) ?? Promise.resolve();
        void localLoad.then(() => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            return pullFromCloud(scope).finally(() => {
                if (isAuthIdentityScopeCurrent(scope)) void useSettingsStore.getState().syncVesselFleet();
            });
        });
    },

    updateSettings: async (patch) => {
        // Gate on hydration, not the paint `loading` flag — the sync seed
        // makes loading=false early, but writes must still wait for the
        // authoritative load so they can't be clobbered by it (the
        // cold-boot race this guard has always protected).
        const scope = getAuthIdentityScope();
        if (_hydratedScopeKey !== scope.key) return;

        const updated = { ...get().settings, ...patch };
        // Keep isPro in sync with subscriptionTier
        updated.isPro = tierIsPro(updated.subscriptionTier);
        set({ settings: updated, isPro: tierIsPro(updated.subscriptionTier) });

        // Keep the desired relay WAN gate locally even if the Pi is absent.
        // PiCacheService reconciles it on the next successful health check,
        // so satellite mode cannot be bypassed by a brief Boat-LAN outage.
        if (Object.prototype.hasOwnProperty.call(patch, 'satelliteMode')) {
            void piCache.setDiaryRelayInternetPolicy(updated.satelliteMode !== true);
        }
        // Mirror first (synchronous) so the very next boot paints this change.
        writeSettingsMirror(updated, scope);

        try {
            await writeSettingsToPreferences(scope, updated);
            if (!isAuthIdentityScopeCurrent(scope)) return;
            if (patch.heroWidgets) {
                _addDebugLog(`SAVE OK: [${patch.heroWidgets.join(', ')}]`);
            } else {
                _addDebugLog('SAVE OK: Settings Updated');
            }
        } catch (err: unknown) {
            _addDebugLog(`SAVE FAIL: ${getErrorMessage(err)}`);
        }

        // Profile-bearing settings travel through the fleet service as
        // field-level patches. Retain the old onSave callers (onboarding and
        // older settings panels) while giving them the new safe behaviour.
        const fleetPatch = profilePatchFromSettingsPatch(patch);
        if (fleetPatch) {
            void get()
                .patchActiveVesselProfile(fleetPatch)
                .catch((error) => {
                    log.warn(`[updateSettings] vessel patch deferred: ${getErrorMessage(error)}`);
                });
        }
        if (scope.userId && _userId === scope.userId) {
            void syncToCloud(scope, updated).catch((error) => {
                log.warn(`[updateSettings] generic cloud sync deferred: ${getErrorMessage(error)}`);
            });
        }
        if (isAuthIdentityScopeCurrent(scope)) void manageScreenEffects(updated, scope);
    },

    togglePro: () => get().updateSettings({ subscriptionTier: 'owner', isPro: true }),

    setTier: (tier) => get().updateSettings({ subscriptionTier: tier, isPro: tierIsPro(tier) }),

    resetSettings: async () => {
        const scope = getAuthIdentityScope();
        if (_hydratedScopeKey !== scope.key) return;
        set({ settings: DEFAULT_SETTINGS });
        // Update the sync mirror BEFORE the reload, or the warm-boot seed
        // would paint the pre-reset settings for a frame.
        writeSettingsMirror(DEFAULT_SETTINGS, scope);
        await writeSettingsToPreferences(scope, DEFAULT_SETTINGS);
        if (isAuthIdentityScopeCurrent(scope)) window.location.reload();
    },
}));

// ── Identity-scoped load + transition ────────────────────────────
async function loadSettings(scope: AuthIdentityScope): Promise<void> {
    try {
        await migrateLegacyPreferences(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const loaded = await readSettingsFromPreferences(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        // The complete fleet lives in its own account-scoped cache. Project
        // its selected profile before the first paint so an offline launch
        // never falls back to a stale singleton `settings.vessel` snapshot.
        const cachedFleet = scope.userId ? await loadCachedOwnedVesselFleet(scope) : null;
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const cachedActive = cachedFleet ? activeFleetVessel(cachedFleet.fleet) : null;
        const cachedFleetState = cachedFleet?.fleet ?? { vessels: [], activeBoatId: null };
        const cachedFleetStatus = cachedFleet?.pendingActiveBoatId ? 'offline' : 'idle';
        if (loaded) {
            // Mark that this device had its own settings on disk
            // before any cloud pull — gates the welcome-back modal so
            // it only fires on true fresh-device restores.
            _localHadPriorData.set(scope.key, true);
            const merged = cachedActive ? settingsWithFleetVessel(loaded, cachedActive) : loaded;

            useSettingsStore.setState({
                settings: merged,
                isPro: tierIsPro(merged.subscriptionTier),
                loading: false,
                vesselFleet: cachedFleetState.vessels,
                activeVesselId: cachedFleetState.activeBoatId,
                vesselFleetStatus: cachedFleetStatus,
            });
            // Refresh the sync mirror with the authoritative (migrated)
            // settings so the next warm boot seeds from the same shape.
            writeSettingsMirror(merged, scope);
            _addDebugLog(`LOADED: [${(merged.heroWidgets ?? []).join(', ')}] from Disk.`);
            void manageScreenEffects(merged, scope);

            // Boot Pi Cache from saved settings (no UI dependency)
            if (isAuthIdentityScopeCurrent(scope)) {
                // Apply the persisted satellite policy before the Pi's first
                // health check/reconciliation. The Pi starts fail-closed, so
                // a restart cannot drain a diary over a satellite link first.
                void piCache.setDiaryRelayInternetPolicy(merged.satelliteMode !== true);
                piCache.boot({
                    piCacheEnabled: merged.piCacheEnabled,
                    piCacheHost: merged.piCacheHost,
                    piCachePort: merged.piCachePort,
                });
            }
        } else {
            _localHadPriorData.set(scope.key, Boolean(_localHadPriorData.get(scope.key) || cachedActive));
            const fallback = cachedActive ? settingsWithFleetVessel(DEFAULT_SETTINGS, cachedActive) : DEFAULT_SETTINGS;
            useSettingsStore.setState({
                settings: fallback,
                isPro: tierIsPro(fallback.subscriptionTier),
                loading: false,
                vesselFleet: cachedFleetState.vessels,
                activeVesselId: cachedFleetState.activeBoatId,
                vesselFleetStatus: cachedFleetStatus,
            });
            if (cachedActive) {
                writeSettingsMirror(fallback, scope);
                await writeSettingsToPreferences(scope, fallback);
                _addDebugLog(`LOADED: active vessel ${cachedActive.profile.name} from offline fleet cache.`);
            } else {
                _addDebugLog('INIT: No Settings Found (Starting Defaults)');
            }
        }
    } catch {
        if (isAuthIdentityScopeCurrent(scope)) {
            useSettingsStore.setState({ loading: false });
            _addDebugLog('ERROR: Native Load Failed');
        }
    } finally {
        // Authoritative load is done (success, no-data, or error) — writes
        // are now safe to accept. Set in `finally` so a Preferences failure
        // can't leave updateSettings permanently dead.
        if (isAuthIdentityScopeCurrent(scope)) {
            _hydratedScopeKey = scope.key;
            useSettingsStore.setState({ loading: false });
        }
    }
}

function beginSettingsScope(scope: AuthIdentityScope, previous: AuthIdentityScope | null): Promise<void> {
    _userId = scope.userId;
    _hydratedScopeKey = null;

    // Privacy fence and warm paint happen synchronously with the auth switch.
    const mirror = readSettingsMirrorSync(scope);
    _localHadPriorData.set(scope.key, mirror !== null);
    const visible = mirror ?? DEFAULT_SETTINGS;
    useSettingsStore.setState({
        settings: visible,
        isPro: tierIsPro(visible.subscriptionTier),
        loading: mirror === null,
        vesselFleet: [],
        activeVesselId: null,
        vesselFleetStatus: 'idle',
    });

    const transition = _scopeTransitionTail.then(async () => {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await migrateLegacyPreferences(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await adoptAnonymousSettingsIfSafe(scope, previous);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        await loadSettings(scope);
    });
    _scopeTransitionTail = transition.catch(() => undefined);
    _scopeLoadPromises.set(scope.key, transition);
    _loadSettingsPromise = transition;
    return transition;
}

subscribeAuthIdentityScope((next, previous) => {
    void beginSettingsScope(next, previous);
});

// The profile outbox is intentionally retried by connectivity/foreground
// events instead of a tight polling loop. This respects satellite/offline
// use while making a change made below deck converge as soon as a normal
// connection returns.
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        void useSettingsStore.getState().syncVesselFleet();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void useSettingsStore.getState().syncVesselFleet();
    });
}

void beginSettingsScope(_seedScope, null);

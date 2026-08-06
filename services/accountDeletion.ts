import { Preferences } from '@capacitor/preferences';

import { createLogger } from '../utils/createLogger';
import { boundedLocalQuarantine, isEmptyLocalValue, removeLocalValuesOwnedBy } from '../utils/localPrivacyRetention';
import { useAuthStore } from '../stores/authStore';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import { clearBoundAppleCredential } from './auth/appleCredentialState';
import { deleteAudio, deletePhoto, isIdbAudio, isIdbPhoto } from './diaryPhotoStore';
import { DATA_CACHE_KEY, deleteLargeData, HISTORY_CACHE_KEY, VOYAGE_CACHE_KEY } from './nativeStorage';
import { PushNotificationService } from './PushNotificationService';
import { setUser as setSentryUser } from './sentry';
import { supabase } from './supabase';
import { initLocalDatabase, purgeLocalDatabaseForUser } from './vessel/LocalDatabase';
import {
    ACCOUNT_DELETION_PUBLIC_BETA_ENABLED,
    ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE,
} from './accountDeletionPublicBetaBoundary';

const log = createLogger('accountDeletion');

export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE';
const LOCAL_MEDIA_REFERENCE_PATTERN = /\bidb(?:-audio)?:[A-Za-z0-9._-]+/g;
const SAFETY_RECOVERY_KEY_PREFIXES = ['thalassa_mob_active_v1', 'thalassa_anchor_watch_state'] as const;

/** Historical global browser keys that may still contain explicitly owned rows. */
const LEGACY_BROWSER_OWNED_JSON_KEYS = [
    'thalassa_settings_mirror',
    'thalassa_diary_entries_v2',
    'thalassa_diary_pending_v2',
    'thalassa_diary_deleted_v1',
    'thalassa_diary_idmap_v1',
] as const;
const BROWSER_QUARANTINE_KEYS = ['thalassa_settings_mirror_quarantine_v2', 'thalassa_diary_quarantine_v1'] as const;
const GLOBAL_POINT_WEATHER_CACHE_PREFIX = 'marine_weather_cache_';
const RETIRED_LAST_MARINE_REPORT_KEY = 'last_marine_report';
const SCOPED_NATIVE_WEATHER_CACHE_BASE_KEYS = [
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
    HISTORY_CACHE_KEY,
    'thalassa_next_update',
    'thalassa_weather_cache_schema',
] as const;

/** Historical native Preferences keys retained only for owner-safe migration. */
const LEGACY_NATIVE_OWNED_JSON_KEYS = [
    'thalassa_settings',
    'thalassa_settings_anonymous_claim_v1',
    'ship_log_offline_queue',
    'ship_log_deleted_voyages',
    'ship_log_deleted_entries',
    'ship_log_voyage_archive_intents',
    'ship_log_offline_queue_dead_letters',
    'chat_offline_queue',
] as const;
const NATIVE_QUARANTINE_KEYS = [
    'thalassa_settings_quarantine_v2',
    'ship_log_offline_queue_quarantine_v2',
    'chat_offline_queue_quarantine_v2',
] as const;
/** Unowned v1 secrets are never safe to migrate and are retired on sight. */
const NATIVE_UNOWNED_SECRET_KEYS = [
    'calypso:gmail:access_token',
    'calypso:gmail:refresh_token',
    'calypso:gmail:token_expiry',
    'calypso:gmail:email',
    'calypso:gmail:pkce_verifier',
    'calypso:gmail:oauth_state',
] as const;

export interface AccountDeletionResult {
    deleted: true;
    localCleanupComplete: boolean;
    /** Apple token was not retained, so Apple documents manual consent removal. */
    appleRevocationRequired: boolean;
    /** Auth deletion succeeded but the minimal server tombstone needs an
     * operational repair checkpoint. Local identity cleanup must still run. */
    serverFinalizationPending?: boolean;
}

function collectMediaReferences(value: string | null | undefined, references: Set<string>): void {
    if (!value) return;
    for (const match of value.matchAll(LOCAL_MEDIA_REFERENCE_PATTERN)) references.add(match[0]);
}

function isSafetyRecoveryKey(key: string, suffix: string): boolean {
    return SAFETY_RECOVERY_KEY_PREFIXES.some((prefix) => key === `${prefix}${suffix}`);
}

function purgeWebStorage(storage: Storage | undefined, suffix: string, references: Set<string>): void {
    if (!storage) return;
    try {
        const matchingKeys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.endsWith(suffix) && !isSafetyRecoveryKey(key, suffix)) matchingKeys.push(key);
        }
        for (const key of matchingKeys) {
            collectMediaReferences(storage.getItem(key), references);
            storage.removeItem(key);
        }
    } catch (error) {
        throw new Error(`Could not clear browser account data: ${String(error)}`);
    }
}

/** Coordinate weather caches are deliberately global, so a user suffix is
 * not sufficient evidence for retaining them after successful deletion. */
function purgeGlobalPointWeatherCaches(storage: Storage | undefined): void {
    if (!storage) return;
    try {
        const matchingKeys: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key && (key.startsWith(GLOBAL_POINT_WEATHER_CACHE_PREFIX) || key === RETIRED_LAST_MARINE_REPORT_KEY)) {
                matchingKeys.push(key);
            }
        }
        for (const key of matchingKeys) storage.removeItem(key);
    } catch (error) {
        throw new Error(`Could not clear global point weather caches: ${String(error)}`);
    }
}

async function purgeScopedNativeWeatherCaches(scope: AuthIdentityScope): Promise<void> {
    await Promise.all(
        SCOPED_NATIVE_WEATHER_CACHE_BASE_KEYS.map((baseKey) => deleteLargeData(authScopedStorageKey(baseKey, scope))),
    );
}

async function purgeNativePreferences(suffix: string, references: Set<string>): Promise<void> {
    const { keys } = await Preferences.keys();
    for (const key of keys.filter(
        (candidate) => candidate.endsWith(suffix) && !isSafetyRecoveryKey(candidate, suffix),
    )) {
        const { value } = await Preferences.get({ key });
        collectMediaReferences(value, references);
        await Preferences.remove({ key });
    }
}

function scrubOwnedJson(
    raw: string,
    userId: string,
    quarantine: boolean,
    references: Set<string>,
): { serialized: string | null; changed: boolean } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        if (!quarantine) return { serialized: raw, changed: false };
        // An unreadable non-replayable quarantine has no owner evidence. Keep
        // it briefly for diagnostics, but give it a real finite retention age.
        parsed = {
            quarantined_at: new Date().toISOString(),
            reason: 'unreadable legacy quarantine payload',
            unreadable_payload: raw,
        };
    }

    const scrubbed = removeLocalValuesOwnedBy(parsed, userId);
    for (const removed of scrubbed.removed) collectMediaReferences(JSON.stringify(removed), references);
    const retained = quarantine ? boundedLocalQuarantine(scrubbed.value) : scrubbed.value;
    const serialized = isEmptyLocalValue(retained) ? null : JSON.stringify(retained);
    return { serialized, changed: scrubbed.changed || serialized !== raw };
}

function purgeLegacyBrowserValues(storage: Storage | undefined, userId: string, references: Set<string>): void {
    if (!storage) return;
    try {
        const processKey = (key: string, quarantine: boolean) => {
            const raw = storage.getItem(key);
            if (raw === null) return;
            const scrubbed = scrubOwnedJson(raw, userId, quarantine, references);
            if (!scrubbed.changed) return;
            if (scrubbed.serialized === null) storage.removeItem(key);
            else storage.setItem(key, scrubbed.serialized);
        };
        LEGACY_BROWSER_OWNED_JSON_KEYS.forEach((key) => processKey(key, false));
        BROWSER_QUARANTINE_KEYS.forEach((key) => processKey(key, true));

        // DocumentSync v1 encoded the identity after a colon rather than the
        // shared `::user:*` suffix. It has exact key-level owner evidence.
        storage.removeItem(`thalassa_doc_sync_status:${encodeURIComponent(userId)}`);
    } catch (error) {
        throw new Error(`Could not clear legacy browser account data: ${String(error)}`);
    }
}

async function purgeLegacyNativeValues(userId: string, references: Set<string>): Promise<void> {
    const processKey = async (key: string, quarantine: boolean) => {
        const { value } = await Preferences.get({ key });
        if (value === null) return;
        const scrubbed = scrubOwnedJson(value, userId, quarantine, references);
        if (!scrubbed.changed) return;
        if (scrubbed.serialized === null) await Preferences.remove({ key });
        else await Preferences.set({ key, value: scrubbed.serialized });
    };
    for (const key of LEGACY_NATIVE_OWNED_JSON_KEYS) await processKey(key, false);
    for (const key of NATIVE_QUARANTINE_KEYS) await processKey(key, true);
    for (const key of NATIVE_UNOWNED_SECRET_KEYS) await Preferences.remove({ key });
}

async function purgeReferencedMedia(references: ReadonlySet<string>): Promise<void> {
    await Promise.all(
        [...references].map((reference) => {
            if (isIdbAudio(reference)) return deleteAudio(reference);
            if (isIdbPhoto(reference)) return deletePhoto(reference);
            return Promise.resolve();
        }),
    );
}

/**
 * Delete the authenticated account remotely, then remove every identity-scoped
 * local copy. Remote deletion is deliberately first: a network failure must
 * never sign the sailor out while leaving a still-live account behind.
 */
export async function deleteCurrentAccount(confirmation: string): Promise<AccountDeletionResult> {
    // This must remain the first runtime gate. The reviewed implementation is
    // intentionally retained behind it, but a production beta must never reach
    // confirmation handling, safety-state reads, or the live destructive Edge
    // Function until the committed release profile explicitly enables it.
    if (!ACCOUNT_DELETION_PUBLIC_BETA_ENABLED) {
        throw new Error(ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE);
    }
    if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
        throw new Error(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm permanent account deletion.`);
    }
    if (!supabase) throw new Error('Account deletion is unavailable because cloud services are not configured.');

    const deletionScope = getAuthIdentityScope();
    const userId = deletionScope.userId;
    const accountUser = useAuthStore.getState().user;
    if (!userId || accountUser?.id !== userId) {
        throw new Error('Sign in again before deleting your account.');
    }
    // This must precede the irreversible Edge call. A live physical safety
    // monitor remains recoverable through involuntary auth loss, but deliberate
    // deletion requires the skipper to clear it explicitly first.
    const { assertNoActiveSafetyMonitor } = await import('./activeSafetyInterlock');
    await assertNoActiveSafetyMonitor('delete this account');
    const isAppleAccount =
        accountUser.app_metadata?.provider === 'apple' ||
        accountUser.identities?.some((identity) => identity.provider === 'apple') === true;

    const { data, error } = await supabase.functions.invoke('delete-account', {
        body: { confirmation: ACCOUNT_DELETION_CONFIRMATION },
    });
    if (data?.deletionInProgress === true) {
        throw new Error(
            typeof data.message === 'string'
                ? data.message
                : 'Account deletion is safely in progress. Some data may already be removed; retry to continue.',
        );
    }
    if (error || data?.deleted !== true) {
        throw new Error(
            'Account deletion could not be confirmed complete. If it started, some data may already be removed and the account is write-fenced. Check your connection and retry safely.',
        );
    }
    // The server knows whether it successfully revoked a retained refresh
    // token. The provider fallback preserves the manual TN3194 instruction
    // during a rolling deployment where an older function has no result flag.
    const appleRevocationRequired =
        typeof data.appleRevocationRequired === 'boolean' ? data.appleRevocationRequired : isAppleAccount;

    const stillCurrent = isAuthIdentityScopeCurrent(deletionScope) && useAuthStore.getState().user?.id === userId;
    if (stillCurrent) {
        // Hide the deleted identity synchronously before any local cleanup can
        // yield to a render, timer, or background sync callback.
        setAuthIdentityScope(null);
        useAuthStore.setState({ user: null, authChecked: true });
        setSentryUser(null);
    } else {
        // A newer login won the race. Ensure that identity has completed its
        // own database transition before explicitly deleting only old files.
        const currentIdentity = getAuthIdentityScope().userId;
        await initLocalDatabase(currentIdentity).catch((cleanupError) => {
            log.warn('Could not confirm the newer local database scope before old-account cleanup:', cleanupError);
        });
    }

    let localCleanupComplete = true;
    const references = new Set<string>();
    const suffix = `::${encodeURIComponent(`user:${userId}`)}`;

    try {
        purgeWebStorage(typeof localStorage === 'undefined' ? undefined : localStorage, suffix, references);
        purgeWebStorage(typeof sessionStorage === 'undefined' ? undefined : sessionStorage, suffix, references);
        purgeGlobalPointWeatherCaches(typeof localStorage === 'undefined' ? undefined : localStorage);
        purgeGlobalPointWeatherCaches(typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
        purgeLegacyBrowserValues(typeof localStorage === 'undefined' ? undefined : localStorage, userId, references);
        purgeLegacyBrowserValues(
            typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
            userId,
            references,
        );
        await purgeNativePreferences(suffix, references);
        await purgeLegacyNativeValues(userId, references);
        await purgeScopedNativeWeatherCaches(deletionScope);
        const databaseReferences = await purgeLocalDatabaseForUser(userId);
        databaseReferences.forEach((reference) => references.add(reference));
        await purgeReferencedMedia(references);
    } catch (cleanupError) {
        localCleanupComplete = false;
        log.error(
            'The cloud account was deleted, but some unreachable device cache could not be removed:',
            cleanupError,
        );
    }

    if (stillCurrent) {
        const results = await Promise.allSettled([
            PushNotificationService.clearUser(),
            clearBoundAppleCredential(),
            supabase.auth.signOut({ scope: 'local' }),
            initLocalDatabase(null),
        ]);
        if (results.some((result) => result.status === 'rejected')) {
            localCleanupComplete = false;
            log.warn('One or more post-deletion identity cleanup operations failed');
        }
        // Auth callbacks may run during local sign-out; enforce the terminal
        // deleted state once more after those callbacks settle.
        setAuthIdentityScope(null);
        setSentryUser(null);
        useAuthStore.setState({ user: null, authChecked: true });
    }

    return {
        deleted: true,
        localCleanupComplete,
        appleRevocationRequired,
        ...(data.serverFinalizationPending === true ? { serverFinalizationPending: true } : {}),
    };
}

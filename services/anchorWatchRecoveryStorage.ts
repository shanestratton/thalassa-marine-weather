import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { authScopedStorageKey, type AuthIdentityScope } from './authIdentityScope';

export const ANCHOR_WATCH_LEGACY_STATE_KEY = 'thalassa_anchor_watch_state';
export const ANCHOR_WATCH_DEVICE_RECOVERY_KEY = 'thalassa_anchor_watch_device_recovery_v1';

interface AnchorWatchStoragePlugin {
    get(options: { slot: 'device' | 'scoped'; identityKey?: string }): Promise<{ value: string | null }>;
    set(options: { slot: 'device' | 'scoped'; identityKey?: string; value: string }): Promise<void>;
    remove(options: { slot: 'device' | 'scoped'; identityKey?: string }): Promise<void>;
    clearScoped(): Promise<void>;
}

export interface AnchorWatchRecoveryRead {
    raw: string;
    deviceRecovery: boolean;
}

const NativeAnchorWatchStorage = registerPlugin<AnchorWatchStoragePlugin>('AnchorWatchStorage');
const SCOPED_LEGACY_PREFIX = `${ANCHOR_WATCH_LEGACY_STATE_KEY}::`;
const MAX_IDENTITY_BYTES = 256;
let operationTail: Promise<void> = Promise.resolve();

function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = operationTail;
    let release!: () => void;
    operationTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    return previous
        .catch(() => undefined)
        .then(operation)
        .finally(release);
}

function usesNativeAnchorWatchStorage(): boolean {
    return Capacitor.getPlatform() === 'ios';
}

function assertIdentityKey(identityKey: string): void {
    const bytes = new TextEncoder().encode(identityKey).byteLength;
    const validOwner = identityKey === 'anonymous' || (identityKey.startsWith('user:') && identityKey.length > 5);
    const hasControlCharacter = [...identityKey].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
    });
    if (!validOwner || bytes > MAX_IDENTITY_BYTES || hasControlCharacter) {
        throw new Error('Anchor Watch recovery identity is invalid.');
    }
}

function localStorageKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) keys.push(key);
    }
    return keys;
}

function isReviewedLegacyKey(key: string): boolean {
    return (
        key === ANCHOR_WATCH_DEVICE_RECOVERY_KEY ||
        key === ANCHOR_WATCH_LEGACY_STATE_KEY ||
        key.startsWith(SCOPED_LEGACY_PREFIX)
    );
}

function identityFromScopedLegacyKey(key: string): string | null {
    if (!key.startsWith(SCOPED_LEGACY_PREFIX)) return null;
    try {
        const identityKey = decodeURIComponent(key.slice(SCOPED_LEGACY_PREFIX.length));
        assertIdentityKey(identityKey);
        return identityKey;
    } catch {
        return null;
    }
}

async function nativeGet(slot: 'device' | 'scoped', identityKey?: string): Promise<string | null> {
    if (identityKey) assertIdentityKey(identityKey);
    const { value } = await NativeAnchorWatchStorage.get({ slot, identityKey });
    return value ?? null;
}

async function nativeSetVerified(slot: 'device' | 'scoped', value: string, identityKey?: string): Promise<void> {
    if (identityKey) assertIdentityKey(identityKey);
    await NativeAnchorWatchStorage.set({ slot, identityKey, value });
    const verified = await nativeGet(slot, identityKey);
    if (verified !== value) throw new Error('Anchor Watch secure recovery write could not be verified.');
}

async function nativeRemoveVerified(slot: 'device' | 'scoped', identityKey?: string): Promise<void> {
    if (identityKey) assertIdentityKey(identityKey);
    await NativeAnchorWatchStorage.remove({ slot, identityKey });
    if ((await nativeGet(slot, identityKey)) !== null) {
        throw new Error('Anchor Watch secure recovery removal could not be verified.');
    }
}

async function nativeClearScopedVerified(identityKey: string): Promise<void> {
    assertIdentityKey(identityKey);
    await NativeAnchorWatchStorage.clearScoped();
    if ((await nativeGet('scoped', identityKey)) !== null) {
        throw new Error('Anchor Watch scoped recovery removal could not be verified.');
    }
}

async function readPreferencesLegacy(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key });
    return value ?? null;
}

async function removeLegacyKeyRequired(key: string): Promise<void> {
    await Preferences.remove({ key });
    localStorage.removeItem(key);
    const [native, browser] = await Promise.all([
        readPreferencesLegacy(key),
        Promise.resolve(localStorage.getItem(key)),
    ]);
    if (native !== null || browser !== null) {
        throw new Error('Anchor Watch plaintext recovery cleanup could not be verified.');
    }
}

async function reviewedLegacyKeys(): Promise<Set<string>> {
    const preferenceKeys = (await Preferences.keys()).keys;
    return new Set([...localStorageKeys(), ...preferenceKeys].filter((key) => isReviewedLegacyKey(key)));
}

/**
 * Moves every attributable legacy Anchor Watch record out of browser storage
 * and Preferences. A secure record is always read-verified before its
 * plaintext source is deleted. The old unscoped record has no safe owner and
 * is retired rather than adopted by whichever account happens to launch next.
 */
async function migrateNativeLegacyRecords(): Promise<void> {
    const reviewed = await reviewedLegacyKeys();

    if (reviewed.has(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)) {
        const browser = localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
        const preference = await readPreferencesLegacy(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
        const legacy = browser ?? preference;
        if (legacy !== null && (await nativeGet('device')) === null) {
            await nativeSetVerified('device', legacy);
        }
        await removeLegacyKeyRequired(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
    }

    for (const key of reviewed) {
        if (!key.startsWith(SCOPED_LEGACY_PREFIX)) continue;
        const identityKey = identityFromScopedLegacyKey(key);
        if (!identityKey) {
            // An invalid namespace cannot be restored safely. Remove the
            // precise location instead of assigning it to the current user.
            await removeLegacyKeyRequired(key);
            continue;
        }
        const browser = localStorage.getItem(key);
        const preference = await readPreferencesLegacy(key);
        const legacy = browser ?? preference;
        if (legacy !== null && (await nativeGet('scoped', identityKey)) === null) {
            await nativeSetVerified('scoped', legacy, identityKey);
        }
        await removeLegacyKeyRequired(key);
    }

    if (reviewed.has(ANCHOR_WATCH_LEGACY_STATE_KEY)) {
        await removeLegacyKeyRequired(ANCHOR_WATCH_LEGACY_STATE_KEY);
    }
}

export async function readAnchorWatchRecovery(scope: AuthIdentityScope): Promise<AnchorWatchRecoveryRead | null> {
    return runExclusive(async () => {
        if (!usesNativeAnchorWatchStorage()) {
            const device = localStorage.getItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
            if (device !== null) return { raw: device, deviceRecovery: true };
            const scoped = localStorage.getItem(authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, scope));
            return scoped === null ? null : { raw: scoped, deviceRecovery: false };
        }

        assertIdentityKey(scope.key);
        await migrateNativeLegacyRecords();
        const device = await nativeGet('device');
        if (device !== null) return { raw: device, deviceRecovery: true };
        const scoped = await nativeGet('scoped', scope.key);
        return scoped === null ? null : { raw: scoped, deviceRecovery: false };
    });
}

/** Presence check used before deliberate sign-out/account deletion. */
export async function hasAnchorWatchRecovery(scope: AuthIdentityScope): Promise<boolean> {
    return (await readAnchorWatchRecovery(scope)) !== null;
}

export async function writeAnchorWatchRecovery(scope: AuthIdentityScope, raw: string): Promise<void> {
    return runExclusive(async () => {
        if (!usesNativeAnchorWatchStorage()) {
            localStorage.setItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY, raw);
            localStorage.setItem(authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, scope), raw);
            return;
        }

        assertIdentityKey(scope.key);
        await migrateNativeLegacyRecords();
        // The device envelope is authoritative and lands first. If the
        // scoped rollover or secondary write fails, crash recovery still has
        // the current record. Removing every older scope prevents a stopped
        // account A watch from resurfacing after account B has armed one.
        await nativeSetVerified('device', raw);
        await nativeClearScopedVerified(scope.key);
        await nativeSetVerified('scoped', raw, scope.key);
    });
}

export async function clearAnchorWatchRecovery(scope: AuthIdentityScope): Promise<void> {
    return runExclusive(async () => {
        if (!usesNativeAnchorWatchStorage()) {
            localStorage.removeItem(authScopedStorageKey(ANCHOR_WATCH_LEGACY_STATE_KEY, scope));
            localStorage.removeItem(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
            return;
        }

        assertIdentityKey(scope.key);
        const reviewed = await reviewedLegacyKeys();
        // This is an explicit Weigh Anchor, not a restore. Retire corrupt or
        // oversized legacy records directly so a value that cannot migrate can
        // never make strict clear impossible. Keep both forms of the device
        // envelope until every scoped record is confirmed gone.
        for (const key of reviewed) {
            if (key !== ANCHOR_WATCH_DEVICE_RECOVERY_KEY) await removeLegacyKeyRequired(key);
        }
        await nativeClearScopedVerified(scope.key);
        if (reviewed.has(ANCHOR_WATCH_DEVICE_RECOVERY_KEY)) {
            await removeLegacyKeyRequired(ANCHOR_WATCH_DEVICE_RECOVERY_KEY);
        }
        await nativeRemoveVerified('device');
    });
}

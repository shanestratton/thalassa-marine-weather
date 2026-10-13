import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
    remove(options: { key: string }): Promise<void>;
}

// Registered on first use, so importing this module has no side effect: the
// Pi's chart token (PiPairingService) brings it into modules and tests that
// never touch the Keychain.
let nativeSecureStorage: SecureStoragePlugin | undefined;
const NativeSecureStorage = () => (nativeSecureStorage ??= registerPlugin<SecureStoragePlugin>('SecureStorage'));

/** Exact storage keys used by the installed Supabase Auth client. */
export const SECURE_AUTH_STORAGE_KEYS = [
    'thalassa-auth-session',
    'thalassa-auth-session-code-verifier',
    'thalassa-auth-session-user',
] as const;

/**
 * This phone's token for the boat Pi's chart vault (127-C-d). Not an auth key:
 * Supabase's migration and orphan purge walk SECURE_AUTH_STORAGE_KEYS, never this.
 */
export const SECURE_PI_CHART_DEVICE_KEY = 'thalassa-pi-chart-device';

/**
 * Every key the native plugin accepts, and the one list the guard below is
 * built from: tests/SecureStorageAllowlist.test.ts holds it equal to
 * SecureStoragePlugin.swift's allowedKeys.
 */
export const SECURE_STORAGE_KEYS: readonly string[] = [...SECURE_AUTH_STORAGE_KEYS, SECURE_PI_CHART_DEVICE_KEY];

const secureStorageKeySet = new Set(SECURE_STORAGE_KEYS);

function assertSecureStorageKey(key: string): void {
    if (!secureStorageKeySet.has(key)) throw new Error('Secure-storage key is not allowed');
}

export function usesNativeSecureStorage(): boolean {
    return Capacitor?.getPlatform?.() === 'ios';
}

export async function getSecureValue(key: string): Promise<string | null> {
    assertSecureStorageKey(key);
    const { value } = await NativeSecureStorage().get({ key });
    return value ?? null;
}

export async function setSecureValue(key: string, value: string): Promise<void> {
    assertSecureStorageKey(key);
    await NativeSecureStorage().set({ key, value });
}

export async function removeSecureValue(key: string): Promise<void> {
    assertSecureStorageKey(key);
    await NativeSecureStorage().remove({ key });
}

import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
    remove(options: { key: string }): Promise<void>;
}

const NativeSecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

/** Exact storage keys used by the installed Supabase Auth client. */
export const SECURE_AUTH_STORAGE_KEYS = [
    'thalassa-auth-session',
    'thalassa-auth-session-code-verifier',
    'thalassa-auth-session-user',
] as const;

const secureAuthStorageKeySet = new Set<string>(SECURE_AUTH_STORAGE_KEYS);

function assertSecureAuthStorageKey(key: string): void {
    if (!secureAuthStorageKeySet.has(key)) throw new Error('Secure auth-storage key is not allowed');
}

export function usesNativeSecureStorage(): boolean {
    return Capacitor.getPlatform() === 'ios';
}

export async function getSecureValue(key: string): Promise<string | null> {
    assertSecureAuthStorageKey(key);
    const { value } = await NativeSecureStorage.get({ key });
    return value ?? null;
}

export async function setSecureValue(key: string, value: string): Promise<void> {
    assertSecureAuthStorageKey(key);
    await NativeSecureStorage.set({ key, value });
}

export async function removeSecureValue(key: string): Promise<void> {
    assertSecureAuthStorageKey(key);
    await NativeSecureStorage.remove({ key });
}

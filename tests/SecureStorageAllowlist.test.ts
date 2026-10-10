import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as secureStorage from '../services/auth/secureStorage';

// The real wrapper over a stand-in for the native plugin, so the guard that
// actually runs is the one under test (not a copy of it in a mock).
const native = vi.hoisted(() => {
    const store = new Map<string, string>();
    return {
        store,
        plugin: {
            get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
            set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
                store.set(key, value);
            }),
            remove: vi.fn(async ({ key }: { key: string }) => {
                store.delete(key);
            }),
        },
    };
});
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'ios' },
    registerPlugin: () => native.plugin,
}));

/**
 * One allowlist, written twice (127-C-d).
 *
 * The Keychain plugin refuses any key it was not compiled with, and the JS
 * wrapper refuses any key it does not list. If the two lists drift, a key the
 * JS side accepts is rejected natively ("Secure-storage key is not allowed")
 * and the chart device token is never kept: the phone would have to be set up
 * again after every launch, and nothing would say why. So the two lists are
 * compared here, key for key.
 */

const swift = readFileSync(join(process.cwd(), 'ios/App/App/SecureStoragePlugin.swift'), 'utf8');

function swiftAllowedKeys(): string[] {
    const start = swift.indexOf('private let allowedKeys: Set<String> = [');
    expect(start, 'SecureStoragePlugin.swift declares allowedKeys').toBeGreaterThan(-1);
    const body = swift.slice(start, swift.indexOf(']', start));
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe('the Keychain allowlist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        native.store.clear();
    });

    it('is the same set of keys in services/auth/secureStorage.ts and SecureStoragePlugin.swift', () => {
        const js = [...(secureStorage as { SECURE_STORAGE_KEYS?: readonly string[] }).SECURE_STORAGE_KEYS!].sort();
        expect(swiftAllowedKeys().sort()).toEqual(js);
    });

    it("includes the chart vault's device key, 'thalassa-pi-chart-device'", () => {
        expect(secureStorage.SECURE_STORAGE_KEYS).toContain('thalassa-pi-chart-device');
        expect(swiftAllowedKeys()).toContain('thalassa-pi-chart-device');
    });

    it('keeps the chart key out of the Supabase auth family, which migrates and purges its keys', () => {
        // services/supabase.ts walks SECURE_AUTH_STORAGE_KEYS to migrate
        // plaintext sessions and to retire orphaned bearer records on a fresh
        // install. The chart token is not a session: it must never be swept
        // up by either pass.
        expect(secureStorage.SECURE_AUTH_STORAGE_KEYS).not.toContain('thalassa-pi-chart-device');
    });

    it('stores every key this-device-only (never iCloud Keychain or a backup)', () => {
        expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(swift).not.toMatch(/kSecAttrSynchronizable/);
    });

    it('refuses a key that is on neither list before it reaches the native side', async () => {
        await expect(secureStorage.getSecureValue('thalassa-something-else')).rejects.toThrow(/not allowed/);
        await expect(secureStorage.setSecureValue('thalassa-something-else', 'x')).rejects.toThrow(/not allowed/);
        expect(native.plugin.get).not.toHaveBeenCalled();
        expect(native.plugin.set).not.toHaveBeenCalled();
    });

    it('lets every listed key through the real wrapper to the native plugin, the chart key included', async () => {
        // The guard that runs is built from SECURE_STORAGE_KEYS, the list the
        // Swift side is compared against above. If it were the auth family
        // alone again, the Pi would enrol this phone and the token would then
        // be refused here and lost.
        for (const key of secureStorage.SECURE_STORAGE_KEYS) {
            await secureStorage.setSecureValue(key, `value for ${key}`);
            await expect(secureStorage.getSecureValue(key)).resolves.toBe(`value for ${key}`);
            await secureStorage.removeSecureValue(key);
        }
        expect(native.plugin.set).toHaveBeenCalledWith({
            key: 'thalassa-pi-chart-device',
            value: 'value for thalassa-pi-chart-device',
        });
        expect(native.plugin.get).toHaveBeenCalledWith({ key: 'thalassa-pi-chart-device' });
        expect(native.plugin.remove).toHaveBeenCalledWith({ key: 'thalassa-pi-chart-device' });
        expect(native.store.size).toBe(0);
        expect(secureStorage.usesNativeSecureStorage()).toBe(true);
    });
});

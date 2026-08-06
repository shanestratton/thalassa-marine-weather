import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('iOS secure auth-session storage contract', () => {
    it('stores only the reviewed Supabase auth key family in this-device-only Keychain storage', () => {
        const swift = read('ios/App/App/SecureStoragePlugin.swift');

        expect(swift).toContain('private let allowedKeys: Set<String> = [');
        expect(swift).toContain('"thalassa-auth-session"');
        expect(swift).toContain('"thalassa-auth-session-code-verifier"');
        expect(swift).toContain('"thalassa-auth-session-user"');
        expect(swift).toContain('private let maximumValueBytes = 256 * 1024');
        expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(swift).toContain('SecItemUpdate(');
        expect(swift.indexOf('SecItemUpdate(')).toBeLessThan(swift.indexOf('SecItemAdd('));
        expect(swift).not.toMatch(/try\?\s+remove|SecItemDelete[\s\S]{0,300}SecItemAdd/);
    });

    it('compiles and registers the local plugin in the native bridge', () => {
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');

        expect(project).toContain('SecureStoragePlugin.swift in Sources');
        expect(bridge).toContain('bridge?.registerPluginInstance(SecureStoragePlugin())');
    });

    it('uses Keychain on iOS without a plaintext runtime fallback', () => {
        const adapter = read('services/supabase.ts');
        const secureStorage = read('services/auth/secureStorage.ts');

        expect(adapter).toContain('if (usesNativeSecureStorage())');
        expect(adapter).toContain('for (const storageKey of SECURE_AUTH_STORAGE_KEYS)');
        expect(adapter).toContain('await setSecureValue(key, value)');
        expect(adapter).toContain('await removeSecureValue(key)');
        expect(adapter).toContain('const verified = await getSecureValue(storageKey)');
        expect(adapter).toContain('verified !== legacy');
        expect(adapter).toContain("const SECURE_AUTH_INSTALL_MARKER_KEY = 'thalassa-secure-auth-install-v1'");
        expect(adapter).toContain('await removeSecureValue(storageKey)');
        expect(adapter).toContain('if ((await getSecureValue(storageKey)) !== null)');
        expect(adapter).toContain('if (!secureAuthInstallBoundaryReady) await establishSecureAuthInstallBoundary()');
        expect(adapter).not.toContain('await Preferences.set({ key, value })');
        expect(secureStorage).toContain("'thalassa-auth-session-code-verifier'");
        expect(secureStorage).toContain("'thalassa-auth-session-user'");
        expect(secureStorage).toContain('secureAuthStorageKeySet.has(key)');
    });
});

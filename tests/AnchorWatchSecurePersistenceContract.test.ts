import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Anchor Watch secure persistence release contract', () => {
    it('uses a narrow this-device-only Keychain plugin with reinstall fencing', () => {
        const swift = read('ios/App/App/AnchorWatchStoragePlugin.swift');

        expect(swift).toContain('public let jsName = "AnchorWatchStorage"');
        expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(swift).toContain('kSecAttrSynchronizable as String: false');
        expect(swift).toContain('SHA256.hash');
        expect(swift).toContain('private let maximumValueBytes = 64 * 1024');
        expect(swift).toContain('installMarkerKey');
        expect(swift).toContain('SecItemDelete([');
        expect(swift).toContain('if slot == "device"');
        expect(swift).toContain('guard slot == "scoped"');
        expect(swift).toContain('CAPPluginMethod(name: "clearScoped"');
        expect(swift).toContain('kSecAttrService as String: scopedService');
        expect(swift).not.toContain('Documents');
        expect(swift).not.toContain('iCloud');
    });

    it('compiles and registers the Anchor Watch storage plugin', () => {
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');

        expect(project).toContain('AnchorWatchStoragePlugin.swift in Sources');
        expect(bridge).toContain('bridge?.registerPluginInstance(AnchorWatchStoragePlugin())');
    });

    it('keeps iOS Anchor Watch runtime persistence out of plaintext stores', () => {
        const anchor = read('services/AnchorWatchService.ts');
        const storage = read('services/anchorWatchRecoveryStorage.ts');
        const interlock = read('services/activeSafetyInterlock.ts');

        expect(anchor).toContain('await readAnchorWatchRecovery(currentScope)');
        expect(anchor).toContain('await writeAnchorWatchRecovery(persistenceScope, JSON.stringify(data))');
        expect(anchor).toContain('await clearAnchorWatchRecovery(scope)');
        expect(anchor).not.toContain('localStorage.');
        expect(storage).toContain("Capacitor.getPlatform() === 'ios'");
        expect(storage).toContain("await nativeSetVerified('device', raw)");
        expect(storage).toContain("await nativeSetVerified('scoped', raw, scope.key)");
        expect(storage).toContain('await nativeClearScopedVerified(scope.key)');
        expect(storage).toContain("await nativeRemoveVerified('device')");
        expect(storage).toContain('await Preferences.remove({ key })');
        expect(storage).toContain('localStorage.removeItem(key)');
        expect(storage).not.toContain('Directory.Documents');
        expect(storage).not.toContain('Preferences.set');
        expect(interlock).toContain('hasAnchorWatchRecovery(scope)');
        expect(interlock).not.toContain('localStorage.getItem(ANCHOR_RECOVERY_KEY)');
    });
});

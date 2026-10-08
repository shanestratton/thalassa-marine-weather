/**
 * The Keychain device id's native contract (build 125, 125-12). The Swift is
 * checked with `xcrun swiftc -parse` only (no xcodebuild in this package), so
 * this pins the properties that matter by reading the source: this device
 * only, never synchronised, a hashed account name, a narrow value, and —
 * unlike the Anchor Watch recovery records beside it — OUTSIDE the install
 * boundary, because surviving a reinstall is the whole point.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** The body of one Swift `@objc func name(` up to the next `@objc func` or `private func`. */
function swiftMethod(source: string, name: string): string {
    const start = source.indexOf(`@objc func ${name}(`);
    expect(start, `missing @objc func ${name}`).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const next = rest.search(/\n\s*(@objc func|private func|\/\*\*)/);
    return next === -1 ? rest : rest.slice(0, next);
}

describe('Keychain device identity contract', () => {
    const swift = read('ios/App/App/AnchorWatchStoragePlugin.swift');

    it('registers the two methods on the existing, already-registered plugin', () => {
        expect(swift).toContain('CAPPluginMethod(name: "getDeviceIdentity", returnType: CAPPluginReturnPromise)');
        expect(swift).toContain('CAPPluginMethod(name: "setDeviceIdentity", returnType: CAPPluginReturnPromise)');
        const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
        expect(bridge).toContain('bridge?.registerPluginInstance(AnchorWatchStoragePlugin())');
    });

    it('keeps the id on this device only, never synchronised, under a hashed account name', () => {
        const query = swift.slice(swift.indexOf('private func deviceIdentityQuery('));
        expect(query).toContain('kSecAttrService as String: deviceIdentityService');
        expect(query).toContain('kSecAttrSynchronizable as String: false');
        expect(query).toContain('SHA256.hash(data: Data(deviceIdentityName.utf8))');
        const set = swiftMethod(swift, 'setDeviceIdentity');
        expect(set).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(set.indexOf('SecItemUpdate(')).toBeLessThan(set.indexOf('SecItemAdd('));
        expect(set).toContain('isValidDeviceIdentity(value)');
        expect(swift).toContain('"\\(Bundle.main.bundleIdentifier ?? "com.thalassa.weather").device-identity"');
    });

    it('survives a reinstall: neither method crosses the install boundary, and the boundary never deletes it', () => {
        expect(swiftMethod(swift, 'getDeviceIdentity')).not.toContain('prepareInstallBoundary');
        expect(swiftMethod(swift, 'setDeviceIdentity')).not.toContain('prepareInstallBoundary');
        const boundary = swift.slice(
            swift.indexOf('private func prepareInstallBoundary('),
            swift.indexOf('private func validatedAccount('),
        );
        expect(boundary).not.toContain('deviceIdentityService');
        // The plugin keeps its other promises.
        expect(swift).not.toContain('iCloud');
        expect(swift).not.toContain('Documents');
    });

    it('the JS side reads it through the same bridge, only on iOS, before the claim is compared', () => {
        const storage = read('services/anchorWatchRecoveryStorage.ts');
        expect(storage).toContain('getDeviceIdentity(): Promise<{ value: string | null }>;');
        expect(storage).toContain('setDeviceIdentity(options: { value: string }): Promise<void>;');
        expect(storage).toContain('export async function readNativeDeviceIdentity(');
        expect(storage).toContain('export async function writeNativeDeviceIdentity(');
        const skipper = read('services/skipperDevice.ts');
        expect(skipper).toContain("platformName() === 'ios'");
        expect(skipper).toContain("import('./anchorWatchRecoveryStorage')");
        const trickle = read('services/shiplog/LiveTrickle.ts');
        expect(trickle.indexOf('await deviceIdReady()')).toBeGreaterThan(-1);
        expect(trickle.indexOf('await deviceIdReady()')).toBeLessThan(trickle.indexOf('mayPublish(claim)'));
    });
});

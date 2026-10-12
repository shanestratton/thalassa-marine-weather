import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('iOS encrypted large-storage source contract', () => {
    it('uses bounded AES-GCM records with hashed filenames and logical-key AAD', () => {
        const swift = read('ios/App/App/EncryptedLargeStoragePlugin.swift');

        expect(swift).toContain('import CryptoKit');
        expect(swift).toContain('private let maximumValueBytes = 5 * 1024 * 1024');
        expect(swift).toContain('private let maximumFileCount = 64');
        expect(swift).toContain('private let maximumAggregateBytes = 48 * 1024 * 1024');
        expect(swift).toContain('SHA256.hash(data: Data(key.utf8))');
        expect(swift).toContain('AES.GCM.seal(plaintext, using: symmetricKey, authenticating: Data(key.utf8))');
        expect(swift).toContain('AES.GCM.open(');
        expect(swift).toContain('authenticating: Data(key.utf8)');
        expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
        expect(swift).toContain('kSecAttrSynchronizable as String: false');
    });

    it('keeps encrypted files private, atomic, read-back verified, and out of backup', () => {
        const swift = read('ios/App/App/EncryptedLargeStoragePlugin.swift');

        expect(swift).toContain('for: .applicationSupportDirectory');
        expect(swift).toContain('ThalassaEncryptedLargeStorage');
        expect(swift).toContain('.completeFileProtectionUntilFirstUserAuthentication');
        expect(swift).toContain('FileProtectionType.completeUntilFirstUserAuthentication');
        expect(swift).toContain('values.isExcludedFromBackup = true');
        expect(swift).toContain('options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]');
        expect(swift).toContain('let verifiedEnvelope = try Data(contentsOf: destination');
        expect(swift).toContain('guard verified == plaintext');
        expect(swift).not.toContain('Directory.Documents');
        expect(swift).not.toContain('try!');
    });

    it('fences reinstall/device restore and orders legacy migration write-read-delete', () => {
        const swift = read('ios/App/App/EncryptedLargeStoragePlugin.swift');
        const migrationStart = swift.indexOf('private func migrateLegacyDocument');
        const migration = swift.slice(
            migrationStart,
            swift.indexOf('private func scrubLegacyDocument', migrationStart),
        );

        expect(swift).toContain('installDefaultsKey');
        expect(swift).toContain('installMarkerAccount');
        expect(swift).toContain('let firstRollout = defaultsMarker == nil && keychainMarker == nil');
        expect(swift).toContain('let boundaryMatches = defaultsMarker != nil && defaultsMarker == keychainMarker');
        expect(swift).toContain('try purgeStorageDirectory()');
        expect(swift).toContain('try purgeReviewedLegacyDocuments()');
        expect(migration.indexOf('try writeEncryptedValue(value, for: key)')).toBeGreaterThanOrEqual(0);
        expect(migration.indexOf('guard try readEncryptedValue(key) == value')).toBeGreaterThan(
            migration.indexOf('try writeEncryptedValue(value, for: key)'),
        );
        expect(migration.lastIndexOf('try removeItemStrict(at: legacy)')).toBeGreaterThan(
            migration.indexOf('guard try readEncryptedValue(key) == value'),
        );
    });

    it('is compiled, manually registered, and has no iOS plaintext runtime fallback', () => {
        const project = read('ios/App/App.xcodeproj/project.pbxproj');
        const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
        const typescript = read('services/nativeStorage.ts');

        expect(project).toContain('EncryptedLargeStoragePlugin.swift in Sources');
        expect(bridge).toContain('bridge?.registerPluginInstance(EncryptedLargeStoragePlugin())');
        expect(typescript).toContain("Capacitor.getPlatform() === 'ios'");
        expect(typescript).toContain("registerPlugin<EncryptedLargeStoragePlugin>('EncryptedLargeStorage')");
        expect(typescript).toContain('Never surface the');
        expect(typescript).toContain('old plaintext startup mirror on iOS');
        expect(typescript).toContain('return null;');
    });
});

/**
 * 127-C-c decisions 4 and 5(c): the two chart methods on this plugin. Open
 * (NOAA) cells move out of Documents into Library/Application Support/enc-open,
 * excluded from backup; chart pictures older builds left in WebKit's HTTP
 * cache are purged once. Never local storage, IndexedDB, cookies, or the
 * Fetch Cache (Mapbox's own Cache API store of Mapbox tiles).
 */
describe('iOS chart store methods (127-C-c)', () => {
    const swift = read('ios/App/App/EncryptedLargeStoragePlugin.swift');
    const body = (name: string) => {
        const start = swift.indexOf(`@objc func ${name}(`);
        expect(start, `${name} is an @objc plugin method`).toBeGreaterThan(-1);
        const next = swift.indexOf('@objc func ', start + 10);
        return swift.slice(start, next > -1 ? next : swift.indexOf('// MARK: - Install and device boundary'));
    };

    it('registers prepareChartStore and purgeWebDiskCache as promise methods', () => {
        expect(swift).toContain('CAPPluginMethod(name: "prepareChartStore", returnType: CAPPluginReturnPromise)');
        expect(swift).toContain('CAPPluginMethod(name: "purgeWebDiskCache", returnType: CAPPluginReturnPromise)');
        expect(swift).toContain('import WebKit');
    });

    it('prepareChartStore runs on workQueue, makes enc-open with first-unlock protection and excludes it from backup', () => {
        const method = body('prepareChartStore');
        expect(method).toContain('workQueue.async');
        const onQueue = swift.slice(swift.indexOf('private func prepareChartStoreOnQueue'));
        const fn = onQueue.slice(0, onQueue.indexOf('\n    }\n') + 6);
        expect(fn).toContain('for: .applicationSupportDirectory');
        expect(fn).toContain('"enc-open"');
        expect(fn).toContain('FileProtectionType.completeUntilFirstUserAuthentication');
        expect(fn).toContain('try excludeFromBackup(');
        expect(fn).toContain('"Application Support/enc-open"');
        expect(fn).not.toContain('.documentDirectory');
    });

    it('purgeWebDiskCache names exactly the disk and memory caches and runs on the main queue', () => {
        const method = body('purgeWebDiskCache');
        expect(method).toContain('DispatchQueue.main.async');
        expect(method).toContain('WKWebsiteDataStore.default().removeData(');
        expect(method).toContain('WKWebsiteDataTypeDiskCache');
        expect(method).toContain('WKWebsiteDataTypeMemoryCache');
        expect(method).toContain('modifiedSince: .distantPast');
        for (const never of [
            'WKWebsiteDataTypeLocalStorage',
            'WKWebsiteDataTypeIndexedDBDatabases',
            'WKWebsiteDataTypeCookies',
            'WKWebsiteDataTypeFetchCache',
            'allWebsiteDataTypes',
            'WKWebsiteDataTypeSessionStorage',
        ])
            expect(method).not.toContain(never);
    });

    it('the JS bindings sit beside the existing plugin registration', () => {
        const typescript = read('services/nativeStorage.ts');
        expect(typescript).toContain('prepareChartStore(): Promise<{ path: string }>;');
        expect(typescript).toContain('purgeWebDiskCache(): Promise<void>;');
        expect(typescript).toContain('export function prepareChartStore()');
        expect(typescript).toContain('export function purgeWebDiskCache()');
    });
});

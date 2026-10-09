// @vitest-environment node
/** Pure cached-plan schema fixtures. No binary, simulator, signing or Auth run. */
import { describe, expect, it, vi } from 'vitest';
import {
    FULL_APP_CACHED_SWIFT_SOURCES,
    inspectFullAppCachedBuild,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppUiResumeContract.mjs';

const checkout = '/owned/thalassa',
    digest = 'b'.repeat(64),
    root = '/owned/T/thalassa-messaging-build-fixture';
function fixture() {
    const required = [
        'ScuttlebuttResearchAuth',
        'research-local-ui-fixture.json',
        'public/index.html',
        'capacitor.config.json',
        'research-config.json',
    ];
    const artifactHashes = Object.fromEntries(
        [...required, ...Array.from({ length: 299 }, (_, index) => 'assets/file-' + index)].map((name) => [
            name,
            digest,
        ]),
    );
    const publicDistInputHashes = Object.fromEntries(
        ['index.html', ...Array.from({ length: 255 }, (_, index) => 'assets/web-' + index)].map((name) => [
            name,
            digest,
        ]),
    );
    const framework = (count: number) =>
        Object.fromEntries(Array.from({ length: count }, (_, index) => ['file-' + index, digest]));
    return {
        status: 'passed',
        platform: 'iphonesimulator',
        bundleId: 'app.thalassa.research.scuttlebutt-auth',
        compileOnly: true,
        unsignedApplication: true,
        applicationSignatureCheckedAbsent: true,
        localUiFixture: true,
        fullAppUiFixture: true,
        protectedUiFixture: false,
        signingPerformed: false,
        installed: false,
        launched: false,
        primaryCapSyncExecuted: false,
        primaryTargetsBuilt: false,
        physicalDeviceExecution: false,
        freshRustBuild: false,
        ordinaryProductionIntegrationEnabled: false,
        liveAuthExecuted: false,
        publicConfigurationSource: 'synthetic-local-ui-only',
        fullAppWebReceiptSha256: digest,
        fullAppCspTightened: true,
        outputRoot: root,
        projectPath: root + '/Project/ScuttlebuttResearchAuth.xcodeproj',
        artifact: root + '/DerivedData/Build/Products/Debug-iphonesimulator/ScuttlebuttResearchAuth.app',
        sourceHashes: Object.fromEntries(
            FULL_APP_CACHED_SWIFT_SOURCES.map((name: string) => [checkout + '/' + name, digest]),
        ),
        artifactHashes,
        publicDistInputHashes,
        localUiFixtureResourceSha256: digest,
        executableSha256: digest,
        fullAppFixtureHtmlSha256: digest,
        providerSha256: digest,
        providerManifestSha256: digest,
        providerLockfileSha256: digest,
        cachedBindingHashes: {
            'thalassa_vodozemac_native.swift': digest,
            'thalassa_vodozemac_nativeFFI.h': digest,
            'thalassa_vodozemac_nativeFFI.modulemap': digest,
        },
        copiedFrameworkHashes: { Capacitor: framework(19), Cordova: framework(22) },
        simulatorLinkEntitlements: {
            requestedMachOEmbedding: true,
            embeddedInMachO: true,
            hostCodesignGrant: false,
            xmlSha256: digest,
            derSha256: digest,
            measuredSections: { __entitlements: digest, __ents_der: digest },
            inspectorSha256: digest,
        },
        runnerSha256: digest,
        fullAppFixtureContractSha256: digest,
        localUiFrameworksReceiptSha256: digest,
        priorNativeResearchReceiptSha256: digest,
        bundledConfigSha256: digest,
    };
}
describe('cached unsigned native resume — pure plan only', () => {
    it('copies the exact scoped plan without claiming execution or changing fixture bytes', () => {
        const raw = fixture(),
            plan = inspectFullAppCachedBuild(raw, checkout, digest);
        raw.sourceHashes[checkout + '/' + FULL_APP_CACHED_SWIFT_SOURCES[0]] = 'a'.repeat(64);
        expect(plan.sourceHashes[checkout + '/' + FULL_APP_CACHED_SWIFT_SOURCES[0]]).toBe(digest);
        expect(Object.keys(plan.artifactHashes)).toHaveLength(304);
        expect(plan.resourceHash).toBe(digest);
        expect(plan.resourcePath).toBe(plan.artifactRoot + '/research-local-ui-fixture.json');
        expect(Object.isFrozen(plan)).toBe(true);
    });
    it.each(['unsignedApplication', 'applicationSignatureCheckedAbsent', 'fullAppUiFixture', 'compileOnly'])(
        'refuses missing positive compile proof %s',
        (key) => {
            const raw = fixture() as unknown as Record<string, unknown>;
            raw[key] = false;
            expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
        },
    );
    it.each(['protectedUiFixture', 'signingPerformed', 'installed', 'primaryCapSyncExecuted', 'liveAuthExecuted'])(
        'refuses an out-of-scope cached target %s',
        (key) => {
            const raw = fixture() as unknown as Record<string, unknown>;
            raw[key] = true;
            expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
        },
    );
    it('refuses stale or injected source inventories instead of adopting them', () => {
        const raw = fixture();
        delete raw.sourceHashes[checkout + '/' + FULL_APP_CACHED_SWIFT_SOURCES[0]];
        raw.sourceHashes[checkout + '/foreign.swift'] = digest;
        expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
    });
    it('refuses escaped artifact paths, altered tree counts and resource hash mismatch', () => {
        for (const change of [
            (raw: ReturnType<typeof fixture>) => {
                delete raw.artifactHashes['assets/file-0'];
            },
            (raw: ReturnType<typeof fixture>) => {
                delete raw.artifactHashes['assets/file-0'];
                raw.artifactHashes['../outside'] = digest;
            },
            (raw: ReturnType<typeof fixture>) => {
                raw.localUiFixtureResourceSha256 = 'a'.repeat(64);
            },
        ]) {
            const raw = fixture();
            change(raw);
            expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
        }
    });
    it('refuses wrong web, platform, CSP, framework and entitlement proof', () => {
        const changes = [
            (raw: ReturnType<typeof fixture>) => {
                raw.platform = 'iphoneos';
            },
            (raw: ReturnType<typeof fixture>) => {
                raw.fullAppWebReceiptSha256 = 'a'.repeat(64);
            },
            (raw: ReturnType<typeof fixture>) => {
                raw.fullAppCspTightened = false;
            },
            (raw: ReturnType<typeof fixture>) => {
                raw.simulatorLinkEntitlements.hostCodesignGrant = true;
            },
            (raw: ReturnType<typeof fixture>) => {
                raw.simulatorLinkEntitlements.measuredSections.__ents_der = 'a'.repeat(64);
            },
            (raw: ReturnType<typeof fixture>) => {
                delete raw.copiedFrameworkHashes.Capacitor['file-0'];
            },
        ];
        for (const change of changes) {
            const raw = fixture();
            change(raw);
            expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
        }
    });
    it('does not invoke private accessors or copy their error strings', () => {
        const raw = fixture(),
            getter = vi.fn(() => {
                throw new Error('private-canary');
            });
        Object.defineProperty(raw, 'sourceHashes', { get: getter });
        expect(() => inspectFullAppCachedBuild(raw, checkout, digest)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
    });
});

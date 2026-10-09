// @vitest-environment node
/** Pure cached-plan schema fixtures. No binary, simulator, signing or Auth run. */
import { describe, expect, it, vi } from 'vitest';
import {
    FULL_APP_CACHED_SWIFT_SOURCES,
    inspectFullAppCachedBuild,
    inspectCachedResumeOptions,
    inspectCachedRuntimeSelection,
    FULL_APP_CACHED_RUNTIME_IDS,
    inspectFailedLaunchObservation,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppUiResumeContract.mjs';
import {
    FULL_APP_NATIVE_COUNTERS,
    FULL_APP_NATIVE_CASES,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppUiContract.mjs';

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

describe('cached runtime selection — pure inventory fixtures only', () => {
    const model = 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation';
    const inventories = () =>
        FULL_APP_CACHED_RUNTIME_IDS.map((identifier: string, index: number) => ({
            identifier,
            version: index === 0 ? '26.5' : '27.0',
            buildversion: index === 0 ? '23F77' : '24A434',
            isAvailable: true,
            supportedDeviceTypes: [{ identifier: model }],
        }));
    it('preserves the cached default26.5 with no option and recorded observed facts', () => {
        expect(inspectCachedResumeOptions([])).toEqual({ remainingWaitMs: null, requestedRuntimeId: null });
        expect(inspectCachedRuntimeSelection(inventories())).toEqual({
            requestedRuntimeId: null,
            runtimeId: FULL_APP_CACHED_RUNTIME_IDS[0],
            runtimeVersion: '26.5',
            runtimeBuild: '23F77',
            deviceTypeId: model,
            observedAvailable: true,
        });
    });
    it('selects only explicit installed27.0 and keeps the shared remaining budget', () => {
        const options = inspectCachedResumeOptions(['59987', '--runtime', FULL_APP_CACHED_RUNTIME_IDS[1]]);
        expect(options.remainingWaitMs).toBe(59987);
        const selected = inspectCachedRuntimeSelection(inventories(), options.requestedRuntimeId);
        expect(selected.runtimeVersion).toBe('27.0');
        expect(selected.runtimeBuild).toBe('24A434');
        expect(selected.requestedRuntimeId).toBe(FULL_APP_CACHED_RUNTIME_IDS[1]);
        expect(Object.isFrozen(selected)).toBe(true);
    });
    it('accepts an explicit26.5 option and zero remaining wait without inventing availability', () => {
        expect(inspectCachedResumeOptions(['0', '--runtime', FULL_APP_CACHED_RUNTIME_IDS[0]]).remainingWaitMs).toBe(0);
        expect(inspectCachedResumeOptions(['--runtime', FULL_APP_CACHED_RUNTIME_IDS[0]]).requestedRuntimeId).toBe(
            FULL_APP_CACHED_RUNTIME_IDS[0],
        );
    });
    it.each([
        'com.apple.CoreSimulator.SimRuntime.iOS-28-0',
        '27.0',
        FULL_APP_CACHED_RUNTIME_IDS[1] + '\n',
        '',
        true,
        null,
    ])('refuses unapproved explicit runtime %s', (value) => {
        expect(() => inspectCachedResumeOptions(['--runtime', value])).toThrow('contract refused');
    });
    it('refuses duplicate, malformed, out-of-order or unbounded CLI options', () => {
        for (const args of [
            ['--runtime'],
            ['--runtime', FULL_APP_CACHED_RUNTIME_IDS[1], '100'],
            ['120001'],
            ['001'],
            ['--other', FULL_APP_CACHED_RUNTIME_IDS[1]],
            ['--runtime', FULL_APP_CACHED_RUNTIME_IDS[1], '--runtime'],
        ])
            expect(() => inspectCachedResumeOptions(args)).toThrow('contract refused');
    });
    it('refuses absent or duplicate runtime inventory rows', () => {
        const rows = inventories();
        expect(() => inspectCachedRuntimeSelection([rows[0]], FULL_APP_CACHED_RUNTIME_IDS[1])).toThrow(
            'contract refused',
        );
        expect(() => inspectCachedRuntimeSelection([rows[1], rows[1]], FULL_APP_CACHED_RUNTIME_IDS[1])).toThrow(
            'contract refused',
        );
    });
    it('requires exact available version/build and existing supported model', () => {
        for (const change of [
            (row: ReturnType<typeof inventories>[number]) => {
                row.isAvailable = false;
            },
            (row: ReturnType<typeof inventories>[number]) => {
                row.version = '27.1';
            },
            (row: ReturnType<typeof inventories>[number]) => {
                row.buildversion = 'different';
            },
            (row: ReturnType<typeof inventories>[number]) => {
                row.supportedDeviceTypes = [];
            },
        ]) {
            const rows = inventories();
            change(rows[1]);
            expect(() => inspectCachedRuntimeSelection(rows, FULL_APP_CACHED_RUNTIME_IDS[1])).toThrow(
                'contract refused',
            );
        }
    });
    it('refuses source accessors without invoking their private bodies', () => {
        const rows = inventories(),
            getter = vi.fn(() => {
                throw new Error('private-canary');
            });
        Object.defineProperty(rows[1], 'buildversion', { get: getter });
        expect(() => inspectCachedRuntimeSelection(rows, FULL_APP_CACHED_RUNTIME_IDS[1])).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
        const options = ['--runtime', FULL_APP_CACHED_RUNTIME_IDS[1]];
        Object.defineProperty(options, '1', { get: getter });
        expect(() => inspectCachedResumeOptions(options)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
    });
    it('requires the observed iPhone family when supplied without fabricating absent metadata', () => {
        const rows = inventories();
        Object.defineProperty(rows[1].supportedDeviceTypes[0], 'productFamily', {
            value: 'iPhone',
            configurable: true,
        });
        expect(inspectCachedRuntimeSelection(rows, FULL_APP_CACHED_RUNTIME_IDS[1]).deviceTypeId).toBe(model);
        Object.defineProperty(rows[1].supportedDeviceTypes[0], 'productFamily', { value: 'iPad' });
        expect(() => inspectCachedRuntimeSelection(rows, FULL_APP_CACHED_RUNTIME_IDS[1])).toThrow('contract refused');
    });
});

describe('failed launch preservation — pure sanitized observation fixtures only', () => {
    const run = '93000000-0000-4000-8000-000000000001',
        nonce = 'a'.repeat(64);
    const failure = () => ({ operation: 'owned-app-launch', exitStatus: null, timedOut: true });
    const envelope = () => ({
        version: 2,
        runID: run,
        nonce,
        scenario: 'full-app-native-startup',
        status: 'running',
        phase: 'script-installed',
        assertions: 0,
        nativeAssertions: 0,
        sdkCounts: null,
        cases: [] as string[],
        nativeCounters: Object.fromEntries(FULL_APP_NATIVE_COUNTERS.map((name: string) => [name, 0])),
        nativeState: { status: 'running' },
        nativeVerifiedAtProgress: {},
        nativeHttpFence: null,
        windowEvidence: null,
        domFacts: null,
        syntheticPagehide: true,
        realOsLifecycleOrBfCacheProved: false,
    });
    it('retains null exit and timeout when both known files are absent without accepting the driver', () => {
        const result = inspectFailedLaunchObservation(failure(), null, null, run, nonce);
        expect(result.captureStatus).toBe('absent');
        expect(result.failure).toEqual(failure());
        expect(result.nativeLaunchPhase).toBe(null);
        expect(result.outerDriverAccepted).toBe(false);
        expect(result.observedNativeFinalValidated).toBe(false);
        expect(Object.isFrozen(result.failure)).toBe(true);
    });
    it('copies a fixed phase and strict running envelope independently of launch syscall failure', () => {
        const raw = envelope();
        const result = inspectFailedLaunchObservation(
            failure(),
            { version: 1, phase: 'bridge-created' },
            raw,
            run,
            nonce,
        );
        raw.nativeCounters.authenticate = 999;
        expect(result.nativeLaunchPhase).toBe('bridge-created');
        expect(result.nativeFacts?.nativeCounters.authenticate).toBe(0);
        expect(result.failure.timedOut).toBe(true);
        expect(result.outerDriverAccepted).toBe(false);
        expect(Object.isFrozen(result.nativeFacts)).toBe(true);
    });
    it('retains strict failed native facts without storing arbitrary error details', () => {
        const raw = envelope();
        raw.status = 'failed';
        raw.phase = 'fixture-failed';
        raw.cases = ['fixture-failed'];
        const result = inspectFailedLaunchObservation(failure(), null, raw, run, nonce);
        expect(result.nativeFacts?.status).toBe('failed');
        expect(result.outerDriverAccepted).toBe(false);
        expect(result.observedNativeFinalValidated).toBe(false);
    });
    it('does not promote a passed-shaped envelope without final native acceptance or a returned PID', () => {
        const raw = envelope();
        raw.status = 'passed';
        raw.phase = 'fixture-complete';
        raw.nativeAssertions = 10;
        raw.cases = [...FULL_APP_NATIVE_CASES];
        const result = inspectFailedLaunchObservation(failure(), null, raw, run, nonce);
        expect(result.nativeFacts?.status).toBe('passed');
        expect(result.observedNativeFinalValidated).toBe(false);
        expect(result.outerDriverAccepted).toBe(false);
        expect(result.failure).toEqual(failure());
    });
    it('requires the original exact run, nonce and scenario binding', () => {
        for (const key of ['runID', 'nonce', 'scenario']) {
            const raw = { ...envelope(), [key]: 'foreign' };
            expect(() => inspectFailedLaunchObservation(failure(), null, raw, run, nonce)).toThrow('contract refused');
        }
    });
    it('refuses unknown phase, extra private fields and unbounded counters instead of exporting their values', () => {
        for (const phase of [
            { version: 1, phase: 'unknown' },
            { version: 1, phase: 'bridge-created', error: 'private-canary' },
        ])
            expect(() => inspectFailedLaunchObservation(failure(), phase, null, run, nonce)).toThrow(
                'contract refused',
            );
        for (const raw of [
            { ...envelope(), token: 'private-canary' },
            { ...envelope(), domFacts: { body: 'private-canary' } },
            { ...envelope(), nativeCounters: { ...envelope().nativeCounters, authenticate: 10001 } },
        ])
            expect(() => inspectFailedLaunchObservation(failure(), null, raw, run, nonce)).toThrow('contract refused');
    });
    it('refuses nonlaunch failures and arbitrary failure metadata', () => {
        for (const raw of [
            { ...failure(), operation: 'simulator-bootstatus' },
            { ...failure(), exitStatus: -1 },
            { ...failure(), timedOut: 'true' },
            { ...failure(), error: 'private-canary' },
        ])
            expect(() => inspectFailedLaunchObservation(raw, null, null, run, nonce)).toThrow('contract refused');
    });
    it('does not invoke phase, failure or native accessors or export their private errors', () => {
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        for (const [raw, key, position] of [
            [failure(), 'timedOut', 0],
            [{ version: 1, phase: 'bridge-created' }, 'phase', 1],
            [envelope(), 'phase', 2],
        ] as const) {
            Object.defineProperty(raw, key, { get: getter });
            const values: unknown[] = [failure(), null, null];
            values[position] = raw;
            expect(() => inspectFailedLaunchObservation(values[0], values[1], values[2], run, nonce)).toThrow(
                'contract refused',
            );
        }
        expect(getter).not.toHaveBeenCalled();
    });
});

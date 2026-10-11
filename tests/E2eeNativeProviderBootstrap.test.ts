// @vitest-environment node
/** Synthetic schema fixtures only: no files, native execution, signing or relay. */
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    NATIVE_PROVIDER_BOOTSTRAP_KIND,
    NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES,
    NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES,
    NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES,
    NATIVE_PROVIDER_BOOTSTRAP_PHASES,
    NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS,
    NATIVE_PROVIDER_BOOTSTRAP_NODE_PIN,
    NATIVE_PROVIDER_BOOTSTRAP_PROVIDER_PIN,
    NATIVE_PROVIDER_BOOTSTRAP_RELAY_ARCHIVE_PIN,
    inspectNativeProviderBootstrapReceipt,
    inspectNativeProviderBootstrapStatus,
} from '../experiments/scuttlebutt-e2ee/nativeProviderBootstrapContract.mjs';

export const syntheticBootstrapCheckout = '/owned/thalassa';
const digest = 'b'.repeat(64),
    otherDigest = 'c'.repeat(64),
    runID = '11111111-2222-3333-4444-555555555555',
    cacheRoot = '/private/tmp/thalassa-provider-bootstrap-fixture/cache',
    refusal = 'Native provider bootstrap contract refused';

/** An explicit example for the driver author, never an executable receipt. */
export function createSyntheticNativeProviderBootstrapFixture() {
    return {
        schemaVersion: 1,
        kind: NATIVE_PROVIDER_BOOTSTRAP_KIND,
        status: 'passed',
        runID,
        bundle: 'app.thalassa.research.vodozemac.' + runID,
        cacheRoot,
        providerPin: { ...NATIVE_PROVIDER_BOOTSTRAP_PROVIDER_PIN },
        node: { ...NATIVE_PROVIDER_BOOTSTRAP_NODE_PIN },
        sourceHashes: Object.fromEntries(
            NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES.map((name: string) => [
                resolve(syntheticBootstrapCheckout, name),
                digest,
            ]),
        ),
        cacheArtifacts: Object.entries(NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS).map(
            ([name, sha256]): { path: string; sha256: string } => ({
                path: resolve(cacheRoot, name),
                sha256,
            }),
        ),
        compiled: {
            platform: 'iphonesimulator',
            target: 'arm64-apple-ios17.0-simulator',
            executable: { path: resolve(cacheRoot, 'NativeResearch.app/NativeResearch'), sha256: digest },
            unsignedBeforeSign: true,
            embeddedEntitlements: {
                xmlSha256: digest,
                derSha256: otherDigest,
                measured: { __entitlements: digest, __ents_der: otherDigest },
            },
        },
        signing: { performed: true, signedOnlyOwnedApp: true, hostCodesignEntitlementsSupplied: false },
        runtime: {
            requestedRuntimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
            runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
            runtimeVersion: '27.0',
            runtimeBuild: '24A434',
            deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
            observedAvailable: true,
        },
        ownedSimulator: {
            id: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
            name: 'Thalassa cached provider bootstrap ' + runID,
            createdNew: true,
            priorDevicesMutated: false,
        },
        controlLaunch: {
            bundle: 'com.apple.Preferences',
            exitStatus: 0,
            timedOut: false,
            returnedPID: 901,
            boundMs: 120000,
            systemAppMetadataChecked: true,
        },
        phases: NATIVE_PROVIDER_BOOTSTRAP_PHASES.map((phase: string, index: number) => ({
            runID,
            phase,
            pid: 1000 + index,
            status: 'passed',
            stage: 'complete',
            launchExitStatus: 0,
            launchTimedOut: false,
        })),
        coordinatorAssertions: 37,
        relay: {
            messages: 3,
            decisions: 3,
            requests: 8,
            databaseReopens: 1,
            exactRetriesDeduplicated: true,
            tamperingRefused: true,
            plaintextCanariesAbsent: true,
            freshAuthChecked: true,
        },
        relayArchive: {
            path: resolve(cacheRoot, '../native-relay/pglite.tgz'),
            sha256: digest,
            ...NATIVE_PROVIDER_BOOTSTRAP_RELAY_ARCHIVE_PIN,
        },
        cleanup: {
            appUninstalled: true,
            simulatorRemoved: true,
            relayClosed: true,
            sourcesStable: true,
            cacheStable: true,
            executableStable: true,
        },
        freshRustBuild: false,
        sourceBinaryProvenanceProved: false,
        independentlyReviewed: false,
        liveAuth: false,
        physicalDeviceExecution: false,
        productionTouched: false,
        humanDevicesChanged: false,
        hostedActorsChanged: false,
        primaryTargetsBuilt: false,
        sharedSlotWaitMs: 0,
    };
}

type Fixture = ReturnType<typeof createSyntheticNativeProviderBootstrapFixture>;
function inspect(raw = createSyntheticNativeProviderBootstrapFixture()) {
    // A separate copy represents the caller's independent pre-run snapshot.
    const expected = Object.fromEntries(
        NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES.map((name: string) => [
            resolve(syntheticBootstrapCheckout, name),
            digest,
        ]),
    );
    return inspectNativeProviderBootstrapReceipt(raw, syntheticBootstrapCheckout, expected);
}
function refuses(change: (raw: Fixture) => void) {
    const raw = createSyntheticNativeProviderBootstrapFixture();
    change(raw);
    expect(() => inspect(raw)).toThrow(refusal);
}
function nativeStatus(phase = 'prepare') {
    return {
        phase,
        stage: 'complete',
        status: 'passed',
        runID,
        pid: 1000,
        physicalDeviceProtectionVerified: false,
    };
}

describe('cached provider bootstrap — strict synthetic receipts only', () => {
    it('copies and deeply freezes the exact accepted shape without promoting provenance', () => {
        const raw = createSyntheticNativeProviderBootstrapFixture(),
            copied = inspect(raw);
        expect(copied).toEqual(raw);
        expect(copied.freshRustBuild).toBe(false);
        expect(copied.sourceBinaryProvenanceProved).toBe(false);
        for (const value of [
            copied,
            copied.node,
            copied.providerPin,
            copied.sourceHashes,
            copied.cacheArtifacts,
            ...copied.cacheArtifacts,
            copied.compiled,
            copied.compiled.executable,
            copied.compiled.embeddedEntitlements,
            copied.compiled.embeddedEntitlements.measured,
            copied.runtime,
            copied.ownedSimulator,
            copied.controlLaunch,
            copied.phases,
            ...copied.phases,
            copied.relay,
            copied.relayArchive,
            copied.cleanup,
        ])
            expect(Object.isFrozen(value)).toBe(true);
        raw.phases[0].pid = 3000;
        raw.compiled.executable.sha256 = otherDigest;
        raw.sourceHashes[resolve(syntheticBootstrapCheckout, NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES[0])] = otherDigest;
        expect(copied.phases[0].pid).toBe(1000);
        expect(copied.compiled.executable.sha256).toBe(digest);
        expect(
            copied.sourceHashes[resolve(syntheticBootstrapCheckout, NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES[0])],
        ).toBe(digest);
    });

    it('pins the complete 21-source Swift closure and separate 17 proof inputs', () => {
        expect(NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES).toHaveLength(21);
        expect(NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES).toHaveLength(17);
        expect(new Set(NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES).size).toBe(38);
        expect(NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES).toContain(
            'experiments/scuttlebutt-e2ee/VodozemacMessageOperations.swift',
        );
        expect(NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES).toContain(
            'experiments/scuttlebutt-e2ee/VodozemacRelayResult.swift',
        );
        expect(NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES).toContain(
            'experiments/scuttlebutt-e2ee/VodozemacRelayPolicy.swift',
        );
        expect(
            NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES.some(
                (name: string) => name.includes('fullAppUi') || name.includes('ResearchAuth'),
            ),
        ).toBe(false);
    });

    it.each(['schemaVersion', 'kind', 'status', 'runID', 'bundle'])('refuses a missing top-level binding %s', (key) =>
        refuses((raw) => {
            Reflect.deleteProperty(raw, key);
        }),
    );
    it('refuses unknown, symbol and accessor fields without invoking getters', () => {
        for (const key of ['rawPayload', Symbol('rawPayload')]) {
            refuses((raw) => Object.defineProperty(raw, key, { value: 'PRIVATE-CANARY', enumerable: true }));
        }
        const getter = vi.fn(() => 'PRIVATE-CANARY');
        refuses((raw) => Object.defineProperty(raw, 'runID', { get: getter }));
        expect(getter).not.toHaveBeenCalled();
    });
    it('refuses nested extras and throws only the fixed error', () => {
        const raw = createSyntheticNativeProviderBootstrapFixture();
        Object.defineProperty(raw.relay, 'errorBody', { value: 'PRIVATE-CANARY', enumerable: true });
        expect(() => inspect(raw)).toThrowError(new Error(refusal));
    });
    it.each(['missing', 'extra', 'stale', 'invalid'])(
        'refuses a %s source inventory against the independent expected map',
        (mode) =>
            refuses((raw) => {
                const name = resolve(syntheticBootstrapCheckout, NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES[0]);
                if (mode === 'missing') delete raw.sourceHashes[name];
                if (mode === 'extra') raw.sourceHashes[syntheticBootstrapCheckout + '/unreviewed.swift'] = digest;
                if (mode === 'stale') raw.sourceHashes[name] = otherDigest;
                if (mode === 'invalid') raw.sourceHashes[name] = 'not-a-digest';
            }),
    );
    it('refuses an accessor source digest without calling it', () => {
        const getter = vi.fn(() => digest);
        refuses((raw) =>
            Object.defineProperty(
                raw.sourceHashes,
                resolve(syntheticBootstrapCheckout, NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES[0]),
                { get: getter },
            ),
        );
        expect(getter).not.toHaveBeenCalled();
    });
    it('requires a separately supplied exact expected source inventory', () => {
        const raw = createSyntheticNativeProviderBootstrapFixture();
        expect(() => inspectNativeProviderBootstrapReceipt(raw, syntheticBootstrapCheckout, {})).toThrow(refusal);
        const expected = { ...raw.sourceHashes };
        expected[Object.keys(expected)[0]] = otherDigest;
        expect(() => inspectNativeProviderBootstrapReceipt(raw, syntheticBootstrapCheckout, expected)).toThrow(refusal);
    });
    it.each(['wrong-digest', 'reordered', 'escaped-path', 'missing', 'extra'])(
        'refuses %s historical cache evidence',
        (mode) =>
            refuses((raw) => {
                if (mode === 'wrong-digest') raw.cacheArtifacts[0].sha256 = digest;
                if (mode === 'reordered') raw.cacheArtifacts.reverse();
                if (mode === 'escaped-path') raw.cacheArtifacts[0].path = '/private/tmp/unowned/archive.a';
                if (mode === 'missing') raw.cacheArtifacts.pop();
                if (mode === 'extra') raw.cacheArtifacts.push({ ...raw.cacheArtifacts[0] });
            }),
    );
    it.each(['/owned/cache', '/private/tmp/thalassa-fixture/../cache', '/private/tmp/thalassa-fixture\n'])(
        'refuses an unowned or noncanonical cache root %s',
        (value) =>
            refuses((raw) => {
                raw.cacheRoot = value;
            }),
    );
    it('accepts the canonical owned macOS temporary-root spelling', () => {
        const raw = createSyntheticNativeProviderBootstrapFixture();
        raw.cacheRoot = '/private/var/folders/gp/private-owned/T/thalassa-provider-bootstrap-fixture/cache';
        for (const [index, name] of Object.keys(NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS).entries())
            raw.cacheArtifacts[index].path = resolve(raw.cacheRoot, name);
        raw.compiled.executable.path = resolve(raw.cacheRoot, 'NativeResearch.app/NativeResearch');
        raw.relayArchive.path = resolve(raw.cacheRoot, '../native-relay/pglite.tgz');
        expect(inspect(raw).cacheRoot).toBe(raw.cacheRoot);
    });
    it.each(['version', 'execPath', 'sha256'])('refuses drift in the actual Node pin %s', (key) =>
        refuses((raw) => {
            Object.defineProperty(raw.node, key, { value: 'changed', enumerable: true });
        }),
    );
    it.each(['version', 'uniffiVersion', 'protocol', 'manifestSha256', 'lockfileSha256'])(
        'refuses provider pin drift %s',
        (key) =>
            refuses((raw) => {
                Object.defineProperty(raw.providerPin, key, { value: 'changed', enumerable: true });
            }),
    );
    it.each(['target', 'platform', 'unsigned', 'executable-path', 'entitlements', 'grant'])(
        'refuses unsupported compile/signing evidence %s',
        (mode) =>
            refuses((raw) => {
                if (mode === 'target') raw.compiled.target = 'arm64-apple-ios17.0';
                if (mode === 'platform') raw.compiled.platform = 'iphoneos';
                if (mode === 'unsigned') raw.compiled.unsignedBeforeSign = false;
                if (mode === 'executable-path') raw.compiled.executable.path = '/private/tmp/another-app';
                if (mode === 'entitlements') raw.compiled.embeddedEntitlements.measured.__ents_der = digest;
                if (mode === 'grant') raw.signing.hostCodesignEntitlementsSupplied = true;
            }),
    );
    it.each(['requestedRuntimeId', 'runtimeId', 'runtimeVersion', 'runtimeBuild', 'deviceTypeId', 'observedAvailable'])(
        'refuses unsupported runtime selection %s',
        (key) =>
            refuses((raw) => {
                Object.defineProperty(raw.runtime, key, { value: 'changed', enumerable: true });
            }),
    );
    it.each(['id', 'name', 'createdNew', 'priorDevicesMutated'])('refuses unowned simulator evidence %s', (key) =>
        refuses((raw) => {
            Object.defineProperty(raw.ownedSimulator, key, { value: 'changed', enumerable: true });
        }),
    );
    it.each(['bundle', 'exitStatus', 'timedOut', 'returnedPID', 'boundMs', 'systemAppMetadataChecked'])(
        'refuses a failed or absent control gate %s',
        (key) =>
            refuses((raw) => {
                Object.defineProperty(raw.controlLaunch, key, { value: 'changed', enumerable: true });
            }),
    );
    it.each(['missing', 'reordered', 'run', 'failed', 'stage', 'pid', 'exit', 'timeout'])(
        'refuses incomplete or mixed phase evidence %s',
        (mode) =>
            refuses((raw) => {
                if (mode === 'missing') raw.phases.pop();
                if (mode === 'reordered') raw.phases.reverse();
                if (mode === 'run') raw.phases[0].runID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
                if (mode === 'failed') raw.phases[0].status = 'failed';
                if (mode === 'stage') raw.phases[0].stage = 'PRIVATE-CANARY';
                if (mode === 'pid') raw.phases[0].pid = 0;
                if (mode === 'exit') raw.phases[0].launchExitStatus = 1;
                if (mode === 'timeout') raw.phases[0].launchTimedOut = true;
            }),
    );
    it('refuses array accessors, sparse slots and extra properties before executing getters', () => {
        const getter = vi.fn(() => createSyntheticNativeProviderBootstrapFixture().phases[0]);
        refuses((raw) => Object.defineProperty(raw.phases, '0', { get: getter }));
        expect(getter).not.toHaveBeenCalled();
        refuses((raw) => {
            Reflect.deleteProperty(raw.phases, '0');
        });
        refuses((raw) => Object.defineProperty(raw.phases, 'extra', { value: 'PRIVATE-CANARY' }));
    });
    it.each([0, -1, 10001, 1.5, NaN])('refuses an unbounded assertion count %s', (count) =>
        refuses((raw) => {
            raw.coordinatorAssertions = count;
        }),
    );
    it.each([
        'messages',
        'decisions',
        'requests',
        'databaseReopens',
        'exactRetriesDeduplicated',
        'tamperingRefused',
        'plaintextCanariesAbsent',
        'freshAuthChecked',
    ])('refuses missing or altered SQL evidence %s', (key) =>
        refuses((raw) => {
            Object.defineProperty(raw.relay, key, { value: null, enumerable: true });
        }),
    );
    it.each(['path', 'sha256', 'version', 'integrity'])(
        'refuses a missing or mismatched copied relay archive binding %s',
        (key) =>
            refuses((raw) => {
                Object.defineProperty(raw.relayArchive, key, { value: 'changed', enumerable: true });
            }),
    );
    it.each(['appUninstalled', 'simulatorRemoved', 'relayClosed', 'sourcesStable', 'cacheStable', 'executableStable'])(
        'refuses an uncompleted cleanup/stability step %s',
        (key) =>
            refuses((raw) => {
                Object.defineProperty(raw.cleanup, key, { value: false, enumerable: true });
            }),
    );
    it.each([
        'freshRustBuild',
        'sourceBinaryProvenanceProved',
        'independentlyReviewed',
        'liveAuth',
        'physicalDeviceExecution',
        'productionTouched',
        'humanDevicesChanged',
        'hostedActorsChanged',
        'primaryTargetsBuilt',
    ])('refuses the unsupported release claim %s', (key) =>
        refuses((raw) => {
            Object.defineProperty(raw, key, { value: true, enumerable: true });
        }),
    );
    it.each([-1, 120001, 1.5, NaN])('refuses an invalid shared-slot wait %s', (value) =>
        refuses((raw) => {
            raw.sharedSlotWaitMs = value;
        }),
    );
});

describe('native provider status — fixed sanitized fields only', () => {
    it('accepts a bound complete phase and freezes a copy', () => {
        const raw = nativeStatus(),
            copied = inspectNativeProviderBootstrapStatus(raw, runID, 'prepare', 1000);
        raw.pid = 2;
        expect(copied.pid).toBe(1000);
        expect(Object.isFrozen(copied)).toBe(true);
    });
    it('requires the actual positive assertion count only on replay completion', () => {
        const raw = { ...nativeStatus('replay'), coordinatorAssertions: 37 };
        expect(inspectNativeProviderBootstrapStatus(raw, runID, 'replay', 1000).coordinatorAssertions).toBe(37);
        expect(() => inspectNativeProviderBootstrapStatus(nativeStatus('replay'), runID, 'replay', 1000)).toThrow(
            refusal,
        );
        expect(() =>
            inspectNativeProviderBootstrapStatus(
                { ...nativeStatus(), coordinatorAssertions: 37 },
                runID,
                'prepare',
                1000,
            ),
        ).toThrow(refusal);
    });
    it('normalizes arbitrary native failure and running labels without exporting them', () => {
        const failed = { ...nativeStatus(), status: 'failed', stage: 'PRIVATE-CANARY' };
        const running = { ...nativeStatus(), status: 'running', stage: 'PRIVATE-CANARY' };
        expect(inspectNativeProviderBootstrapStatus(failed, runID, 'prepare', 1000).stage).toBe('native-check-failed');
        expect(inspectNativeProviderBootstrapStatus(running, runID, 'prepare', 1000).stage).toBe(
            'unknown-native-progress',
        );
        expect(JSON.stringify(inspectNativeProviderBootstrapStatus(failed, runID, 'prepare', 1000))).not.toContain(
            'PRIVATE-CANARY',
        );
    });
    it.each(['run', 'phase', 'pid', 'status', 'physical', 'extra', 'stage-size'])(
        'refuses invalid native status binding %s',
        (mode) => {
            const raw = nativeStatus();
            if (mode === 'run') raw.runID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            if (mode === 'phase') raw.phase = 'receive';
            if (mode === 'pid') raw.pid = 0;
            if (mode === 'status') raw.status = 'unknown';
            if (mode === 'physical') raw.physicalDeviceProtectionVerified = true;
            if (mode === 'extra') Object.defineProperty(raw, 'message', { value: 'PRIVATE-CANARY' });
            if (mode === 'stage-size') raw.stage = 'x'.repeat(257);
            expect(() => inspectNativeProviderBootstrapStatus(raw, runID, 'prepare', 1000)).toThrow(refusal);
        },
    );
    it('does not call a status getter or preserve a supplied native error message', () => {
        const getter = vi.fn(() => 'PRIVATE-CANARY'),
            raw = nativeStatus();
        Object.defineProperty(raw, 'stage', { get: getter });
        expect(() => inspectNativeProviderBootstrapStatus(raw, runID, 'prepare', 1000)).toThrow(refusal);
        expect(getter).not.toHaveBeenCalled();
    });
});

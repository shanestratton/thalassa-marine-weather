/** Pure cached-binary re-execution evidence. This is neither a reconstruction
 * of a retired receipt nor fresh Rust/provenance/physical/production proof.
 * The driver must independently hash real files and verify fresh ownership. */
import { isAbsolute, resolve } from 'node:path';

const prefix = 'experiments/scuttlebutt-e2ee/';
export const NATIVE_PROVIDER_BOOTSTRAP_KIND = 'cached-provider-native-bootstrap';
export const NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES = Object.freeze(
    [
        'VodozemacSealedStore.swift',
        'VodozemacSealedStoreProbe.swift',
        'VodozemacDmFrame.swift',
        'VodozemacDmFrameProbe.swift',
        'VodozemacDmCoordinator.swift',
        'VodozemacMessageOperations.swift',
        'VodozemacRelayTransport.swift',
        'VodozemacRelayPolicy.swift',
        'VodozemacRelayResult.swift',
        'VodozemacSupabaseAuth.swift',
        'VodozemacAuthSession.swift',
        'VodozemacAuthProbe.swift',
        'VodozemacAccountDirectory.swift',
        'VodozemacSessionFacade.swift',
        'VodozemacAccountDirectoryProbe.swift',
        'VodozemacRelayCodec.swift',
        'VodozemacRelayProbe.swift',
        'VodozemacResearchCleanup.swift',
        'VodozemacDmCoordinatorProbe.swift',
        'VodozemacDmRestartProbe.swift',
        'VodozemacNativeProbe.swift',
    ].map((name) => prefix + name),
);
export const NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES = Object.freeze([
    ...[
        'cachedProviderBootstrap.mjs',
        'nativeProviderBootstrapContract.mjs',
        'bridge-native/machOEntitlementEvidence.mjs',
        'vodozemac-native-pin.json',
        'vodozemac-pin.json',
        'vodozemac-native/Cargo.toml',
        'vodozemac-native/Cargo.lock',
        'relay/nativeRelayBridge.mjs',
        'relay/gateway.ts',
        'relay/signedGateway.ts',
        'relay/signedRequest.ts',
        'relay/supabaseAuth.ts',
        'relay/deviceBundle.ts',
        'relay/relay.sql',
        'relay/pglite-pin.json',
    ].map((name) => prefix + name),
    'services/chat/e2ee/directMessageEnvelope.ts',
    'services/chat/e2ee/encryptedDmDelivery.ts',
]);
export const NATIVE_PROVIDER_BOOTSTRAP_PHASES = Object.freeze([
    'prepare',
    'receive',
    'reply',
    'verify',
    'replay',
    'cleanup',
    'dm-prepare',
    'dm-receive',
    'dm-reply',
    'dm-verify',
    'dm-replay',
    'dm-cleanup',
    'relay-prepare',
    'relay-send',
    'relay-reply',
    'relay-verify',
    'relay-replay',
    'relay-cleanup',
]);
export const NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS = Object.freeze({
    'target/aarch64-apple-ios-sim/debug/libthalassa_vodozemac_native.a':
        'ce81b9cf0723a108c42f8eb2bd03f001aa4800739000aac525dd7e03461d8c0f',
    'bindings/thalassa_vodozemac_native.swift': 'f26c6256b43c383209f9d8da64afe2c87ea84cd647a312a9be322d4f403fa62e',
    'bindings/thalassa_vodozemac_nativeFFI.h': 'e135cfea1701a0e760f6741edd7c848f8197907cdbf2683a2a923742be31fb11',
    'bindings/thalassa_vodozemac_nativeFFI.modulemap':
        'c7d5f877e8d06da086653661f8052ab5fec7d136061edcad1bfcd504ea295f41',
});
export const NATIVE_PROVIDER_BOOTSTRAP_NODE_PIN = Object.freeze({
    version: 'v24.21.0',
    execPath: '/opt/homebrew/Cellar/node@24/24.21.0_2/bin/node',
    sha256: '798d7f9c0d38051608d11ba87a12fbb01e92bfa457cd77ec612b5bad2a73a05e',
});
export const NATIVE_PROVIDER_BOOTSTRAP_PROVIDER_PIN = Object.freeze({
    version: '0.11.0',
    uniffiVersion: '0.29.4',
    protocol: 'olm-v1',
    manifestSha256: '8cef57a4b945989302db94361bb03df46157e9c305862232dd9d59379ed610d9',
    lockfileSha256: '5788c45d3bd629c4640f88c5b533484c89d39029674a02bce0301597e6fe50f7',
});
export const NATIVE_PROVIDER_BOOTSTRAP_RELAY_ARCHIVE_PIN = Object.freeze({
    version: '0.5.8',
    integrity: 'sha512-n9tsbUOhwx2epK1V0ZG9Ar4SHWUju04dhmzZXiSBXwBoleOvIfals33NAaWgagQVAL4Rbvx/Ptsu3P+pA09f6Q==',
});
export const NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES = Object.freeze([
    ...NATIVE_PROVIDER_BOOTSTRAP_SWIFT_SOURCES,
    ...NATIVE_PROVIDER_BOOTSTRAP_PROOF_SOURCES,
]);
export const NATIVE_PROVIDER_BOOTSTRAP_RECEIPT_KEYS = Object.freeze([
    'schemaVersion',
    'kind',
    'status',
    'runID',
    'bundle',
    'cacheRoot',
    'providerPin',
    'node',
    'sourceHashes',
    'cacheArtifacts',
    'compiled',
    'signing',
    'runtime',
    'ownedSimulator',
    'controlLaunch',
    'phases',
    'coordinatorAssertions',
    'relay',
    'relayArchive',
    'cleanup',
    'freshRustBuild',
    'sourceBinaryProvenanceProved',
    'independentlyReviewed',
    'liveAuth',
    'physicalDeviceExecution',
    'productionTouched',
    'humanDevicesChanged',
    'hostedActorsChanged',
    'primaryTargetsBuilt',
    'sharedSlotWaitMs',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const refused = () => {
    throw new Error('Native provider bootstrap contract refused');
};
const require = (value) => {
    if (!value) refused();
};
const guarded = (action) => {
    try {
        return action();
    } catch {
        return refused();
    }
};
const hash = (value) => typeof value === 'string' && value.length === 64 && HASH.test(value);
const uuid = (value) => typeof value === 'string' && value.length === 36 && UUID.test(value);
function data(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    require(descriptor && 'value' in descriptor);
    return descriptor.value;
}
function record(value) {
    require(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function exact(value, keys) {
    record(value);
    const names = Reflect.ownKeys(value);
    require(names.length === keys.length && names.every((name) => typeof name === 'string' && keys.includes(name)));
    return Object.fromEntries(keys.map((key) => [key, data(value, key)]));
}
function integer(value, min = 0, max = 10000) {
    require(Number.isSafeInteger(value) && value >= min && value <= max);
    return value;
}
function array(value, length, read) {
    require(Array.isArray(value) && data(value, 'length') === length);
    require(
        Reflect.ownKeys(value).every(
            (key) =>
                key === 'length' ||
                (typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length),
        ),
    );
    return Object.freeze(Array.from({ length }, (_, index) => read(data(value, String(index)), index)));
}
function path(value) {
    require(
        typeof value === 'string' &&
            value.length <= 1024 &&
            isAbsolute(value) &&
            resolve(value) === value &&
            !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    );
    return value;
}
function ref(raw, expectedPath) {
    const row = exact(raw, ['path', 'sha256']);
    require(path(row.path) === expectedPath && hash(row.sha256));
    return Object.freeze(row);
}
function pinned(raw, pin) {
    const row = exact(raw, Object.keys(pin));
    require(Object.keys(pin).every((key) => row[key] === pin[key]));
    return Object.freeze(row);
}

/** Six native-owned fields, with optional replay assertion count. Failed stage
 * labels are never copied, interpreted or used as acceptance evidence. */
export function inspectNativeProviderBootstrapStatus(raw, runID, phase, pid) {
    return guarded(() => {
        require(uuid(runID) && NATIVE_PROVIDER_BOOTSTRAP_PHASES.includes(phase));
        integer(pid, 1, 999999999);
        record(raw);
        const withAssertions = Reflect.ownKeys(raw).includes('coordinatorAssertions');
        const row = exact(raw, [
            'phase',
            'stage',
            'status',
            'runID',
            'pid',
            'physicalDeviceProtectionVerified',
            ...(withAssertions ? ['coordinatorAssertions'] : []),
        ]);
        require(
            row.runID === runID &&
                row.phase === phase &&
                row.pid === pid &&
                row.physicalDeviceProtectionVerified === false,
        );
        require(
            ['running', 'passed', 'failed'].includes(row.status) &&
                typeof row.stage === 'string' &&
                row.stage.length <= 256,
        );
        if (withAssertions) {
            require(phase === 'replay');
            row.coordinatorAssertions = integer(row.coordinatorAssertions, 1);
        }
        if (row.status === 'passed') {
            require(row.stage === 'complete' && (phase !== 'replay' || withAssertions));
        } else if (row.status === 'failed') row.stage = 'native-check-failed';
        else if (
            ![
                'didFinish',
                'sceneConnected',
                'sceneActive',
                'storage',
                'provider',
                'storage-probes',
                'dm-frame-probes',
                'dm-coordinator-probes',
                'dm-restart',
                'native-signed-relay',
            ].includes(row.stage)
        )
            row.stage = 'unknown-native-progress';
        return Object.freeze(row);
    });
}

/** expectedSourceHashes is the driver's independent pre-run current-file
 * snapshot, never merely an alias of fields read from the submitted receipt. */
export function inspectNativeProviderBootstrapReceipt(raw, checkout, expectedSourceHashes) {
    return guarded(() => {
        path(checkout);
        const row = exact(raw, NATIVE_PROVIDER_BOOTSTRAP_RECEIPT_KEYS);
        require(
            row.schemaVersion === 1 &&
                row.kind === NATIVE_PROVIDER_BOOTSTRAP_KIND &&
                row.status === 'passed' &&
                uuid(row.runID),
        );
        require(row.bundle === 'app.thalassa.research.vodozemac.' + row.runID);
        path(row.cacheRoot);
        require(
            /^\/(?:private\/tmp|(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T)\/thalassa-[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(
                row.cacheRoot,
            ),
        );
        row.providerPin = pinned(row.providerPin, NATIVE_PROVIDER_BOOTSTRAP_PROVIDER_PIN);
        row.node = pinned(row.node, NATIVE_PROVIDER_BOOTSTRAP_NODE_PIN);
        const names = NATIVE_PROVIDER_BOOTSTRAP_SOURCE_FILES.map((name) => resolve(checkout, name));
        const expected = exact(expectedSourceHashes, names),
            actual = exact(row.sourceHashes, names);
        require(names.every((name) => hash(expected[name]) && actual[name] === expected[name]));
        row.sourceHashes = Object.freeze(actual);
        const artifacts = Object.entries(NATIVE_PROVIDER_BOOTSTRAP_CACHE_PINS);
        row.cacheArtifacts = array(row.cacheArtifacts, 4, (item, index) => {
            const output = ref(item, resolve(row.cacheRoot, artifacts[index][0]));
            require(output.sha256 === artifacts[index][1]);
            return output;
        });
        const compiled = exact(row.compiled, [
            'platform',
            'target',
            'executable',
            'unsignedBeforeSign',
            'embeddedEntitlements',
        ]);
        require(
            compiled.platform === 'iphonesimulator' &&
                compiled.target === 'arm64-apple-ios17.0-simulator' &&
                compiled.unsignedBeforeSign === true,
        );
        compiled.executable = ref(compiled.executable, resolve(row.cacheRoot, 'NativeResearch.app/NativeResearch'));
        const sections = exact(compiled.embeddedEntitlements, ['xmlSha256', 'derSha256', 'measured']);
        require(hash(sections.xmlSha256) && hash(sections.derSha256));
        const measured = exact(sections.measured, ['__entitlements', '__ents_der']);
        require(measured.__entitlements === sections.xmlSha256 && measured.__ents_der === sections.derSha256);
        sections.measured = Object.freeze(measured);
        compiled.embeddedEntitlements = Object.freeze(sections);
        row.compiled = Object.freeze(compiled);
        row.signing = pinned(row.signing, {
            performed: true,
            signedOnlyOwnedApp: true,
            hostCodesignEntitlementsSupplied: false,
        });
        const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
        row.runtime = pinned(row.runtime, {
            requestedRuntimeId: runtime,
            runtimeId: runtime,
            runtimeVersion: '27.0',
            runtimeBuild: '24A434',
            deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
            observedAvailable: true,
        });
        const simulator = exact(row.ownedSimulator, ['id', 'name', 'createdNew', 'priorDevicesMutated']);
        require(
            typeof simulator.id === 'string' &&
                uuid(simulator.id.toLowerCase()) &&
                simulator.name === 'Thalassa cached provider bootstrap ' + row.runID &&
                simulator.createdNew === true &&
                simulator.priorDevicesMutated === false,
        );
        row.ownedSimulator = Object.freeze(simulator);
        const control = exact(row.controlLaunch, [
            'bundle',
            'exitStatus',
            'timedOut',
            'returnedPID',
            'boundMs',
            'systemAppMetadataChecked',
        ]);
        require(
            control.bundle === 'com.apple.Preferences' &&
                control.exitStatus === 0 &&
                control.timedOut === false &&
                control.boundMs === 120000 &&
                control.systemAppMetadataChecked === true,
        );
        integer(control.returnedPID, 1, 999999999);
        row.controlLaunch = Object.freeze(control);
        row.phases = array(row.phases, 18, (item, index) => {
            const value = exact(item, [
                'runID',
                'phase',
                'pid',
                'status',
                'stage',
                'launchExitStatus',
                'launchTimedOut',
            ]);
            require(
                value.runID === row.runID &&
                    value.phase === NATIVE_PROVIDER_BOOTSTRAP_PHASES[index] &&
                    value.status === 'passed' &&
                    value.stage === 'complete' &&
                    value.launchExitStatus === 0 &&
                    value.launchTimedOut === false,
            );
            integer(value.pid, 1, 999999999);
            return Object.freeze(value);
        });
        row.coordinatorAssertions = integer(row.coordinatorAssertions, 1);
        row.relay = pinned(row.relay, {
            messages: 3,
            decisions: 3,
            requests: 8,
            databaseReopens: 1,
            exactRetriesDeduplicated: true,
            tamperingRefused: true,
            plaintextCanariesAbsent: true,
            freshAuthChecked: true,
        });
        const archive = exact(row.relayArchive, ['path', 'sha256', 'version', 'integrity']);
        require(path(archive.path) === resolve(row.cacheRoot, '../native-relay/pglite.tgz') && hash(archive.sha256));
        require(
            archive.version === NATIVE_PROVIDER_BOOTSTRAP_RELAY_ARCHIVE_PIN.version &&
                archive.integrity === NATIVE_PROVIDER_BOOTSTRAP_RELAY_ARCHIVE_PIN.integrity,
        );
        row.relayArchive = Object.freeze(archive);
        row.cleanup = pinned(row.cleanup, {
            appUninstalled: true,
            simulatorRemoved: true,
            relayClosed: true,
            sourcesStable: true,
            cacheStable: true,
            executableStable: true,
        });
        for (const key of [
            'freshRustBuild',
            'sourceBinaryProvenanceProved',
            'independentlyReviewed',
            'liveAuth',
            'physicalDeviceExecution',
            'productionTouched',
            'humanDevicesChanged',
            'hostedActorsChanged',
            'primaryTargetsBuilt',
        ])
            require(row[key] === false);
        row.sharedSlotWaitMs = integer(row.sharedSlotWaitMs, 0, 120000);
        return Object.freeze(row);
    });
}

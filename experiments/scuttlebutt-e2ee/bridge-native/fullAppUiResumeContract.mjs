/** Pure exact-aXIcUx cached-artifact planning, not a general future-cache
 * admission policy. No files, signing, simulator, Auth or I/O. */
import { isAbsolute, join, resolve } from 'node:path';
import {
    FULL_APP_NATIVE_PHASES,
    inspectFullAppNativeEnvelope,
    inspectFullAppNativeReceipt,
} from './fullAppUiContract.mjs';

export const FULL_APP_CACHED_SWIFT_SOURCES = Object.freeze(
    [
        ...[
            'ResearchApp.swift',
            'ScuttlebuttResearchAuthPlugin.swift',
            'ResearchAuthHost.swift',
            'ResearchMessagingAdapter.swift',
            'ResearchPrivateMessageAdapter.swift',
            'ResearchLocalUiFixture.swift',
            'ResearchFullAppHttpFence.swift',
        ].map((name) => 'bridge-native/' + name),
        'VodozemacSealedStore.swift',
        'VodozemacDmFrame.swift',
        'VodozemacDmCoordinator.swift',
        'VodozemacMessageOperations.swift',
        'VodozemacRelayCodec.swift',
        'VodozemacRelayTransport.swift',
        'VodozemacRelayResult.swift',
        'VodozemacRelayPolicy.swift',
        'VodozemacScopedRelayClient.swift',
        'VodozemacSupabaseAuth.swift',
        'VodozemacAuthSession.swift',
        'VodozemacAccountDirectory.swift',
        'VodozemacSessionFacade.swift',
    ].map((name) => 'experiments/scuttlebutt-e2ee/' + name),
);
const refusal = () => {
    throw new Error('Full App cached resume contract refused');
};
const require = (value) => {
    if (!value) refusal();
};
function data(row, key) {
    const property = Object.getOwnPropertyDescriptor(row, key);
    require(property && 'value' in property);
    return property.value;
}
function exact(raw, keys) {
    require(raw && typeof raw === 'object' && !Array.isArray(raw));
    const names = Reflect.ownKeys(raw);
    require(names.length === keys.length && names.every((key) => typeof key === 'string' && keys.includes(key)));
    return Object.fromEntries(keys.map((key) => [key, data(raw, key)]));
}

/** Diagnostic facts cannot turn a failed launch syscall into driver acceptance.
 * The caller reads each known owned file once; no arbitrary container JSON is copied.
 * @param {unknown} failure Fixed launch operation/exit/timeout facts only.
 * @param {unknown} phaseRaw Parsed bounded phase file, or null when absent.
 * @param {unknown} nativeRaw Parsed bounded v2 file, or null when absent.
 * @param {string} runID Original packaged fixture run binding.
 * @param {string} runNonce Original packaged fixture nonce binding.
 */
export function inspectFailedLaunchObservation(failure, phaseRaw, nativeRaw, runID, runNonce) {
    try {
        const fixedFailure = exact(failure, ['operation', 'exitStatus', 'timedOut']);
        require(
            fixedFailure.operation === 'owned-app-launch' &&
                typeof fixedFailure.timedOut === 'boolean' &&
                (fixedFailure.exitStatus === null ||
                    (Number.isSafeInteger(fixedFailure.exitStatus) &&
                        fixedFailure.exitStatus >= 0 &&
                        fixedFailure.exitStatus <= 255)),
        );
        let nativeLaunchPhase = null;
        if (phaseRaw !== null) {
            const phase = exact(phaseRaw, ['version', 'phase']);
            require(
                phase.version === 1 &&
                    [
                        ...FULL_APP_NATIVE_PHASES,
                        'application-launched',
                        'scene-connected',
                        'bridge-created',
                        'fixture-install-failed',
                    ].includes(phase.phase),
            );
            nativeLaunchPhase = phase.phase;
        }
        const nativeFacts = nativeRaw === null ? null : inspectFullAppNativeEnvelope(nativeRaw, runID, runNonce);
        let observedNativeFinalValidated = false;
        if (nativeFacts?.status === 'passed') {
            try {
                inspectFullAppNativeReceipt(nativeFacts, runID, runNonce);
                observedNativeFinalValidated = true;
            } catch {
                // A strict incomplete envelope remains observation only.
            }
        }
        return Object.freeze({
            version: 1,
            captureStatus: phaseRaw === null && nativeRaw === null ? 'absent' : 'validated',
            outerDriverAccepted: false,
            failure: Object.freeze(fixedFailure),
            phaseFilePresent: phaseRaw !== null,
            nativeFilePresent: nativeRaw !== null,
            nativeLaunchPhase,
            nativeFacts,
            observedNativeFinalValidated,
        });
    } catch {
        return refusal();
    }
}
function hash(value) {
    require(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value.length === 64);
    return value;
}
function absolute(value) {
    require(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\\'));
    return value;
}
function map(raw, count, exactNames) {
    require(raw && typeof raw === 'object' && !Array.isArray(raw));
    const names = Reflect.ownKeys(raw);
    require(names.length === count && names.every((name) => typeof name === 'string'));
    if (exactNames) require(names.every((name) => exactNames.includes(name)));
    else
        require(
            names.every(
                (name) =>
                    name !== '' &&
                    !name.startsWith('/') &&
                    !name.includes('\\') &&
                    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
            ),
        );
    return Object.freeze(Object.fromEntries(names.map((name) => [name, hash(data(raw, name))])));
}

export const FULL_APP_CACHED_RUNTIME_IDS = Object.freeze([
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
]);
const cachedDeviceTypeId = 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation';
export const FULL_APP_CONTROL_BUNDLE = 'com.apple.Preferences';
// Diagnostic timing hypothesis only; no arbitrary CLI bound or retry.
export const FULL_APP_CONTROL_LAUNCH_BOUND_MS = 120000;

/** Cached-mode tail only: optional wait/runtime, then one fixed control probe. */
export function inspectCachedResumeOptions(raw) {
    try {
        require(Array.isArray(raw));
        const length = data(raw, 'length');
        require(Number.isSafeInteger(length) && length >= 0 && length <= 4);
        const tail = Array.from({ length }, (_, index) => data(raw, String(index)));
        require(Reflect.ownKeys(raw).length === tail.length + 1 && tail.every((value) => typeof value === 'string'));
        let remainingWaitMs = null,
            requestedRuntimeId = null;
        let controlLaunchProbe = false;
        if (tail.length && !['--runtime', '--control-launch-probe'].includes(tail[0])) {
            require(/^(?:0|[1-9][0-9]{0,5})$/.exec(tail[0])?.[0] === tail[0] && Number(tail[0]) <= 120000);
            remainingWaitMs = Number(tail.shift());
        }
        if (tail[0] === '--runtime') {
            require(tail.length >= 2 && FULL_APP_CACHED_RUNTIME_IDS.includes(tail[1]));
            requestedRuntimeId = tail.splice(0, 2)[1];
        }
        if (tail.length) {
            require(
                tail.length === 1 &&
                    tail[0] === '--control-launch-probe' &&
                    requestedRuntimeId === FULL_APP_CACHED_RUNTIME_IDS[1],
            );
            controlLaunchProbe = true;
        }
        return Object.freeze({
            remainingWaitMs,
            requestedRuntimeId,
            ...(controlLaunchProbe ? { controlLaunchProbe: true } : {}),
        });
    } catch {
        return refusal();
    }
}

/** Only fixed built-in Settings facts leave the fresh owned app inventory.
 * This is launch-path evidence, not a control-binary provenance claim.
 * @param {unknown} raw Parsed bounded installed-application inventory.
 */
export function inspectControlLaunchMetadata(raw) {
    try {
        require(raw && typeof raw === 'object' && !Array.isArray(raw));
        require(Reflect.ownKeys(raw).length > 0 && Reflect.ownKeys(raw).length <= 500);
        const app = data(raw, FULL_APP_CONTROL_BUNDLE);
        require(app && typeof app === 'object' && !Array.isArray(app));
        require(data(app, 'ApplicationType') === 'System');
        if (Object.getOwnPropertyDescriptor(app, 'CFBundleIdentifier'))
            require(data(app, 'CFBundleIdentifier') === FULL_APP_CONTROL_BUNDLE);
        return Object.freeze({
            version: 1,
            bundleIdentifier: FULL_APP_CONTROL_BUNDLE,
            applicationType: 'System',
            installedSystemMetadataVerified: true,
            controlBinaryProvenanceProved: false,
        });
    } catch {
        return refusal();
    }
}

/** Fixed syscall facts; stdout is only used for one exact bundle/PID pattern.
 * No body/error/options or arbitrary process identity leaves this inspector.
 * @param {unknown} raw Fixed exitStatus/timedOut/stdout observation.
 */
export function inspectControlLaunchObservation(raw) {
    try {
        const row = exact(raw, ['exitStatus', 'timedOut', 'stdout']);
        require(
            typeof row.timedOut === 'boolean' &&
                (row.exitStatus === null ||
                    (Number.isSafeInteger(row.exitStatus) && row.exitStatus >= 0 && row.exitStatus <= 255)) &&
                typeof row.stdout === 'string' &&
                row.stdout.length <= 4096,
        );
        const found = /^com\.apple\.Preferences: ([1-9][0-9]{0,8})\s*$/.exec(row.stdout);
        const returnedPID = found ? Number(found[1]) : null;
        return Object.freeze({
            version: 1,
            exitStatus: row.exitStatus,
            timedOut: row.timedOut,
            returnedPID,
            launchCallAccepted: row.exitStatus === 0 && row.timedOut === false && returnedPID !== null,
            nativeResearchAcceptanceProved: false,
        });
    } catch {
        return refusal();
    }
}

/** Only copied selection facts leave the actual read-only runtime inventory.
 * @param {unknown} raw Parsed inventory, never a native authority input.
 * @param {string | null} [requestedRuntimeId] Exact cached-mode option or default.
 */
export function inspectCachedRuntimeSelection(raw, requestedRuntimeId = null) {
    try {
        require(requestedRuntimeId === null || FULL_APP_CACHED_RUNTIME_IDS.includes(requestedRuntimeId));
        require(Array.isArray(raw));
        const length = data(raw, 'length');
        require(Number.isSafeInteger(length) && length > 0 && length <= 100);
        const selectedId = requestedRuntimeId ?? FULL_APP_CACHED_RUNTIME_IDS[0];
        const selected = [];
        for (let index = 0; index < length; index += 1) {
            const row = data(raw, String(index));
            require(row && typeof row === 'object' && !Array.isArray(row));
            if (data(row, 'identifier') === selectedId) selected.push(row);
        }
        require(selected.length === 1);
        const row = selected[0],
            version = selectedId === FULL_APP_CACHED_RUNTIME_IDS[0] ? '26.5' : '27.0';
        const build = selectedId === FULL_APP_CACHED_RUNTIME_IDS[0] ? '23F77' : '24A434';
        require(
            data(row, 'isAvailable') === true &&
                data(row, 'version') === version &&
                data(row, 'buildversion') === build,
        );
        const models = data(row, 'supportedDeviceTypes');
        require(Array.isArray(models));
        const modelLength = data(models, 'length');
        require(Number.isSafeInteger(modelLength) && modelLength > 0 && modelLength <= 100);
        let chosen = 0;
        for (let index = 0; index < modelLength; index += 1) {
            const model = data(models, String(index));
            require(model && typeof model === 'object' && !Array.isArray(model));
            if (data(model, 'identifier') === cachedDeviceTypeId) {
                if (Object.getOwnPropertyDescriptor(model, 'productFamily'))
                    require(data(model, 'productFamily') === 'iPhone');
                chosen += 1;
            }
        }
        require(chosen === 1);
        return Object.freeze({
            requestedRuntimeId,
            runtimeId: selectedId,
            runtimeVersion: version,
            runtimeBuild: build,
            deviceTypeId: cachedDeviceTypeId,
            observedAvailable: true,
        });
    } catch {
        return refusal();
    }
}

/** Input receipt SHA is pinned by the driver before calling this. Returned
 * paths/hashes are plans, not an independent provenance or execution claim. */
export function inspectFullAppCachedBuild(raw, checkout, expectedWebHash) {
    try {
        require(raw && typeof raw === 'object' && !Array.isArray(raw));
        absolute(checkout);
        hash(expectedWebHash);
        for (const key of [
            'compileOnly',
            'unsignedApplication',
            'applicationSignatureCheckedAbsent',
            'localUiFixture',
            'fullAppUiFixture',
        ])
            require(data(raw, key) === true);
        for (const key of [
            'protectedUiFixture',
            'signingPerformed',
            'installed',
            'launched',
            'primaryCapSyncExecuted',
            'primaryTargetsBuilt',
            'physicalDeviceExecution',
            'freshRustBuild',
            'ordinaryProductionIntegrationEnabled',
            'liveAuthExecuted',
        ])
            require(data(raw, key) === false);
        require(
            data(raw, 'status') === 'passed' &&
                data(raw, 'platform') === 'iphonesimulator' &&
                data(raw, 'bundleId') === 'app.thalassa.research.scuttlebutt-auth' &&
                data(raw, 'publicConfigurationSource') === 'synthetic-local-ui-only' &&
                data(raw, 'fullAppWebReceiptSha256') === expectedWebHash &&
                data(raw, 'fullAppCspTightened') === true,
        );
        const outputRoot = absolute(data(raw, 'outputRoot'));
        require(!outputRoot.startsWith(checkout + '/') && outputRoot.includes('/T/thalassa-messaging-build-'));
        const projectRoot = join(outputRoot, 'Project'),
            artifactRoot = join(
                outputRoot,
                'DerivedData/Build/Products/Debug-iphonesimulator/ScuttlebuttResearchAuth.app',
            );
        require(
            data(raw, 'projectPath') === join(projectRoot, 'ScuttlebuttResearchAuth.xcodeproj') &&
                data(raw, 'artifact') === artifactRoot,
        );
        const sourceNames = FULL_APP_CACHED_SWIFT_SOURCES.map((name) => join(checkout, name));
        const sourceHashes = map(data(raw, 'sourceHashes'), 20, sourceNames);
        const artifactHashes = map(data(raw, 'artifactHashes'), 304);
        const resourceHash = hash(data(raw, 'localUiFixtureResourceSha256'));
        require(
            artifactHashes['research-local-ui-fixture.json'] === resourceHash &&
                artifactHashes['research-config.json'] === hash(data(raw, 'bundledConfigSha256')) &&
                artifactHashes.ScuttlebuttResearchAuth === hash(data(raw, 'executableSha256')) &&
                artifactHashes['public/index.html'] === hash(data(raw, 'fullAppFixtureHtmlSha256')),
        );
        const bindings = map(data(raw, 'cachedBindingHashes'), 3, [
            'thalassa_vodozemac_native.swift',
            'thalassa_vodozemac_nativeFFI.h',
            'thalassa_vodozemac_nativeFFI.modulemap',
        ]);
        const frameworks = data(raw, 'copiedFrameworkHashes');
        require(
            frameworks &&
                typeof frameworks === 'object' &&
                Reflect.ownKeys(frameworks).length === 2 &&
                Reflect.ownKeys(frameworks).every((key) => ['Capacitor', 'Cordova'].includes(key)),
        );
        const frameworkPlans = ['Capacitor', 'Cordova'].map((name) =>
            Object.freeze({
                root: join(projectRoot, 'Frameworks', name + '.framework'),
                hashes: map(data(frameworks, name), name === 'Capacitor' ? 19 : 22),
            }),
        );
        const entitlements = data(raw, 'simulatorLinkEntitlements');
        require(
            data(entitlements, 'requestedMachOEmbedding') === true &&
                data(entitlements, 'embeddedInMachO') === true &&
                data(entitlements, 'hostCodesignGrant') === false,
        );
        const xml = hash(data(entitlements, 'xmlSha256')),
            der = hash(data(entitlements, 'derSha256'));
        const measured = map(data(entitlements, 'measuredSections'), 2, ['__entitlements', '__ents_der']);
        require(measured.__entitlements === xml && measured.__ents_der === der);
        const originalWebHashes = map(data(raw, 'publicDistInputHashes'), 256);
        return Object.freeze({
            outputRoot,
            projectRoot,
            artifactRoot,
            sourceHashes,
            artifactHashes,
            resourcePath: join(artifactRoot, 'research-local-ui-fixture.json'),
            resourceHash,
            executablePath: join(artifactRoot, 'ScuttlebuttResearchAuth'),
            providerPath: join(projectRoot, 'Provider/libthalassa_vodozemac_native.a'),
            providerHash: hash(data(raw, 'providerSha256')),
            providerManifestHash: hash(data(raw, 'providerManifestSha256')),
            providerLockHash: hash(data(raw, 'providerLockfileSha256')),
            bindingRoot: join(projectRoot, 'Bindings'),
            bindings,
            frameworkPlans: Object.freeze(frameworkPlans),
            originalWebHashes,
            nativePublicHashes: Object.freeze({
                ...originalWebHashes,
                'index.html': hash(data(raw, 'fullAppFixtureHtmlSha256')),
            }),
            expectedEntitlementSections: Object.freeze({ __entitlements: xml, __ents_der: der }),
            entitlementInspectorHash: hash(data(entitlements, 'inspectorSha256')),
            originalBuilderHash: hash(data(raw, 'runnerSha256')),
            originalContractHash: hash(data(raw, 'fullAppFixtureContractSha256')),
            frameworkReceiptHash: hash(data(raw, 'localUiFrameworksReceiptSha256')),
            priorExchangeReceiptHash: hash(data(raw, 'priorNativeResearchReceiptSha256')),
            researchConfigHash: hash(data(raw, 'bundledConfigSha256')),
        });
    } catch {
        return refusal();
    }
}

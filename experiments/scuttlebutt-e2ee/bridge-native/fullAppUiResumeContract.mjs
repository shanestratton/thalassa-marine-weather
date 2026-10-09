/** Pure exact-aXIcUx cached-artifact planning, not a general future-cache
 * admission policy. No files, signing, simulator, Auth or I/O. */
import { isAbsolute, join, resolve } from 'node:path';

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

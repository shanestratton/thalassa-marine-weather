/** Pure receipt/request contracts. Fixtures do not launch a browser or grant authority. */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const WINDOW_EVIDENCE_GLOBAL = '__THALASSA_FULL_APP_WINDOW_EVIDENCE__';
export const WINDOW_REMOUNT_GLOBAL = '__THALASSA_FULL_APP_WINDOW_REMOUNT__';
export const WINDOW_RUN_QUERY = 'fullAppWindowProofRun';
export const WINDOW_NONCE_QUERY = 'fullAppWindowProofNonce';
export const WINDOW_CSP_CONTROL_PATH = '/__thalassa_full_app_csp_probe__';
export const WINDOW_CSP_CONTROL_ELEMENT = 'audio';
export const WINDOW_CSP_CONTROL_DIRECTIVE = 'media-src';
export const WINDOW_PROOF_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const WINDOW_FENCE_COUNTERS = Object.freeze([
    'fetch',
    'xhr',
    'webSocket',
    'eventSource',
    'beacon',
    'preservedFetch',
    'preservedXhr',
    'worker',
    'sharedWorker',
    'serviceWorker',
    'caches',
    'indexedDB',
    'geolocation',
    'media',
    'clipboard',
    'audio',
    'navigation',
    'permissions',
    'otherNetwork',
    'localStorageReads',
    'localStorageWrites',
    'sessionStorageReads',
    'sessionStorageWrites',
    'storageRefused',
    'storageManager',
    'patchFailures',
    'locationPatchUnavailable',
    'authRequests',
    'authResponses',
    'authRefused',
]);
export const WINDOW_BOUNDARY_COUNTERS = Object.freeze([
    'instrumentRequests',
    'gpsRequests',
    'internetRequests',
    'aisRequests',
    'appleRequests',
    'anchorRequests',
    'anchorSyncRequests',
    'anchorPiRequests',
    'shiplogRequests',
    'vesselRequests',
    'piRequests',
    'nativeRequests',
    'observations',
    'subscriptions',
    'cleanups',
]);
export const WINDOW_MEMORY_COUNTERS = Object.freeze([
    'preferenceReads',
    'preferenceWrites',
    'preferenceRemovals',
    'preferenceClears',
    'preferenceKeys',
    'cacheReads',
    'cacheWrites',
    'cacheRemovals',
    'cacheFlushes',
    'versionReads',
    'versionWrites',
    'refusals',
]);
const mainRoutingWorkerSources = Object.freeze([
    'services/routing/routeWorkerHost.ts',
    'services/routing/routeJob.ts',
    'services/engine/navGridWorkerHost.ts',
]);
export const WINDOW_REQUIRED_BUILD_SOURCES = Object.freeze([
    'App.tsx',
    'viewRegistry.tsx',
    'hooks/useAppBootstrap.ts',
    'context/ThalassaContext.tsx',
    'contexts/CrewCountContext.tsx',
    'components/ChatPage.tsx',
    ...mainRoutingWorkerSources,
    'experiments/scuttlebutt-e2ee/app-pilot/PrivateMessageResearchApp.tsx',
    ...[
        'entry.ts',
        'sdk.ts',
        'main.tsx',
        'FullAppResearchRoot.tsx',
        'windowEvidence.ts',
        'ioFence.ts',
        'core.ts',
        'authProjection.ts',
        'authStore.ts',
        'boundaries.ts',
        'boundaryMemory.ts',
    ].map((name) => 'experiments/scuttlebutt-e2ee/full-app-pilot/' + name),
]);
export const WINDOW_REQUIRED_WORKER_ENTRY_SOURCES = Object.freeze([
    'services/enc/encParseWorker.ts',
    'services/enc/encGeometryWorker.ts',
    'services/userOverlays/worker.ts',
    'services/weather/gribImportWorker.ts',
    'services/charts/localRasterWorker.ts',
]);
export const WINDOW_REQUIRED_PROOF_SOURCES = Object.freeze([
    ...['vite.config.mjs', 'graphIsolation.mjs', 'brandAsset.mjs', 'windowProof.mjs', 'windowProofContract.mjs'].map(
        (name) => 'experiments/scuttlebutt-e2ee/full-app-pilot/' + name,
    ),
    'tests/E2eeFullAppWindowProof.test.ts',
]);
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => {
    throw new Error('Full App Window proof contract refused');
};
const demand = (value) => {
    if (!value) fail();
};
function data(row, key) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    demand(descriptor && 'value' in descriptor);
    return descriptor.value;
}
function exact(row, names) {
    demand(row !== null && typeof row === 'object' && !Array.isArray(row));
    const keys = Reflect.ownKeys(row);
    demand(
        keys.length === names.length &&
            keys.every((key) => typeof key === 'string') &&
            keys.sort().join(',') === [...names].sort().join(','),
    );
    return Object.fromEntries(names.map((name) => [name, data(row, name)]));
}
const count = (value, limit = 10000) => {
    demand(Number.isInteger(value) && value >= 0 && value <= limit);
    return value;
};
function counts(row, names, limit = 10000) {
    const result = exact(row, names);
    for (const key of names) result[key] = count(result[key], limit);
    return Object.freeze(result);
}
function nullableBoolean(value) {
    demand(value === null || typeof value === 'boolean');
    return value;
}
export const isWindowProofRun = (value) => typeof value === 'string' && value.length === 36 && uuidPattern.test(value);
export const isWindowProofHash = (value) => typeof value === 'string' && value.length === 64 && hashPattern.test(value);

/** Header and meta CSP can each report the same blocked resource. Neither policy is removed. */
export function inspectWindowCspControl(raw) {
    const row = exact(raw, [
        'element',
        'directive',
        'expectedEventCount',
        'unexpectedEventCount',
        'enforcingPolicyCount',
    ]);
    demand(row.element === WINDOW_CSP_CONTROL_ELEMENT && row.directive === WINDOW_CSP_CONTROL_DIRECTIVE);
    demand(count(row.enforcingPolicyCount, 2) === 2);
    demand(count(row.expectedEventCount, 2) >= 1 && count(row.unexpectedEventCount) === 0);
    return Object.freeze(row);
}

/** Only fixed names/scalars leave the browser. Invalid snapshots are never copied to receipts. */
export function inspectWindowEvidence(raw, runId) {
    demand(isWindowProofRun(runId));
    const row = exact(raw, [
        'version',
        'runId',
        'phase',
        'fence',
        'sdk',
        'root',
        'auth',
        'authScope',
        'privateSelection',
        'legacyPermitAvailable',
        'core',
        'boundaries',
        'memory',
        'lifecycle',
    ]);
    demand(row.version === 1 && row.runId === runId && ['starting', 'ready', 'failed'].includes(row.phase));
    let fence = null;
    if (row.fence !== null) {
        const value = exact(row.fence, ['version', 'status', 'counts']);
        demand(value.version === 1 && ['uninstalled', 'installed', 'failed'].includes(value.status));
        fence = Object.freeze({ ...value, counts: counts(value.counts, WINDOW_FENCE_COUNTERS) });
    }
    let core = null;
    if (row.core !== null) {
        core = exact(row.core, ['registrationAttempts', 'methodAttempts', 'platform']);
        demand(['web', 'ios'].includes(core.platform));
        core.registrationAttempts = count(core.registrationAttempts, 1024);
        core.methodAttempts = count(core.methodAttempts, 1024);
        core = Object.freeze(core);
    }
    const auth = exact(row.auth, ['status', 'userPresent', 'authChecked']);
    demand(
        [
            'unknown',
            'detached',
            'inactive',
            'unsupported',
            'unavailable',
            'signed_out',
            'verifying',
            'authenticated',
        ].includes(auth.status),
    );
    auth.userPresent = nullableBoolean(auth.userPresent);
    auth.authChecked = nullableBoolean(auth.authChecked);
    const scope = exact(row.authScope, [
        'originalUserPresent',
        'originalAnonymous',
        'originalGeneration',
        'currentUserPresent',
        'currentAnonymous',
        'currentGeneration',
    ]);
    for (const name of ['originalUserPresent', 'originalAnonymous', 'currentUserPresent', 'currentAnonymous'])
        scope[name] = nullableBoolean(scope[name]);
    for (const name of ['originalGeneration', 'currentGeneration'])
        if (scope[name] !== null) scope[name] = count(scope[name]);
    const lifecycle = exact(row.lifecycle, ['stopped']);
    demand(typeof lifecycle.stopped === 'boolean');
    demand(row.privateSelection === null || ['native-unavailable', 'native-pilot'].includes(row.privateSelection));
    demand(row.legacyPermitAvailable === null || typeof row.legacyPermitAvailable === 'boolean');
    return Object.freeze({
        version: 1,
        runId,
        phase: row.phase,
        fence,
        sdk: counts(row.sdk, ['runtimeCreations', 'sdkConstructions', 'nativeCalls']),
        root: counts(row.root, ['mounts', 'remounts', 'closedRenders']),
        auth: Object.freeze(auth),
        authScope: Object.freeze(scope),
        privateSelection: row.privateSelection,
        legacyPermitAvailable: row.legacyPermitAvailable,
        core,
        boundaries: row.boundaries === null ? null : counts(row.boundaries, WINDOW_BOUNDARY_COUNTERS, 1024),
        memory: row.memory === null ? null : counts(row.memory, WINDOW_MEMORY_COUNTERS, 1024),
        lifecycle: Object.freeze(lifecycle),
    });
}

/** Unsupported acceptance does not relabel denied leaf calls/storage as zero transports. */
export function requireUnsupportedWindowEvidence(value, mounts, remounts, stopped = false) {
    demand(value.phase === 'ready' && value.fence?.status === 'installed' && value.fence.counts.patchFailures === 0);
    demand(value.core?.platform === 'web' && value.boundaries !== null && value.memory !== null);
    demand(value.auth.status === (stopped ? 'inactive' : 'unsupported'));
    demand(value.auth.userPresent === false && value.auth.authChecked === true);
    demand(value.privateSelection === 'native-unavailable' && value.legacyPermitAvailable === false);
    demand(value.sdk.runtimeCreations === mounts && value.sdk.sdkConstructions === 0 && value.sdk.nativeCalls === 0);
    demand(value.root.mounts === mounts && value.root.remounts === remounts && value.root.closedRenders >= mounts);
    demand(value.lifecycle.stopped === stopped);
    const scope = value.authScope;
    demand(
        scope.originalUserPresent === false &&
            scope.currentUserPresent === false &&
            scope.originalAnonymous === true &&
            scope.currentAnonymous === true &&
            scope.originalGeneration !== null &&
            scope.currentGeneration !== null,
    );
    for (const name of [
        'fetch',
        'xhr',
        'webSocket',
        'eventSource',
        'beacon',
        'preservedFetch',
        'preservedXhr',
        'worker',
        'sharedWorker',
        'serviceWorker',
        'otherNetwork',
        'authRequests',
        'authResponses',
        'authRefused',
    ])
        demand(value.fence.counts[name] === 0);
    return value;
}

/** This is the isolated Vite receipt schema, not the broad review manifest. */
export function inspectWindowBuildReceipt(raw, checkout) {
    demand(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
    const value = (key) => data(raw, key);
    demand(
        value('schemaVersion') === 1 &&
            value('status') === 'passed' &&
            value('config') === 'experiments/scuttlebutt-e2ee/full-app-pilot/vite.config.mjs' &&
            value('publicAssetsCopied') === false &&
            value('automaticPublicDirectoryCopy') === false &&
            value('inheritedCanariesAbsent') === true &&
            value('inheritedSyntheticCanariesInjected') === true,
    );
    const omissions = value('moduleSourceHashOmissions');
    demand(Array.isArray(omissions) && omissions.length === 0);
    const inputs = value('moduleSourceInputs'),
        outputs = value('outputs');
    function items(list, max) {
        demand(Array.isArray(list) && list.length > 0 && list.length <= max);
        const keys = Reflect.ownKeys(list);
        demand(
            keys.length === list.length + 1 &&
                keys.every(
                    (key) =>
                        key === 'length' ||
                        (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < list.length),
                ),
        );
        return Array.from({ length: list.length }, (_, index) => data(list, String(index)));
    }
    function rows(list, max, names = ['path', 'sha256']) {
        const seen = new Set();
        return items(list, max).map((item) => {
            const row = exact(item, names);
            demand(
                typeof row.path === 'string' &&
                    isAbsolute(row.path) &&
                    resolve(row.path) === row.path &&
                    isWindowProofHash(row.sha256) &&
                    !seen.has(row.path),
            );
            seen.add(row.path);
            return Object.freeze(row);
        });
    }
    const sourceInputs = rows(inputs, 10000),
        artifacts = rows(outputs, 2000);
    const assetInputs = rows(value('explicitAssetSourceInputs'), 1);
    const expectedAssetHash = '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1';
    demand(
        assetInputs.length === 1 &&
            assetInputs[0].path === resolve(checkout, 'public/thalassa-icon-128.png') &&
            assetInputs[0].sha256 === expectedAssetHash,
    );
    const proofSources = rows(value('windowProofSourceInputs'), 100);
    for (const name of WINDOW_REQUIRED_PROOF_SOURCES)
        demand(proofSources.some((row) => row.path === resolve(checkout, name)));
    demand(proofSources.every((row) => row.path.startsWith(checkout + sep)));
    demand(value('outputCount') === artifacts.length);
    for (const name of WINDOW_REQUIRED_BUILD_SOURCES)
        demand(sourceInputs.some((row) => row.path === resolve(checkout, name)));
    const workerEntrySourceInputs = rows(
        value('workerEntrySourceInputs'),
        WINDOW_REQUIRED_WORKER_ENTRY_SOURCES.length,
        ['path', 'sha256', 'graph'],
    );
    demand(workerEntrySourceInputs.length === WINDOW_REQUIRED_WORKER_ENTRY_SOURCES.length);
    const workerPaths = new Set(WINDOW_REQUIRED_WORKER_ENTRY_SOURCES.map((name) => resolve(checkout, name))),
        workerGraphs = new Set(WINDOW_REQUIRED_WORKER_ENTRY_SOURCES.map((_, index) => 'worker-' + (index + 1))),
        seenWorkerGraphs = new Set();
    for (const row of workerEntrySourceInputs) {
        demand(
            workerPaths.has(row.path) &&
                workerGraphs.has(row.graph) &&
                !seenWorkerGraphs.has(row.graph) &&
                sourceInputs.some((source) => source.path === row.path && source.sha256 === row.sha256),
        );
        seenWorkerGraphs.add(row.graph);
    }
    const html = artifacts.filter((row) => row.path.endsWith(sep + 'index.html'));
    demand(html.length === 1);
    const dist = dirname(html[0].path);
    const emissions = value('explicitAssetEmissions');
    demand(Array.isArray(emissions) && emissions.length === 1);
    const emission = exact(emissions[0], ['label', 'input', 'output', 'byteLength', 'width', 'height']);
    const input = exact(emission.input, ['path', 'sha256']),
        output = exact(emission.output, ['path', 'sha256']);
    demand(
        emission.label === 'app-brand-icon-128' &&
            emission.byteLength === 9036 &&
            emission.width === 256 &&
            emission.height === 256,
    );
    demand(input.path === assetInputs[0].path && input.sha256 === expectedAssetHash);
    demand(
        output.path === resolve(dist, 'thalassa-icon-128.png') &&
            output.sha256 === expectedAssetHash &&
            artifacts.some((row) => row.path === output.path && row.sha256 === output.sha256),
    );
    demand(
        artifacts.every((row) => {
            const name = relative(dist, row.path);
            return name !== '' && !name.startsWith('..' + sep) && !isAbsolute(name) && !name.includes('\\');
        }),
    );
    const graphNames = new Set(['main', ...workerGraphs]),
        graphs = items(value('graphPolicyObservations'), graphNames.size),
        seenGraphs = new Set();
    demand(graphs.length === graphNames.size && value('workerGraphCount') === workerEntrySourceInputs.length);
    for (const graph of graphs) {
        const row = exact(graph, ['graph', 'isWorker', 'closedGraphInstances', 'workerFormat']);
        demand(
            graphNames.has(row.graph) &&
                !seenGraphs.has(row.graph) &&
                row.isWorker === (row.graph !== 'main') &&
                row.closedGraphInstances === 1 &&
                row.workerFormat === 'es',
        );
        seenGraphs.add(row.graph);
    }
    const seenModules = new Map(),
        sourcePaths = new Set(sourceInputs.map((row) => row.path)),
        representedSourcePaths = new Set();
    const moduleInventory = items(value('moduleInventory'), 10000).map((module) => {
        const row = exact(module, ['graph', 'id', 'virtual', 'transformedCodeSha256']);
        demand(
            graphNames.has(row.graph) &&
                typeof row.id === 'string' &&
                row.id.length > 0 &&
                row.id.length <= 4096 &&
                typeof row.virtual === 'boolean' &&
                row.virtual === row.id.startsWith('\0') &&
                isWindowProofHash(row.transformedCodeSha256),
        );
        if (!row.virtual) {
            const path = row.id.split(/[?#]/)[0];
            demand(
                path.length > 0 &&
                    !path.includes('\0') &&
                    isAbsolute(path) &&
                    resolve(path) === path &&
                    sourcePaths.has(path),
            );
            // Transformed code can differ from source bytes. The caller checks
            // the frozen raw digests; every compiled source must map to one.
            representedSourcePaths.add(path);
        }
        if (!seenModules.has(row.graph)) seenModules.set(row.graph, new Set());
        const graphModules = seenModules.get(row.graph);
        demand(!graphModules.has(row.id));
        graphModules.add(row.id);
        return Object.freeze(row);
    });
    for (const source of sourceInputs) demand(representedSourcePaths.has(source.path));
    for (const worker of workerEntrySourceInputs)
        demand(
            moduleInventory.some(
                (row) => row.graph === worker.graph && row.id === worker.path && row.virtual === false,
            ),
        );
    for (const name of mainRoutingWorkerSources) {
        const path = resolve(checkout, name);
        demand(moduleInventory.some((row) => row.graph === 'main' && row.id === path && row.virtual === false));
        demand(sourceInputs.some((row) => row.path === path));
    }
    return Object.freeze({
        sourceInputs: Object.freeze([...sourceInputs, ...assetInputs]),
        workerEntrySourceInputs: Object.freeze(workerEntrySourceInputs),
        moduleInventory: Object.freeze(moduleInventory),
        proofSources: Object.freeze(proofSources),
        artifacts: Object.freeze(artifacts),
        dist,
    });
}

/** Request classification never returns a URL, query, body or credential. */
export function classifyWindowRequest({ url, method, origin, runId, nonce, assetPaths }) {
    try {
        if (!isWindowProofRun(runId) || !isWindowProofHash(nonce)) return 'refused';
        const target = new URL(url);
        if (method !== 'GET' || target.origin !== origin || target.username || target.password || target.hash)
            return 'refused';
        if (target.pathname === '/index.html') {
            const keys = [...target.searchParams.keys()].sort();
            return keys.join(',') === [WINDOW_NONCE_QUERY, WINDOW_RUN_QUERY].sort().join(',') &&
                target.searchParams.get(WINDOW_RUN_QUERY) === runId &&
                target.searchParams.get(WINDOW_NONCE_QUERY) === nonce
                ? 'document'
                : 'refused';
        }
        if (target.search) return 'refused';
        if (target.pathname === '/favicon.ico') return 'favicon-control';
        if (target.pathname === WINDOW_CSP_CONTROL_PATH) return 'csp-control';
        return assetPaths.has(target.pathname) ? 'asset' : 'refused';
    } catch {
        return 'refused';
    }
}

/** Diagnostic only. Never decides whether a request may proceed, and never
 * exports a URL/path/query/header/body. The one semantic label is audited from
 * the ordinary App's static brand-image literal; all other paths stay unknown.
 */
export function describeWindowRefusal({ url, resourceType, method, origin, redirectChain }) {
    const resourceTypes = new Set([
        'document',
        'stylesheet',
        'image',
        'media',
        'font',
        'script',
        'texttrack',
        'xhr',
        'fetch',
        'eventsource',
        'websocket',
        'manifest',
        'other',
    ]);
    const target = new URL(url);
    const sameLoopbackOrigin = target.origin === origin;
    return Object.freeze({
        resourceType: resourceTypes.has(resourceType) ? resourceType : 'other',
        protocol: { 'http:': 'http', 'https:': 'https', 'data:': 'data', 'blob:': 'blob' }[target.protocol] ?? 'other',
        sameLoopbackOrigin,
        method: method === 'GET' || method === 'POST' ? method : 'other',
        hasQuery: target.search !== '',
        hasFragment: target.hash !== '',
        redirectChain: redirectChain === true,
        pathSha256: sameLoopbackOrigin ? createHash('sha256').update(target.pathname).digest('hex') : null,
        assetLabel:
            sameLoopbackOrigin && target.pathname === '/thalassa-icon-128.png' ? 'app-brand-icon-128' : 'unknown',
    });
}

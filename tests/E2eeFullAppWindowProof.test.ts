/** Pure contracts only. These cases never launch Chrome, start a server or exercise native/SDK Auth. */
import { describe, expect, it } from 'vitest';
import {
    WINDOW_BOUNDARY_COUNTERS,
    WINDOW_MEMORY_COUNTERS,
    WINDOW_FENCE_COUNTERS,
    WINDOW_REQUIRED_BUILD_SOURCES,
    WINDOW_REQUIRED_PROOF_SOURCES,
    WINDOW_RUN_QUERY,
    WINDOW_NONCE_QUERY,
    WINDOW_CSP_CONTROL_PATH,
    WINDOW_CSP_CONTROL_ELEMENT,
    WINDOW_CSP_CONTROL_DIRECTIVE,
    classifyWindowRequest,
    describeWindowRefusal,
    inspectWindowBuildReceipt,
    inspectWindowCspControl,
    inspectWindowEvidence,
    isWindowProofHash,
    isWindowProofRun,
    requireUnsupportedWindowEvidence,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/windowProofContract.mjs';

const runId = '93000000-0000-4000-8000-000000000001';
const nonce = 'a'.repeat(64),
    digest = 'b'.repeat(64),
    checkout = '/owned/thalassa';
const zero = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 0]));
function evidence() {
    return {
        version: 1,
        runId,
        phase: 'ready',
        fence: { version: 1, status: 'installed', counts: zero(WINDOW_FENCE_COUNTERS) },
        sdk: { runtimeCreations: 1, sdkConstructions: 0, nativeCalls: 0 },
        root: { mounts: 1, remounts: 0, closedRenders: 1 },
        auth: { status: 'unsupported', userPresent: false, authChecked: true },
        authScope: {
            originalUserPresent: false,
            originalAnonymous: true,
            originalGeneration: 0,
            currentUserPresent: false,
            currentAnonymous: true,
            currentGeneration: 0,
        },
        privateSelection: 'native-unavailable',
        legacyPermitAvailable: false,
        core: { registrationAttempts: 16, methodAttempts: 0, platform: 'web' },
        boundaries: zero(WINDOW_BOUNDARY_COUNTERS),
        memory: zero(WINDOW_MEMORY_COUNTERS),
        lifecycle: { stopped: false },
    };
}
function buildReceipt() {
    return {
        schemaVersion: 1,
        status: 'passed',
        config: 'experiments/scuttlebutt-e2ee/full-app-pilot/vite.config.mjs',
        publicAssetsCopied: false,
        automaticPublicDirectoryCopy: false,
        inheritedCanariesAbsent: true,
        inheritedSyntheticCanariesInjected: true,
        moduleSourceHashOmissions: [],
        workerGraphCount: 3,
        moduleSourceInputs: WINDOW_REQUIRED_BUILD_SOURCES.map((name: string) => ({
            path: checkout + '/' + name,
            sha256: digest,
        })),
        explicitAssetSourceInputs: [
            {
                path: checkout + '/public/thalassa-icon-128.png',
                sha256: '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1',
            },
        ],
        explicitAssetEmissions: [
            {
                label: 'app-brand-icon-128',
                input: {
                    path: checkout + '/public/thalassa-icon-128.png',
                    sha256: '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1',
                },
                output: {
                    path: '/owned/built/dist/thalassa-icon-128.png',
                    sha256: '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1',
                },
                byteLength: 9036,
                width: 256,
                height: 256,
            },
        ],
        windowProofSourceInputs: WINDOW_REQUIRED_PROOF_SOURCES.map((name: string) => ({
            path: checkout + '/' + name,
            sha256: digest,
        })),
        outputs: [
            { path: '/owned/built/dist/index.html', sha256: digest },
            { path: '/owned/built/dist/assets/entry.js', sha256: digest },
            {
                path: '/owned/built/dist/thalassa-icon-128.png',
                sha256: '5beb04af8d53a700cddcfca1a4a0b9120ea22aa136e1cf03d79add6814b0aab1',
            },
        ],
        outputCount: 3,
        graphPolicyObservations: [false, true, true, true].map((isWorker) => ({
            isWorker,
            closedGraphInstances: 1,
            workerFormat: 'es',
        })),
    };
}
const inspect = (row: ReturnType<typeof evidence>) => inspectWindowEvidence(row, runId);
const accepted = (row: ReturnType<typeof evidence>) => requireUnsupportedWindowEvidence(inspect(row), 1, 0);
const control = (expectedEventCount: unknown, unexpectedEventCount = 0, enforcingPolicyCount = 2) => ({
    element: WINDOW_CSP_CONTROL_ELEMENT,
    directive: WINDOW_CSP_CONTROL_DIRECTIVE,
    expectedEventCount,
    unexpectedEventCount,
    enforcingPolicyCount,
});
describe('bounded CSP positive control — pure fixtures', () => {
    it.each([1, 2])('retains %s observed media refusals from two enforcing policies', (expectedEventCount) => {
        expect(inspectWindowCspControl(control(expectedEventCount))).toEqual(control(expectedEventCount));
    });
    it.each([0, 3, -1, 1.5, NaN, Infinity, null])(
        'refuses absent or excessive event evidence %s',
        (expectedEventCount) => {
            expect(() => inspectWindowCspControl(control(expectedEventCount))).toThrow('contract refused');
        },
    );
    it('refuses an unexpected violation or missing/weakened policy evidence', () => {
        expect(() => inspectWindowCspControl(control(1, 1))).toThrow('contract refused');
        expect(() => inspectWindowCspControl(control(1, 0, 1))).toThrow('contract refused');
    });
    it('requires the fixed audio/media positive control without broadening request admission', () => {
        expect(() => inspectWindowCspControl({ ...control(1), element: 'iframe' })).toThrow('contract refused');
        expect(() => inspectWindowCspControl({ ...control(1), directive: 'frame-src' })).toThrow('contract refused');
        expect(WINDOW_CSP_CONTROL_ELEMENT).toBe('audio');
        expect(WINDOW_CSP_CONTROL_DIRECTIVE).toBe('media-src');
    });
});
describe('bounded actual Window evidence contract — pure fixtures', () => {
    it('keeps honest leaf/storage/location refusal counts without treating them as transports', () => {
        const row = evidence();
        row.fence.counts.locationPatchUnavailable = 3;
        row.fence.counts.localStorageWrites = 4;
        row.boundaries.instrumentRequests = 2;
        row.memory.preferenceReads = 7;
        expect(accepted(row).fence.counts.locationPatchUnavailable).toBe(3);
        expect(accepted(row).memory.preferenceReads).toBe(7);
        expect(accepted(row).core.registrationAttempts).toBe(16);
    });
    it('copies snapshots rather than retaining mutable input', () => {
        const row = evidence(),
            snapshot = inspect(row);
        row.sdk.nativeCalls = 1;
        row.fence.counts.fetch = 1;
        expect(snapshot.sdk.nativeCalls).toBe(0);
        if (snapshot.fence === null) throw new Error('Fixture fence observation unavailable');
        expect(snapshot.fence.counts.fetch).toBe(0);
        expect(Object.isFrozen(snapshot.fence.counts)).toBe(true);
    });
    it('accepts explicit unavailable initial facts without inventing zero snapshots', () => {
        const row = {
            ...evidence(),
            phase: 'starting',
            fence: null,
            core: null,
            boundaries: null,
            memory: null,
            auth: { status: 'unknown', userPresent: null, authChecked: null },
            privateSelection: null,
            authScope: {
                originalUserPresent: null,
                originalAnonymous: null,
                originalGeneration: null,
                currentUserPresent: null,
                currentAnonymous: null,
                currentGeneration: null,
            },
        };
        const snapshot = inspectWindowEvidence(row, runId);
        expect(snapshot.fence).toBeNull();
        expect(snapshot.auth.userPresent).toBeNull();
        expect(() => requireUnsupportedWindowEvidence(snapshot, 1, 0)).toThrow('contract refused');
    });
    it.each([
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
    ])('refuses a measured %s attempt in unsupported acceptance', (name) => {
        const row = evidence();
        row.fence.counts[name] = 1;
        expect(() => accepted(row)).toThrow('contract refused');
    });
    it.each(['sdkConstructions', 'nativeCalls'])('refuses real %s even if the page claims unsupported', (name) => {
        const row = evidence();
        row.sdk[name as 'sdkConstructions' | 'nativeCalls'] = 1;
        expect(() => accepted(row)).toThrow('contract refused');
    });
    it.each([NaN, Infinity, -1, 0.5, 10001])('refuses invalid bounded counts %s', (value) => {
        const row = evidence();
        row.sdk.nativeCalls = value;
        expect(() => inspect(row)).toThrow('contract refused');
    });
    it('refuses unknown data, credentials, wrong run and getters before reading their values', () => {
        const row = evidence(),
            getter = () => {
                throw new Error('Secret getter must not run');
            };
        expect(() => inspectWindowEvidence({ ...row, bearer: 'should-not-be-retained' }, runId)).toThrow(
            'contract refused',
        );
        expect(() => inspectWindowEvidence({ ...row, runId: '93000000-0000-4000-8000-000000000002' }, runId)).toThrow(
            'contract refused',
        );
        Object.defineProperty(row.auth, 'status', { get: getter, enumerable: true });
        expect(() => inspect(row)).toThrow('contract refused');
    });
    it('requires closed selection, truthful browse state, scope and exact mount counts', () => {
        for (const change of [
            (row: ReturnType<typeof evidence>) => {
                row.privateSelection = 'native-pilot';
            },
            (row: ReturnType<typeof evidence>) => {
                row.legacyPermitAvailable = true;
            },
            (row: ReturnType<typeof evidence>) => {
                row.auth.userPresent = true;
            },
            (row: ReturnType<typeof evidence>) => {
                row.auth.authChecked = false;
            },
            (row: ReturnType<typeof evidence>) => {
                row.authScope.currentAnonymous = false;
            },
            (row: ReturnType<typeof evidence>) => {
                row.root.closedRenders = 0;
            },
            (row: ReturnType<typeof evidence>) => {
                row.root.mounts = 2;
            },
        ]) {
            const row = evidence();
            change(row);
            expect(() => accepted(row)).toThrow('contract refused');
        }
    });
    it('requires explicit stopped facts and a fresh composition after remount', () => {
        const row = evidence();
        row.auth.status = 'inactive';
        row.lifecycle.stopped = true;
        expect(requireUnsupportedWindowEvidence(inspect(row), 1, 0, true).lifecycle.stopped).toBe(true);
        row.auth.status = 'unsupported';
        row.lifecycle.stopped = false;
        row.sdk.runtimeCreations = 2;
        row.root = { mounts: 2, remounts: 1, closedRenders: 2 };
        expect(requireUnsupportedWindowEvidence(inspect(row), 2, 1).root.mounts).toBe(2);
        row.sdk.runtimeCreations = 1;
        expect(() => requireUnsupportedWindowEvidence(inspect(row), 2, 1)).toThrow('contract refused');
    });
});
describe('passed hashed isolated build contract — pure fixtures', () => {
    it('accepts exact runtime, proof, artifact and single-gate worker inventories', () => {
        const result = inspectWindowBuildReceipt(buildReceipt(), checkout);
        expect(result.dist).toBe('/owned/built/dist');
        expect(result.artifacts).toHaveLength(3);
        expect(result.proofSources).toHaveLength(WINDOW_REQUIRED_PROOF_SOURCES.length);
    });
    it('refuses older builds without actual Window instrumentation or proof freeze hashes', () => {
        const row = buildReceipt();
        row.moduleSourceInputs = row.moduleSourceInputs.filter((item) => !item.path.endsWith('/windowEvidence.ts'));
        expect(() => inspectWindowBuildReceipt(row, checkout)).toThrow('contract refused');
        const noProof = buildReceipt();
        noProof.windowProofSourceInputs = [];
        expect(() => inspectWindowBuildReceipt(noProof, checkout)).toThrow('contract refused');
    });
    it('refuses missing or mismatched pinned input/output/explicit emission evidence', () => {
        const input = buildReceipt();
        input.explicitAssetSourceInputs[0].sha256 = digest;
        expect(() => inspectWindowBuildReceipt(input, checkout)).toThrow('contract refused');
        const missing = buildReceipt();
        missing.explicitAssetEmissions = [];
        expect(() => inspectWindowBuildReceipt(missing, checkout)).toThrow('contract refused');
        const output = buildReceipt();
        output.explicitAssetEmissions[0].output.sha256 = digest;
        expect(() => inspectWindowBuildReceipt(output, checkout)).toThrow('contract refused');
        const copied = buildReceipt();
        copied.automaticPublicDirectoryCopy = true;
        expect(() => inspectWindowBuildReceipt(copied, checkout)).toThrow('contract refused');
    });
    it('refuses correlated retired asset hashes or retired emission byte length', () => {
        const retired = buildReceipt();
        const oldHash = '629fc1d56dbbc8e0e57f4a46bfdfa353865db69b3cc7707af1be849092440b15';
        retired.explicitAssetSourceInputs[0].sha256 = oldHash;
        retired.explicitAssetEmissions[0].input.sha256 = oldHash;
        retired.explicitAssetEmissions[0].output.sha256 = oldHash;
        retired.outputs[2].sha256 = oldHash;
        expect(() => inspectWindowBuildReceipt(retired, checkout)).toThrow('contract refused');
        const length = buildReceipt();
        length.explicitAssetEmissions[0].byteLength = 31539;
        expect(() => inspectWindowBuildReceipt(length, checkout)).toThrow('contract refused');
    });
    it.each([
        'status',
        'config',
        'publicAssetsCopied',
        'inheritedCanariesAbsent',
        'inheritedSyntheticCanariesInjected',
    ])('refuses unsuccessful/wrong build fact %s', (name) => {
        const row = { ...buildReceipt(), [name]: name === 'publicAssetsCopied' ? true : false };
        expect(() => inspectWindowBuildReceipt(row, checkout)).toThrow('contract refused');
    });
    it('refuses duplicate files, source hash omissions, escaped artifacts and worker-policy weakening', () => {
        const duplicate = buildReceipt();
        duplicate.outputs.push(duplicate.outputs[0]);
        duplicate.outputCount += 1;
        expect(() => inspectWindowBuildReceipt(duplicate, checkout)).toThrow('contract refused');
        const omissions = { ...buildReceipt(), moduleSourceHashOmissions: ['unreadable-source'] };
        expect(() => inspectWindowBuildReceipt(omissions, checkout)).toThrow('contract refused');
        const escaped = buildReceipt();
        escaped.outputs[1].path = '/outside/entry.js';
        expect(() => inspectWindowBuildReceipt(escaped, checkout)).toThrow('contract refused');
        const worker = buildReceipt();
        worker.graphPolicyObservations[1].closedGraphInstances = 2;
        expect(() => inspectWindowBuildReceipt(worker, checkout)).toThrow('contract refused');
    });
    it('refuses malformed hashes and path normalization tricks', () => {
        const row = buildReceipt();
        row.outputs[1].sha256 = 'not-a-hash';
        expect(() => inspectWindowBuildReceipt(row, checkout)).toThrow('contract refused');
        const path = buildReceipt();
        path.outputs[1].path = '/owned/built/dist/assets/../entry.js';
        expect(() => inspectWindowBuildReceipt(path, checkout)).toThrow('contract refused');
        expect(isWindowProofHash(digest.toUpperCase())).toBe(false);
        expect(isWindowProofRun(runId + '\n')).toBe(false);
    });
});
describe('browser/loopback allowlist — pure fixtures', () => {
    const origin = 'http://127.0.0.1:54321';
    const assetPaths = new Set(['/index.html', '/assets/entry.js']);
    const classify = (url: string, method = 'GET') =>
        classifyWindowRequest({ url, method, origin, runId, nonce, assetPaths });
    const documentUrl =
        origin + '/index.html?' + WINDOW_RUN_QUERY + '=' + runId + '&' + WINDOW_NONCE_QUERY + '=' + nonce;
    it('permits only exact hashed assets, the owned nonce document and named controls', () => {
        expect(classify(documentUrl)).toBe('document');
        expect(classify(origin + '/assets/entry.js')).toBe('asset');
        expect(classify(origin + '/favicon.ico')).toBe('favicon-control');
        expect(classify(origin + WINDOW_CSP_CONTROL_PATH)).toBe('csp-control');
    });
    it.each([
        'https://example.invalid/secret',
        'http://127.0.0.1:54322/assets/entry.js',
        origin + '/not-hashed.js',
        origin + '/assets/entry.js?credential=hidden',
        origin + '/index.html',
        documentUrl + '&extra=1',
        documentUrl + '&' + WINDOW_RUN_QUERY + '=' + runId,
        'http://user:secret@127.0.0.1:54321/assets/entry.js',
        'file:///tmp/index.html',
        'not-a-url',
    ])('refuses out-of-scope request without returning sensitive data', (url) => expect(classify(url)).toBe('refused'));
    it('refuses method changes and wrong run/nonce despite a matching pathname', () => {
        expect(classify(documentUrl, 'POST')).toBe('refused');
        expect(classify(documentUrl.replace(nonce, 'c'.repeat(64)))).toBe('refused');
        expect(classify(documentUrl.replace(runId, '93000000-0000-4000-8000-000000000002'))).toBe('refused');
    });
});

describe('bounded refusal diagnostics — pure fixtures only', () => {
    const origin = 'http://127.0.0.1:54321';
    it('labels only the audited brand asset and hashes pathname without returning URL or query', () => {
        const facts = describeWindowRefusal({
            url: origin + '/thalassa-icon-128.png?credential=diagnostic-canary',
            resourceType: 'image',
            method: 'GET',
            origin,
            redirectChain: false,
        });
        expect(facts).toMatchObject({
            resourceType: 'image',
            protocol: 'http',
            sameLoopbackOrigin: true,
            method: 'GET',
            hasQuery: true,
            hasFragment: false,
            redirectChain: false,
            assetLabel: 'app-brand-icon-128',
        });
        expect(facts.pathSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(facts)).not.toMatch(/diagnostic-canary|credential|thalassa-icon|127\.0\.0\.1/);
        expect(Object.isFrozen(facts)).toBe(true);
    });
    it('keeps unknown/cross-origin paths and unsupported enums bounded without path or error contents', () => {
        const local = describeWindowRefusal({
            url: origin + '/unknown-private-path',
            resourceType: 'invented',
            method: 'PATCH',
            origin,
            redirectChain: true,
        });
        expect(local).toMatchObject({
            resourceType: 'other',
            method: 'other',
            sameLoopbackOrigin: true,
            redirectChain: true,
            assetLabel: 'unknown',
        });
        const remote = describeWindowRefusal({
            url: 'https://example.invalid/private?secret=diagnostic-canary#hidden',
            resourceType: 'fetch',
            method: 'POST',
            origin,
            redirectChain: false,
        });
        expect(remote).toMatchObject({
            protocol: 'https',
            sameLoopbackOrigin: false,
            hasQuery: true,
            hasFragment: true,
            pathSha256: null,
            assetLabel: 'unknown',
        });
        expect(JSON.stringify(remote)).not.toMatch(/example|private|secret|diagnostic-canary|hidden/);
    });
});

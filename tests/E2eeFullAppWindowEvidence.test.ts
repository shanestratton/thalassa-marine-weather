// @vitest-environment node
/** Fixed fake-host diagnostic/control fixtures. These do not execute a real
 * Window/App/SDK/native bridge or establish encrypted/security acceptance.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFullAppIoFence } from '../experiments/scuttlebutt-e2ee/full-app-pilot/ioFence';
import { createFullAppStartupBoundaries } from '../experiments/scuttlebutt-e2ee/full-app-pilot/boundaries';
import { createFullAppMemoryBoundary } from '../experiments/scuttlebutt-e2ee/full-app-pilot/boundaryMemory';
import type {
    FullAppWindowEvidence,
    FullAppWindowGraphObservation,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/windowEvidence';

const RUN = '12345678-1234-1234-1234-123456789abc';
const NONCE = 'a'.repeat(64);
const QUERY = `?fullAppWindowProofRun=${RUN}&fullAppWindowProofNonce=${NONCE}`;
const EVIDENCE = '__THALASSA_FULL_APP_WINDOW_EVIDENCE__';
const REMOUNT = '__THALASSA_FULL_APP_WINDOW_REMOUNT__';
const originalScope = Object.freeze({ key: 'anonymous', userId: null, generation: 0 });

async function fixture(search = QUERY, scope: unknown = originalScope) {
    vi.resetModules();
    const evidence = await import('../experiments/scuttlebutt-e2ee/full-app-pilot/windowEvidence');
    const host: Record<string, unknown> = {};
    evidence.installFullAppWindowEvidence(host, search, scope);
    return {
        host,
        evidence,
        read: () => host[EVIDENCE] as FullAppWindowEvidence,
        remount: (value: unknown) => (host[REMOUNT] as (request: unknown) => boolean)(value),
    };
}
function graphFixture() {
    const boundaries = createFullAppStartupBoundaries();
    const memory = createFullAppMemoryBoundary();
    let authStatus = 'unsupported';
    const graph = (): FullAppWindowGraphObservation => ({
        auth: { status: authStatus, userPresent: false, authChecked: true },
        scope: originalScope,
        legacyPermitAvailable: false,
        core: { registrationAttempts: 0, methodAttempts: 0, platform: 'web' },
        boundaries: boundaries.readCounters(),
        memory: memory.readCounters(),
    });
    return {
        graph,
        boundaries,
        memory,
        setStatus: (status: string) => {
            authStatus = status;
        },
    };
}
function ioFixture() {
    const originalFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const host = {
        fetch: originalFetch,
        Request,
        navigator: {},
        document: { addEventListener() {} },
        location: {},
    };
    return { host, originalFetch, fence: createFullAppIoFence(host) };
}

describe('explicit full App Window fixed evidence fixtures', () => {
    it.each([
        '',
        `?fullAppWindowProofRun=${RUN}`,
        `?fullAppWindowProofNonce=${NONCE}`,
        `?fullAppWindowProofRun=${RUN.toUpperCase()}&fullAppWindowProofNonce=${NONCE}`,
        `?fullAppWindowProofRun=${RUN}&fullAppWindowProofNonce=${NONCE.toUpperCase()}`,
        QUERY + `&fullAppWindowProofRun=${RUN}`,
        QUERY + `&fullAppWindowProofNonce=${NONCE}`,
        QUERY.replace(NONCE, NONCE + '\n'),
        QUERY.replace(RUN, RUN + '\n'),
    ])('exposes no globals without one exact pair of run-bound opt-in parameters: %s', async (search) => {
        const f = await fixture(search);
        expect(Reflect.ownKeys(f.host)).toEqual([]);
    });

    it('keeps the getter/control immutable and reports unavailable observations as null before graph attachment', async () => {
        const f = await fixture();
        expect(Object.getOwnPropertyDescriptor(f.host, EVIDENCE)).toMatchObject({
            configurable: false,
            enumerable: false,
        });
        expect(Object.getOwnPropertyDescriptor(f.host, EVIDENCE)?.set).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(f.host, REMOUNT)).toMatchObject({
            configurable: false,
            enumerable: false,
            writable: false,
        });
        expect(Reflect.set(f.host, EVIDENCE, {})).toBe(false);
        expect(Reflect.deleteProperty(f.host, REMOUNT)).toBe(false);
        const snapshot = f.read();
        expect(Object.keys(snapshot)).toEqual([
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
        expect(snapshot).toMatchObject({
            version: 1,
            runId: RUN,
            phase: 'starting',
            fence: null,
            core: null,
            boundaries: null,
            memory: null,
            auth: { status: 'unknown', userPresent: null, authChecked: null },
            authScope: {
                originalUserPresent: false,
                originalAnonymous: true,
                originalGeneration: 0,
                currentUserPresent: null,
                currentAnonymous: null,
                currentGeneration: null,
            },
            privateSelection: null,
            legacyPermitAvailable: null,
        });
        expect(f.remount({ runId: RUN, nonce: NONCE })).toBe(false);
        expect(JSON.stringify(snapshot)).not.toContain(NONCE);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.authScope)).toBe(true);
    });

    it('copies measured fence and leaf counts without retaining native/account/transport data or exposing mutable snapshots', async () => {
        const f = await fixture(QUERY, {
            key: 'user:synthetic-owner-canary',
            userId: 'synthetic-owner-canary',
            generation: 3,
        });
        const io = ioFixture(),
            graph = graphFixture();
        f.evidence.observeFullAppWindowFence(io.fence.evidence);
        io.fence.install();
        const contaminated = (): FullAppWindowGraphObservation => ({
            ...graph.graph(),
            scope: { key: 'user:synthetic-owner-canary', userId: 'synthetic-owner-canary', generation: 4 },
            ...{
                runtime: { token: 'synthetic-token-canary' },
                credentialBinding: 'synthetic-binding-canary',
                native: io.host,
                error: new Error('synthetic-error-canary'),
                originalFetch: io.originalFetch,
            },
        });
        f.evidence.observeFullAppWindowGraph(contaminated);
        f.evidence.observeFullAppWindowRootMount();
        f.evidence.observeFullAppWindowSelection('native-unavailable');
        const before = f.read();
        await expect((io.host.fetch as typeof fetch)('https://synthetic.invalid')).rejects.toThrow();
        graph.boundaries.startInternetProbe();
        await graph.memory.Preferences.get({ key: 'fixture' });
        const after = f.read();
        expect(before.fence!.counts.fetch).toBe(0);
        expect(after.fence!.counts.fetch).toBe(1);
        expect(after.boundaries!.internetRequests).toBe(1);
        expect(after.memory!.preferenceReads).toBe(1);
        expect(after.authScope).toEqual({
            originalUserPresent: true,
            originalAnonymous: false,
            originalGeneration: 3,
            currentUserPresent: true,
            currentAnonymous: false,
            currentGeneration: 4,
        });
        expect(after.auth).toEqual({ status: 'unsupported', userPresent: false, authChecked: true });
        expect(after.fence).not.toBe(before.fence);
        expect(after.fence!.counts).not.toBe(before.fence!.counts);
        for (const object of [
            after.fence,
            after.fence!.counts,
            after.core,
            after.boundaries,
            after.memory,
            after.sdk,
            after.root,
            after.auth,
            after.lifecycle,
        ])
            expect(Object.isFrozen(object)).toBe(true);
        expect(io.originalFetch).not.toHaveBeenCalled();
        const serialized = JSON.stringify(after);
        for (const canary of [
            'synthetic-owner-canary',
            'synthetic-token-canary',
            'synthetic-binding-canary',
            'synthetic-error-canary',
            NONCE,
        ])
            expect(serialized).not.toContain(canary);
        expect(serialized).not.toMatch(/"runtime":|originalFetch|credentialBinding|accessToken|accountId|deviceId/);
    });

    it('keeps failed/throwing observations unavailable rather than fabricating zero counters or disclosing errors', async () => {
        const f = await fixture();
        f.evidence.observeFullAppWindowFence(() => {
            throw new Error('private-fence-canary');
        });
        f.evidence.observeFullAppWindowGraph(() => {
            throw new Error('private-graph-canary');
        });
        f.evidence.failFullAppWindowEvidence();
        expect(f.read()).toMatchObject({
            phase: 'failed',
            fence: null,
            core: null,
            boundaries: null,
            memory: null,
            auth: { status: 'unknown', userPresent: null, authChecked: null },
        });
        const getter = vi.fn(() => {
            throw new Error('private-getter-canary');
        });
        f.evidence.observeFullAppWindowGraph(
            () => Object.defineProperty({}, 'auth', { get: getter }) as FullAppWindowGraphObservation,
        );
        expect(f.read().auth.status).toBe('unknown');
        expect(getter).not.toHaveBeenCalled();
        f.evidence.observeFullAppWindowGraph(
            () =>
                new Proxy(
                    {},
                    {
                        getOwnPropertyDescriptor() {
                            throw new Error('private-trap-canary');
                        },
                    },
                ) as FullAppWindowGraphObservation,
        );
        expect(() => f.read()).not.toThrow();
        expect(JSON.stringify(f.read())).not.toContain('canary');
    });

    it('reports the actual failed fence snapshot and preserves failed startup despite a later observation', async () => {
        const f = await fixture(),
            io = ioFixture();
        Object.defineProperty(io.host, 'fetch', { configurable: false, writable: false, value: io.originalFetch });
        f.evidence.observeFullAppWindowFence(io.fence.evidence);
        expect(() => io.fence.install()).toThrow();
        f.evidence.failFullAppWindowEvidence();
        f.evidence.observeFullAppWindowRootMount();
        expect(f.read().phase).toBe('failed');
        expect(f.read().fence).toMatchObject({ status: 'failed', counts: { patchFailures: 1 } });
        expect(f.remount({ runId: RUN, nonce: NONCE })).toBe(false);
    });

    it('bounds only recorded constructions/calls and leaves unrelated counters unchanged', async () => {
        const f = await fixture();
        f.evidence.countFullAppRuntimeCreation();
        f.evidence.countFullAppSdkConstruction();
        for (let count = 0; count < 10_005; count += 1) f.evidence.countFullAppNativeCall();
        expect(f.read().sdk).toEqual({ runtimeCreations: 1, sdkConstructions: 1, nativeCalls: 10_000 });
        expect(f.read().root).toEqual({ mounts: 0, remounts: 0, closedRenders: 0 });
    });

    it('uses one stable measured native wrapper across factory calls without retaining call arguments', async () => {
        const f = await fixture();
        const configurations: unknown[] = [];
        const nativeCall = vi.fn(async (_options: unknown) => ({ status: 'unavailable' }));
        const native = { fenceSession: nativeCall };
        const sdk = vi.fn(() => ({
            auth: {
                getSession: vi.fn(),
                signInWithPassword: vi.fn(),
                signOut: vi.fn(),
                onAuthStateChange: vi.fn(),
                stopAutoRefresh: vi.fn(),
            },
        }));
        const createRuntime = vi.fn((options: unknown) => {
            configurations.push(options);
            return {};
        });
        vi.doMock('@capacitor/core', () => ({
            Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false },
        }));
        vi.doMock('@supabase/supabase-js', () => ({ createClient: sdk }));
        vi.doMock('../experiments/scuttlebutt-e2ee/bridge-web/auth', () => ({ researchNativePlugin: native }));
        vi.doMock('../experiments/scuttlebutt-e2ee/app-pilot/runtime', () => ({
            createPrivateMessageResearchRuntime: createRuntime,
        }));
        try {
            const { createFullAppRuntimeFactory } = await import('../experiments/scuttlebutt-e2ee/full-app-pilot/sdk');
            const factory = createFullAppRuntimeFactory(vi.fn() as never);
            expect(f.read().sdk).toEqual({ runtimeCreations: 0, sdkConstructions: 0, nativeCalls: 0 });
            factory();
            factory();
            const first = configurations[0] as {
                native: { fenceSession(options: unknown): Promise<unknown> };
                auth: { native: unknown; createSdk(configuration: unknown, options: unknown): unknown };
            };
            const second = configurations[1] as typeof first;
            expect(first.native).toBe(second.native);
            expect(first.auth.native).toBe(first.native);
            expect(second.auth).toBe(first.auth);
            const options = { mode: 'verify', syntheticSecret: 'native-argument-canary' };
            await first.native.fenceSession(options);
            expect(nativeCall).toHaveBeenCalledWith(options);
            expect(nativeCall.mock.instances[0]).toBe(native);
            first.auth.createSdk({ supabaseUrl: 'synthetic', publicApiKey: 'public-fixture' }, {});
            expect(f.read().sdk).toEqual({ runtimeCreations: 2, sdkConstructions: 1, nativeCalls: 1 });
            expect(JSON.stringify(f.read())).not.toContain('native-argument-canary');
        } finally {
            vi.doUnmock('@capacitor/core');
            vi.doUnmock('@supabase/supabase-js');
            vi.doUnmock('../experiments/scuttlebutt-e2ee/bridge-web/auth');
            vi.doUnmock('../experiments/scuttlebutt-e2ee/app-pilot/runtime');
        }
    });

    it('accepts one exact nonce-bound remount and rejects accessors, inherited data, extra fields and reentry', async () => {
        const f = await fixture(),
            graph = graphFixture();
        f.evidence.observeFullAppWindowGraph(graph.graph);
        f.evidence.observeFullAppWindowRootMount();
        const render = vi.fn(() => {
            expect(f.remount({ runId: RUN, nonce: NONCE })).toBe(false);
            return true;
        });
        f.evidence.setFullAppWindowRemount(render);
        const getter = vi.fn(() => NONCE);
        for (const invalid of [
            null,
            { runId: RUN, nonce: 'b'.repeat(64) },
            { runId: RUN, nonce: NONCE, extra: true },
            Object.create({ runId: RUN, nonce: NONCE }),
            Object.defineProperty({ runId: RUN }, 'nonce', { get: getter }),
            new Proxy(
                {},
                {
                    ownKeys() {
                        throw new Error('private-remount-canary');
                    },
                },
            ),
        ])
            expect(f.remount(invalid)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        expect(f.remount({ runId: RUN, nonce: NONCE })).toBe(true);
        expect(f.remount({ runId: RUN, nonce: NONCE })).toBe(false);
        expect(render).toHaveBeenCalledTimes(1);
        expect(f.read().root.remounts).toBe(1);
    });

    it('preserves closed terminal evidence and fences stale-root cleanup after a fresh root observation', async () => {
        const f = await fixture(),
            graph = graphFixture();
        f.evidence.observeFullAppWindowGraph(graph.graph);
        const first = f.evidence.observeFullAppWindowRootMount();
        graph.setStatus('authenticated');
        f.evidence.observeFullAppWindowSelection('native-pilot');
        first.stop();
        f.evidence.observeFullAppWindowSelection('native-pilot');
        expect(f.read()).toMatchObject({
            auth: { status: 'inactive' },
            privateSelection: 'native-unavailable',
            lifecycle: { stopped: true },
        });
        // A replacement projection attaches to its new controller, whose fresh
        // publication must settle independently of the stopped root snapshot.
        graph.setStatus('unavailable');
        f.evidence.observeFullAppWindowSelection('native-unavailable');
        const second = f.evidence.observeFullAppWindowRootMount();
        first.detach();
        graph.setStatus('unsupported');
        f.evidence.observeFullAppWindowSelection('native-unavailable');
        expect(f.read()).toMatchObject({
            root: { mounts: 2, closedRenders: 2 },
            auth: { status: 'unsupported' },
            privateSelection: 'native-unavailable',
            lifecycle: { stopped: false },
        });
        second.detach();
        expect(f.read().lifecycle.stopped).toBe(true);
    });

    it('retains source ordering and scopes remount/measurement to the existing Research composition', () => {
        const read = (name: string) =>
            readFileSync(new URL(`../experiments/scuttlebutt-e2ee/full-app-pilot/${name}`, import.meta.url), 'utf8');
        const entry = read('entry.ts'),
            sdk = read('sdk.ts'),
            main = read('main.tsx'),
            root = read('FullAppResearchRoot.tsx');
        expect(entry.indexOf('requireNativePrivateMessagesForProcess();')).toBeLessThan(
            entry.indexOf('fence.install();'),
        );
        expect(entry.indexOf('fence.install();')).toBeLessThan(entry.indexOf("import('./sdk')"));
        expect(entry.indexOf('createFullAppRuntimeFactory(fence.researchAuthFetch)')).toBeLessThan(
            entry.indexOf("import('./main')"),
        );
        expect(entry).toContain('observeFullAppWindowFence(fence.evidence)');
        expect(sdk).toContain('createPrivateMessageResearchRuntime({ auth, native })');
        expect(sdk.indexOf('const native =')).toBeLessThan(sdk.indexOf('return () => {'));
        expect(sdk.indexOf('countFullAppSdkConstruction();')).toBeGreaterThan(
            sdk.indexOf('const client = createClient'),
        );
        expect(main).toContain('FullAppResearchRoot key={generation} createRuntime={createRuntime}');
        expect(root).toContain('const attachment = attachFullAppResearchAuth(owned.auth)');
        expect(root).toContain('const evidence = observeFullAppWindowRootMount()');
        expect(root).toContain('observeFullAppWindowSelection(closed.kind)');
        expect(root).not.toMatch(
            /new ResearchAuthController|createClient|setInterval|\.initialize\(|\.checkCurrentAccount\(/,
        );
    });
});

// @vitest-environment node
/** Pure synthetic schemas only; no Window/SDK/native/provider/Keychain execution. */
import { describe, expect, it, vi } from 'vitest';
import {
    createFullAppNativeResource,
    inspectFullAppNativeResource,
    inspectFullAppNativeReceipt,
    inspectFullAppNativeEnvelope,
    FULL_APP_NATIVE_CASES,
    FULL_APP_NATIVE_COUNTERS,
    FULL_APP_NATIVE_DOM_KEYS,
    FULL_APP_NATIVE_HTTP_COUNTERS,
    FULL_APP_NATIVE_RUN_MARKER,
    FULL_APP_NATIVE_NONCE_MARKER,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppUiContract.mjs';
import {
    WINDOW_FENCE_COUNTERS,
    WINDOW_BOUNDARY_COUNTERS,
    WINDOW_MEMORY_COUNTERS,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/windowProofContract.mjs';

const run = '93000000-0000-4000-8000-000000000001',
    nonce = 'a'.repeat(64);
const template = `const runID = '${FULL_APP_NATIVE_RUN_MARKER}'; const nonce = '${FULL_APP_NATIVE_NONCE_MARKER}';`;
const zero = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 0]));
function fixture() {
    const nativeCounters = zero(FULL_APP_NATIVE_COUNTERS);
    for (const method of ['configuration', 'fenceSession', 'authenticate', 'currentAccount', 'messagePrivateAdmission'])
        nativeCounters[method] = 1;
    nativeCounters.nativeAuthRequests = 2;
    nativeCounters.fenceSession = 2;
    const http = Object.fromEntries(
        FULL_APP_NATIVE_HTTP_COUNTERS.map((name: string) => [
            name,
            ['addListener', 'removeListener'].includes(name) ? 0 : 1,
        ]),
    );
    const verified = () => ({
        status: 'verified-unregistered-unpaired',
        serverVerified: true,
        accountPresent: true,
        selection: 'unknown',
        registration: 'none',
        claim: 'none',
        pairing: 'unpaired',
        outgoingCount: 0,
        incomingCount: 0,
        unresolvedCount: 0,
        originalSnapshotCurrent: true,
    });
    const dom = Object.fromEntries(
        FULL_APP_NATIVE_DOM_KEYS.map((name: string) => [
            name,
            [
                'actualAppNavigation',
                'unavailablePrivateView',
                'stoppedNotice',
                'messageLogAbsent',
                'passwordEmpty',
            ].includes(name),
        ]),
    );
    const fence = zero(WINDOW_FENCE_COUNTERS);
    fence.authRequests = 1;
    fence.authResponses = 1;
    return {
        version: 2,
        runID: run,
        nonce,
        scenario: 'full-app-native-startup',
        status: 'passed',
        phase: 'fixture-complete',
        assertions: 123,
        nativeAssertions: 10,
        sdkCounts: { password: 1, unexpected: 0 },
        cases: [...FULL_APP_NATIVE_CASES],
        nativeCounters,
        nativeState: { status: 'credential-fenced', accountPresent: false, originalSnapshotCurrent: false },
        nativeVerifiedAtProgress: { 'signed-in': verified(), 'admission-returned': verified() },
        nativeHttpFence: {
            version: 1,
            status: 'installed',
            primaryCurrent: true,
            classAliasCurrent: true,
            observedDefaultMethodCount: 6,
            primaryCounts: { ...http },
            classAliasCounts: { ...http },
        },
        domFacts: dom,
        syntheticPagehide: true,
        realOsLifecycleOrBfCacheProved: false,
        windowEvidence: {
            version: 1,
            runId: run,
            phase: 'ready',
            fence: { version: 1, status: 'installed', counts: fence },
            sdk: { runtimeCreations: 2, sdkConstructions: 2, nativeCalls: 10 },
            root: { mounts: 2, remounts: 1, closedRenders: 6 },
            auth: { status: 'inactive', userPresent: false, authChecked: true },
            authScope: {
                originalUserPresent: false,
                originalAnonymous: true,
                originalGeneration: 0,
                currentUserPresent: false,
                currentAnonymous: true,
                currentGeneration: 2,
            },
            privateSelection: 'native-unavailable',
            legacyPermitAvailable: false,
            core: { registrationAttempts: 0, methodAttempts: 0, platform: 'ios' },
            boundaries: zero(WINDOW_BOUNDARY_COUNTERS),
            memory: zero(WINDOW_MEMORY_COUNTERS),
            lifecycle: { stopped: true },
        },
    };
}
describe('native full-root fixture resource — pure schema', () => {
    it('binds exact script substitution and immutable metadata', () => {
        const resource = createFullAppNativeResource(template, run, nonce);
        expect(inspectFullAppNativeResource(resource, template)).toEqual(resource);
        expect(Object.isFrozen(resource)).toBe(true);
        expect(resource.script).not.toContain('__RESEARCH_');
    });
    it.each(['A3000000-0000-4000-8000-000000000001', run + '\n', '', true, null])(
        'refuses invalid exact run identity %s',
        (value) => {
            expect(() => createFullAppNativeResource(template, value, nonce)).toThrow('contract refused');
        },
    );
    it.each(['A'.repeat(64), nonce + '\n', 'a'.repeat(63), '', false])('refuses invalid exact nonce %s', (value) => {
        expect(() => createFullAppNativeResource(template, run, value)).toThrow('contract refused');
    });
    it.each([
        '',
        template + FULL_APP_NATIVE_RUN_MARKER,
        template.replace(FULL_APP_NATIVE_NONCE_MARKER, ''),
        'x'.repeat(65537),
    ])('refuses missing/duplicate/oversize template markers', (value) => {
        expect(() => createFullAppNativeResource(value, run, nonce)).toThrow('contract refused');
    });
    it('refuses foreign scenario, extra fields and altered script instead of granting fixture access', () => {
        const r = createFullAppNativeResource(template, run, nonce);
        for (const row of [
            { ...r, scenario: 'protected-exchange' },
            { ...r, version: 2 },
            { ...r, token: 'synthetic-canary' },
            { ...r, script: r.script + 'x' },
        ])
            expect(() => inspectFullAppNativeResource(row, template)).toThrow('contract refused');
    });
    it('does not invoke resource accessors or export their errors', () => {
        const r = { ...createFullAppNativeResource(template, run, nonce) },
            getter = vi.fn(() => {
                throw new Error('private-canary');
            });
        Object.defineProperty(r, 'script', { get: getter });
        expect(() => inspectFullAppNativeResource(r, template)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
    });
});
describe('native full-root final receipt — synthetic assertions, not execution evidence', () => {
    it('accepts and copies only the exact bounded final facts', () => {
        const raw = fixture(),
            accepted = inspectFullAppNativeReceipt(raw, run, nonce);
        raw.nativeCounters.authenticate = 999;
        expect(accepted.nativeCounters.authenticate).toBe(1);
        expect(Object.isFrozen(accepted)).toBe(true);
        expect(Object.isFrozen(accepted.nativeHttpFence.primaryCounts)).toBe(true);
        expect(accepted.nativeState.status).toBe('credential-fenced');
    });
    it.each(['configuration', 'fenceSession', 'authenticate', 'currentAccount', 'messagePrivateAdmission'])(
        'requires actual recorded %s attempts in a passing receipt',
        (method) => {
            const r = fixture();
            r.nativeCounters[method] = 0;
            expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
        },
    );
    it('refuses a final receipt without a later native fence attempt', () => {
        const r = fixture();
        r.nativeCounters.fenceSession = 1;
        expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
    });
    it.each([
        'messageRegisterDevice',
        'messageClaimPeer',
        'privateMessageIssue',
        'privateMessageSendText',
        'relayRequests',
        'unexpectedMethods',
        'fixtureSetupControls',
    ])('refuses unexpected setup/permission/transport attempt %s', (name) => {
        const r = fixture();
        r.nativeCounters[name] = 1;
        expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
    });
    it.each(['request', 'get', 'post', 'put', 'patch', 'delete', 'addListener', 'removeListener'])(
        'requires exact refusal meter for %s on both HTTP routes',
        (name) => {
            const r = fixture();
            r.nativeHttpFence.classAliasCounts[name] = 2;
            expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
        },
    );
    it.each([false, -1, 1.5, Infinity, 10001])('refuses coerced or unbounded counters %s', (value) => {
        const r = fixture();
        (r.nativeCounters as Record<string, unknown>).configuration = value;
        expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
    });
    it('refuses forged UI/native authority, stale/current snapshots and absent provenance facts', () => {
        const changes = [
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.auth.userPresent = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.legacyPermitAvailable = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.nativeState.accountPresent = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.nativeState.originalSnapshotCurrent = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.nativeVerifiedAtProgress['signed-in'].registration = 'acknowledged';
            },
            (r: ReturnType<typeof fixture>) => {
                r.nativeHttpFence.classAliasCurrent = false;
            },
            (r: ReturnType<typeof fixture>) => {
                r.sdkCounts.unexpected = 1;
            },
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.fence.counts.fetch = 1;
            },
            (r: ReturnType<typeof fixture>) => {
                r.cases.reverse();
            },
        ];
        for (const change of changes) {
            const r = fixture();
            change(r);
            expect(() => inspectFullAppNativeReceipt(r, run, nonce)).toThrow('contract refused');
        }
    });
    it('refuses identity/credential extra fields, changed run binding and failed/pending reports', () => {
        const r = fixture();
        for (const row of [
            { ...r, credentialBinding: 'synthetic-canary' },
            { ...r, nonce: 'b'.repeat(64) },
            { ...r, status: 'running' },
            { ...r, version: 1 },
        ])
            expect(() => inspectFullAppNativeReceipt(row, run, nonce)).toThrow('contract refused');
        expect(() => inspectFullAppNativeReceipt({ ...r, windowEvidence: null }, run, nonce)).toThrow(
            'contract refused',
        );
    });
});

describe('native diagnostic envelope — strict copied incomplete facts only', () => {
    it('copies known initial null facts and honest running counters without accepting startup', () => {
        const raw = {
            ...fixture(),
            status: 'running',
            phase: 'fixture-installed',
            assertions: 0,
            nativeAssertions: 0,
            sdkCounts: null,
            cases: [],
            nativeState: { status: 'unavailable' },
            nativeVerifiedAtProgress: {},
            nativeHttpFence: null,
            windowEvidence: null,
            domFacts: null,
        };
        const copied = inspectFullAppNativeEnvelope(raw, run, nonce);
        raw.nativeCounters.configuration = 999;
        expect(copied.nativeCounters.configuration).toBe(1);
        expect(copied.windowEvidence).toBeNull();
        expect(copied.nativeHttpFence).toBeNull();
        expect(() => inspectFullAppNativeReceipt(copied, run, nonce)).toThrow('contract refused');
    });
    it('copies a known failed envelope with measured nonzero refusal counters', () => {
        const raw = {
            ...fixture(),
            status: 'failed',
            phase: 'fixture-failed',
            nativeAssertions: 0,
            cases: ['fixture-failed'],
        };
        raw.sdkCounts.unexpected = 1;
        raw.nativeHttpFence.primaryCounts.get = 2;
        const copied = inspectFullAppNativeEnvelope(raw, run, nonce);
        expect(copied.sdkCounts.unexpected).toBe(1);
        expect(copied.nativeHttpFence.primaryCounts.get).toBe(2);
        expect(() => inspectFullAppNativeReceipt(copied, run, nonce)).toThrow('contract refused');
    });
    it.each(['nativeState', 'domFacts', 'nativeHttpFence', 'windowEvidence'])(
        'rejects private canaries in %s before export',
        (key) => {
            const raw = fixture() as unknown as Record<string, unknown>;
            raw[key] = { ...(raw[key] as object), privatePayload: 'synthetic-private-canary' };
            expect(() => inspectFullAppNativeEnvelope(raw, run, nonce)).toThrow('contract refused');
        },
    );
    it('refuses unknown phases, arbitrary payload keys and changed bindings', () => {
        for (const raw of [
            { ...fixture(), phase: 'unknown' },
            { ...fixture(), nonce: 'b'.repeat(64) },
            { ...fixture(), status: 'running', phase: 'fixture-complete' },
            { ...fixture(), error: 'private-canary' },
        ])
            expect(() => inspectFullAppNativeEnvelope(raw, run, nonce)).toThrow('contract refused');
    });
    it('refuses accessors without invoking their private body', () => {
        const raw = fixture(),
            getter = vi.fn(() => {
                throw new Error('private-canary');
            });
        Object.defineProperty(raw, 'domFacts', { get: getter });
        expect(() => inspectFullAppNativeEnvelope(raw, run, nonce)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
    });
    it('keeps final acceptance stricter than diagnostic copying', () => {
        const raw = fixture();
        raw.nativeState = { status: 'credential-fenced', accountPresent: false, originalSnapshotCurrent: false };
        raw.nativeCounters.authenticate = 0;
        expect(inspectFullAppNativeEnvelope(raw, run, nonce).nativeCounters.authenticate).toBe(0);
        expect(() => inspectFullAppNativeReceipt(raw, run, nonce)).toThrow('contract refused');
    });
});

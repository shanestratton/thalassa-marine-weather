// @vitest-environment node
/** Synthetic pure schemas/source preservation only. No SDK/Window/native,
 * provider, credentials, simulator, transport or encryption execution. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    createFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeEnvelope,
    inspectFullAppProtectedNativeReceipt,
    FULL_APP_PROTECTED_NATIVE_CASES,
    FULL_APP_PROTECTED_DOM_KEYS,
    FULL_APP_PROTECTED_MESSAGE_KEYS,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
    FULL_APP_PROTECTED_NATIVE_SCENARIO,
    FULL_APP_PROTECTED_RUN_MARKER,
    FULL_APP_PROTECTED_NONCE_MARKER,
    inspectFullAppProtectedWait,
    addFullAppProtectedChildWait,
    requireFullAppProtectedCleanup,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppProtectedUiContract.mjs';
import {
    FULL_APP_NATIVE_COUNTERS,
    FULL_APP_NATIVE_HTTP_COUNTERS,
} from '../experiments/scuttlebutt-e2ee/bridge-native/fullAppUiContract.mjs';
import {
    WINDOW_FENCE_COUNTERS,
    WINDOW_BOUNDARY_COUNTERS,
    WINDOW_MEMORY_COUNTERS,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/windowProofContract.mjs';

const run = '93000000-0000-4000-8000-000000000001',
    nonce = 'a'.repeat(64);
const template = `const runID = '${FULL_APP_PROTECTED_RUN_MARKER}'; const nonce = '${FULL_APP_PROTECTED_NONCE_MARKER}';`;
const zero = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 0]));
describe('protected fixture driver controls — synthetic scheduling and cleanup only', () => {
    it('allows an immediate zero-budget free probe, never zero-budget waiting', () => {
        expect(inspectFullAppProtectedWait({ limitMs: 0, spentMs: 0, otherHeavyProcesses: 0 })).toBe('ready');
        expect(inspectFullAppProtectedWait({ limitMs: 0, spentMs: 0, otherHeavyProcesses: 1 })).toBe('exhausted');
    });
    it.each([120000, 120001, Number.MAX_SAFE_INTEGER])(
        'refuses exhausted or overshot free-slot dispatch %s',
        (spentMs) => {
            expect(inspectFullAppProtectedWait({ limitMs: 120000, spentMs, otherHeavyProcesses: 0 })).toBe('exhausted');
        },
    );
    it('accounts child waiting only within its exact supplied remainder', () => {
        expect(
            addFullAppProtectedChildWait({
                limitMs: 120000,
                spentMs: 100000,
                childSpentMs: 20000,
                childStatus: 'passed',
            }),
        ).toEqual({ spentMs: 120000, queued: true });
        expect(() =>
            addFullAppProtectedChildWait({
                limitMs: 120000,
                spentMs: 100000,
                childSpentMs: 20001,
                childStatus: 'passed',
            }),
        ).toThrow('contract refused');
    });
    it('preserves a measured queued child timer overshoot without new dispatch', () => {
        expect(
            addFullAppProtectedChildWait({
                limitMs: 120000,
                spentMs: 115000,
                childSpentMs: 5003,
                childStatus: 'queued-unrun',
            }),
        ).toEqual({ spentMs: 120003, queued: true });
    });
    it.each([
        [0, 0, 0, 0],
        [120000, 100000, 10000, 110000],
        [120000, 100000, 20000, 120000],
        [120000, 115000, 5003, 120003],
        [120000, 115000, Number.MAX_SAFE_INTEGER - 115000, Number.MAX_SAFE_INTEGER],
    ])(
        'preserves failed child waiting as terminal failure: limit %s, parent %s, child %s, total %s',
        (limitMs, spentMs, childSpentMs, expectedSpentMs) => {
            const accounting = addFullAppProtectedChildWait({
                limitMs,
                spentMs,
                childSpentMs,
                childStatus: 'failed',
            });
            expect(accounting).toEqual({ spentMs: expectedSpentMs, queued: false, outcome: 'failed' });
            expect(Object.isFrozen(accounting)).toBe(true);
        },
    );
    it.each([
        [0, 0, 0, 0],
        [120000, 100000, 10000, 110000],
    ])(
        'preserves passed child waiting below exhaustion: limit %s, parent %s, child %s, total %s',
        (limitMs, spentMs, childSpentMs, expectedSpentMs) => {
            expect(addFullAppProtectedChildWait({ limitMs, spentMs, childSpentMs, childStatus: 'passed' })).toEqual({
                spentMs: expectedSpentMs,
                queued: false,
            });
        },
    );
    it.each(['preparing', 'running', 'failure', '', null, true])('refuses unknown child status %s', (childStatus) => {
        expect(() =>
            addFullAppProtectedChildWait({ limitMs: 120000, spentMs: 0, childSpentMs: 0, childStatus }),
        ).toThrow('contract refused');
    });
    it('refuses malformed failed-child accounting without truncation or coercion', () => {
        const facts = { limitMs: 120000, spentMs: 1, childSpentMs: 0, childStatus: 'failed' };
        for (const raw of [
            null,
            [],
            { ...facts, limitMs: 120001 },
            { ...facts, spentMs: 120001 },
            { ...facts, childSpentMs: -1 },
            { ...facts, childSpentMs: 0.5 },
            { ...facts, childSpentMs: '1' },
            { ...facts, childSpentMs: Number.NaN },
            { ...facts, childSpentMs: Number.POSITIVE_INFINITY },
            { ...facts, childSpentMs: Number.MAX_SAFE_INTEGER },
            { ...facts, childSpentMs: Number.MAX_SAFE_INTEGER + 1 },
            { ...facts, childError: 'private-canary' },
            { limitMs: 120000, spentMs: 1, childSpentMs: 0 },
        ])
            expect(() => addFullAppProtectedChildWait(raw)).toThrow('contract refused');
    });
    it.each(['limitMs', 'spentMs', 'childSpentMs', 'childStatus'])(
        'refuses accessor child accounting %s without invoking it',
        (key) => {
            const getter = vi.fn(() => {
                throw new Error('private-canary');
            });
            const facts = { limitMs: 120000, spentMs: 0, childSpentMs: 0, childStatus: 'failed' };
            Object.defineProperty(facts, key, { get: getter });
            expect(() => addFullAppProtectedChildWait(facts)).toThrow('contract refused');
            expect(getter).not.toHaveBeenCalled();
        },
    );
    it.each([0, 1])(
        'saves failed child wait before refusing actual driver return (synthetic exit %s)',
        (exitStatus) => {
            const source = readFileSync(
                'experiments/scuttlebutt-e2ee/bridge-native/fullAppProtectedUiProof.mjs',
                'utf8',
            );
            const start = source.indexOf('function quiet('),
                end = source.indexOf('\nfunction own()', start);
            expect(start).toBeGreaterThan(0);
            expect(end).toBeGreaterThan(start);
            const saved: Array<{ status?: string; sharedSlotWaitMs?: number }> = [];
            const receipt: { phase: string; status?: string; sharedSlotWaitMs?: number } = { phase: 'native-build' };
            const child = { status: 'failed', sharedSlotWaitMs: 5003 };
            // Execute only the current driver's child-result callsite against fake
            // process/fs responses. No child build, native runtime or file I/O runs.
            const context = {
                receipt,
                operationName: () => 'native-build',
                spawnSync: () => ({
                    status: exitStatus,
                    stdout: 'Nonsecret research messaging build receipt: /synthetic/build-receipt.json\n',
                    error: undefined,
                }),
                save: () => saved.push({ status: receipt.status, sharedSlotWaitMs: receipt.sharedSlotWaitMs }),
                existsSync: () => true,
                regular: () => undefined,
                hash: () => 'a'.repeat(64),
                readFileSync: () => JSON.stringify(child),
                addFullAppProtectedChildWait,
                waitBudget: 120000,
                waited: 115000,
            };
            expect(() =>
                runInNewContext(source.slice(start, end) + "\nquiet('/synthetic/owned-child', []);", context, {
                    timeout: 1000,
                }),
            ).toThrow('Owned child build failed');
            expect(context.waited).toBe(120003);
            expect(receipt.status).toBe('failed');
            expect(receipt.sharedSlotWaitMs).toBe(120003);
            expect(saved.at(-1)).toEqual({ status: 'failed', sharedSlotWaitMs: 120003 });
        },
    );
    it.each(['idAbsent', 'nameAbsent', 'sourcesUnchanged'])('refuses incomplete cleanup %s', (key) => {
        const facts = { idAbsent: true, nameAbsent: true, sourcesUnchanged: true };
        expect(requireFullAppProtectedCleanup(facts)).toBe(true);
        expect(() => requireFullAppProtectedCleanup({ ...facts, [key]: false })).toThrow('contract refused');
    });
    it('refuses accessor/unknown control facts without invoking their private errors', () => {
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        const facts = { limitMs: 120000, spentMs: 0, otherHeavyProcesses: 0 };
        Object.defineProperty(facts, 'spentMs', { get: getter });
        expect(() => inspectFullAppProtectedWait(facts)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
        expect(() =>
            requireFullAppProtectedCleanup({
                idAbsent: true,
                nameAbsent: true,
                sourcesUnchanged: true,
                nativePassed: true,
            }),
        ).toThrow('contract refused');
    });
});
const helperNames = [
    'peer-authenticate',
    'host-register',
    'peer-register',
    'host-require-protected',
    'peer-require-protected',
    'host-pairing-card',
    'peer-pairing-card',
    'host-inspect-peer',
    'peer-inspect-peer',
    'host-confirm-peer',
    'peer-confirm-peer',
    'host-claim',
    'peer-claim',
    'peer-pm-issue',
    'peer-pm-inbox',
    'peer-pm-send',
    'host-thread-read',
    'peer-thread-read',
];
function fixture(initiates = true) {
    const n = zero(FULL_APP_NATIVE_COUNTERS);
    for (const name of [
        'configuration',
        'fenceSession',
        'authenticate',
        'currentAccount',
        'messagePrivateAdmission',
        'privateMessageIssue',
        'privateMessageReadiness',
        'privateMessagePermissions',
        'privateMessageInbox',
        'privateMessageThread',
        'privateMessageSendText',
    ])
        n[name] = 1;
    n.fenceSession = 2;
    n.nativeAuthRequests = 2;
    n.fixtureSetupControls = 1;
    n.fixtureReplyControls = 1;
    n.privateMessageInbox = 3;
    const http = Object.fromEntries(
        FULL_APP_NATIVE_HTTP_COUNTERS.map((name: string) => [
            name,
            ['addListener', 'removeListener'].includes(name) ? 0 : 1,
        ]),
    );
    const actor = (role: boolean) => ({
        selection: 'protected-required',
        registration: 'acknowledged',
        claim: role ? 'verified' : 'none',
        pairing: 'confirmed',
        initialRole: role ? 'initiator' : 'responder',
        sessionRole: 'established',
        fullFingerprintStillConfirmed: true,
        outgoingCount: 1,
        incomingCount: 1,
        unresolvedCount: 0,
    });
    const host = actor(initiates),
        peer = actor(!initiates);
    if (!initiates) {
        host.incomingCount = 2;
        peer.outgoingCount = 2;
    }
    const actions = {
        'require-protected': 2,
        'account-mode': 0,
        policy: 3,
        claim: 1,
        send: initiates ? 2 : 3,
        list: 4,
    };
    const dispatch = Object.values(actions).reduce((a, b) => a + b, 0),
        hashes = ['b'.repeat(64), 'c'.repeat(64), ...(initiates ? [] : ['d'.repeat(64)])];
    const helperCalls = Object.fromEntries(helperNames.map((name) => [name, 1]));
    helperCalls['host-claim'] = initiates ? 1 : 0;
    helperCalls['peer-claim'] = initiates ? 0 : 1;
    helperCalls['peer-pm-send'] = initiates ? 1 : 2;
    helperCalls['host-thread-read'] = 2;
    helperCalls['peer-thread-read'] = initiates ? 3 : 4;
    const fence = zero(WINDOW_FENCE_COUNTERS);
    fence.authRequests = 1;
    fence.authResponses = 1;
    const dom = Object.fromEntries(
        FULL_APP_PROTECTED_DOM_KEYS.map((name: string) => [
            name,
            [
                'actualAppNavigation',
                'unavailablePrivateView',
                'stoppedNotice',
                'messageLogAbsent',
                'passwordEmpty',
                'legacyControlsAbsent',
            ].includes(name),
        ]),
    );
    const pm = zero(FULL_APP_PROTECTED_PM_RESULT_KEYS);
    pm['privateMessageSendText:ok'] = 1;
    pm['privateMessagePermissions:ok'] = 1;
    pm['privateMessageInbox:ok'] = 3;
    return {
        version: 3,
        runID: run,
        nonce,
        scenario: FULL_APP_PROTECTED_NATIVE_SCENARIO,
        status: 'passed',
        phase: 'fixture-complete',
        assertions: 100,
        nativeAssertions: 12,
        sdkCounts: { password: 1, unexpected: 0 },
        cases: [...FULL_APP_PROTECTED_NATIVE_CASES],
        nativeCounters: n,
        nativeState: { status: 'credential-fenced', accountPresent: false, originalSnapshotCurrent: false },
        nativeHttpFence: {
            version: 1,
            status: 'installed',
            primaryCurrent: true,
            classAliasCurrent: true,
            observedDefaultMethodCount: 6,
            primaryCounts: { ...http },
            classAliasCounts: { ...http },
        },
        windowEvidence: {
            version: 1,
            runId: run,
            phase: 'ready',
            fence: { version: 1, status: 'installed', counts: fence },
            sdk: { runtimeCreations: 2, sdkConstructions: 2, nativeCalls: 20 },
            root: { mounts: 2, remounts: 1, closedRenders: 8 },
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
        domFacts: dom,
        messageFacts: {
            outgoingRows: 1,
            incomingRows: initiates ? 1 : 2,
            openerRows: initiates ? 0 : 1,
            ...Object.fromEntries(FULL_APP_PROTECTED_MESSAGE_KEYS.slice(3).map((k: string) => [k, true])),
        },
        protectedExchange: {
            version: 1,
            status: 'passed',
            hostInitiates: initiates,
            originalHostBindingStillCurrent: true,
            originalPeerBindingStillCurrent: true,
            host,
            peer,
            uiOutgoingEnvelopeSHA256: hashes[0],
            peerReplyEnvelopeSHA256: hashes[1],
            peerOpenerEnvelopeSHA256: initiates ? null : hashes[2],
            nativeAssertions: 55,
            nativeCalls: helperCalls,
            relay: {
                version: 1,
                methodCounters: { auth: 4, register: 2, dispatch, unexpected: 0 },
                authCounters: { host: 2, peer: 2 },
                actionCounters: actions,
                acceptedEnvelopeSHA256: hashes,
                signatureVerificationCounts: { registration: 2, dispatch },
                canaryAbsence: { outgoing: true, peer: true, opener: true },
                acceptedSendCount: hashes.length,
            },
            syntheticAuthAndRelay: true,
            physicalDeviceExecution: false,
            capturedBeforeTerminal: true,
        },
        pmResultCounters: pm,
        syntheticPagehide: true,
        realOsLifecycleOrBfCacheProved: false,
    };
}
describe('full-root protected resource — pure schema, not source adoption', () => {
    it('pins separate v4/scenario/markers without adopting a v3 startup or old v2 resource', () => {
        const r = createFullAppProtectedNativeResource(template, run, nonce);
        expect(r.version).toBe(4);
        expect(inspectFullAppProtectedNativeResource(r, template)).toEqual(r);
        for (const version of [2, 3])
            expect(() => inspectFullAppProtectedNativeResource({ ...r, version }, template)).toThrow(
                'contract refused',
            );
    });
    it.each(['', 'A'.repeat(64), nonce + '\n'])('refuses malformed nonce %s', (value) =>
        expect(() => createFullAppProtectedNativeResource(template, run, value)).toThrow('contract refused'),
    );
    it('refuses duplicate/missing markers, oversized scripts and arbitrary resource fields', () => {
        for (const text of [
            template + FULL_APP_PROTECTED_RUN_MARKER,
            template.replace(FULL_APP_PROTECTED_NONCE_MARKER, ''),
            'x'.repeat(65537),
        ])
            expect(() => createFullAppProtectedNativeResource(text, run, nonce)).toThrow('contract refused');
        const r = createFullAppProtectedNativeResource(template, run, nonce);
        expect(() => inspectFullAppProtectedNativeResource({ ...r, permission: true }, template)).toThrow(
            'contract refused',
        );
    });
});
describe('full-root protected report — synthetic assertions only', () => {
    it.each([true, false])('copies the bounded role-sensitive native proof before terminal, role %s', (role) => {
        const raw = fixture(role),
            out = inspectFullAppProtectedNativeReceipt(raw, run, nonce);
        raw.protectedExchange.relay.acceptedEnvelopeSHA256[0] = 'e'.repeat(64);
        expect(out.protectedExchange.relay.acceptedEnvelopeSHA256[0]).toBe('b'.repeat(64));
        expect(out.nativeState.accountPresent).toBe(false);
        expect(Object.isFrozen(out.messageFacts)).toBe(true);
    });
    it('retains only strict running/failed facts, never final acceptance', () => {
        const raw = fixture();
        raw.status = 'running';
        raw.phase = 'fixture-installed';
        raw.cases = [];
        raw.nativeAssertions = 0;
        const unknown = {
            ...raw,
            nativeState: { status: 'unavailable' },
            sdkCounts: null,
            windowEvidence: null,
            domFacts: null,
            messageFacts: null,
            protectedExchange: null,
        };
        for (const route of ['primaryCounts', 'classAliasCounts'] as const)
            unknown.nativeHttpFence[route] = zero(FULL_APP_NATIVE_HTTP_COUNTERS);
        expect(inspectFullAppProtectedNativeEnvelope(unknown, run, nonce).phase).toBe('fixture-installed');
        expect(() => inspectFullAppProtectedNativeReceipt(unknown, run, nonce)).toThrow('contract refused');
        const failed = { ...unknown, status: 'failed', phase: 'fixture-failed', cases: ['fixture-failed'] };
        expect(inspectFullAppProtectedNativeEnvelope(failed, run, nonce).status).toBe('failed');
    });
    it.each(['nativeHttpFence', 'windowEvidence', 'messageFacts', 'protectedExchange'])(
        'refuses missing final proof %s',
        (key) =>
            expect(() => inspectFullAppProtectedNativeReceipt({ ...fixture(), [key]: null }, run, nonce)).toThrow(
                'contract refused',
            ),
    );
    it('refuses fabricated User/legacy/private access and restored authority after terminal', () => {
        for (const change of [
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.auth.userPresent = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.privateSelection = 'native-pilot';
            },
            (r: ReturnType<typeof fixture>) => {
                r.windowEvidence.legacyPermitAvailable = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.nativeState.originalSnapshotCurrent = true;
            },
        ]) {
            const raw = fixture();
            change(raw);
            expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
        }
    });
    it('refuses uncorrelated/relabelled hashes and claimed physical or OS evidence', () => {
        for (const change of [
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.peerReplyEnvelopeSHA256 = r.protectedExchange.uiOutgoingEnvelopeSHA256;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.capturedBeforeTerminal = false;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.physicalDeviceExecution = true;
            },
            (r: ReturnType<typeof fixture>) => {
                r.realOsLifecycleOrBfCacheProved = true;
            },
        ]) {
            const raw = fixture();
            change(raw);
            expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
        }
    });
    it('rejects leaked identity/text/error/options and unexpected method counters', () => {
        const r = fixture();
        for (const raw of [
            { ...r, token: 'private-canary' },
            {
                ...r,
                protectedExchange: { ...r.protectedExchange, host: { ...r.protectedExchange.host, accountId: run } },
            },
            { ...r, messageFacts: { ...r.messageFacts, text: 'private-canary' } },
            { ...r, nativeCounters: { ...r.nativeCounters, messageRegisterDevice: 1 } },
        ])
            expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
    });
    it('refuses missing native operations, mixed roles and excess evidence recollection', () => {
        for (const change of [
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.nativeCalls['host-register'] = 0;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.nativeCalls['peer-pm-inbox'] = 0;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.nativeCalls['peer-claim'] = 1;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.peer.initialRole = 'initiator';
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.nativeCalls['host-thread-read'] = 3;
            },
            (r: ReturnType<typeof fixture>) => {
                r.protectedExchange.nativeCalls['peer-thread-read'] = 4;
            },
        ]) {
            const raw = fixture();
            change(raw);
            expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
        }
    });
    it('refuses missing or impossible completed inbox scan evidence', () => {
        for (const count of [0, 1, 2, 4, 10001]) {
            const raw = fixture();
            raw.pmResultCounters['privateMessageInbox:ok'] = count;
            expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
        }
    });
    it('does not invoke source accessors or expose their private errors', () => {
        const raw = fixture(),
            getter = vi.fn(() => {
                throw new Error('private-canary');
            });
        Object.defineProperty(raw.protectedExchange, 'host', { get: getter });
        expect(() => inspectFullAppProtectedNativeReceipt(raw, run, nonce)).toThrow('contract refused');
        expect(getter).not.toHaveBeenCalled();
    });
});
describe('v3 and existing UI semantics — read-only source preservation, not execution', () => {
    it.each([
        [
            'experiments/scuttlebutt-e2ee/full-app-pilot/nativeUiFixture.js',
            '71ff8b18a6420831616846a0b741ed94cdfe2dfe9c4af9086df9086b9e44fcfe',
        ],
        [
            'experiments/scuttlebutt-e2ee/bridge-native/ResearchFullAppHttpFence.swift',
            '1588135aa7a49b2e8e97a0fa18ddc1c8013aa14e5c6072f643147f19f7c334d1',
        ],
        [
            'experiments/scuttlebutt-e2ee/bridge-native/ResearchProtectedUiFixture.swift',
            'da48c8d6951685581d6c8cf25e126a7f9b32e76cef827a9aca2d4fb92dfc8651',
        ],
        [
            'experiments/scuttlebutt-e2ee/bridge-native/ResearchProtectedUiRelay.swift',
            '479663fb9b843c7f563c024f2e32c52ef51facb4ddde7288782090ea2c1312ec',
        ],
    ])('keeps existing source bytes %s', (path, digest) =>
        expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(digest),
    );
    it('does not change native pending IDs/null content/time/rejected status/legacy page contracts', () => {
        const port = readFileSync('experiments/scuttlebutt-e2ee/bridge-web/privateMessagePort.ts', 'utf8'),
            view = readFileSync('components/chat/PrivateMessagePilotView.tsx', 'utf8');
        expect(port).toContain('clientMessageId');
        expect(port).toContain('privateMessageRetryPending');
        expect(view).toContain("dm.message ?? 'Message text unavailable'");
        expect(view).toContain("case 'rejected'");
        expect(view).toContain("if (value === null) return 'Time unknown'");
        const mapping = readFileSync('services/chat/e2ee/privateMessagePilot.ts', 'utf8');
        expect(mapping).toContain("(value.delivery === 'rejected' && value.reason === null)");
        expect(mapping).toContain('value.text === null');
        expect(mapping).toContain('value.localCreatedAtMillis !== null');
        expect(readFileSync('components/chat/ChatDMView.tsx', 'utf8')).toContain(
            "'kind' in value && value.kind === 'native-pilot'",
        );
        expect(readFileSync('components/ChatPage.tsx', 'utf8')).toContain(
            "const requiresNative = selected.kind !== 'legacy'",
        );
    });
    it('requires measured repeated-scan progress and grounded legacy-only controls', () => {
        const fixture = readFileSync(
            'experiments/scuttlebutt-e2ee/bridge-native/ResearchFullAppProtectedUiFixture.swift',
            'utf8',
        );
        expect(fixture).toContain('pmResults["privateMessageInbox:ok"] == inbox + 1');
        expect(fixture).toContain('counters["privateMessageThread"] == thread + 1');
        const script = readFileSync('experiments/scuttlebutt-e2ee/full-app-pilot/nativeProtectedUiFixture.js', 'utf8');
        expect(script).toContain('async function refreshMessages(enabledPhase, completionPhase)');
        expect(script).toContain("refreshMessages('receive-refresh-enabled', 'receive-refresh-completion')");
        expect(script).toContain("refreshMessages('dedup-refresh-enabled', 'dedup-refresh-completion')");
        expect(script).toContain('aria-label^="Page actions"');
        expect(script).not.toContain('Server-readable private message');
        expect(readFileSync('components/chat/ChatHeader.tsx', 'utf8')).toContain("'Page actions'");
        expect(readFileSync('components/chat/ChatDMView.tsx', 'utf8')).toContain(
            'aria-label="Open self-test conversation"',
        );
    });
    it('keeps Research launch at the default bound and gates polling on its exact positive PID', () => {
        const driver = readFileSync('experiments/scuttlebutt-e2ee/bridge-native/fullAppProtectedUiProof.mjs', 'utf8');
        const phase = driver.indexOf("receipt.phase = 'actual-full-root-protected';");
        const poll = driver.indexOf("receipt.lastOperation = 'native-status-poll';", phase);
        expect(phase).toBeGreaterThan(0);
        expect(poll).toBeGreaterThan(phase);
        // Diagnostic capture also checks the independent PID. Only the actual
        // launch-to-poll block can prove this guard precedes native polling.
        const launchToPoll = driver.slice(phase, poll);
        const launch = launchToPoll.indexOf(
            "quiet('/usr/bin/xcrun', ['simctl', 'launch', '--terminate-running-process', simulator, bundle]);",
        );
        const gate = launchToPoll.indexOf(
            'assert(Number.isSafeInteger(receipt.ownedLaunchPID) && receipt.ownedLaunchPID > 0);',
            launch,
        );
        expect(launch).toBeGreaterThan(0);
        expect(gate).toBeGreaterThan(launch);
        expect(poll).toBeGreaterThan(phase + gate);
        expect(driver).toContain('function quiet(bin, args, timeout = 30000');
        expect(driver).toContain('app\\.thalassa\\.research\\.scuttlebutt-auth: ([1-9][0-9]{0,8})');
    });
});

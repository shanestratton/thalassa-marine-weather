/** Synthetic evidence-contract tests only. No OS callbacks, device authority,
 * simulator, native encryption, launch or transport is exercised here. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createResearchSceneLifecycleResource,
    inspectResearchSceneLifecycleResource,
    inspectResearchSceneLifecycleEvidence,
    requireResearchSceneProtectedRoundTrip,
    createResearchSceneProtectedUiResource,
    inspectResearchSceneProtectedUiResource,
    inspectResearchSceneProtectedResources,
    inspectResearchSceneProtectedUiClosure,
    requireResearchSceneProtectedDriverStage,
    researchSceneProtectedProofHash,
    RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS,
} from '../experiments/scuttlebutt-e2ee/bridge-native/researchSceneLifecycleContract.mjs';
import {
    createFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeResource,
    inspectFullAppProtectedNativeEnvelope,
    inspectFullAppSceneProtectedEnvelope,
    inspectFullAppSceneProtectedPrefix,
    FULL_APP_PROTECTED_NATIVE_CASES,
    FULL_APP_PROTECTED_DOM_KEYS,
    FULL_APP_PROTECTED_MESSAGE_KEYS,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
    FULL_APP_PROTECTED_RUN_MARKER,
    FULL_APP_PROTECTED_NONCE_MARKER,
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

const pin = {
    runID: '12345678-1234-4234-8234-123456789abc',
    nonce: 'a'.repeat(64),
    resourceSHA256: 'b'.repeat(64),
    pid: 1234,
};
const coldAuthority = () => ({
    observationStatus: 'unavailable',
    facadeObserved: false,
    originalSnapshotObserved: false,
    accountPresent: null as boolean | null,
    originalSnapshotCurrent: null as boolean | null,
    verifyFenceCompletions: null as number | null,
});
const cover = (shown: boolean) => ({
    present: shown,
    opaque: shown,
    attachedToOwnedWindow: shown,
    coversOwnedWindowBounds: shown,
    accessibilityModal: shown,
    contentAccessibilityHidden: shown,
});
function trace() {
    const phases = [
        ['process-started', 'unattached'],
        ['application-launched', 'unattached'],
        ['scene-connected', 'foreground-inactive'],
        ['did-become-active', 'foreground-active'],
        ['protected-ready', 'foreground-active'],
        ['will-resign-active', 'foreground-inactive'],
        ['did-enter-background', 'background'],
        ['will-enter-foreground', 'foreground-inactive'],
        ['did-become-active', 'foreground-active'],
        ['foreground-ui-closed', 'foreground-active'],
    ];
    const events = phases.map(([event, activationState], index) => ({
        index,
        sequence: index + 1,
        event,
        activationState,
        cover: cover(index >= 5 && index <= 8),
        authority:
            index < 4
                ? coldAuthority()
                : {
                      observationStatus: 'observed',
                      facadeObserved: true,
                      originalSnapshotObserved: true,
                      accountPresent: index < 5,
                      originalSnapshotCurrent: index < 5,
                      verifyFenceCompletions: index < 5 ? 1 : 2,
                  },
    }));
    return {
        version: 1,
        kind: 'research-scene-lifecycle-observations',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: pin.resourceSHA256,
        process: { pid: pin.pid, epoch: '22345678-1234-4234-8234-123456789abc' },
        evidenceCategory: 'synthetic-direct-calls',
        status: 'recording',
        eventCount: events.length,
        events,
        osLifecycleProved: false,
        authorityMutated: false,
    };
}
function receipt() {
    return trace();
}
const zero = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 0]));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const protectedTemplate = `(() => {
    const runID = '${FULL_APP_PROTECTED_RUN_MARKER}';
    const nonce = '${FULL_APP_PROTECTED_NONCE_MARKER}';
    const sceneLifecycleProof = false;
})();`;
function protectedReport() {
    const nativeCounters = zero(FULL_APP_NATIVE_COUNTERS);
    for (const name of [
        'configuration',
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
        nativeCounters[name] = 1;
    Object.assign(nativeCounters, {
        fenceSession: 2,
        nativeAuthRequests: 2,
        fixtureSetupControls: 1,
        fixtureReplyControls: 1,
        privateMessageInbox: 3,
    });
    const pmResultCounters = zero(FULL_APP_PROTECTED_PM_RESULT_KEYS);
    Object.assign(pmResultCounters, {
        'privateMessageSendText:ok': 1,
        'privateMessagePermissions:ok': 1,
        'privateMessageInbox:ok': 3,
    });
    const http = Object.fromEntries(
        FULL_APP_NATIVE_HTTP_COUNTERS.map((name) => [name, ['addListener', 'removeListener'].includes(name) ? 0 : 1]),
    );
    const fence = zero(WINDOW_FENCE_COUNTERS);
    fence.authRequests = fence.authResponses = 1;
    const dom = Object.fromEntries(
        FULL_APP_PROTECTED_DOM_KEYS.map((name) => [
            name,
            [
                'actualAppNavigation',
                'authenticatedNotice',
                'passwordEmpty',
                'logPresent',
                'composeEmpty',
                'encryptionTestLabel',
                'truthfulIncomingStatus',
                'truthfulOutgoingStatus',
                'legacyControlsAbsent',
            ].includes(name),
        ]),
    );
    const actor = (initiates: boolean) => ({
        selection: 'protected-required',
        registration: 'acknowledged',
        claim: initiates ? 'verified' : 'none',
        pairing: 'confirmed',
        initialRole: initiates ? 'initiator' : 'responder',
        sessionRole: 'established',
        fullFingerprintStillConfirmed: true,
        outgoingCount: initiates ? 2 : 1,
        incomingCount: initiates ? 1 : 2,
        unresolvedCount: 0,
    });
    const nativeCalls = Object.fromEntries(
        [
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
        ].map((name) => [name, 1]),
    );
    Object.assign(nativeCalls, { 'host-claim': 0, 'peer-pm-send': 2, 'host-thread-read': 2, 'peer-thread-read': 4 });
    const actionCounters = { 'require-protected': 2, 'account-mode': 0, policy: 3, claim: 1, send: 3, list: 4 };
    const dispatch = Object.values(actionCounters).reduce((sum, count) => sum + count, 0);
    const hashes = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
    return {
        version: 3,
        runID: pin.runID,
        nonce: pin.nonce,
        scenario: 'full-app-native-protected-exchange',
        status: 'running',
        phase: 'native-proof-captured',
        assertions: 100,
        nativeAssertions: 0,
        sdkCounts: { password: 1, unexpected: 0 },
        cases: FULL_APP_PROTECTED_NATIVE_CASES.slice(0, 11),
        nativeCounters,
        nativeState: { status: 'running' },
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
            runId: pin.runID,
            phase: 'ready',
            fence: { version: 1, status: 'installed', counts: fence },
            sdk: { runtimeCreations: 1, sdkConstructions: 1, nativeCalls: 20 },
            root: { mounts: 1, remounts: 0, closedRenders: 1 },
            auth: { status: 'authenticated', userPresent: false, authChecked: true },
            authScope: {
                originalUserPresent: false,
                originalAnonymous: true,
                originalGeneration: 0,
                currentUserPresent: true,
                currentAnonymous: false,
                currentGeneration: 1,
            },
            privateSelection: 'native-pilot',
            legacyPermitAvailable: false,
            core: { registrationAttempts: 0, methodAttempts: 0, platform: 'ios' },
            boundaries: zero(WINDOW_BOUNDARY_COUNTERS),
            memory: zero(WINDOW_MEMORY_COUNTERS),
            lifecycle: { stopped: false },
        },
        domFacts: dom,
        messageFacts: {
            outgoingRows: 1,
            incomingRows: 2,
            openerRows: 1,
            ...Object.fromEntries(FULL_APP_PROTECTED_MESSAGE_KEYS.slice(3).map((name) => [name, true])),
        },
        protectedExchange: {
            version: 1,
            status: 'passed',
            hostInitiates: false,
            originalHostBindingStillCurrent: true,
            originalPeerBindingStillCurrent: true,
            host: actor(false),
            peer: actor(true),
            uiOutgoingEnvelopeSHA256: hashes[0],
            peerReplyEnvelopeSHA256: hashes[1],
            peerOpenerEnvelopeSHA256: hashes[2],
            nativeAssertions: 55,
            nativeCalls,
            relay: {
                version: 1,
                methodCounters: { auth: 4, register: 2, dispatch, unexpected: 0 },
                authCounters: { host: 2, peer: 2 },
                actionCounters,
                acceptedEnvelopeSHA256: hashes,
                signatureVerificationCounts: { registration: 2, dispatch },
                canaryAbsence: { outgoing: true, peer: true, opener: true },
                acceptedSendCount: 3,
            },
            syntheticAuthAndRelay: true,
            physicalDeviceExecution: false,
            capturedBeforeTerminal: true,
        },
        pmResultCounters,
        syntheticPagehide: false,
        realOsLifecycleOrBfCacheProved: false,
    };
}
function driverStage(stage = 'foreground-closed') {
    const protectedResource = createResearchSceneProtectedUiResource(protectedTemplate, pin.runID, pin.nonce);
    const observerResource = createResearchSceneLifecycleResource(pin.runID, pin.nonce);
    const observerResourceBytes = JSON.stringify(observerResource),
        protectedResourceBytes = JSON.stringify(protectedResource);
    const report = protectedReport(),
        observer = trace();
    observer.resourceSHA256 = sha(observerResourceBytes);
    observer.evidenceCategory = 'simulator-native-observations';
    if (stage !== 'foreground-closed') {
        observer.events = observer.events.slice(0, stage === 'protected-ready' ? 5 : 7);
        observer.eventCount = observer.events.length;
    }
    const sourceBindings = Object.fromEntries(
        RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS.map((name) => [name, 'e'.repeat(64)]),
    );
    sourceBindings.protectedScript = sha(protectedTemplate);
    const expected = {
        ...pin,
        resourceSHA256: observer.resourceSHA256,
        protectedResourceSHA256: sha(protectedResourceBytes),
        protectedProofSHA256: researchSceneProtectedProofHash(report, pin.runID, pin.nonce),
        epoch: observer.process.epoch,
        sourceBindings,
    };
    const windowEvidence = structuredClone(report.windowEvidence);
    windowEvidence.auth.status = 'unavailable';
    Object.assign(windowEvidence.authScope, {
        currentUserPresent: false,
        currentAnonymous: true,
        currentGeneration: 2,
    });
    windowEvidence.privateSelection = 'native-unavailable';
    const nativeCounters: Record<string, number> = {
        ...report.nativeCounters,
        lifecycleState: report.nativeCounters.lifecycleState + 1,
        acknowledgeClosedPresentation: report.nativeCounters.acknowledgeClosedPresentation + 1,
    };
    const closure = {
        version: 1,
        kind: 'research-scene-protected-ui-closure',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: expected.resourceSHA256,
        protectedResourceSHA256: expected.protectedResourceSHA256,
        protectedProofSHA256: expected.protectedProofSHA256,
        process: { ...observer.process },
        status: 'observed',
        phase: 'foreground-ui-closed',
        domFacts: {
            actualAppNavigation: true,
            privateOpenEnabled: false,
            logPresent: false,
            composeEmpty: true,
            passwordEmpty: true,
            legacyControlsAbsent: true,
        },
        windowEvidence,
        nativeCounters,
        pmResultCounters: { ...report.pmResultCounters },
        sdkCounts: { ...report.sdkCounts },
        relayCounters: { ...report.protectedExchange.relay.methodCounters },
        syntheticPagehide: false,
        realOsLifecycleOrBfCacheProved: false,
    };
    return {
        expected,
        closure,
        input: {
            stage,
            observerEvidence: observer,
            observerResourceBytes,
            protectedResourceBytes,
            protectedTemplate,
            protectedReport: report,
            protectedUiClosure: stage === 'foreground-closed' ? closure : null,
            sourceBindings: { ...sourceBindings },
        },
    };
}

const nativeSource = (name: string) => readFileSync('experiments/scuttlebutt-e2ee/bridge-native/' + name, 'utf8');
function sceneGuardedReferences(source: string, reference: string) {
    const guards: boolean[] = [];
    let matches = 0;
    for (const line of source.split('\n')) {
        const directive = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
        if (directive) {
            const enabled = /^\s*E2EE_FULL_APP_SCENE_UI_FIXTURE(?:\s*&&\s*targetEnvironment\(simulator\))?\s*$/.test(
                directive[2],
            );
            if (directive[1] === 'if') guards.push(enabled);
            else if (directive[1] === 'elseif') guards[guards.length - 1] = enabled;
            else if (directive[1] === 'else') guards[guards.length - 1] = false;
            else guards.pop();
        } else if (line.includes(reference)) {
            expect(guards.some(Boolean)).toBe(true);
            matches += 1;
        }
    }
    expect(guards).toHaveLength(0);
    expect(matches).toBeGreaterThan(0);
}

describe('scene evidence resource — synthetic bounded configuration', () => {
    it('creates an exact resource without script, store path or authority', () => {
        const resource = createResearchSceneLifecycleResource(pin.runID, pin.nonce);
        expect(resource).toEqual({
            version: 1,
            scenario: 'full-app-native-os-lifecycle-observations',
            runID: pin.runID,
            nonce: pin.nonce,
            maximumEvents: 64,
        });
        expect(Object.isFrozen(resource)).toBe(true);
        expect(inspectResearchSceneLifecycleResource(resource)).toEqual(resource);
    });
    it.each([
        { version: 4 },
        { scenario: 'full-app-native-protected-exchange' },
        { maximumEvents: 65 },
        { maximumEvents: '64' },
        { runID: '12345678-1234-4234-8234-123456789ABC' },
        { nonce: 'not-a-nonce' },
        { storePath: '/private-canary' },
        { script: 'private-canary' },
    ])('refuses wrong or expansive resource fields: %s', (mutation) => {
        expect(() =>
            inspectResearchSceneLifecycleResource({
                ...createResearchSceneLifecycleResource(pin.runID, pin.nonce),
                ...mutation,
            }),
        ).toThrow('Research scene lifecycle evidence refused');
    });
});

describe('explicit scene v4 helper and parser — synthetic correlation only', () => {
    it('keeps the ordinary helper false and enables only the separate scene helper', () => {
        const ordinary = createFullAppProtectedNativeResource(protectedTemplate, pin.runID, pin.nonce),
            scene = createResearchSceneProtectedUiResource(protectedTemplate, pin.runID, pin.nonce);
        expect(ordinary.script).toContain('const sceneLifecycleProof = false;');
        expect(scene.script).toContain('const sceneLifecycleProof = true;');
        expect(inspectFullAppProtectedNativeResource(ordinary, protectedTemplate)).toEqual(ordinary);
        expect(inspectResearchSceneProtectedUiResource(scene, protectedTemplate)).toEqual(scene);
        expect(() => inspectFullAppProtectedNativeResource(scene, protectedTemplate)).toThrow('contract refused');
        expect(() => inspectResearchSceneProtectedUiResource(ordinary, protectedTemplate)).toThrow('evidence refused');
        expect(Object.keys(scene)).toEqual(['version', 'runID', 'nonce', 'scenario', 'script']);
    });
    it.each([
        protectedTemplate.replace('const sceneLifecycleProof = false;', ''),
        protectedTemplate + '\nconst sceneLifecycleProof = false;',
        protectedTemplate.replace('const sceneLifecycleProof = false;', 'const sceneLifecycleProof = true;'),
    ])('refuses absent, duplicated or already-enabled helper source %s', (source) => {
        expect(() => createResearchSceneProtectedUiResource(source, pin.runID, pin.nonce)).toThrow('evidence refused');
    });
    it('correlates the two resources by exact run and nonce, without merging their schemas', () => {
        const protectedResource = createResearchSceneProtectedUiResource(protectedTemplate, pin.runID, pin.nonce),
            observerResource = createResearchSceneLifecycleResource(pin.runID, pin.nonce);
        expect(
            inspectResearchSceneProtectedResources({ protectedResource, observerResource }, protectedTemplate),
        ).toEqual({ protectedResource, observerResource });
        for (const mutation of [{ runID: '32345678-1234-4234-8234-123456789abc' }, { nonce: 'c'.repeat(64) }])
            expect(() =>
                inspectResearchSceneProtectedResources(
                    { protectedResource, observerResource: { ...observerResource, ...mutation } },
                    protectedTemplate,
                ),
            ).toThrow('evidence refused');
    });
    it('parses the scene prefix without rewriting its false synthetic-pagehide fact', () => {
        const report = protectedReport();
        expect(inspectFullAppSceneProtectedPrefix(report, pin.runID, pin.nonce).syntheticPagehide).toBe(false);
        expect(() => inspectFullAppProtectedNativeEnvelope(report, pin.runID, pin.nonce)).toThrow('contract refused');
        const ordinary = { ...report, syntheticPagehide: true };
        expect(inspectFullAppProtectedNativeEnvelope(ordinary, pin.runID, pin.nonce).phase).toBe(
            'native-proof-captured',
        );
        expect(() => inspectFullAppSceneProtectedEnvelope(ordinary, pin.runID, pin.nonce)).toThrow('contract refused');
    });
    it('preserves failed/unknown scene diagnostics without accepting them as the protected prefix', () => {
        const failed = {
            ...protectedReport(),
            status: 'failed',
            phase: 'fixture-failed',
            cases: ['fixture-failed'],
            assertions: 0,
            nativeState: { status: 'unavailable' },
            sdkCounts: null,
            nativeHttpFence: null,
            windowEvidence: null,
            domFacts: null,
            messageFacts: null,
            protectedExchange: null,
        };
        expect(inspectFullAppSceneProtectedEnvelope(failed, pin.runID, pin.nonce).windowEvidence).toBeNull();
        expect(() => inspectFullAppSceneProtectedPrefix(failed, pin.runID, pin.nonce)).toThrow('contract refused');
    });
    it('refuses scene terminal prefixes and final passes while preserving the ordinary envelope', () => {
        const prefix = protectedReport();
        expect(() =>
            inspectFullAppSceneProtectedEnvelope(
                { ...prefix, phase: 'terminal-closed', cases: FULL_APP_PROTECTED_NATIVE_CASES.slice(0, 12) },
                pin.runID,
                pin.nonce,
            ),
        ).toThrow('contract refused');
        const completed = {
            ...prefix,
            status: 'passed',
            phase: 'fixture-complete',
            nativeAssertions: 12,
            cases: [...FULL_APP_PROTECTED_NATIVE_CASES],
            nativeState: { status: 'credential-fenced', accountPresent: false, originalSnapshotCurrent: false },
        };
        expect(() => inspectFullAppSceneProtectedEnvelope(completed, pin.runID, pin.nonce)).toThrow('contract refused');
        expect(
            inspectFullAppProtectedNativeEnvelope({ ...completed, syntheticPagehide: true }, pin.runID, pin.nonce)
                .cases,
        ).toHaveLength(14);
    });
    it.each(['originalHostBindingStillCurrent', 'originalPeerBindingStillCurrent'])(
        'refuses the protected prefix with stale captured proof: %s',
        (key) => {
            const report = protectedReport();
            Object.assign(report.protectedExchange, { [key]: false });
            expect(() => inspectFullAppSceneProtectedPrefix(report, pin.runID, pin.nonce)).toThrow('contract refused');
        },
    );
    it('hashes inspected exchange dictionaries canonically without hashing the whole native report', () => {
        const report = protectedReport(),
            first = researchSceneProtectedProofHash(report, pin.runID, pin.nonce);
        const reordered = {
            ...report,
            assertions: report.assertions + 1,
            protectedExchange: Object.fromEntries(Object.entries(report.protectedExchange).reverse()),
        };
        expect(researchSceneProtectedProofHash(reordered, pin.runID, pin.nonce)).toBe(first);
        expect(first).not.toBe(sha(JSON.stringify(report)));
    });
});

describe('source-bound scene driver stages — synthetic inputs, never whole-run acceptance', () => {
    it.each(['protected-ready', 'background-fenced', 'foreground-closed'])(
        'matches only the exact stage %s and returns no nonce, authority or final acceptance',
        (stage) => {
            const candidate = driverStage(stage);
            const output = requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected);
            expect(output.stage).toBe(stage);
            expect(output.wholeRunAccepted).toBe(false);
            expect(output.messagingPermission).toBe(false);
            expect(output.sourceArtifactVerificationRequired).toBe(true);
            expect(output.protectedUiClosed).toBe(stage === 'foreground-closed');
            expect(Object.isFrozen(output)).toBe(true);
            expect(JSON.stringify(output)).not.toContain(pin.nonce);
            expect(JSON.stringify(output)).not.toContain('protectedReport');
        },
    );
    it.each(['driver', 'observer', 'coordinator', 'plugin', 'protectedScript'])(
        'refuses a changed source binding %s',
        (key) => {
            const candidate = driverStage();
            candidate.input.sourceBindings[key] = 'f'.repeat(64);
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        },
    );
    it.each(['observerResourceBytes', 'protectedResourceBytes'])(
        'refuses even parse-equivalent byte drift in %s',
        (key) => {
            const candidate = driverStage();
            Object.assign(candidate.input, { [key]: candidate.input[key as 'observerResourceBytes'] + '\n' });
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        },
    );
    it.each(['resourceSHA256', 'protectedResourceSHA256', 'protectedProofSHA256', 'epoch'])(
        'refuses changed resource/proof/process pin %s',
        (key) => {
            const candidate = driverStage();
            Object.assign(candidate.expected, {
                [key]: key === 'epoch' ? '32345678-1234-4234-8234-123456789abc' : 'f'.repeat(64),
            });
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        },
    );
    it('refuses incomplete, synthetic or unsafe observed stages without completing their traces', () => {
        for (const mutate of [
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.stage = 'unknown';
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.observerEvidence.evidenceCategory = 'synthetic-direct-calls';
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.observerEvidence.events[6].authority.accountPresent = true;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.observerEvidence.events[6].authority.originalSnapshotCurrent = true;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.observerEvidence.events[6].authority.verifyFenceCompletions = 1;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.observerEvidence.events.pop();
                candidate.input.observerEvidence.eventCount -= 1;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.input.protectedUiClosure = null;
            },
        ]) {
            const candidate = driverStage();
            mutate(candidate);
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        }
    });
    it.each([
        'actualAppNavigation',
        'privateOpenEnabled',
        'logPresent',
        'composeEmpty',
        'passwordEmpty',
        'legacyControlsAbsent',
    ])('requires actual protected PM closure fact %s', (key) => {
        const candidate = driverStage();
        const facts = candidate.closure.domFacts;
        Object.assign(facts, { [key]: !facts[key as keyof typeof facts] });
        expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
            'evidence refused',
        );
    });
    it.each([
        'authenticate',
        'nativeAuthRequests',
        'fixtureSetupControls',
        'fixtureReplyControls',
        'privateMessageIssue',
        'privateMessageSendText',
    ])('refuses automatic Auth/setup/private operation growth %s', (key) => {
        const candidate = driverStage();
        candidate.closure.nativeCounters[key] += 1;
        expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
            'evidence refused',
        );
    });
    it.each(['auth', 'register', 'dispatch', 'unexpected'])(
        'compares live relay growth %s against the captured proof',
        (key) => {
            const candidate = driverStage();
            candidate.closure.relayCounters[key as keyof typeof candidate.closure.relayCounters] += 1;
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        },
    );
    it('refuses SDK Auth growth, remounts, stopped roots and retained private selection', () => {
        for (const mutate of [
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.sdkCounts.password += 1;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.windowEvidence.fence.counts.authRequests += 1;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.windowEvidence.root.remounts += 1;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.windowEvidence.lifecycle.stopped = true;
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.windowEvidence.privateSelection = 'native-pilot';
            },
            (candidate: ReturnType<typeof driverStage>) => {
                candidate.closure.pmResultCounters['privateMessageSendText:ok'] += 1;
            },
        ]) {
            const candidate = driverStage();
            mutate(candidate);
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
        }
    });
    it.each(['observerEvidence', 'observerResourceBytes', 'protectedReport', 'sourceBindings'])(
        'refuses driver input accessor %s without invoking it',
        (key) => {
            const getter = vi.fn(() => {
                throw new Error('private-canary');
            });
            const candidate = driverStage();
            Object.defineProperty(candidate.input, key, { get: getter });
            expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
                'evidence refused',
            );
            expect(getter).not.toHaveBeenCalled();
        },
    );
    it('keeps failed/unknown closure facts inspectable but never accepts them as UI closure', () => {
        const candidate = driverStage();
        const failed = {
            ...candidate.closure,
            status: 'failed',
            phase: 'lifecycle-failed',
            domFacts: null,
            windowEvidence: null,
            nativeCounters: null,
            pmResultCounters: null,
            sdkCounts: null,
            relayCounters: null,
        };
        const { sourceBindings: _, ...closureExpected } = candidate.expected;
        const inspected = inspectResearchSceneProtectedUiClosure(failed, closureExpected);
        expect(inspected.domFacts).toBeNull();
        expect(inspected.nativeCounters).toBeNull();
        expect(inspected.status).toBe('failed');
        expect(() =>
            requireResearchSceneProtectedDriverStage(
                { ...candidate.input, protectedUiClosure: failed },
                candidate.expected,
            ),
        ).toThrow('evidence refused');
    });
    it('refuses accessor/unknown closure facts before invoking or retaining private errors', () => {
        const candidate = driverStage();
        const { sourceBindings: _, ...closureExpected } = candidate.expected;
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        Object.defineProperty(candidate.closure.domFacts, 'logPresent', { get: getter });
        expect(() => inspectResearchSceneProtectedUiClosure(candidate.closure, closureExpected)).toThrow(
            'evidence refused',
        );
        expect(getter).not.toHaveBeenCalled();
        expect(() =>
            inspectResearchSceneProtectedUiClosure({ ...candidate.closure, error: 'private-canary' }, closureExpected),
        ).toThrow('evidence refused');
    });
});

describe('scene evidence projection — synthetic traces, never native acceptance', () => {
    it('retains nullable unknown observations and freezes every copied layer', () => {
        const projected = inspectResearchSceneLifecycleEvidence(receipt(), pin);
        expect(projected.events[0].authority.accountPresent).toBeNull();
        expect(projected.events[0].authority.verifyFenceCompletions).toBeNull();
        expect(projected.osLifecycleProved).toBe(false);
        for (const row of [
            projected,
            projected.process,
            projected.events,
            projected.events[0],
            projected.events[0].cover,
            projected.events[0].authority,
        ])
            expect(Object.isFrozen(row)).toBe(true);
    });
    it.each([
        { version: 3 },
        { kind: 'passed-native-exchange' },
        { runID: '32345678-1234-4234-8234-123456789abc' },
        { nonce: 'c'.repeat(64) },
        { resourceSHA256: 'c'.repeat(64) },
        { evidenceCategory: 'physical-device' },
        { status: 'passed' },
        { eventCount: 0 },
        { eventCount: 65 },
        { eventCount: '10' },
        { osLifecycleProved: true },
        { authorityMutated: true },
        { error: 'private-canary' },
    ])('refuses malformed or overclaimed envelope %s', (mutation) => {
        expect(() => inspectResearchSceneLifecycleEvidence({ ...receipt(), ...mutation }, pin)).toThrow(
            'evidence refused',
        );
    });
    it.each(['runID', 'nonce', 'resourceSHA256', 'pid'])('refuses accessor pin %s without invoking it', (key) => {
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        const candidate = { ...pin };
        Object.defineProperty(candidate, key, { get: getter });
        expect(() => inspectResearchSceneLifecycleEvidence(receipt(), candidate)).toThrow('evidence refused');
        expect(getter).not.toHaveBeenCalled();
    });
    it.each([{ pid: 0 }, { pid: 1235 }, { pid: '1234' }, { epoch: 'invalid' }, { secret: 'private-canary' }])(
        'refuses process correlation mismatch %s',
        (mutation) => {
            const row = receipt();
            expect(() =>
                inspectResearchSceneLifecycleEvidence({ ...row, process: { ...row.process, ...mutation } }, pin),
            ).toThrow('evidence refused');
        },
    );
    it.each(['sequence', 'index', 'event', 'activationState', 'cover', 'authority'])(
        'refuses event accessor %s without invoking it',
        (key) => {
            const getter = vi.fn(() => {
                throw new Error('private-canary');
            });
            const row = receipt();
            Object.defineProperty(row.events[0], key, { get: getter });
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
            expect(getter).not.toHaveBeenCalled();
        },
    );
    it('refuses sparse, accessor, extra-key and reordered events', () => {
        for (const mutate of [
            (row: ReturnType<typeof receipt>) => {
                delete (row.events as Array<unknown>)[1];
            },
            (row: ReturnType<typeof receipt>) => {
                Object.defineProperty(row.events, 'extra', { value: 'private-canary' });
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[0].sequence = 2;
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[0].event = 'scene-connected';
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[4].event = 'process-started';
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[4].activationState = 'synthetic-hidden';
            },
        ]) {
            const row = receipt();
            mutate(row);
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        }
    });
    it('refuses absent native observations disguised as false or completed fences', () => {
        for (const mutation of [
            { accountPresent: false },
            { originalSnapshotCurrent: false },
            { verifyFenceCompletions: 1 },
            { facadeObserved: true },
        ]) {
            const row = receipt();
            Object.assign(row.events[0].authority, mutation);
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        }
    });
    it('requires exactly bounded capacity refusal and keeps observations distinct from passes', () => {
        const row = receipt();
        row.status = 'capacity-refused';
        expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        row.events = Array.from({ length: 64 }, (_, index) => ({
            ...row.events[0],
            index,
            sequence: index + 1,
            event: index ? 'did-become-active' : 'process-started',
        }));
        row.eventCount = 64;
        expect(inspectResearchSceneLifecycleEvidence(row, pin).status).toBe('capacity-refused');
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
});

describe('future OS observation gate — populated only with synthetic test values here', () => {
    it('never upgrades synthetic direct calls into OS proof', () => {
        expect(() => requireResearchSceneProtectedRoundTrip(receipt(), pin)).toThrow('evidence refused');
    });
    it('matches a fabricated candidate sequence only with explicit further driver/UI evidence requirements', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        expect(requireResearchSceneProtectedRoundTrip(row, pin)).toEqual({
            status: 'observations-matched',
            pid: pin.pid,
            epoch: row.process.epoch,
            evidenceCategory: 'simulator-native-observations',
            sameProcessSceneRoundTrip: true,
            sourceBoundDriverAcceptanceRequired: true,
            protectedUiClosureReceiptRequired: true,
            physicalAcceptance: false,
            sameStoreRecoveryProved: false,
            messagingPermission: false,
        });
    });
    it.each([
        ['foreground-active', 'background'],
        ['foreground-active', 'foreground-inactive'],
        ['foreground-inactive', 'background'],
    ])('retains pretransition UIKit will-callback states %s/%s', (resigning, entering) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[5].activationState = resigning;
        row.events[7].activationState = entering;
        expect(requireResearchSceneProtectedRoundTrip(row, pin).status).toBe('observations-matched');
        expect(row.events[5].activationState).toBe(resigning);
        expect(row.events[7].activationState).toBe(entering);
    });
    it('allows the actual startup will-enter callback before the first activation', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events.splice(3, 0, {
            ...row.events[2],
            event: 'will-enter-foreground',
            activationState: 'background',
            cover: cover(false),
            authority: coldAuthority(),
        });
        row.events.forEach((event, index) => {
            event.index = index;
            event.sequence = index + 1;
        });
        row.eventCount = row.events.length;
        expect(requireResearchSceneProtectedRoundTrip(row, pin).status).toBe('observations-matched');
        row.events[3].activationState = 'foreground-active';
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it.each([
        [5, 'background'],
        [5, 'unknown'],
        [6, 'foreground-inactive'],
        [7, 'foreground-active'],
        [7, 'unknown'],
        [8, 'background'],
    ])('refuses impossible or unknown transition state at %s: %s', (index, state) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[Number(index)].activationState = String(state);
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it.each([4, 5, 6, 7, 8, 9])('refuses missing original snapshot observation at stage %s', (index) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[index].authority.originalSnapshotObserved = false;
        row.events[index].authority.originalSnapshotCurrent = null;
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it.each([5, 6, 7, 8, 9])(
        'does not accept expiry-only account absence without completed verify fence at stage %s',
        (index) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            row.events[index].authority.verifyFenceCompletions = 1;
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it.each(['accountPresent', 'originalSnapshotCurrent'])(
        'preserves unsafe immediate background %s rather than accepting a later stale sample',
        (key) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            Object.assign(row.events[6].authority, { [key]: true });
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it.each([
        'present',
        'opaque',
        'attachedToOwnedWindow',
        'coversOwnedWindowBounds',
        'accessibilityModal',
        'contentAccessibilityHidden',
    ])('requires observed cover property %s at inactive transition', (key) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        Object.assign(row.events[5].cover, { [key]: false });
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it('refuses alternate callback order or a later second fencing operation', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[7].event = 'did-enter-background';
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        row.events[7].event = 'will-enter-foreground';
        row.events[9].authority.verifyFenceCompletions = 3;
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it('keeps foreground covered until the independently measured DOM acknowledgement', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[8].cover = cover(false);
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it('refuses a duplicate JS fence even when its account absence would look safe', () => {
        const candidate = driverStage();
        candidate.closure.nativeCounters.fenceSession += 1;
        expect(() => requireResearchSceneProtectedDriverStage(candidate.input, candidate.expected)).toThrow(
            'evidence refused',
        );
    });
    it.each(['cover', 'account', 'snapshot', 'fence-count'])(
        'preserves protected observation at will-enter-foreground: %s',
        (mutation) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            const event = row.events[7];
            if (mutation === 'cover') event.cover = cover(false);
            if (mutation === 'account') event.authority.accountPresent = true;
            if (mutation === 'snapshot') event.authority.originalSnapshotCurrent = true;
            if (mutation === 'fence-count') event.authority.verifyFenceCompletions = 3;
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it('retains native fresh-install refusal instead of claiming cold same-store recovery', () => {
        expect(readFileSync('experiments/scuttlebutt-e2ee/bridge-native/ResearchAuthHost.swift', 'utf8')).toContain(
            'requireFreshInstallation(markerPresent: marker != nil, rootExists: rootExists)',
        );
        expect(
            readFileSync('experiments/scuttlebutt-e2ee/bridge-native/ResearchLocalUiFixture.swift', 'utf8'),
        ).toContain('guard !markerPresent, !rootExists else');
    });
});

describe('explicit scene wiring — source regression evidence, not native execution', () => {
    it('guards scene hooks and successful-completion instrumentation behind the separate compiler lane', () => {
        sceneGuardedReferences(nativeSource('ResearchApp.swift'), 'ResearchFullAppSceneUiFixture.');
        sceneGuardedReferences(nativeSource('ScuttlebuttResearchAuthPlugin.swift'), 'noteSceneVerifyCompletion(');
        sceneGuardedReferences(
            nativeSource('ResearchFullAppProtectedUiFixture.swift'),
            'ResearchFullAppSceneUiFixture.',
        );
        expect(nativeSource('ResearchFullAppSceneUiFixture.swift')).toContain(
            '#if E2EE_FULL_APP_SCENE_UI_FIXTURE && targetEnvironment(simulator)',
        );
    });
    it('observes callback state and cover after the existing synchronous presentation operation', () => {
        const app = nativeSource('ResearchApp.swift');
        for (const [signature, nextSignature, presentation, callback] of [
            ['func sceneWillResignActive(', 'func sceneDidEnterBackground(', 'showPrivacyCover()', '.willResignActive'],
            [
                'func sceneDidEnterBackground(',
                'func sceneWillEnterForeground(',
                'showPrivacyCover()',
                '.didEnterBackground',
            ],
            ['func sceneDidBecomeActive(', 'private func showPrivacyCover(', 'hidePrivacyCover()', '.didBecomeActive'],
        ]) {
            const start = app.indexOf(signature),
                end = app.indexOf(nextSignature, start + signature.length);
            expect(start).toBeGreaterThan(0);
            expect(end).toBeGreaterThan(start);
            const body = app.slice(start, end),
                cover = body.indexOf(presentation),
                observation = body.indexOf('ResearchFullAppSceneUiFixture.observe(' + callback);
            expect(cover).toBeGreaterThan(0);
            expect(observation).toBeGreaterThan(cover);
        }
        const coordinator = nativeSource('ResearchFullAppSceneUiFixture.swift');
        expect(coordinator).toContain('activationState: activation(scene?.activationState)');
        expect(coordinator).toContain('ResearchFullAppProtectedUiFixture.sceneAuthorityFacts()');
        expect(coordinator).not.toMatch(/\.fenceSession\s*\(|\.authenticate\s*\(/);
    });
    it('counts a successful verify only after the real native fence returns and before JS resolves', () => {
        const plugin = nativeSource('ScuttlebuttResearchAuthPlugin.swift');
        const start = plugin.indexOf('@objc public func fenceSession('),
            end = plugin.indexOf('@objc public func authenticate(', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const body = plugin.slice(start, end),
            fence = body.indexOf('let fence = try ownedFacade.fenceSession('),
            completion = body.indexOf('ResearchFullAppProtectedUiFixture.noteSceneVerifyCompletion(ownedFacade)'),
            resolve = body.indexOf('call.resolve(["status": "fenced"');
        expect(fence).toBeGreaterThan(0);
        expect(completion).toBeGreaterThan(fence);
        expect(resolve).toBeGreaterThan(completion);
        expect(body).toContain(
            'if mode == "verify" { ResearchFullAppProtectedUiFixture.noteSceneVerifyCompletion(ownedFacade) }',
        );
        expect(body.slice(fence, resolve)).not.toMatch(/\bTask\s*\{/);
    });
    it('persists the validated captured prefix before recording the protected-ready marker', () => {
        const fixture = nativeSource('ResearchFullAppProtectedUiFixture.swift');
        const start = fixture.indexOf('@MainActor func userContentController('),
            end = fixture.indexOf('@MainActor private func control(', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const body = fixture.slice(start, end),
            proof = body.indexOf('guard capturedProof != nil'),
            write = body.indexOf('try write(status: "running", phase: report.phase'),
            ready = body.indexOf('try ResearchFullAppSceneUiFixture.protectedReady()');
        expect(proof).toBeGreaterThan(0);
        expect(write).toBeGreaterThan(proof);
        expect(ready).toBeGreaterThan(write);
        expect(body.split('ResearchFullAppSceneUiFixture.protectedReady()')).toHaveLength(2);
    });
    it('keeps native parse/write mode isolation and exact resource helper selection', () => {
        const fixture = nativeSource('ResearchFullAppProtectedUiFixture.swift');
        expect(
            fixture.match(
                /#if E2EE_FULL_APP_SCENE_UI_FIXTURE\s+let syntheticPagehide = false\s+#else\s+let syntheticPagehide = true\s+#endif/g,
            ),
        ).toHaveLength(2);
        expect(fixture).toContain('Self.boolean(r["syntheticPagehide"]) == syntheticPagehide');
        expect(fixture).toContain('"syntheticPagehide": syntheticPagehide');
        expect(fixture).toContain('source.components(separatedBy: "const sceneLifecycleProof = ").count == 2');
        expect(fixture).toContain(
            'guard source.contains("const sceneLifecycleProof = true;"), !source.contains("const sceneLifecycleProof = false;")',
        );
        expect(fixture).toContain(
            'guard source.contains("const sceneLifecycleProof = false;"), !source.contains("const sceneLifecycleProof = true;")',
        );
    });
    it('requires matching simulator resources and enables both scene flags only for that mode', () => {
        const builder = nativeSource('build.mjs');
        expect(builder).toContain(
            "assert(localUiFile && platform === 'iphonesimulator' && !keyFile && !priorBuildFile)",
        );
        expect(builder).toContain(
            'fullAppProtectedUi && sceneResource.runID === localUi.runID && sceneResource.nonce === localUi.nonce',
        );
        expect(builder).toContain(
            '(sceneResource ? inspectResearchSceneProtectedUiResource : inspectFullAppProtectedNativeResource)',
        );
        expect(builder).toContain(
            "(sceneResource ? ' E2EE_FULL_APP_SCENE_UI_FIXTURE E2EE_SCENE_LIFECYCLE_EVIDENCE' : '')",
        );
        expect(builder).toContain('sceneFixtureResourceSha256: sceneResource ? hash(sceneResourceFile) : null');
        expect(builder).toContain(
            "sceneFixtureContractSha256: sceneResource ? hash(join(HERE, 'researchSceneLifecycleContract.mjs')) : null",
        );
        expect(builder).toContain('receipt.sourceHashes[source] = hash(source)');
        expect(builder).toContain('assert(hash(path) === expected)');
    });
    it('keeps the Ruby scene whitelist at exact 30 sources and the ordinary bound at 24', () => {
        const ruby = nativeSource('generate_project.rb'),
            builder = nativeSource('build.mjs');
        const scene =
            ruby
                .match(/scene_sources = %w\[([\s\S]*?)\]\.sort/)?.[1]
                .trim()
                .split(/\s+/)
                .sort() ?? [];
        expect(scene).toHaveLength(30);
        expect(new Set(scene).size).toBe(30);
        expect(scene).toContain('ResearchSceneAuthorityTimingEvidence.swift');
        expect(scene).toContain('ResearchSceneProgressStageEvidence.swift');
        expect(ruby).toContain(
            "manifest['sceneUiFixture'] ? sources.sort == scene_sources : sources.length.between?(3, 24)",
        );
        expect(ruby).toContain("manifest['localUiFixture'] == true && manifest['sceneUiFixture'] == true");
        expect(ruby).toContain("manifest['localUiFixture'] == true && manifest['platform'] == 'iphonesimulator'");
        const swiftNames = (text: string) => [...text.matchAll(/'([A-Za-z0-9_-]+\.swift)'/g)].map((match) => match[1]);
        const base = builder.match(/const sourcePaths = \[([\s\S]*?)\n {4}\];/)?.[1] ?? '',
            protectedFiles = builder.match(/if \(fullAppProtectedUi\)\s+sourcePaths\.push\(([\s\S]*?)\);/)?.[1] ?? '',
            sceneFiles = builder.match(/if \(sceneResource\)\s+sourcePaths\.push\(([\s\S]*?)\);/)?.[1] ?? '';
        const names = [
            ...swiftNames(base),
            'ResearchLocalUiFixture.swift',
            ...swiftNames(protectedFiles),
            ...swiftNames(sceneFiles),
        ].sort();
        expect(names).toEqual(scene);
    });
    it('binds each driver source label and reads the exact private resources as UTF-8 strings', () => {
        const driver = nativeSource('fullAppProtectedUiProof.mjs');
        const start = driver.indexOf('function sceneSourceBindings()'),
            end = driver.indexOf('function sceneStage(', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const names = Object.fromEntries(
            [...driver.slice(start, end).matchAll(/(\w+): '([^']+)'/g)].map((match) => [match[1], match[2]]),
        );
        expect(Object.keys(names)).toEqual(RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS);
        expect(names.observer).toBe('bridge-native/ResearchSceneLifecycleEvidence.swift');
        expect(names.coordinator).toBe('bridge-native/ResearchFullAppSceneUiFixture.swift');
        expect(driver).toContain("observerResourceBytes: readFileSync(sceneFixtureFile, 'utf8')");
        expect(driver).toContain("protectedResourceBytes: readFileSync(protectedFixtureFile, 'utf8')");
        expect(driver).toContain(
            '(sceneProof ? inspectFullAppSceneProtectedEnvelope : inspectFullAppProtectedNativeEnvelope)',
        );
        expect(driver).toContain('sceneBaseline = inspectFullAppSceneProtectedPrefix(native, runID, nonce)');
    });
    it('bypasses all three synthetic pagehide paths in the scene helper, including failure closure', () => {
        const script = readFileSync('experiments/scuttlebutt-e2ee/full-app-pilot/nativeProtectedUiFixture.js', 'utf8');
        expect(script.split('const sceneLifecycleProof = false;')).toHaveLength(2);
        expect(script).toContain('syntheticPagehide: !sceneLifecycleProof');
        const scene = script.indexOf(
                'if (sceneLifecycleProof) {',
                script.indexOf("post('progress', 'native-proof-captured')"),
            ),
            firstPagehide = script.indexOf("new window.PageTransitionEvent('pagehide'", scene),
            returning = script.indexOf('return;', scene);
        expect(scene).toBeGreaterThan(0);
        expect(returning).toBeGreaterThan(scene);
        expect(firstPagehide).toBeGreaterThan(returning);
        const sceneBody = script.slice(scene, returning);
        expect(sceneBody).toMatch(
            /await wait\(\s*\(\) => sceneProtectedReady && sceneForegroundObserved && scenePresentationClosed,\s*'await-foreground',?\s*\)/,
        );
        expect(sceneBody).toContain("await wait(() => sceneUiClosed, 'await-closure-ack')");
        expect(sceneBody).not.toContain('PageTransitionEvent');
        expect(sceneBody).not.toContain("post('passed'");
        expect(sceneBody).not.toContain('remountName');
        expect(script.match(/new window\.PageTransitionEvent\('pagehide'/g)).toHaveLength(3);
        expect(script).toMatch(
            /if \(!sceneLifecycleProof\)\s+window\.dispatchEvent\(new window\.PageTransitionEvent\('pagehide'/,
        );
    });
    it('measures the actual closure DOM, including absent compose, and sends only seven script fields', () => {
        const script = readFileSync('experiments/scuttlebutt-e2ee/full-app-pilot/nativeProtectedUiFixture.js', 'utf8');
        const start = script.indexOf('const facts = domFacts();'),
            end = script.indexOf("await wait(() => sceneUiClosed, 'await-closure-ack')", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const body = script.slice(start, end);
        expect(body).toContain('const compose = document.querySelector(\'input[aria-label="Message Paired sailor"]\')');
        expect(body).toContain("composeEmpty: !compose || compose.value === ''");
        expect(body).toContain('actualAppNavigation: facts.actualAppNavigation');
        expect(body).toContain('privateOpenEnabled: facts.privateOpenEnabled');
        expect(body).toContain('logPresent: !facts.messageLogAbsent');
        expect(body).toContain('passwordEmpty: facts.passwordEmpty');
        expect(body).toContain('legacyControlsAbsent: facts.legacyControlsAbsent');
        const fields = [...body.matchAll(/^\s{28}(\w+):/gm)].map((match) => match[1]);
        expect(fields).toEqual(['version', 'phase', 'windowEvidence', 'domFacts', 'sdkCounts']);
        expect(body).toMatch(/version: 1,\s+runID,\s+nonce,\s+phase: 'foreground-ui-closed'/);
        expect(body).not.toMatch(/nativeCounters:|relayCounters:|protectedProofSHA256:|protectedResourceSHA256:/);
    });
});

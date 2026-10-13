/** Synthetic schema/comparison tests only. No app, provider, OS callback,
 * protected operation, simulator launch or hosted service is exercised. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { inspectSceneClosureCorrelationDiagnostic as inspect } from './sceneClosureCorrelationDiagnostic.mjs';
import { inspectResearchSceneProtectedUiClosure } from './researchSceneLifecycleContract.mjs';
import {
    FULL_APP_PROTECTED_NATIVE_CASES,
    FULL_APP_PROTECTED_DOM_KEYS,
    FULL_APP_PROTECTED_MESSAGE_KEYS,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
    inspectFullAppSceneProtectedPrefix,
} from './fullAppProtectedUiContract.mjs';
import { FULL_APP_NATIVE_COUNTERS, FULL_APP_NATIVE_HTTP_COUNTERS } from './fullAppUiContract.mjs';
import {
    WINDOW_FENCE_COUNTERS,
    WINDOW_BOUNDARY_COUNTERS,
    WINDOW_MEMORY_COUNTERS,
} from '../full-app-pilot/windowProofContract.mjs';

const groupKeys = [
    'closureFactsPresent',
    'domClosed',
    'windowClosed',
    'sdkAndAuthUnchanged',
    'nativeCountersCorrelated',
    'pmResultsCorrelated',
    'relayCorrelated',
];
const nativeKeys = [
    'configuration',
    'fenceSession',
    'authenticate',
    'currentAccount',
    'lifecycleState',
    'acknowledgeClosedPresentation',
    'messageState',
    'messagePrivateAdmission',
    'messagePairingCard',
    'messageInspectPeerCard',
    'messageConfirmPeer',
    'messageRegisterDevice',
    'messageClaimPeer',
    'messageRefreshPolicy',
    'messageRequireProtected',
    'messageAccountMode',
    'messageThread',
    'messagePrepareText',
    'messageSendPending',
    'messageSyncInbox',
    'privateMessageIssue',
    'privateMessageReadiness',
    'privateMessagePermissions',
    'privateMessageInbox',
    'privateMessageThread',
    'privateMessageSendText',
    'privateMessageRetryPending',
    'nativeAuthRequests',
    'unexpectedNativeRequests',
    'relayRequests',
    'unexpectedMethods',
    'fixtureSetupControls',
    'fixtureReplyControls',
];
const pmKeys = [
    'privateMessagePermissions:ok',
    'privateMessagePermissions:unavailable',
    'privateMessageInbox:ok',
    'privateMessageInbox:unavailable',
    'privateMessageSendText:ok',
    'privateMessageSendText:unavailable',
    'privateMessageRetryPending:ok',
    'privateMessageRetryPending:unavailable',
];
const relayKeys = ['auth', 'register', 'dispatch', 'unexpected'];
const nullableFacts = [
    'domFacts',
    'windowEvidence',
    'nativeCounters',
    'pmResultCounters',
    'sdkCounts',
    'relayCounters',
];
const zero = (names) => Object.fromEntries(names.map((name) => [name, 0]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const at = (value, path) => path.reduce((row, key) => row[key], value);
const set = (value, path, next) => {
    at(value, path.slice(0, -1))[path.at(-1)] = next;
};

function syntheticPair() {
    // Fixed invented identifiers bind this synthetic object pair only.
    const pin = {
        runID: '12345678-1234-4234-8234-123456789abc',
        nonce: 'a'.repeat(64),
        resourceSHA256: 'b'.repeat(64),
        protectedResourceSHA256: 'c'.repeat(64),
        protectedProofSHA256: 'd'.repeat(64),
        pid: 1234,
        epoch: '22345678-1234-4234-8234-123456789abc',
    };
    const nativeCounters = zero(FULL_APP_NATIVE_COUNTERS);
    for (const name of [
        'configuration',
        'authenticate',
        'currentAccount',
        'messagePrivateAdmission',
        'privateMessageIssue',
        'privateMessageReadiness',
        'privateMessagePermissions',
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
    const actor = (initiates) => ({
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
    const hashes = ['e'.repeat(64), 'f'.repeat(64), '0'.repeat(64)];
    const protectedReport = {
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
        domFacts: Object.fromEntries(
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
        ),
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
    const windowEvidence = clone(protectedReport.windowEvidence);
    windowEvidence.auth.status = 'unavailable';
    Object.assign(windowEvidence.authScope, {
        currentUserPresent: false,
        currentAnonymous: true,
        currentGeneration: 2,
    });
    windowEvidence.privateSelection = 'native-unavailable';
    const closure = {
        version: 1,
        kind: 'research-scene-protected-ui-closure',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: pin.resourceSHA256,
        protectedResourceSHA256: pin.protectedResourceSHA256,
        protectedProofSHA256: pin.protectedProofSHA256,
        process: { pid: pin.pid, epoch: pin.epoch },
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
        nativeCounters: { ...nativeCounters, lifecycleState: 1, acknowledgeClosedPresentation: 1 },
        pmResultCounters: { ...pmResultCounters },
        sdkCounts: { ...protectedReport.sdkCounts },
        relayCounters: { ...protectedReport.protectedExchange.relay.methodCounters },
        syntheticPagehide: false,
        realOsLifecycleOrBfCacheProved: false,
    };
    return { input: { closure, protectedReport }, pin };
}

// Read/evaluate the current private predicate function, never a copied gate.
// Any new requireClosedUi condition changes this independent parity oracle.
const contract = readFileSync(new URL('./researchSceneLifecycleContract.mjs', import.meta.url), 'utf8');
const start = contract.indexOf('function requireClosedUi(closure, baseline) {');
const end = contract.indexOf('\n/** Correlate a bounded actual driver stage', start);
assert.ok(start >= 0 && end > start, 'current private closure gate must remain extractable');
const currentGate = runInNewContext(`(${contract.slice(start, end)})`, {
    require: (value) => {
        if (!value) throw new Error('synthetic gate refused');
    },
    FULL_APP_NATIVE_COUNTERS,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
});
function assertParity(pair) {
    const { input, pin } = pair;
    const closure = inspectResearchSceneProtectedUiClosure(input.closure, pin);
    const baseline = inspectFullAppSceneProtectedPrefix(input.protectedReport, pin.runID, pin.nonce);
    let currentMatched = true;
    try {
        currentGate(closure, baseline);
    } catch {
        currentMatched = false;
    }
    const result = inspect(input, pin);
    assert.equal(Object.values(result.facts.groups).every(Boolean), currentMatched);
    return result;
}
function assertBooleanMaps(value) {
    assert.ok(Object.isFrozen(value));
    for (const field of Object.values(value)) {
        if (field !== null && typeof field === 'object') assertBooleanMaps(field);
        else assert.equal(typeof field, 'boolean');
    }
}
const refused = (pair) =>
    assert.throws(() => inspect(pair.input, pair.pin), /^Error: Scene closure correlation diagnostic refused$/);

test('valid invented fixtures pass the actual exported strict inspectors and current gate parity', () => {
    assert.deepEqual(FULL_APP_NATIVE_COUNTERS, nativeKeys);
    assert.deepEqual(FULL_APP_PROTECTED_PM_RESULT_KEYS, pmKeys);
    const pair = syntheticPair();
    const original = clone(pair);
    const result = assertParity(pair);
    assert.deepEqual(pair, original, 'inspection never mutates the caller');
    assert.deepEqual(Reflect.ownKeys(result), ['version', 'kind', 'facts', 'acceptanceEvidence']);
    assert.equal(result.version, 1);
    assert.equal(result.kind, 'scene-closure-correlation-diagnostic');
    assert.equal(result.acceptanceEvidence, false);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Reflect.ownKeys(result.facts), [
        'groups',
        'nativeCounterMatches',
        'pmResultCounterMatches',
        'relayCounterMatches',
    ]);
    assert.deepEqual(Reflect.ownKeys(result.facts.groups), groupKeys);
    assert.deepEqual(Reflect.ownKeys(result.facts.nativeCounterMatches), nativeKeys);
    assert.deepEqual(Reflect.ownKeys(result.facts.pmResultCounterMatches), pmKeys);
    assert.deepEqual(Reflect.ownKeys(result.facts.relayCounterMatches), relayKeys);
    assertBooleanMaps(result.facts);
    for (const map of Object.values(result.facts)) assert.ok(Object.values(map).every((value) => value === true));
});

test('fixed output contains only classification and Boolean maps with no source values or inferred proof', () => {
    const pair = syntheticPair();
    const result = inspect(pair.input, pair.pin);
    const text = JSON.stringify(result);
    for (const value of Object.values(pair.pin)) assert.equal(text.includes(String(value)), false);
    for (const hash of pair.input.protectedReport.protectedExchange.relay.acceptedEnvelopeSHA256)
        assert.equal(text.includes(hash), false);
    for (const name of [
        'status',
        'passed',
        'permission',
        'osLifecycleProved',
        'originalGeneration',
        'currentGeneration',
        'messageFacts',
        'error',
        'nonce',
        'authority',
        'token',
    ])
        assert.equal(Object.hasOwn(result, name), false);
    assertBooleanMaps(result.facts);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 16384);
});

test('failed all-null closure remains inspectable with every dependent fact false and fixed shape', () => {
    const pair = syntheticPair();
    pair.input.closure.status = 'failed';
    pair.input.closure.phase = 'lifecycle-failed';
    for (const name of nullableFacts) pair.input.closure[name] = null;
    const result = assertParity(pair);
    for (const map of Object.values(result.facts)) assert.ok(Object.values(map).every((value) => value === false));
    assertBooleanMaps(result.facts);
    assert.deepEqual(Reflect.ownKeys(result.facts.groups), groupKeys);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16384);
});

for (const name of nullableFacts) {
    test(`null ${name} is unknown and makes its dependent group false`, () => {
        const pair = syntheticPair();
        pair.input.closure[name] = null;
        const result = assertParity(pair);
        assert.equal(result.facts.groups.closureFactsPresent, false);
        const group = {
            domFacts: 'domClosed',
            windowEvidence: 'windowClosed',
            nativeCounters: 'nativeCountersCorrelated',
            pmResultCounters: 'pmResultsCorrelated',
            sdkCounts: 'sdkAndAuthUnchanged',
            relayCounters: 'relayCorrelated',
        }[name];
        assert.equal(result.facts.groups[group], false);
        if (name === 'windowEvidence') assert.equal(result.facts.groups.sdkAndAuthUnchanged, false);
    });
}

const predicateMutations = [
    { path: ['status'], value: 'failed', group: 'closureFactsPresent', phase: 'lifecycle-failed' },
    ...[
        ['actualAppNavigation', false],
        ['privateOpenEnabled', true],
        ['logPresent', true],
        ['composeEmpty', false],
        ['passwordEmpty', false],
        ['legacyControlsAbsent', false],
    ].map(([name, value]) => ({ path: ['domFacts', name], value, group: 'domClosed' })),
    ...[
        [['phase'], 'starting'],
        [['fence', 'status'], 'failed'],
        [['fence', 'counts', 'patchFailures'], 1],
        [['core', 'platform'], 'web'],
        [['auth', 'status'], 'authenticated'],
        [['auth', 'userPresent'], true],
        [['auth', 'authChecked'], false],
        [['privateSelection'], 'native-pilot'],
        [['legacyPermitAvailable'], true],
        [['authScope', 'originalUserPresent'], true],
        [['authScope', 'originalAnonymous'], false],
        [['authScope', 'currentUserPresent'], true],
        [['authScope', 'currentAnonymous'], false],
        [['lifecycle', 'stopped'], true],
        [['root', 'mounts'], 2],
        [['root', 'remounts'], 1],
        [['sdk', 'runtimeCreations'], 2],
        [['sdk', 'sdkConstructions'], 2],
    ].map(([path, value]) => ({ path: ['windowEvidence', ...path], value, group: 'windowClosed' })),
    { path: ['sdkCounts', 'password'], value: 2, group: 'sdkAndAuthUnchanged' },
    { path: ['sdkCounts', 'unexpected'], value: 1, group: 'sdkAndAuthUnchanged' },
    ...['authRequests', 'authResponses', 'authRefused'].map((name) => ({
        path: ['windowEvidence', 'fence', 'counts', name],
        value: 2,
        group: 'sdkAndAuthUnchanged',
    })),
];
for (const { path, value, group, phase } of predicateMutations) {
    test(`current private gate parity for changed ${path.join('.')}`, () => {
        const pair = syntheticPair();
        set(pair.input.closure, path, value);
        if (phase) pair.input.closure.phase = phase;
        const result = assertParity(pair);
        assert.equal(result.facts.groups[group], false);
    });
}

test('both admitted closed auth statuses have current private gate parity', () => {
    for (const status of ['unavailable', 'signed_out']) {
        const pair = syntheticPair();
        pair.input.closure.windowEvidence.auth.status = status;
        assert.ok(Object.values(assertParity(pair).facts.groups).every(Boolean));
    }
});

test('nullable Window fence/core and baseline fence do not invent successful comparisons', () => {
    for (const [scope, name] of [
        ['closure', 'fence'],
        ['closure', 'core'],
        ['protectedReport', 'fence'],
    ]) {
        const pair = syntheticPair();
        pair.input[scope].windowEvidence[name] = null;
        const result = assertParity(pair);
        const group = scope === 'protectedReport' ? 'sdkAndAuthUnchanged' : 'windowClosed';
        assert.equal(result.facts.groups[group], false);
    }
});

for (const key of nativeKeys) {
    test(`native counter map and current private gate parity for growth/decrease/equality of ${key}`, () => {
        const pair = syntheticPair();
        const allowedGrowth = ['lifecycleState', 'acknowledgeClosedPresentation'].includes(key);
        pair.input.closure.nativeCounters[key] = pair.input.protectedReport.nativeCounters[key] + 1;
        const grown = assertParity(pair);
        assert.equal(grown.facts.nativeCounterMatches[key], allowedGrowth);
        assert.equal(grown.facts.groups.nativeCountersCorrelated, allowedGrowth);
        pair.input.protectedReport.nativeCounters[key] = 2;
        pair.input.closure.nativeCounters[key] = 1;
        const decreased = assertParity(pair);
        assert.equal(decreased.facts.nativeCounterMatches[key], false);
        assert.equal(decreased.facts.groups.nativeCountersCorrelated, false);
        pair.input.closure.nativeCounters[key] = 2;
        assert.equal(assertParity(pair).facts.nativeCounterMatches[key], true);
    });
}
for (const key of pmKeys) {
    test(`PM result map uses exact equality for ${key}`, () => {
        const pair = syntheticPair();
        pair.input.closure.pmResultCounters[key] += 1;
        const result = assertParity(pair);
        assert.equal(result.facts.pmResultCounterMatches[key], false);
        assert.equal(result.facts.groups.pmResultsCorrelated, false);
        pair.input.protectedReport.pmResultCounters[key] = 2;
        pair.input.closure.pmResultCounters[key] = 1;
        assert.equal(assertParity(pair).facts.pmResultCounterMatches[key], false);
    });
}
for (const key of relayKeys) {
    test(`relay map uses exact equality for ${key}`, () => {
        const pair = syntheticPair();
        pair.input.closure.relayCounters[key] += 1;
        const result = assertParity(pair);
        assert.equal(result.facts.relayCounterMatches[key], false);
        assert.equal(result.facts.groups.relayCorrelated, false);
    });
}

test('uncompared valid generation/render/network observations do not acquire new gate predicates', () => {
    const pair = syntheticPair();
    pair.input.closure.windowEvidence.authScope.currentGeneration = 10000;
    pair.input.closure.windowEvidence.authScope.originalGeneration = null;
    pair.input.closure.windowEvidence.root.closedRenders = 10000;
    pair.input.closure.windowEvidence.sdk.nativeCalls = 10000;
    pair.input.closure.windowEvidence.fence.counts.fetch = 10000;
    assert.ok(Object.values(assertParity(pair).facts.groups).every(Boolean));
});

const objectPaths = (value, path = []) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    return [path, ...Object.entries(value).flatMap(([key, field]) => objectPaths(field, [...path, key]))];
};
for (const path of objectPaths(syntheticPair())) {
    if (path.length === 0) continue;
    test(`strict dictionary fields/accessors are refused at ${path.join('.')}`, () => {
        for (const mutation of ['extra', 'symbol', 'missing', 'accessor']) {
            const pair = syntheticPair();
            const row = at(pair, path);
            const first = Reflect.ownKeys(row)[0];
            let calls = 0;
            if (mutation === 'extra') row.privateCanary = 'do-not-copy-private-canary';
            if (mutation === 'symbol') row[Symbol('private-canary')] = true;
            if (mutation === 'missing') delete row[first];
            if (mutation === 'accessor')
                Object.defineProperty(row, first, {
                    configurable: true,
                    enumerable: true,
                    get: () => {
                        calls += 1;
                        throw new Error('do-not-copy-private-canary');
                    },
                });
            refused(pair);
            assert.equal(calls, 0, 'accessor must never be invoked');
        }
    });
}

test('every exact input and pin property accessor is refused before invocation', () => {
    for (const path of [['input'], ['pin']]) {
        for (const name of Reflect.ownKeys(at(syntheticPair(), path))) {
            const pair = syntheticPair();
            let calls = 0;
            Object.defineProperty(at(pair, path), name, {
                configurable: true,
                enumerable: true,
                get: () => {
                    calls += 1;
                    return 'private-canary';
                },
            });
            refused(pair);
            assert.equal(calls, 0);
        }
    }
});

test('input own-data rules refuse arrays/primitives/foreign prototypes/nonenumerable fields', () => {
    for (const invalid of [null, undefined, true, 1, 'private-canary', [], new Date()]) {
        const pair = syntheticPair();
        pair.input = invalid;
        refused(pair);
    }
    const pair = syntheticPair();
    Object.defineProperty(pair.input, 'closure', { enumerable: false });
    refused(pair);
    const foreign = syntheticPair();
    Object.setPrototypeOf(foreign.input, { privateCanary: 'private-canary' });
    refused(foreign);
    const plain = syntheticPair();
    Object.setPrototypeOf(plain.input, null);
    assert.ok(Object.values(inspect(plain.input, plain.pin).facts.groups).every(Boolean));
});

test('pin mismatches and malformed values remain strict schema refusals', () => {
    for (const name of [
        'runID',
        'nonce',
        'resourceSHA256',
        'protectedResourceSHA256',
        'protectedProofSHA256',
        'pid',
        'epoch',
    ]) {
        const pair = syntheticPair();
        pair.pin[name] =
            name === 'pid'
                ? 1235
                : name === 'runID' || name === 'epoch'
                  ? '32345678-1234-4234-8234-123456789abc'
                  : '9'.repeat(64);
        refused(pair);
        for (const invalid of [null, undefined, true, 'private-canary', 0, 1.5]) {
            const malformed = syntheticPair();
            malformed.pin[name] = invalid;
            refused(malformed);
        }
    }
});

test('strict report prefix refuses failed/late/unbound reports without constructing a diagnostic', () => {
    for (const [name, value] of [
        ['runID', '32345678-1234-4234-8234-123456789abc'],
        ['nonce', '9'.repeat(64)],
        ['phase', 'pm-opened'],
        ['status', 'failed'],
        ['assertions', 0],
        ['protectedExchange', null],
        ['windowEvidence', null],
        ['syntheticPagehide', true],
        ['realOsLifecycleOrBfCacheProved', true],
    ]) {
        const pair = syntheticPair();
        pair.input.protectedReport[name] = value;
        refused(pair);
    }
});

test('raw counters cannot smuggle strings, fractions, NaN, infinity or out-of-bound values', () => {
    for (const path of [
        ['input', 'closure', 'nativeCounters'],
        ['input', 'closure', 'pmResultCounters'],
        ['input', 'closure', 'relayCounters'],
        ['input', 'closure', 'sdkCounts'],
        ['input', 'protectedReport', 'nativeCounters'],
        ['input', 'protectedReport', 'pmResultCounters'],
    ]) {
        for (const invalid of [null, undefined, true, 'private-canary', -1, 0.5, NaN, Infinity, 10001]) {
            const pair = syntheticPair();
            const row = at(pair, path);
            row[Reflect.ownKeys(row)[0]] = invalid;
            refused(pair);
        }
    }
});

test('strict bounded report arrays refuse extra fields and getters without invocation', () => {
    for (const path of [
        ['input', 'protectedReport', 'cases'],
        ['input', 'protectedReport', 'protectedExchange', 'relay', 'acceptedEnvelopeSHA256'],
    ]) {
        const extra = syntheticPair();
        at(extra, path).privateCanary = true;
        refused(extra);
        const getter = syntheticPair();
        let calls = 0;
        Object.defineProperty(at(getter, path), '0', {
            configurable: true,
            enumerable: true,
            get: () => {
                calls += 1;
                return 'private-canary';
            },
        });
        refused(getter);
        assert.equal(calls, 0);
    }
});

test('thrown inspection errors are sanitized and never returned or retained', () => {
    const pair = syntheticPair();
    pair.input = new Proxy(pair.input, {
        ownKeys: () => {
            throw new Error('do-not-copy-private-canary');
        },
    });
    refused(pair);
});

test('result maps stay independent of caller mutations and refuse subsequent writes', () => {
    const pair = syntheticPair();
    const result = inspect(pair.input, pair.pin);
    pair.input.closure.nativeCounters.authenticate = 10000;
    pair.input.closure.domFacts.logPresent = true;
    assert.equal(result.facts.nativeCounterMatches.authenticate, true);
    assert.equal(result.facts.groups.domClosed, true);
    assert.throws(() => {
        result.facts.groups.domClosed = false;
    }, TypeError);
    assert.throws(() => {
        result.facts.nativeCounterMatches.authenticate = false;
    }, TypeError);
    assert.throws(() => {
        result.facts.pmResultCounterMatches[pmKeys[0]] = false;
    }, TypeError);
    assert.throws(() => {
        result.facts.relayCounterMatches.auth = false;
    }, TypeError);
});

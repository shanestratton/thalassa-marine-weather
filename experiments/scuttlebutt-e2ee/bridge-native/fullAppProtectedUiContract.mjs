/** Pure full-root protected fixture schema. Not native authority, live Auth,
 * a hosted relay, physical acceptance or independent security assessment. */
import { Buffer } from 'node:buffer';
import { inspectWindowEvidence } from '../full-app-pilot/windowProofContract.mjs';
import { FULL_APP_NATIVE_COUNTERS, FULL_APP_NATIVE_HTTP_COUNTERS } from './fullAppUiContract.mjs';

export const FULL_APP_PROTECTED_NATIVE_SCENARIO = 'full-app-native-protected-exchange';
export const FULL_APP_PROTECTED_RUN_MARKER = '__RESEARCH_FULL_APP_PROTECTED_RUN_ID__';
export const FULL_APP_PROTECTED_NONCE_MARKER = '__RESEARCH_FULL_APP_PROTECTED_NONCE__';
export const FULL_APP_PROTECTED_NATIVE_CASES = Object.freeze([
    'native-http-refusals',
    'cold-root-closed',
    'sdk-native-auth-browse-only',
    'unknown-admission-no-private-open',
    'explicit-owned-peer-setup',
    'native-admission-readiness',
    'actual-app-chat-pm-open',
    'actual-native-pm-send',
    'actual-native-pm-receive',
    'dedup-truthful-status',
    'native-exchange-proof-captured',
    'synthetic-terminal-pagehide',
    'fresh-root-no-restored-authority',
    'final-root-closed',
]);
export const FULL_APP_PROTECTED_NATIVE_PHASES = Object.freeze([
    'application-launched',
    'scene-connected',
    'bridge-created',
    'fixture-installed',
    'fixture-install-failed',
    'script-installed',
    'dom-ready',
    'http-refusals',
    'cold-ready',
    'signed-in',
    'unknown-admission',
    'protected-setup',
    'prepared',
    'admission-ready',
    'pm-opened',
    'pm-sent',
    'peer-replied',
    'pm-received',
    'pm-deduped',
    'native-proof-captured',
    'terminal-closed',
    'root-remounted',
    'fixture-complete',
    'fixture-failed',
    'protected-control-failed',
    'protected-peer-reply',
    'capture-proof',
]);
export const FULL_APP_PROTECTED_DOM_KEYS = Object.freeze([
    'actualAppNavigation',
    'authenticatedNotice',
    'signedOutNotice',
    'unknownAdmission',
    'unavailablePrivateView',
    'stoppedNotice',
    'messageLogAbsent',
    'signInEnabled',
    'privateOpenEnabled',
    'passwordEmpty',
    'logPresent',
    'composeEmpty',
    'encryptionTestLabel',
    'truthfulIncomingStatus',
    'truthfulOutgoingStatus',
    'legacyControlsAbsent',
]);
export const FULL_APP_PROTECTED_MESSAGE_KEYS = Object.freeze([
    'outgoingRows',
    'incomingRows',
    'openerRows',
    'outgoingAccepted',
    'incomingReceived',
    'incomingTimeUnknown',
    'incomingReadUnknown',
    'outgoingNotDeliveredOrRead',
    'composeEmpty',
    'dedupStable',
]);
export const FULL_APP_PROTECTED_PM_RESULT_KEYS = Object.freeze(
    [
        'privateMessagePermissions',
        'privateMessageInbox',
        'privateMessageSendText',
        'privateMessageRetryPending',
    ].flatMap((name) => ['ok', 'unavailable'].map((status) => name + ':' + status)),
);
const helperCalls = Object.freeze([
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
]);
const reportKeys = Object.freeze([
    'version',
    'runID',
    'nonce',
    'scenario',
    'status',
    'phase',
    'assertions',
    'nativeAssertions',
    'sdkCounts',
    'cases',
    'nativeCounters',
    'nativeState',
    'nativeHttpFence',
    'windowEvidence',
    'domFacts',
    'messageFacts',
    'protectedExchange',
    'pmResultCounters',
    'syntheticPagehide',
    'realOsLifecycleOrBfCacheProved',
]);
// Twenty keys: all variants use this exact envelope; resource is separately v4.
export const FULL_APP_PROTECTED_REPORT_KEYS = reportKeys;
const refused = () => {
    throw new Error('Full App protected native fixture contract refused');
};
const require = (value) => {
    if (!value) refused();
};
const uuid = (v) =>
    typeof v === 'string' &&
    v.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const nonce = (v) => typeof v === 'string' && v.length === 64 && /^[0-9a-f]{64}$/.test(v);
function data(raw, key) {
    const p = Object.getOwnPropertyDescriptor(raw, key);
    require(p && 'value' in p);
    return p.value;
}
function exact(raw, keys) {
    require(raw && typeof raw === 'object' && !Array.isArray(raw));
    const names = Reflect.ownKeys(raw);
    require(names.length === keys.length && names.every((k) => typeof k === 'string' && keys.includes(k)));
    return Object.fromEntries(keys.map((k) => [k, data(raw, k)]));
}
function integer(v, max = 10000) {
    require(Number.isSafeInteger(v) && v >= 0 && v <= max);
    return v;
}
function counts(raw, keys) {
    const row = exact(raw, keys);
    for (const k of keys) row[k] = integer(row[k]);
    return Object.freeze(row);
}
function booleans(raw, keys) {
    const row = exact(raw, keys);
    for (const k of keys) require(typeof row[k] === 'boolean');
    return Object.freeze(row);
}
function array(raw, min, max, inspector) {
    require(Array.isArray(raw));
    const length = data(raw, 'length');
    require(
        Number.isSafeInteger(length) && length >= min && length <= max && Reflect.ownKeys(raw).length === length + 1,
    );
    return Object.freeze(Array.from({ length }, (_, i) => inspector(data(raw, String(i)))));
}
function guarded(action) {
    try {
        return action();
    } catch {
        return refused();
    }
}

/** Shared-Mac scheduling facts, not native permission or execution evidence. */
export function inspectFullAppProtectedWait(raw) {
    return guarded(() => {
        const row = exact(raw, ['limitMs', 'spentMs', 'otherHeavyProcesses']);
        integer(row.limitMs, 120000);
        integer(row.spentMs, Number.MAX_SAFE_INTEGER);
        integer(row.otherHeavyProcesses, 100000);
        if (row.spentMs > row.limitMs || (row.spentMs > 0 && row.spentMs >= row.limitMs)) return 'exhausted';
        if (row.otherHeavyProcesses === 0) return 'ready';
        return row.spentMs >= row.limitMs ? 'exhausted' : 'waiting';
    });
}

export function addFullAppProtectedChildWait(raw) {
    return guarded(() => {
        const row = exact(raw, ['limitMs', 'spentMs', 'childSpentMs', 'childStatus']);
        integer(row.limitMs, 120000);
        integer(row.spentMs, row.limitMs);
        integer(row.childSpentMs, Number.MAX_SAFE_INTEGER - row.spentMs);
        require(row.childStatus === 'passed' || row.childStatus === 'queued-unrun');
        const spentMs = row.spentMs + row.childSpentMs;
        if (row.childStatus === 'queued-unrun') return Object.freeze({ spentMs, queued: true });
        require(row.childSpentMs <= row.limitMs - row.spentMs);
        return Object.freeze({ spentMs, queued: spentMs > 0 && spentMs >= row.limitMs });
    });
}

/** Whole-run acceptance is later than a passed native observation. */
export function requireFullAppProtectedCleanup(raw) {
    return guarded(() => {
        const row = exact(raw, ['idAbsent', 'nameAbsent', 'sourcesUnchanged']);
        require(row.idAbsent === true && row.nameAbsent === true && row.sourcesUnchanged === true);
        return true;
    });
}

export function createFullAppProtectedNativeResource(template, runID, runNonce) {
    return guarded(() => {
        require(
            uuid(runID) &&
                nonce(runNonce) &&
                typeof template === 'string' &&
                Buffer.byteLength(template, 'utf8') > 0 &&
                Buffer.byteLength(template, 'utf8') <= 65536,
        );
        require(
            template.split(FULL_APP_PROTECTED_RUN_MARKER).length === 2 &&
                template.split(FULL_APP_PROTECTED_NONCE_MARKER).length === 2,
        );
        return Object.freeze({
            version: 4,
            runID,
            nonce: runNonce,
            scenario: FULL_APP_PROTECTED_NATIVE_SCENARIO,
            script: template
                .replace(FULL_APP_PROTECTED_RUN_MARKER, runID)
                .replace(FULL_APP_PROTECTED_NONCE_MARKER, runNonce),
        });
    });
}
export function inspectFullAppProtectedNativeResource(raw, template) {
    return guarded(() => {
        const row = exact(raw, ['version', 'runID', 'nonce', 'scenario', 'script']);
        require(row.version === 4 && row.scenario === FULL_APP_PROTECTED_NATIVE_SCENARIO);
        const expected = createFullAppProtectedNativeResource(template, row.runID, row.nonce);
        require(row.script === expected.script);
        return expected;
    });
}
function actor(raw) {
    const row = exact(raw, [
        'selection',
        'registration',
        'claim',
        'pairing',
        'initialRole',
        'sessionRole',
        'fullFingerprintStillConfirmed',
        'outgoingCount',
        'incomingCount',
        'unresolvedCount',
    ]);
    require(
        row.selection === 'protected-required' &&
            row.registration === 'acknowledged' &&
            ['verified', 'none'].includes(row.claim) &&
            row.pairing === 'confirmed' &&
            ['initiator', 'responder'].includes(row.initialRole) &&
            row.sessionRole === 'established' &&
            row.fullFingerprintStillConfirmed === true &&
            row.unresolvedCount === 0,
    );
    row.outgoingCount = integer(row.outgoingCount, 2);
    row.incomingCount = integer(row.incomingCount, 2);
    return Object.freeze(row);
}
function relay(raw) {
    const row = exact(raw, [
        'version',
        'methodCounters',
        'authCounters',
        'actionCounters',
        'acceptedEnvelopeSHA256',
        'signatureVerificationCounts',
        'canaryAbsence',
        'acceptedSendCount',
    ]);
    require(row.version === 1);
    row.methodCounters = counts(row.methodCounters, ['auth', 'register', 'dispatch', 'unexpected']);
    row.authCounters = counts(row.authCounters, ['host', 'peer']);
    row.actionCounters = counts(row.actionCounters, [
        'require-protected',
        'account-mode',
        'policy',
        'claim',
        'send',
        'list',
    ]);
    row.signatureVerificationCounts = counts(row.signatureVerificationCounts, ['registration', 'dispatch']);
    row.canaryAbsence = booleans(row.canaryAbsence, ['outgoing', 'peer', 'opener']);
    row.acceptedEnvelopeSHA256 = array(row.acceptedEnvelopeSHA256, 2, 3, (v) => {
        require(nonce(v));
        return v;
    });
    row.acceptedSendCount = integer(row.acceptedSendCount, 3);
    return Object.freeze(row);
}
function exchange(raw) {
    const row = exact(raw, [
        'version',
        'status',
        'hostInitiates',
        'originalHostBindingStillCurrent',
        'originalPeerBindingStillCurrent',
        'host',
        'peer',
        'uiOutgoingEnvelopeSHA256',
        'peerReplyEnvelopeSHA256',
        'peerOpenerEnvelopeSHA256',
        'nativeAssertions',
        'nativeCalls',
        'relay',
        'syntheticAuthAndRelay',
        'physicalDeviceExecution',
        'capturedBeforeTerminal',
    ]);
    require(
        row.version === 1 &&
            row.status === 'passed' &&
            typeof row.hostInitiates === 'boolean' &&
            row.originalHostBindingStillCurrent === true &&
            row.originalPeerBindingStillCurrent === true &&
            row.syntheticAuthAndRelay === true &&
            row.physicalDeviceExecution === false &&
            row.capturedBeforeTerminal === true,
    );
    row.host = actor(row.host);
    row.peer = actor(row.peer);
    require(
        nonce(row.uiOutgoingEnvelopeSHA256) &&
            nonce(row.peerReplyEnvelopeSHA256) &&
            (row.peerOpenerEnvelopeSHA256 === null || nonce(row.peerOpenerEnvelopeSHA256)),
    );
    row.nativeAssertions = integer(row.nativeAssertions);
    require(row.nativeAssertions > 0);
    row.nativeCalls = counts(row.nativeCalls, helperCalls);
    row.relay = relay(row.relay);
    const expected = row.hostInitiates ? 2 : 3;
    const calls = row.nativeCalls;
    require(
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
            'peer-pm-issue',
            'peer-pm-inbox',
        ].every((k) => calls[k] === 1) &&
            calls['host-claim'] === (row.hostInitiates ? 1 : 0) &&
            calls['peer-claim'] === (row.hostInitiates ? 0 : 1) &&
            calls['peer-pm-send'] === expected - 1 &&
            calls['host-thread-read'] === 2 &&
            calls['peer-thread-read'] === (row.hostInitiates ? 3 : 4),
    );
    require(
        (row.peerOpenerEnvelopeSHA256 === null) === row.hostInitiates &&
            row.host.outgoingCount === 1 &&
            row.host.incomingCount === (row.hostInitiates ? 1 : 2) &&
            row.peer.outgoingCount === (row.hostInitiates ? 1 : 2) &&
            row.peer.incomingCount === 1 &&
            row.host.initialRole === (row.hostInitiates ? 'initiator' : 'responder') &&
            row.peer.initialRole === (row.hostInitiates ? 'responder' : 'initiator') &&
            row.host.claim === (row.hostInitiates ? 'verified' : 'none') &&
            row.peer.claim === (row.hostInitiates ? 'none' : 'verified'),
    );
    const hashes = [
        row.uiOutgoingEnvelopeSHA256,
        row.peerReplyEnvelopeSHA256,
        ...(row.peerOpenerEnvelopeSHA256 === null ? [] : [row.peerOpenerEnvelopeSHA256]),
    ];
    require(
        new Set(hashes).size === expected &&
            row.relay.acceptedSendCount === expected &&
            row.relay.acceptedEnvelopeSHA256.length === expected &&
            new Set(row.relay.acceptedEnvelopeSHA256).size === expected &&
            hashes.every((v) => row.relay.acceptedEnvelopeSHA256.includes(v)) &&
            Object.values(row.relay.canaryAbsence).every((v) => v === true),
    );
    const m = row.relay.methodCounters,
        a = row.relay.actionCounters,
        s = row.relay.signatureVerificationCounts;
    require(
        m.unexpected === 0 &&
            m.auth === 4 &&
            m.register === 2 &&
            row.relay.authCounters.host === 2 &&
            row.relay.authCounters.peer === 2 &&
            a['require-protected'] === 2 &&
            a['account-mode'] === 0 &&
            a.claim === 1 &&
            a.send === expected &&
            a.list >= 3 &&
            a.list <= 16 &&
            m.dispatch === Object.values(a).reduce((sum, v) => sum + v, 0) &&
            s.registration === 2 &&
            s.dispatch === m.dispatch,
    );
    return Object.freeze(row);
}
function http(raw, challenge = false) {
    const row = exact(raw, [
        'version',
        'status',
        'primaryCurrent',
        'classAliasCurrent',
        'observedDefaultMethodCount',
        'primaryCounts',
        'classAliasCounts',
    ]);
    require(
        row.version === 1 &&
            row.status === 'installed' &&
            row.primaryCurrent === true &&
            row.classAliasCurrent === true &&
            row.observedDefaultMethodCount === 6,
    );
    for (const key of ['primaryCounts', 'classAliasCounts']) {
        row[key] = counts(row[key], FULL_APP_NATIVE_HTTP_COUNTERS);
        require(
            FULL_APP_NATIVE_HTTP_COUNTERS.every((name) =>
                ['addListener', 'removeListener'].includes(name)
                    ? row[key][name] === 0
                    : challenge
                      ? row[key][name] === 1
                      : row[key][name] <= 1,
            ),
        );
    }
    return Object.freeze(row);
}
function messageFacts(raw) {
    const row = exact(raw, FULL_APP_PROTECTED_MESSAGE_KEYS);
    row.outgoingRows = integer(row.outgoingRows, 1);
    row.incomingRows = integer(row.incomingRows, 2);
    row.openerRows = integer(row.openerRows, 1);
    for (const key of FULL_APP_PROTECTED_MESSAGE_KEYS.slice(3)) require(typeof row[key] === 'boolean');
    return Object.freeze(row);
}
const prefixes = {
    'fixture-installed': 0,
    'script-installed': 0,
    'dom-ready': 0,
    'http-refusals': 1,
    'cold-ready': 2,
    'signed-in': 3,
    'unknown-admission': 4,
    'protected-setup': 4,
    prepared: 5,
    'admission-ready': 6,
    'pm-opened': 7,
    'pm-sent': 8,
    'peer-replied': 8,
    'pm-received': 9,
    'pm-deduped': 10,
    'native-proof-captured': 11,
    'terminal-closed': 12,
    'root-remounted': 13,
    'fixture-complete': 14,
};

export function inspectFullAppProtectedNativeEnvelope(raw, runID, runNonce) {
    return guarded(() => {
        require(uuid(runID) && nonce(runNonce));
        const row = exact(raw, reportKeys);
        require(
            row.version === 3 &&
                row.runID === runID &&
                row.nonce === runNonce &&
                row.scenario === FULL_APP_PROTECTED_NATIVE_SCENARIO &&
                ['running', 'passed', 'failed'].includes(row.status) &&
                FULL_APP_PROTECTED_NATIVE_PHASES.includes(row.phase) &&
                row.syntheticPagehide === true &&
                row.realOsLifecycleOrBfCacheProved === false,
        );
        require(
            row.status === 'passed'
                ? row.phase === 'fixture-complete'
                : row.status === 'failed'
                  ? row.phase === 'fixture-failed'
                  : Object.hasOwn(prefixes, row.phase) && row.phase !== 'fixture-complete',
        );
        row.assertions = integer(row.assertions);
        row.nativeAssertions = integer(row.nativeAssertions, 12);
        require(row.status === 'passed' ? row.nativeAssertions === 12 : row.nativeAssertions === 0);
        row.sdkCounts = row.sdkCounts === null ? null : counts(row.sdkCounts, ['password', 'unexpected']);
        const expected =
            row.status === 'failed'
                ? ['fixture-failed']
                : FULL_APP_PROTECTED_NATIVE_CASES.slice(0, prefixes[row.phase]);
        row.cases = array(row.cases, expected.length, expected.length, (v) => v);
        require(row.cases.every((v, i) => v === expected[i]));
        row.nativeCounters = counts(row.nativeCounters, FULL_APP_NATIVE_COUNTERS);
        const state = data(row.nativeState, 'status');
        row.nativeState =
            state === 'credential-fenced'
                ? exact(row.nativeState, ['status', 'accountPresent', 'originalSnapshotCurrent'])
                : exact(row.nativeState, ['status']);
        require(['unavailable', 'running', 'pending-fence', 'credential-fenced'].includes(state));
        if (state === 'credential-fenced')
            require(row.nativeState.accountPresent === false && row.nativeState.originalSnapshotCurrent === false);
        row.nativeState = Object.freeze(row.nativeState);
        row.nativeHttpFence = row.nativeHttpFence === null ? null : http(row.nativeHttpFence);
        row.windowEvidence = row.windowEvidence === null ? null : inspectWindowEvidence(row.windowEvidence, runID);
        row.domFacts = row.domFacts === null ? null : booleans(row.domFacts, FULL_APP_PROTECTED_DOM_KEYS);
        row.messageFacts = row.messageFacts === null ? null : messageFacts(row.messageFacts);
        row.protectedExchange = row.protectedExchange === null ? null : exchange(row.protectedExchange);
        row.pmResultCounters = counts(row.pmResultCounters, FULL_APP_PROTECTED_PM_RESULT_KEYS);
        return Object.freeze(row);
    });
}
export function inspectFullAppProtectedNativeReceipt(raw, runID, runNonce) {
    return guarded(() => {
        const row = inspectFullAppProtectedNativeEnvelope(raw, runID, runNonce);
        require(
            row.status === 'passed' &&
                row.assertions > 0 &&
                row.nativeHttpFence !== null &&
                row.protectedExchange !== null &&
                row.nativeState.status === 'credential-fenced' &&
                row.sdkCounts?.password === 1 &&
                row.sdkCounts.unexpected === 0,
        );
        http(row.nativeHttpFence, true);
        const n = row.nativeCounters,
            required = [
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
            ];
        require(
            required.every((k) => n[k] > 0) &&
                n.authenticate === 1 &&
                n.fenceSession >= 2 &&
                n.nativeAuthRequests === 2 &&
                n.fixtureSetupControls === 1 &&
                n.fixtureReplyControls === 1 &&
                n.unexpectedMethods === 0 &&
                n.unexpectedNativeRequests === 0 &&
                n.relayRequests === 0,
        );
        const allowed = [...required, 'privateMessageRetryPending'];
        require(
            FULL_APP_NATIVE_COUNTERS.filter(
                (k) =>
                    !allowed.includes(k) &&
                    !['nativeAuthRequests', 'fixtureSetupControls', 'fixtureReplyControls'].includes(k),
            ).every((k) => n[k] === 0),
        );
        require(
            row.pmResultCounters['privateMessageSendText:ok'] === 1 &&
                row.pmResultCounters['privateMessagePermissions:ok'] > 0 &&
                row.pmResultCounters['privateMessageInbox:ok'] >= 3 &&
                row.pmResultCounters['privateMessageInbox:ok'] <= n.privateMessageInbox &&
                row.pmResultCounters['privateMessageRetryPending:ok'] === 0,
        );
        const w = row.windowEvidence,
            d = row.domFacts,
            m = row.messageFacts,
            proof = row.protectedExchange;
        require(
            w &&
                d &&
                m &&
                w.phase === 'ready' &&
                w.auth.status === 'inactive' &&
                w.auth.userPresent === false &&
                w.auth.authChecked === true &&
                w.privateSelection === 'native-unavailable' &&
                w.legacyPermitAvailable === false &&
                w.lifecycle.stopped === true &&
                w.sdk.runtimeCreations === 2 &&
                w.sdk.sdkConstructions === 2 &&
                w.sdk.nativeCalls > 0 &&
                w.root.mounts === 2 &&
                w.root.remounts === 1 &&
                w.root.closedRenders >= 2 &&
                w.authScope.originalUserPresent === false &&
                w.authScope.originalAnonymous === true &&
                w.authScope.currentUserPresent === false &&
                w.authScope.currentAnonymous === true &&
                w.fence?.status === 'installed' &&
                w.fence.counts.patchFailures === 0 &&
                w.fence.counts.authRequests === 1 &&
                w.fence.counts.authResponses === 1 &&
                w.fence.counts.authRefused === 0 &&
                w.core?.platform === 'ios',
        );
        require(
            [
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
            ].every((k) => w.fence.counts[k] === 0),
        );
        require(
            d.actualAppNavigation &&
                d.unavailablePrivateView &&
                d.stoppedNotice &&
                d.messageLogAbsent &&
                !d.logPresent &&
                !d.privateOpenEnabled &&
                !d.signInEnabled &&
                d.passwordEmpty &&
                d.legacyControlsAbsent,
        );
        require(
            m.outgoingRows === 1 &&
                m.incomingRows === (proof.hostInitiates ? 1 : 2) &&
                m.openerRows === (proof.hostInitiates ? 0 : 1) &&
                FULL_APP_PROTECTED_MESSAGE_KEYS.slice(3).every((k) => m[k] === true),
        );
        return row;
    });
}

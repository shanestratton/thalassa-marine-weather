/** Pure contracts for the isolated native full-root fixture, not permission or an audit. */
import { inspectWindowEvidence } from '../full-app-pilot/windowProofContract.mjs';
import { Buffer } from 'node:buffer';

export const FULL_APP_NATIVE_SCENARIO = 'full-app-native-startup';
export const FULL_APP_NATIVE_RUN_MARKER = '__RESEARCH_FULL_APP_NATIVE_RUN_ID__';
export const FULL_APP_NATIVE_NONCE_MARKER = '__RESEARCH_FULL_APP_NATIVE_NONCE__';
export const FULL_APP_NATIVE_CASES = Object.freeze([
    'native-http-refusals',
    'cold-root-closed',
    'sdk-native-auth-browse-only',
    'unknown-admission-no-private-open',
    'synthetic-terminal-pagehide',
    'fresh-root-no-restored-authority',
    'final-root-closed',
]);
export const FULL_APP_NATIVE_PHASES = Object.freeze([
    'fixture-installed',
    'script-installed',
    'dom-ready',
    'http-refusals',
    'cold-ready',
    'signed-in',
    'admission-returned',
    'terminal-closed',
    'root-remounted',
    'fixture-complete',
    'fixture-failed',
]);
export const FULL_APP_NATIVE_DOM_KEYS = Object.freeze([
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
]);
export const FULL_APP_NATIVE_METHODS = Object.freeze([
    'configuration',
    'fenceSession',
    'authenticate',
    'currentAccount',
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
]);
export const FULL_APP_NATIVE_COUNTERS = Object.freeze([
    ...FULL_APP_NATIVE_METHODS,
    'nativeAuthRequests',
    'unexpectedNativeRequests',
    'relayRequests',
    'unexpectedMethods',
    'fixtureSetupControls',
    'fixtureReplyControls',
]);
export const FULL_APP_NATIVE_HTTP_COUNTERS = Object.freeze([
    'request',
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'addListener',
    'removeListener',
]);
const refused = () => {
    throw new Error('Full App native fixture contract refused');
};
const require = (value) => {
    if (!value) refused();
};
const uuid = (value) =>
    typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nonce = (value) => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
function data(object, key) {
    const property = Object.getOwnPropertyDescriptor(object, key);
    require(property && 'value' in property);
    return property.value;
}
function exact(object, keys) {
    require(object && typeof object === 'object' && !Array.isArray(object));
    const actual = Reflect.ownKeys(object);
    require(actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key)));
    return Object.fromEntries(keys.map((key) => [key, data(object, key)]));
}
function integer(value, max = 10000) {
    require(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max);
    return value;
}
function counts(raw, keys) {
    const row = exact(raw, keys);
    for (const key of keys) row[key] = integer(row[key]);
    return Object.freeze(row);
}
function fixedList(raw, expected) {
    require(Array.isArray(raw) && data(raw, 'length') === expected.length);
    require(Reflect.ownKeys(raw).length === expected.length + 1);
    return Object.freeze(
        expected.map((value, index) => {
            require(data(raw, String(index)) === value);
            return value;
        }),
    );
}
function guarded(action) {
    try {
        return action();
    } catch {
        return refused();
    }
}

export function createFullAppNativeResource(template, runID, runNonce) {
    return guarded(() => {
        require(uuid(runID) && nonce(runNonce) && typeof template === 'string');
        require(Buffer.byteLength(template, 'utf8') > 0 && Buffer.byteLength(template, 'utf8') <= 65536);
        require(
            template.split(FULL_APP_NATIVE_RUN_MARKER).length === 2 &&
                template.split(FULL_APP_NATIVE_NONCE_MARKER).length === 2,
        );
        return Object.freeze({
            version: 3,
            runID,
            nonce: runNonce,
            scenario: FULL_APP_NATIVE_SCENARIO,
            script: template.replace(FULL_APP_NATIVE_RUN_MARKER, runID).replace(FULL_APP_NATIVE_NONCE_MARKER, runNonce),
        });
    });
}
export function inspectFullAppNativeResource(raw, template) {
    return guarded(() => {
        const row = exact(raw, ['version', 'runID', 'nonce', 'scenario', 'script']);
        require(row.version === 3 && row.scenario === FULL_APP_NATIVE_SCENARIO);
        const expected = createFullAppNativeResource(template, row.runID, row.nonce);
        require(row.script === expected.script);
        return expected;
    });
}
/** A successful native snapshot contains no identity, credential or authority object. */
function verified(raw) {
    const row = exact(raw, [
        'status',
        'serverVerified',
        'accountPresent',
        'selection',
        'registration',
        'claim',
        'pairing',
        'outgoingCount',
        'incomingCount',
        'unresolvedCount',
        'originalSnapshotCurrent',
    ]);
    require(
        row.status === 'verified-unregistered-unpaired' &&
            row.serverVerified === true &&
            row.accountPresent === true &&
            row.selection === 'unknown' &&
            row.registration === 'none' &&
            row.claim === 'none' &&
            row.pairing === 'unpaired' &&
            row.outgoingCount === 0 &&
            row.incomingCount === 0 &&
            row.unresolvedCount === 0 &&
            row.originalSnapshotCurrent === true,
    );
    return Object.freeze(row);
}
function httpFence(raw) {
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
    for (const name of ['primaryCounts', 'classAliasCounts']) {
        row[name] = counts(row[name], FULL_APP_NATIVE_HTTP_COUNTERS);
        for (const method of FULL_APP_NATIVE_HTTP_COUNTERS)
            require(row[name][method] === (method === 'addListener' || method === 'removeListener' ? 0 : 1));
    }
    return Object.freeze(row);
}

/** Copies recognized incomplete evidence only. This grants no acceptance and
 * rejects arbitrary container JSON before any driver artifact is exported. */
export function inspectFullAppNativeEnvelope(raw, runID, runNonce) {
    return guarded(() => {
        require(uuid(runID) && nonce(runNonce));
        const row = exact(raw, [
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
            'nativeVerifiedAtProgress',
            'nativeHttpFence',
            'windowEvidence',
            'domFacts',
            'syntheticPagehide',
            'realOsLifecycleOrBfCacheProved',
        ]);
        require(
            row.version === 2 &&
                row.runID === runID &&
                row.nonce === runNonce &&
                row.scenario === FULL_APP_NATIVE_SCENARIO &&
                ['running', 'passed', 'failed'].includes(row.status) &&
                FULL_APP_NATIVE_PHASES.includes(row.phase) &&
                row.syntheticPagehide === true &&
                row.realOsLifecycleOrBfCacheProved === false,
        );
        require(
            row.status === 'passed'
                ? row.phase === 'fixture-complete'
                : row.status === 'failed'
                  ? row.phase === 'fixture-failed'
                  : !['fixture-complete', 'fixture-failed'].includes(row.phase),
        );
        row.assertions = integer(row.assertions);
        row.nativeAssertions = integer(row.nativeAssertions, 10);
        require(row.status === 'passed' ? row.nativeAssertions === 10 : row.nativeAssertions === 0);
        row.sdkCounts = row.sdkCounts === null ? null : counts(row.sdkCounts, ['password', 'unexpected']);
        const prefixLength = {
            'fixture-installed': 0,
            'script-installed': 0,
            'dom-ready': 0,
            'http-refusals': 1,
            'cold-ready': 2,
            'signed-in': 3,
            'admission-returned': 4,
            'terminal-closed': 5,
            'root-remounted': 6,
        }[row.phase];
        row.cases = fixedList(
            row.cases,
            row.status === 'failed'
                ? ['fixture-failed']
                : row.status === 'passed'
                  ? FULL_APP_NATIVE_CASES
                  : FULL_APP_NATIVE_CASES.slice(0, prefixLength),
        );
        row.nativeCounters = counts(row.nativeCounters, FULL_APP_NATIVE_COUNTERS);
        const state = row.nativeState;
        const status = data(state, 'status');
        if (['unavailable', 'running', 'pending-fence'].includes(status)) {
            row.nativeState = Object.freeze(exact(state, ['status']));
        } else if (status === 'credential-fenced') {
            row.nativeState = exact(state, ['status', 'accountPresent', 'originalSnapshotCurrent']);
            require(row.nativeState.accountPresent === false && row.nativeState.originalSnapshotCurrent === false);
            row.nativeState = Object.freeze(row.nativeState);
        } else row.nativeState = verified(state);
        const progressKeys = Reflect.ownKeys(row.nativeVerifiedAtProgress);
        require(
            progressKeys.every((key) => typeof key === 'string' && ['signed-in', 'admission-returned'].includes(key)),
        );
        const progress = exact(row.nativeVerifiedAtProgress, progressKeys);
        row.nativeVerifiedAtProgress = Object.freeze(
            Object.fromEntries(progressKeys.map((key) => [key, verified(progress[key])])),
        );
        if (row.nativeHttpFence !== null) {
            const http = exact(row.nativeHttpFence, [
                'version',
                'status',
                'primaryCurrent',
                'classAliasCurrent',
                'observedDefaultMethodCount',
                'primaryCounts',
                'classAliasCounts',
            ]);
            require(
                http.version === 1 &&
                    ['installed', 'unavailable'].includes(http.status) &&
                    typeof http.primaryCurrent === 'boolean' &&
                    typeof http.classAliasCurrent === 'boolean' &&
                    http.observedDefaultMethodCount === 6,
            );
            http.primaryCounts = counts(http.primaryCounts, FULL_APP_NATIVE_HTTP_COUNTERS);
            http.classAliasCounts = counts(http.classAliasCounts, FULL_APP_NATIVE_HTTP_COUNTERS);
            row.nativeHttpFence = Object.freeze(http);
        }
        row.windowEvidence = row.windowEvidence === null ? null : inspectWindowEvidence(row.windowEvidence, runID);
        if (row.domFacts !== null) {
            row.domFacts = exact(row.domFacts, FULL_APP_NATIVE_DOM_KEYS);
            for (const key of FULL_APP_NATIVE_DOM_KEYS) require(typeof row.domFacts[key] === 'boolean');
            row.domFacts = Object.freeze(row.domFacts);
        }
        return Object.freeze(row);
    });
}

/** Final fixture acceptance only. This refuses incomplete/failed reports; it does not establish live Auth or encryption. */
export function inspectFullAppNativeReceipt(raw, runID, runNonce) {
    return guarded(() => {
        require(uuid(runID) && nonce(runNonce));
        const row = exact(raw, [
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
            'nativeVerifiedAtProgress',
            'nativeHttpFence',
            'windowEvidence',
            'domFacts',
            'syntheticPagehide',
            'realOsLifecycleOrBfCacheProved',
        ]);
        require(
            row.version === 2 &&
                row.runID === runID &&
                row.nonce === runNonce &&
                row.scenario === FULL_APP_NATIVE_SCENARIO &&
                row.status === 'passed' &&
                row.phase === 'fixture-complete' &&
                row.syntheticPagehide === true &&
                row.realOsLifecycleOrBfCacheProved === false,
        );
        row.assertions = integer(row.assertions);
        require(row.assertions > 0);
        require(row.nativeAssertions === 10);
        row.sdkCounts = counts(row.sdkCounts, ['password', 'unexpected']);
        require(row.sdkCounts.password === 1 && row.sdkCounts.unexpected === 0);
        row.cases = fixedList(row.cases, FULL_APP_NATIVE_CASES);
        row.nativeCounters = counts(row.nativeCounters, FULL_APP_NATIVE_COUNTERS);
        const allowed = ['configuration', 'fenceSession', 'authenticate', 'currentAccount', 'messagePrivateAdmission'];
        for (const method of FULL_APP_NATIVE_METHODS)
            require(allowed.includes(method) ? row.nativeCounters[method] > 0 : row.nativeCounters[method] === 0);
        require(
            row.nativeCounters.authenticate === 1 &&
                row.nativeCounters.nativeAuthRequests === 2 &&
                row.nativeCounters.fenceSession >= 2,
        );
        for (const name of [
            'unexpectedNativeRequests',
            'relayRequests',
            'unexpectedMethods',
            'fixtureSetupControls',
            'fixtureReplyControls',
        ])
            require(row.nativeCounters[name] === 0);
        row.nativeState = exact(row.nativeState, ['status', 'accountPresent', 'originalSnapshotCurrent']);
        require(
            row.nativeState.status === 'credential-fenced' &&
                row.nativeState.accountPresent === false &&
                row.nativeState.originalSnapshotCurrent === false,
        );
        row.nativeState = Object.freeze(row.nativeState);
        const progress = exact(row.nativeVerifiedAtProgress, ['signed-in', 'admission-returned']);
        row.nativeVerifiedAtProgress = Object.freeze({
            'signed-in': verified(progress['signed-in']),
            'admission-returned': verified(progress['admission-returned']),
        });
        row.nativeHttpFence = httpFence(row.nativeHttpFence);
        row.domFacts = exact(row.domFacts, FULL_APP_NATIVE_DOM_KEYS);
        for (const name of FULL_APP_NATIVE_DOM_KEYS) require(typeof row.domFacts[name] === 'boolean');
        require(
            row.domFacts.actualAppNavigation &&
                row.domFacts.unavailablePrivateView &&
                row.domFacts.stoppedNotice &&
                row.domFacts.messageLogAbsent &&
                row.domFacts.passwordEmpty &&
                !row.domFacts.signInEnabled &&
                !row.domFacts.privateOpenEnabled &&
                !row.domFacts.authenticatedNotice,
        );
        row.domFacts = Object.freeze(row.domFacts);
        row.windowEvidence = inspectWindowEvidence(row.windowEvidence, runID);
        const w = row.windowEvidence;
        require(
            w.phase === 'ready' &&
                w.fence?.status === 'installed' &&
                w.fence.counts.patchFailures === 0 &&
                w.core?.platform === 'ios',
        );
        require(
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
                w.root.closedRenders >= 2,
        );
        require(
            w.authScope.originalUserPresent === false &&
                w.authScope.originalAnonymous === true &&
                w.authScope.currentUserPresent === false &&
                w.authScope.currentAnonymous === true &&
                w.authScope.originalGeneration !== null &&
                w.authScope.currentGeneration !== null,
        );
        require(
            w.fence.counts.authRequests === 1 && w.fence.counts.authResponses === 1 && w.fence.counts.authRefused === 0,
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
        ])
            require(w.fence.counts[name] === 0);
        require(w.boundaries !== null && w.memory !== null);
        return Object.freeze(row);
    });
}

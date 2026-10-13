/** Passive Boolean comparisons only. These facts do not establish acceptance,
 * permission, native execution or an operating-system transition. */
import { Buffer } from 'node:buffer';
import { inspectResearchSceneProtectedUiClosure } from './researchSceneLifecycleContract.mjs';
import {
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
    inspectFullAppSceneProtectedPrefix,
} from './fullAppProtectedUiContract.mjs';
import { FULL_APP_NATIVE_COUNTERS } from './fullAppUiContract.mjs';

const relayKeys = Object.freeze(['auth', 'register', 'dispatch', 'unexpected']);
const nativeGrowingKeys = Object.freeze(['lifecycleState', 'acknowledgeClosedPresentation']);
const refused = () => {
    throw new Error('Scene closure correlation diagnostic refused');
};

function inputFields(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refused();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) refused();
    const keys = Reflect.ownKeys(raw);
    const names = ['closure', 'protectedReport'];
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) refused();
    return Object.fromEntries(
        names.map((name) => {
            const descriptor = Object.getOwnPropertyDescriptor(raw, name);
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refused();
            return [name, descriptor.value];
        }),
    );
}

function matchMap(keys, available, matches) {
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, available && matches(key)])));
}
function allMatched(map) {
    return Object.values(map).every((value) => value === true);
}

/** Inspect exact admitted closure/report schemas and return fixed Boolean maps.
 * Driver source/resource/proof checks and its original closure gate remain
 * necessary; no aggregate pass status or private input value is returned. */
export function inspectSceneClosureCorrelationDiagnostic(input, pin) {
    try {
        const raw = inputFields(input);
        // This inspector owns exact pin shape, scalar bounds and bindings. Do
        // not read raw pin properties or substitute defaults for unknown facts.
        const closure = inspectResearchSceneProtectedUiClosure(raw.closure, pin);
        const baseline = inspectFullAppSceneProtectedPrefix(raw.protectedReport, closure.runID, closure.nonce);
        const dom = closure.domFacts;
        const window = closure.windowEvidence;
        const previous = baseline.windowEvidence;
        const nativeCounterMatches = matchMap(FULL_APP_NATIVE_COUNTERS, closure.nativeCounters !== null, (key) =>
            nativeGrowingKeys.includes(key)
                ? closure.nativeCounters[key] >= baseline.nativeCounters[key]
                : closure.nativeCounters[key] === baseline.nativeCounters[key],
        );
        const pmResultCounterMatches = matchMap(
            FULL_APP_PROTECTED_PM_RESULT_KEYS,
            closure.pmResultCounters !== null,
            (key) => closure.pmResultCounters[key] === baseline.pmResultCounters[key],
        );
        const relayCounterMatches = matchMap(
            relayKeys,
            closure.relayCounters !== null,
            (key) => closure.relayCounters[key] === baseline.protectedExchange.relay.methodCounters[key],
        );
        // These seven groups mirror the private requireClosedUi blocks/loops.
        // A nullable prerequisite makes its dependent comparison false.
        const groups = Object.freeze({
            closureFactsPresent:
                closure.status === 'observed' &&
                dom !== null &&
                window !== null &&
                closure.nativeCounters !== null &&
                closure.pmResultCounters !== null &&
                closure.sdkCounts !== null &&
                closure.relayCounters !== null,
            domClosed:
                dom !== null &&
                dom.actualAppNavigation === true &&
                dom.privateOpenEnabled === false &&
                dom.logPresent === false &&
                dom.composeEmpty === true &&
                dom.passwordEmpty === true &&
                dom.legacyControlsAbsent === true,
            windowClosed:
                window !== null &&
                window.phase === 'ready' &&
                window.fence?.status === 'installed' &&
                window.fence.counts.patchFailures === 0 &&
                window.core?.platform === 'ios' &&
                ['unavailable', 'signed_out'].includes(window.auth.status) &&
                window.auth.userPresent === false &&
                window.auth.authChecked === true &&
                window.privateSelection === 'native-unavailable' &&
                window.legacyPermitAvailable === false &&
                window.authScope.originalUserPresent === false &&
                window.authScope.originalAnonymous === true &&
                window.authScope.currentUserPresent === false &&
                window.authScope.currentAnonymous === true &&
                window.lifecycle.stopped === false &&
                window.root.mounts === previous.root.mounts &&
                window.root.remounts === previous.root.remounts &&
                window.sdk.runtimeCreations === previous.sdk.runtimeCreations &&
                window.sdk.sdkConstructions === previous.sdk.sdkConstructions,
            sdkAndAuthUnchanged:
                closure.sdkCounts !== null &&
                window !== null &&
                window.fence !== null &&
                previous.fence !== null &&
                closure.sdkCounts.password === baseline.sdkCounts.password &&
                closure.sdkCounts.unexpected === 0 &&
                window.fence.counts.authRequests === previous.fence.counts.authRequests &&
                window.fence.counts.authResponses === previous.fence.counts.authResponses &&
                window.fence.counts.authRefused === previous.fence.counts.authRefused,
            nativeCountersCorrelated: allMatched(nativeCounterMatches),
            pmResultsCorrelated: allMatched(pmResultCounterMatches),
            relayCorrelated: allMatched(relayCounterMatches),
        });
        const result = Object.freeze({
            version: 1,
            kind: 'scene-closure-correlation-diagnostic',
            facts: Object.freeze({ groups, nativeCounterMatches, pmResultCounterMatches, relayCounterMatches }),
            acceptanceEvidence: false,
        });
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16384) refused();
        return result;
    } catch {
        return refused();
    }
}

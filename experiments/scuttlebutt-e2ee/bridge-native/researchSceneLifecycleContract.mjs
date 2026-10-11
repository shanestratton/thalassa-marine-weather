/** Passive scene/process evidence schema, not an authorization mechanism.
 * Synthetic direct calls never establish OS lifecycle. Driver/source/resource
 * and actual launch/termination evidence must accompany future native receipts. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
    createFullAppProtectedNativeResource,
    FULL_APP_PROTECTED_PM_RESULT_KEYS,
    inspectFullAppSceneProtectedEnvelope,
    inspectFullAppSceneProtectedPrefix,
} from './fullAppProtectedUiContract.mjs';
import { FULL_APP_NATIVE_COUNTERS } from './fullAppUiContract.mjs';
import { inspectWindowEvidence } from '../full-app-pilot/windowProofContract.mjs';

export const RESEARCH_SCENE_LIFECYCLE_KIND = 'research-scene-lifecycle-observations';
export const RESEARCH_SCENE_LIFECYCLE_SCENARIO = 'full-app-native-os-lifecycle-observations';
export const RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS = 64;
export const RESEARCH_SCENE_LIFECYCLE_HELPER_FALSE = 'const sceneLifecycleProof = false;';
export const RESEARCH_SCENE_LIFECYCLE_HELPER_TRUE = 'const sceneLifecycleProof = true;';
export const RESEARCH_SCENE_PROTECTED_UI_CLOSURE_KIND = 'research-scene-protected-ui-closure';
export const RESEARCH_SCENE_PROTECTED_UI_DOM_KEYS = Object.freeze([
    'actualAppNavigation',
    'privateOpenEnabled',
    'logPresent',
    'composeEmpty',
    'passwordEmpty',
    'legacyControlsAbsent',
]);
export const RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS = Object.freeze([
    'driver',
    'builder',
    'projectGenerator',
    'contract',
    'observer',
    'coordinator',
    'application',
    'plugin',
    'sceneAuthority',
    'protectedFixture',
    'protectedScript',
]);
export const RESEARCH_SCENE_LIFECYCLE_EVENTS = Object.freeze([
    'process-started',
    'application-launched',
    'scene-connected',
    'protected-ready',
    'will-resign-active',
    'did-enter-background',
    'will-enter-foreground',
    'did-become-active',
    'foreground-ui-closed',
    'scene-disconnected',
    'will-terminate',
]);
const activations = Object.freeze(['unattached', 'foreground-active', 'foreground-inactive', 'background', 'unknown']);
const covers = Object.freeze([
    'present',
    'opaque',
    'attachedToOwnedWindow',
    'coversOwnedWindowBounds',
    'accessibilityModal',
    'contentAccessibilityHidden',
]);
const refusal = () => {
    throw new Error('Research scene lifecycle evidence refused');
};
function require(value) {
    if (!value) refusal();
}
function guarded(action) {
    try {
        return action();
    } catch {
        return refusal();
    }
}
function value(raw, key) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    require(descriptor && 'value' in descriptor);
    return descriptor.value;
}
function exact(raw, keys) {
    require(raw && typeof raw === 'object' && !Array.isArray(raw));
    const names = Reflect.ownKeys(raw);
    require(names.length === keys.length && names.every((key) => typeof key === 'string' && keys.includes(key)));
    return Object.fromEntries(keys.map((key) => [key, value(raw, key)]));
}
function integer(raw, min, max) {
    require(Number.isSafeInteger(raw) && raw >= min && raw <= max);
    return raw;
}
function bool(raw) {
    require(typeof raw === 'boolean');
    return raw;
}
function nullableBool(raw) {
    return raw === null ? null : bool(raw);
}
function nullableCount(raw) {
    return raw === null ? null : integer(raw, 0, 10000);
}
function uuid(raw) {
    require(typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw));
    return raw;
}
function digest(raw) {
    require(typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw));
    return raw;
}
function list(raw, count, inspect) {
    require(Array.isArray(raw) && value(raw, 'length') === count && Reflect.ownKeys(raw).length === count + 1);
    return Object.freeze(Array.from({ length: count }, (_, index) => inspect(value(raw, String(index)), index)));
}

export function createResearchSceneLifecycleResource(runID, nonce) {
    return guarded(() =>
        Object.freeze({
            version: 1,
            scenario: RESEARCH_SCENE_LIFECYCLE_SCENARIO,
            runID: uuid(runID),
            nonce: digest(nonce),
            maximumEvents: RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS,
        }),
    );
}
export function inspectResearchSceneLifecycleResource(raw) {
    return guarded(() => {
        const row = exact(raw, ['version', 'scenario', 'runID', 'nonce', 'maximumEvents']);
        require(
            row.version === 1 &&
                row.scenario === RESEARCH_SCENE_LIFECYCLE_SCENARIO &&
                row.maximumEvents === RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS,
        );
        return createResearchSceneLifecycleResource(row.runID, row.nonce);
    });
}

/** Explicit lifecycle helper over the same v4 envelope. The ordinary helper
 * remains false and its existing parser still refuses this changed script. */
export function createResearchSceneProtectedUiResource(template, runID, nonce) {
    return guarded(() => {
        require(
            typeof template === 'string' &&
                template.split(RESEARCH_SCENE_LIFECYCLE_HELPER_FALSE).length === 2 &&
                !template.includes(RESEARCH_SCENE_LIFECYCLE_HELPER_TRUE),
        );
        const resource = createFullAppProtectedNativeResource(template, runID, nonce);
        return Object.freeze({
            ...resource,
            script: resource.script.replace(
                RESEARCH_SCENE_LIFECYCLE_HELPER_FALSE,
                RESEARCH_SCENE_LIFECYCLE_HELPER_TRUE,
            ),
        });
    });
}
export function inspectResearchSceneProtectedUiResource(raw, template) {
    return guarded(() => {
        const row = exact(raw, ['version', 'runID', 'nonce', 'scenario', 'script']);
        const expected = createResearchSceneProtectedUiResource(template, row.runID, row.nonce);
        require(
            row.version === expected.version && row.scenario === expected.scenario && row.script === expected.script,
        );
        return expected;
    });
}
export function inspectResearchSceneProtectedResources(raw, template) {
    return guarded(() => {
        const row = exact(raw, ['protectedResource', 'observerResource']);
        const protectedResource = inspectResearchSceneProtectedUiResource(row.protectedResource, template);
        const observerResource = inspectResearchSceneLifecycleResource(row.observerResource);
        require(
            protectedResource.runID === observerResource.runID && protectedResource.nonce === observerResource.nonce,
        );
        return Object.freeze({ protectedResource, observerResource });
    });
}

function fixedCounts(raw, keys) {
    const row = exact(raw, keys);
    for (const key of keys) row[key] = integer(row[key], 0, 10000);
    return Object.freeze(row);
}
function closurePin(raw) {
    const row = exact(raw, [
        'runID',
        'nonce',
        'resourceSHA256',
        'protectedResourceSHA256',
        'protectedProofSHA256',
        'pid',
        'epoch',
    ]);
    uuid(row.runID);
    digest(row.nonce);
    digest(row.resourceSHA256);
    digest(row.protectedResourceSHA256);
    digest(row.protectedProofSHA256);
    integer(row.pid, 1, 2147483647);
    uuid(row.epoch);
    return row;
}

/** Private raw observations, including failed/unknown closure facts. No nonce
 * or arbitrary native error is copied into the later driver-stage result. */
export function inspectResearchSceneProtectedUiClosure(raw, expected) {
    return guarded(() => {
        const pin = closurePin(expected);
        const row = exact(raw, [
            'version',
            'kind',
            'runID',
            'nonce',
            'resourceSHA256',
            'protectedResourceSHA256',
            'protectedProofSHA256',
            'process',
            'status',
            'phase',
            'domFacts',
            'windowEvidence',
            'nativeCounters',
            'pmResultCounters',
            'sdkCounts',
            'relayCounters',
            'syntheticPagehide',
            'realOsLifecycleOrBfCacheProved',
        ]);
        require(row.version === 1 && row.kind === RESEARCH_SCENE_PROTECTED_UI_CLOSURE_KIND);
        for (const key of ['runID', 'nonce', 'resourceSHA256', 'protectedResourceSHA256', 'protectedProofSHA256'])
            require(row[key] === pin[key]);
        const process = exact(row.process, ['pid', 'epoch']);
        require(process.pid === pin.pid && process.epoch === pin.epoch);
        require(
            (row.status === 'observed' && row.phase === 'foreground-ui-closed') ||
                (row.status === 'failed' && row.phase === 'lifecycle-failed'),
        );
        require(row.syntheticPagehide === false && row.realOsLifecycleOrBfCacheProved === false);
        let domFacts = null;
        if (row.domFacts !== null) {
            domFacts = exact(row.domFacts, RESEARCH_SCENE_PROTECTED_UI_DOM_KEYS);
            for (const key of RESEARCH_SCENE_PROTECTED_UI_DOM_KEYS) bool(domFacts[key]);
            Object.freeze(domFacts);
        }
        return Object.freeze({
            ...row,
            process: Object.freeze(process),
            domFacts,
            windowEvidence: row.windowEvidence === null ? null : inspectWindowEvidence(row.windowEvidence, pin.runID),
            nativeCounters:
                row.nativeCounters === null ? null : fixedCounts(row.nativeCounters, FULL_APP_NATIVE_COUNTERS),
            pmResultCounters:
                row.pmResultCounters === null
                    ? null
                    : fixedCounts(row.pmResultCounters, FULL_APP_PROTECTED_PM_RESULT_KEYS),
            sdkCounts: row.sdkCounts === null ? null : fixedCounts(row.sdkCounts, ['password', 'unexpected']),
            relayCounters:
                row.relayCounters === null
                    ? null
                    : fixedCounts(row.relayCounters, ['auth', 'register', 'dispatch', 'unexpected']),
        });
    });
}
function inspectAuthority(raw) {
    const row = exact(raw, [
        'observationStatus',
        'facadeObserved',
        'originalSnapshotObserved',
        'accountPresent',
        'originalSnapshotCurrent',
        'verifyFenceCompletions',
    ]);
    require(['unavailable', 'observed'].includes(row.observationStatus));
    bool(row.facadeObserved);
    bool(row.originalSnapshotObserved);
    nullableBool(row.accountPresent);
    nullableBool(row.originalSnapshotCurrent);
    nullableCount(row.verifyFenceCompletions);
    if (row.observationStatus === 'unavailable') {
        require(
            row.facadeObserved === false &&
                row.originalSnapshotObserved === false &&
                row.accountPresent === null &&
                row.originalSnapshotCurrent === null &&
                row.verifyFenceCompletions === null,
        );
    } else {
        require(row.facadeObserved === true && row.accountPresent !== null);
        require(row.originalSnapshotObserved === (row.originalSnapshotCurrent !== null));
    }
    return Object.freeze(row);
}
function inspectEvent(raw, index) {
    const row = exact(raw, ['index', 'sequence', 'event', 'activationState', 'cover', 'authority']);
    require(row.index === index && row.sequence === index + 1);
    require(RESEARCH_SCENE_LIFECYCLE_EVENTS.includes(row.event) && activations.includes(row.activationState));
    const cover = exact(row.cover, covers);
    for (const key of covers) bool(cover[key]);
    return Object.freeze({ ...row, cover: Object.freeze(cover), authority: inspectAuthority(row.authority) });
}

/** Inspect a private native receipt against driver-owned resource and PID pins.
 * This validates shape/correlation only; it grants no app or messaging authority. */
export function inspectResearchSceneLifecycleEvidence(raw, expected) {
    return guarded(() => {
        const pin = exact(expected, ['runID', 'nonce', 'resourceSHA256', 'pid']);
        uuid(pin.runID);
        digest(pin.nonce);
        digest(pin.resourceSHA256);
        integer(pin.pid, 1, 2147483647);
        const row = exact(raw, [
            'version',
            'kind',
            'runID',
            'nonce',
            'resourceSHA256',
            'process',
            'evidenceCategory',
            'status',
            'eventCount',
            'events',
            'osLifecycleProved',
            'authorityMutated',
        ]);
        require(row.version === 1 && row.kind === RESEARCH_SCENE_LIFECYCLE_KIND);
        require(row.runID === pin.runID && row.nonce === pin.nonce && row.resourceSHA256 === pin.resourceSHA256);
        const process = exact(row.process, ['pid', 'epoch']);
        require(process.pid === pin.pid);
        uuid(process.epoch);
        require(['synthetic-direct-calls', 'simulator-native-observations'].includes(row.evidenceCategory));
        require(['recording', 'capacity-refused'].includes(row.status));
        require(row.osLifecycleProved === false && row.authorityMutated === false);
        integer(row.eventCount, 1, RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS);
        const events = list(row.events, row.eventCount, inspectEvent);
        require(events[0].event === 'process-started');
        require(events.slice(1).every((event) => event.event !== 'process-started'));
        require(row.status !== 'capacity-refused' || row.eventCount === RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS);
        return Object.freeze({ ...row, process: Object.freeze(process), events });
    });
}

/** Future native observation gate. A successful launch, resource-bound files,
 * source/artifact pins and owned cleanup must be verified separately. A direct
 * test trace is always refused here, even when its values mimic the sequence. */
function inspectProtectedObservationStage(raw, expected, stage) {
    return guarded(() => {
        require(['protected-ready', 'background-fenced', 'foreground-closed'].includes(stage));
        const receipt = inspectResearchSceneLifecycleEvidence(raw, expected);
        require(receipt.evidenceCategory === 'simulator-native-observations' && receipt.status === 'recording');
        const events = receipt.events;
        const names = events.map((event) => event.event);
        const startupForeground = names[3] === 'will-enter-foreground';
        const exactSequence = [
            'process-started',
            'application-launched',
            'scene-connected',
            ...(startupForeground ? ['will-enter-foreground'] : []),
            'did-become-active',
            'protected-ready',
            'will-resign-active',
            'did-enter-background',
            'will-enter-foreground',
            'did-become-active',
            'foreground-ui-closed',
        ];
        const offset = startupForeground ? 1 : 0;
        const expectedLength = (stage === 'protected-ready' ? 5 : stage === 'background-fenced' ? 7 : 10) + offset;
        require(names.length === expectedLength && names.every((name, index) => name === exactSequence[index]));
        if (startupForeground)
            require(['unattached', 'background', 'foreground-inactive'].includes(events[3].activationState));
        const baseline = events[4 + offset],
            resign = events[5 + offset],
            background = events[6 + offset],
            enteringForeground = events[7 + offset],
            foreground = events[8 + offset],
            closed = events[9 + offset];
        const startCount = baseline.authority.verifyFenceCompletions;
        require(
            baseline.activationState === 'foreground-active' &&
                baseline.cover.present === false &&
                baseline.authority.observationStatus === 'observed' &&
                baseline.authority.originalSnapshotObserved === true &&
                baseline.authority.accountPresent === true &&
                baseline.authority.originalSnapshotCurrent === true &&
                startCount !== null,
        );
        if (stage === 'protected-ready') return receipt;
        // UIKit's "will" callbacks precede the transition. Preserve the actual
        // state; do not manufacture the destination state inside the observer.
        require(
            ['foreground-active', 'foreground-inactive'].includes(resign.activationState) &&
                background.activationState === 'background',
        );
        for (const event of [resign, background, ...(enteringForeground ? [enteringForeground, foreground] : [])])
            require(covers.every((key) => event.cover[key] === true));
        if (enteringForeground)
            require(['background', 'foreground-inactive'].includes(enteringForeground.activationState));
        const fencedEvents = [resign, background, enteringForeground, foreground, closed].filter(
            (event) => event !== undefined,
        );
        for (const event of fencedEvents) {
            const authority = event.authority;
            require(
                authority.observationStatus === 'observed' &&
                    authority.originalSnapshotObserved === true &&
                    authority.accountPresent === false &&
                    authority.originalSnapshotCurrent === false &&
                    authority.verifyFenceCompletions !== null &&
                    authority.verifyFenceCompletions > startCount,
            );
        }
        if (stage === 'background-fenced') return receipt;
        require(
            foreground.activationState === 'foreground-active' &&
                closed.activationState === 'foreground-active' &&
                closed.cover.present === false,
        );
        const counts = fencedEvents.map((event) => event.authority.verifyFenceCompletions);
        require(counts.every((count) => count === counts[0]));
        return receipt;
    });
}
export function requireResearchSceneProtectedRoundTrip(raw, expected) {
    return guarded(() => {
        const receipt = inspectProtectedObservationStage(raw, expected, 'foreground-closed');
        return Object.freeze({
            status: 'observations-matched',
            pid: receipt.process.pid,
            epoch: receipt.process.epoch,
            evidenceCategory: receipt.evidenceCategory,
            sameProcessSceneRoundTrip: true,
            sourceBoundDriverAcceptanceRequired: true,
            protectedUiClosureReceiptRequired: true,
            physicalAcceptance: false,
            sameStoreRecoveryProved: false,
            messagingPermission: false,
        });
    });
}

const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
function sourceBindings(raw) {
    const row = exact(raw, RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS);
    for (const key of RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS) digest(row[key]);
    return Object.freeze(row);
}
function privateResourceBytes(raw) {
    require(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > 0 && Buffer.byteLength(raw, 'utf8') <= 131072);
    return raw;
}
function canonical(raw) {
    if (raw === null || typeof raw !== 'object') return raw;
    if (Array.isArray(raw)) return raw.map(canonical);
    return Object.fromEntries(
        Object.keys(raw)
            .sort()
            .map((key) => [key, canonical(raw[key])]),
    );
}
/** Hash only an inspected exchange, using the native producer's sorted JSON.
 * This is a captured proof hash, not the whole running native report hash. */
export function researchSceneProtectedProofHash(raw, runID, nonce) {
    return guarded(() => {
        const report = inspectFullAppSceneProtectedEnvelope(raw, runID, nonce);
        require(report.protectedExchange !== null);
        return hash(JSON.stringify(canonical(report.protectedExchange)));
    });
}
function protectedBaseline(raw, runID, nonce) {
    const report = inspectFullAppSceneProtectedPrefix(raw, runID, nonce);
    require(
        report.status === 'running' &&
            report.phase === 'native-proof-captured' &&
            report.assertions > 0 &&
            report.nativeState.status === 'running' &&
            report.protectedExchange !== null &&
            report.nativeHttpFence !== null &&
            report.sdkCounts?.password === 1 &&
            report.sdkCounts.unexpected === 0 &&
            report.windowEvidence !== null &&
            report.domFacts !== null &&
            report.messageFacts !== null,
    );
    const counters = report.nativeCounters;
    require(
        counters.authenticate === 1 &&
            counters.nativeAuthRequests === 2 &&
            counters.fixtureSetupControls === 1 &&
            counters.fixtureReplyControls === 1 &&
            counters.unexpectedMethods === 0 &&
            counters.unexpectedNativeRequests === 0 &&
            counters.relayRequests === 0 &&
            report.pmResultCounters['privateMessageSendText:ok'] === 1 &&
            report.pmResultCounters['privateMessagePermissions:ok'] > 0 &&
            report.pmResultCounters['privateMessageInbox:ok'] >= 3,
    );
    const dom = report.domFacts;
    require(
        dom.actualAppNavigation === true &&
            dom.logPresent === true &&
            dom.composeEmpty === true &&
            dom.passwordEmpty === true &&
            dom.encryptionTestLabel === true &&
            dom.truthfulIncomingStatus === true &&
            dom.truthfulOutgoingStatus === true &&
            dom.legacyControlsAbsent === true,
    );
    const window = report.windowEvidence;
    require(
        window.phase === 'ready' &&
            window.fence?.status === 'installed' &&
            window.fence.counts.patchFailures === 0 &&
            window.core?.platform === 'ios' &&
            window.auth.status === 'authenticated' &&
            window.auth.userPresent === false &&
            window.auth.authChecked === true &&
            window.privateSelection === 'native-pilot' &&
            window.legacyPermitAvailable === false &&
            window.lifecycle.stopped === false,
    );
    return report;
}
function requireClosedUi(closure, baseline) {
    require(
        closure.status === 'observed' &&
            closure.domFacts !== null &&
            closure.windowEvidence !== null &&
            closure.nativeCounters !== null &&
            closure.pmResultCounters !== null &&
            closure.sdkCounts !== null &&
            closure.relayCounters !== null,
    );
    const dom = closure.domFacts;
    require(
        dom.actualAppNavigation === true &&
            dom.privateOpenEnabled === false &&
            dom.logPresent === false &&
            dom.composeEmpty === true &&
            dom.passwordEmpty === true &&
            dom.legacyControlsAbsent === true,
    );
    const window = closure.windowEvidence,
        previous = baseline.windowEvidence;
    require(
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
    );
    require(
        closure.sdkCounts.password === baseline.sdkCounts.password &&
            closure.sdkCounts.unexpected === 0 &&
            window.fence.counts.authRequests === previous.fence.counts.authRequests &&
            window.fence.counts.authResponses === previous.fence.counts.authResponses &&
            window.fence.counts.authRefused === previous.fence.counts.authRefused,
    );
    for (const key of FULL_APP_NATIVE_COUNTERS) {
        const before = baseline.nativeCounters[key],
            after = closure.nativeCounters[key];
        // Closure is native-owner initiated, not a second JS fence. Successful
        // native completions are measured by the immutable observer sequence.
        if (['lifecycleState', 'acknowledgeClosedPresentation'].includes(key)) require(after >= before);
        else require(after === before);
    }
    for (const key of FULL_APP_PROTECTED_PM_RESULT_KEYS)
        require(closure.pmResultCounters[key] === baseline.pmResultCounters[key]);
    for (const key of ['auth', 'register', 'dispatch', 'unexpected'])
        require(closure.relayCounters[key] === baseline.protectedExchange.relay.methodCounters[key]);
}

/** Correlate a bounded actual driver stage, resources, captured v4 proof and
 * closure. The calling driver must still independently verify current sources,
 * compiled/signed artifacts, owned operations and cleanup. No permission or
 * whole-run acceptance can be obtained from this pure function. */
export function requireResearchSceneProtectedDriverStage(raw, expected) {
    return guarded(() => {
        const input = exact(raw, [
            'stage',
            'observerEvidence',
            'observerResourceBytes',
            'protectedResourceBytes',
            'protectedTemplate',
            'protectedReport',
            'protectedUiClosure',
            'sourceBindings',
        ]);
        const suppliedPin = exact(expected, [
            'runID',
            'nonce',
            'resourceSHA256',
            'protectedResourceSHA256',
            'protectedProofSHA256',
            'pid',
            'epoch',
            'sourceBindings',
        ]);
        const pin = closurePin(
            Object.fromEntries(Object.entries(suppliedPin).filter(([key]) => key !== 'sourceBindings')),
        );
        const actualSources = sourceBindings(input.sourceBindings),
            pinnedSources = sourceBindings(suppliedPin.sourceBindings);
        for (const key of RESEARCH_SCENE_REQUIRED_SOURCE_BINDINGS) require(actualSources[key] === pinnedSources[key]);
        require(hash(privateResourceBytes(input.protectedTemplate)) === actualSources.protectedScript);
        const observerBytes = privateResourceBytes(input.observerResourceBytes),
            protectedBytes = privateResourceBytes(input.protectedResourceBytes);
        require(hash(observerBytes) === pin.resourceSHA256 && hash(protectedBytes) === pin.protectedResourceSHA256);
        const resources = inspectResearchSceneProtectedResources(
            { observerResource: JSON.parse(observerBytes), protectedResource: JSON.parse(protectedBytes) },
            input.protectedTemplate,
        );
        require(resources.observerResource.runID === pin.runID && resources.observerResource.nonce === pin.nonce);
        const observation = inspectProtectedObservationStage(
            input.observerEvidence,
            { runID: pin.runID, nonce: pin.nonce, resourceSHA256: pin.resourceSHA256, pid: pin.pid },
            input.stage,
        );
        require(observation.process.epoch === pin.epoch);
        const baseline = protectedBaseline(input.protectedReport, pin.runID, pin.nonce);
        require(hash(JSON.stringify(canonical(baseline.protectedExchange))) === pin.protectedProofSHA256);
        if (input.stage === 'foreground-closed') {
            const closure = inspectResearchSceneProtectedUiClosure(input.protectedUiClosure, pin);
            requireClosedUi(closure, baseline);
        } else require(input.protectedUiClosure === null);
        return Object.freeze({
            status: 'driver-stage-matched',
            stage: input.stage,
            pid: pin.pid,
            epoch: pin.epoch,
            sourceBoundInputCorrelation: true,
            sourceArtifactVerificationRequired: true,
            protectedExchangeCaptured: true,
            protectedUiClosed: input.stage === 'foreground-closed',
            sameProcessSceneRoundTrip: input.stage === 'foreground-closed',
            wholeRunAccepted: false,
            messagingPermission: false,
            physicalAcceptance: false,
            sameStoreRecoveryProved: false,
        });
    });
}

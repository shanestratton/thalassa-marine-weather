/** Passive scene/process evidence schema, not an authorization mechanism.
 * Synthetic direct calls never establish OS lifecycle. Driver/source/resource
 * and actual launch/termination evidence must accompany future native receipts. */
export const RESEARCH_SCENE_LIFECYCLE_KIND = 'research-scene-lifecycle-observations';
export const RESEARCH_SCENE_LIFECYCLE_SCENARIO = 'full-app-native-os-lifecycle-observations';
export const RESEARCH_SCENE_LIFECYCLE_MAX_EVENTS = 64;
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
export function requireResearchSceneProtectedRoundTrip(raw, expected) {
    return guarded(() => {
        const receipt = inspectResearchSceneLifecycleEvidence(raw, expected);
        require(receipt.evidenceCategory === 'simulator-native-observations' && receipt.status === 'recording');
        const events = receipt.events;
        const names = events.map((event) => event.event);
        const exactSequence = [
            'process-started',
            'application-launched',
            'scene-connected',
            'did-become-active',
            'protected-ready',
            'will-resign-active',
            'did-enter-background',
            'will-enter-foreground',
            'did-become-active',
            'foreground-ui-closed',
        ];
        require(names.length === exactSequence.length && names.every((name, index) => name === exactSequence[index]));
        const baseline = events[4],
            resign = events[5],
            background = events[6],
            foreground = events[8],
            closed = events[9];
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
        require(resign.activationState === 'foreground-inactive' && background.activationState === 'background');
        for (const event of [resign, background, events[7]]) require(covers.every((key) => event.cover[key] === true));
        require(events[7].activationState === 'foreground-inactive');
        for (const event of [background, events[7], foreground, closed]) {
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
        require(
            foreground.activationState === 'foreground-active' &&
                closed.activationState === 'foreground-active' &&
                foreground.cover.present === false &&
                closed.cover.present === false,
        );
        const counts = [background, events[7], foreground, closed].map(
            (event) => event.authority.verifyFenceCompletions,
        );
        require(counts.every((count) => count === counts[0]));
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

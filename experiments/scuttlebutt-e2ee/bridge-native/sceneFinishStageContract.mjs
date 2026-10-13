// Diagnostic value parsing only. Fixed names and selected-once shape do not
// grant native permission or prove acceptance, JS consumption, native execution
// or an OS transition. No report, error, authority object or secret is copied.
export const SCENE_FINISH_CALLSITE_NAMES = Object.freeze(['js-failed', 'js-passed', 'native-receive-refused']);
export const SCENE_FINISH_NATIVE_BOUNDARY_NAMES = Object.freeze([
    'progress-order',
    'http',
    'common',
    'control',
    'write',
    'protected-ready',
    'final',
]);
export const SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES = Object.freeze([
    'none',
    'script-installed',
    'dom-ready',
    'http-refusals',
    'cold-ready',
    'signed-in',
    'unknown-admission',
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
    'protected-setup',
    'protected-peer-reply',
    'capture-proof',
    'fixture-complete',
    'fixture-failed',
]);
export const SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES = Object.freeze([
    'cold-ready',
    'cold-chat-closed',
    'authenticated',
    'unknown-admission',
    'prepared',
    'native-admission',
    'inbox-entry',
    'thread-open',
    'send-enabled',
    'send-accepted',
    'reply-refresh-enabled',
    'peer-reply',
    'receive-refresh-enabled',
    'receive-refresh-completion',
    'incoming-received',
    'dedup-refresh-enabled',
    'dedup-refresh-completion',
    'proof-captured',
    'url-check',
    'await-foreground',
    'await-closed-window',
    'closure-post',
    'await-closure-ack',
]);

const fields = Object.freeze(['version', 'kind', 'native', 'javascript', 'acceptanceEvidence']);
const nativeFields = Object.freeze([
    'selectedFinishes',
    'callsites',
    'lastValidationBoundaries',
    'admittedReportPhases',
]);
const javascriptFields = Object.freeze(['selectedFailures', 'failurePhases']);
const boundaryMarkers = Object.freeze([...SCENE_FINISH_NATIVE_BOUNDARY_NAMES, 'none']);
const javascriptMarkers = Object.freeze([...SCENE_FINISH_JAVASCRIPT_FAILURE_PHASE_NAMES, 'none']);

function own(value, names) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw Error('Scene finish diagnostic shape refused');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw Error('Scene finish diagnostic prototype refused');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
        throw Error('Scene finish diagnostic fields refused');
    const entries = [];
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
            throw Error('Scene finish diagnostic data field refused');
        entries.push([name, descriptor.value]);
    }
    // Defining copied own properties avoids inherited setters on a result.
    return Object.fromEntries(entries);
}

function selector(value) {
    if (value !== 0 && value !== 1) throw Error('Scene finish diagnostic selector refused');
    return value;
}

function markers(value, names, selected) {
    const copied = own(value, names);
    let sum = 0;
    for (const name of names) {
        const count = copied[name];
        if (count !== 0 && count !== 1) throw Error('Scene finish diagnostic marker bound refused');
        sum += count;
    }
    // Unselected means no marker, including none. Selected means exactly one
    // fixed marker; none represents a captured absence only in its own channel.
    if (sum !== selected) throw Error('Scene finish diagnostic selection facts refused');
    return Object.freeze(copied);
}

function selectedName(value, names) {
    const name = names.find((key) => value[key] === 1);
    return name === undefined || name === 'none' ? null : name;
}

export function inspectSceneFinishStageEvidence(value) {
    const data = own(value, fields);
    if (data.version !== 1 || data.kind !== 'scene-finish-stage-diagnostic' || data.acceptanceEvidence !== false)
        throw Error('Scene finish diagnostic classification refused');
    const native = own(data.native, nativeFields);
    const javascript = own(data.javascript, javascriptFields);
    const selectedFinishes = selector(native.selectedFinishes);
    const selectedFailures = selector(javascript.selectedFailures);
    const callsites = markers(native.callsites, SCENE_FINISH_CALLSITE_NAMES, selectedFinishes);
    const lastValidationBoundaries = markers(native.lastValidationBoundaries, boundaryMarkers, selectedFinishes);
    const admittedReportPhases = markers(
        native.admittedReportPhases,
        SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES,
        selectedFinishes,
    );
    const failurePhases = markers(javascript.failurePhases, javascriptMarkers, selectedFailures);

    // These independent channels have no derived pass status, permission or
    // cross-channel implication. Re-reading an identical row adds no evidence.
    return Object.freeze({
        version: 1,
        kind: 'scene-finish-stage-diagnostic',
        native: Object.freeze({
            selectedFinishes,
            callsites,
            lastValidationBoundaries,
            admittedReportPhases,
            callsite: selectedName(callsites, SCENE_FINISH_CALLSITE_NAMES),
            lastValidationBoundary: selectedName(lastValidationBoundaries, boundaryMarkers),
            admittedReportPhase: selectedName(admittedReportPhases, SCENE_FINISH_ADMITTED_REPORT_PHASE_NAMES),
        }),
        javascript: Object.freeze({
            selectedFailures,
            failurePhases,
            failurePhase: selectedName(failurePhases, javascriptMarkers),
        }),
        acceptanceEvidence: false,
        javascriptConsumptionProved: false,
        nativeExecutionProvedByParser: false,
        nativePermissionGranted: false,
        osLifecycleProvedByParser: false,
    });
}

// Passive diagnostic value parsing only. Each fixed phase is currently
// entered/observed, never a completed or failed stage. Ordered DOM booleans grant
// no native permission, acceptance, JS consumption or operating-system proof.
// No report, authority object, token, error or secret is copied into the result.
export const SCENE_PROGRESS_MAXIMUM_ENTRIES = 64;
export const SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES = Object.freeze([
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

const fields = Object.freeze(['version', 'kind', 'entries', 'acceptanceEvidence']);
const domFields = Object.freeze([
    'sendPresent',
    'sendEnabled',
    'composePresent',
    'composeEmpty',
    'composeDisabled',
    'composeReadOnly',
]);
const entryFields = Object.freeze(['sequence', 'phase', ...domFields]);

function own(value, names) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw Error('Scene progress diagnostic shape refused');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw Error('Scene progress diagnostic prototype refused');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
        throw Error('Scene progress diagnostic fields refused');
    const entries = [];
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
            throw Error('Scene progress diagnostic data field refused');
        entries.push([name, descriptor.value]);
    }
    // Own properties on the copy avoid inherited setters and input accessors.
    return Object.fromEntries(entries);
}

function arrayValues(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        throw Error('Scene progress diagnostic array refused');
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
        !length ||
        !Object.hasOwn(length, 'value') ||
        length.enumerable !== false ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > SCENE_PROGRESS_MAXIMUM_ENTRIES
    )
        throw Error('Scene progress diagnostic entry bound refused');
    const keys = Reflect.ownKeys(value);
    const names = ['length', ...Array.from({ length: length.value }, (_, index) => String(index))];
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
        throw Error('Scene progress diagnostic array fields refused');
    const copied = [];
    for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
            throw Error('Scene progress diagnostic array data refused');
        copied.push(descriptor.value);
    }
    return copied;
}

function nullableBoolean(value) {
    if (value !== null && value !== true && value !== false) throw Error('Scene progress diagnostic DOM fact refused');
    return value;
}

export function inspectSceneProgressStageEvidence(value) {
    const data = own(value, fields);
    if (data.version !== 1 || data.kind !== 'scene-progress-stage-diagnostic' || data.acceptanceEvidence !== false)
        throw Error('Scene progress diagnostic classification refused');
    const entries = [];
    for (const raw of arrayValues(data.entries)) {
        const entry = own(raw, entryFields);
        if (
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence < 1 ||
            entry.sequence > SCENE_PROGRESS_MAXIMUM_ENTRIES ||
            entry.sequence !== entries.length + 1
        )
            throw Error('Scene progress diagnostic sequence refused');
        if (typeof entry.phase !== 'string' || !SCENE_PROGRESS_JAVASCRIPT_PHASE_NAMES.includes(entry.phase))
            throw Error('Scene progress diagnostic phase refused');
        for (const name of domFields) entry[name] = nullableBoolean(entry[name]);
        if (
            (entry.sendPresent !== true && entry.sendEnabled !== null) ||
            (entry.composePresent !== true &&
                (entry.composeEmpty !== null || entry.composeDisabled !== null || entry.composeReadOnly !== null))
        )
            throw Error('Scene progress diagnostic DOM presence facts refused');
        entries.push(Object.freeze(entry));
    }
    // Exact detached value shape has no derived pass/failure/authority status.
    // Re-reading a row adds no evidence and the parser changes no input state.
    return Object.freeze({
        version: 1,
        kind: 'scene-progress-stage-diagnostic',
        entries: Object.freeze(entries),
        acceptanceEvidence: false,
    });
}

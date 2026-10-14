import { Buffer } from 'node:buffer';

// Passive observations only. A native category identifies the producer; it
// grants no permission, expiry explanation, scene/OS proof or acceptance.
export const SCENE_AUTHORITY_TIMING_MAXIMUM_BYTES = 16_384;
export const SCENE_AUTHORITY_TIMING_MAXIMUM_ENTRIES = 32;

const refusal = 'Scene authority timing evidence refused.';
const wrapperFields = Object.freeze([
    'version',
    'kind',
    'runID',
    'nonce',
    'resourceSHA256',
    'process',
    'timing',
    'acceptanceEvidence',
    'authorityMutated',
]);
const pinFields = Object.freeze(['runID', 'nonce', 'resourceSHA256', 'pid', 'epoch']);
const processFields = Object.freeze(['pid', 'epoch']);
const timingFields = Object.freeze([
    'version',
    'kind',
    'evidenceCategory',
    'status',
    'entries',
    'acceptanceEvidence',
    'authorityMutated',
]);
const entryFields = Object.freeze([
    'sequence',
    'phase',
    'sinceFirstVerify',
    'sinceOriginalCapture',
    'fenceAttempts',
    'verifyCompletions',
    'facadeObserved',
    'originalObserved',
    'accountPresent',
    'originalCurrent',
]);
const phases = Object.freeze([
    'verify-completed',
    'original-captured',
    'original-rechecked',
    'protected-setup',
    'peer-reply',
    'proof-captured',
    'protected-report',
    'authority-observed',
    'authority-unavailable',
    'original-cleared',
]);
const buckets = Object.freeze([
    'unobserved',
    'lt-1s',
    '1s-to-lt-10s',
    '10s-to-lt-30s',
    '30s-to-lt-60s',
    '60s-to-lt-120s',
    'ge-120s',
]);
const categories = Object.freeze(['simulator-native-observations', 'synthetic-direct-calls']);
const statuses = Object.freeze(['recording', 'capacity-refused', 'clock-refused', 'input-refused']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;

function refused() {
    throw Error(refusal);
}

function own(value, names) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) refused();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) refused();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) refused();
    const entries = [];
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refused();
        entries.push([name, descriptor.value]);
    }
    // Do not invoke an input accessor or an inherited setter on the clone.
    return Object.fromEntries(entries);
}

function arrayValues(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) refused();
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
        !length ||
        !Object.hasOwn(length, 'value') ||
        length.enumerable !== false ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > SCENE_AUTHORITY_TIMING_MAXIMUM_ENTRIES
    )
        refused();
    const keys = Reflect.ownKeys(value);
    const names = ['length', ...Array.from({ length: length.value }, (_, index) => String(index))];
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) refused();
    const copied = [];
    for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refused();
        copied.push(descriptor.value);
    }
    return copied;
}

function canonicalUUID(value) {
    if (typeof value !== 'string' || value.length !== 36 || !uuid.test(value)) refused();
    return value;
}

function canonicalHash(value) {
    if (typeof value !== 'string' || value.length !== 64 || !hash.test(value)) refused();
    return value;
}

function positivePID(value) {
    if (!Number.isSafeInteger(value) || value <= 0) refused();
    return value;
}

function nullableCounter(value) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 10_000)) refused();
    return value === 0 ? 0 : value;
}

function boolean(value) {
    if (value !== true && value !== false) refused();
    return value;
}

function nullableBoolean(value) {
    if (value !== null && value !== true && value !== false) refused();
    return value;
}

function bucketIndex(value) {
    if (typeof value !== 'string') refused();
    const index = buckets.indexOf(value);
    if (index < 0) refused();
    return index;
}

function serializedByteLength(value) {
    if (value === null) return 4;
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (typeof value === 'number') return Buffer.byteLength(String(value), 'utf8');
    if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (Array.isArray(value))
        return 2 + Math.max(0, value.length - 1) + value.reduce((size, entry) => size + serializedByteLength(entry), 0);
    const fields = Object.entries(value);
    return (
        2 +
        Math.max(0, fields.length - 1) +
        fields.reduce((size, [name, field]) => size + serializedByteLength(name) + 1 + serializedByteLength(field), 0)
    );
}

function inspectTiming(raw) {
    const data = own(raw, timingFields);
    if (
        data.version !== 1 ||
        data.kind !== 'scene-authority-timing-diagnostic' ||
        !categories.includes(data.evidenceCategory) ||
        !statuses.includes(data.status) ||
        data.acceptanceEvidence !== false ||
        data.authorityMutated !== false
    )
        refused();
    const entries = [];
    let firstVerifyObserved = false;
    let originalCaptureObserved = false;
    let originalWasCleared = false;
    let previousVerifyBucket = 0;
    let previousOriginalBucket = 0;
    for (const rawEntry of arrayValues(data.entries)) {
        const entry = own(rawEntry, entryFields);
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== entries.length + 1) refused();
        if (typeof entry.phase !== 'string' || !phases.includes(entry.phase)) refused();
        if (entry.phase === 'verify-completed') firstVerifyObserved = true;
        if (entry.phase === 'original-captured') {
            if (originalCaptureObserved || originalWasCleared) refused();
            originalCaptureObserved = true;
        }
        const verifyBucket = bucketIndex(entry.sinceFirstVerify);
        const originalBucket = bucketIndex(entry.sinceOriginalCapture);
        if (
            (firstVerifyObserved ? verifyBucket === 0 : verifyBucket !== 0) ||
            (originalCaptureObserved ? originalBucket === 0 : originalBucket !== 0) ||
            verifyBucket < previousVerifyBucket ||
            originalBucket < previousOriginalBucket
        )
            refused();
        previousVerifyBucket = verifyBucket;
        previousOriginalBucket = originalBucket;
        entry.fenceAttempts = nullableCounter(entry.fenceAttempts);
        entry.verifyCompletions = nullableCounter(entry.verifyCompletions);
        entry.facadeObserved = boolean(entry.facadeObserved);
        entry.originalObserved = boolean(entry.originalObserved);
        entry.accountPresent = nullableBoolean(entry.accountPresent);
        entry.originalCurrent = nullableBoolean(entry.originalCurrent);
        if (
            (entry.originalObserved && !entry.facadeObserved) ||
            ((entry.accountPresent !== null || entry.originalCurrent !== null) && !entry.facadeObserved) ||
            (entry.originalCurrent !== null && !entry.originalObserved) ||
            (originalWasCleared && entry.originalObserved)
        )
            refused();
        if (
            entry.phase === 'verify-completed' &&
            (!entry.facadeObserved || entry.verifyCompletions === null || entry.verifyCompletions === 0)
        )
            refused();
        if (entry.phase === 'original-captured' && (!entry.facadeObserved || !entry.originalObserved)) refused();
        if (
            entry.phase === 'authority-observed' &&
            (!entry.facadeObserved ||
                entry.accountPresent === null ||
                entry.originalObserved !== (entry.originalCurrent !== null))
        )
            refused();
        if (
            entry.phase === 'authority-unavailable' &&
            (entry.facadeObserved ||
                entry.originalObserved ||
                entry.accountPresent !== null ||
                entry.originalCurrent !== null)
        )
            refused();
        if (entry.phase === 'original-cleared' && (entry.originalObserved || entry.originalCurrent !== null)) refused();
        entries.push(Object.freeze(entry));
        if (entry.phase === 'original-cleared') originalWasCleared = true;
    }
    return Object.freeze({
        version: 1,
        kind: 'scene-authority-timing-diagnostic',
        evidenceCategory: data.evidenceCategory,
        status: data.status,
        entries: Object.freeze(entries),
        acceptanceEvidence: false,
        authorityMutated: false,
    });
}

export function inspectSceneAuthorityTimingEvidence(raw, pin) {
    try {
        const expected = own(pin, pinFields);
        canonicalUUID(expected.runID);
        canonicalHash(expected.nonce);
        canonicalHash(expected.resourceSHA256);
        positivePID(expected.pid);
        canonicalUUID(expected.epoch);
        const data = own(raw, wrapperFields);
        if (
            data.version !== 1 ||
            data.kind !== 'research-scene-authority-timing-observations' ||
            data.acceptanceEvidence !== false ||
            data.authorityMutated !== false
        )
            refused();
        canonicalUUID(data.runID);
        canonicalHash(data.nonce);
        canonicalHash(data.resourceSHA256);
        const process = own(data.process, processFields);
        positivePID(process.pid);
        canonicalUUID(process.epoch);
        if (
            data.runID !== expected.runID ||
            data.nonce !== expected.nonce ||
            data.resourceSHA256 !== expected.resourceSHA256 ||
            process.pid !== expected.pid ||
            process.epoch !== expected.epoch
        )
            refused();
        const sanitized = Object.freeze({
            version: 1,
            kind: 'research-scene-authority-timing-observations',
            runID: data.runID,
            nonce: data.nonce,
            resourceSHA256: data.resourceSHA256,
            process: Object.freeze(process),
            timing: inspectTiming(data.timing),
            acceptanceEvidence: false,
            authorityMutated: false,
        });
        // Count the exact JSON encoding of admitted own fields. Serialize only
        // primitive strings, never an object (including inherited toJSON hooks)
        // or a rejected input, supplied error or authority object.
        if (serializedByteLength(sanitized) > SCENE_AUTHORITY_TIMING_MAXIMUM_BYTES) refused();
        return sanitized;
    } catch {
        // A hostile proxy/accessor can supply an arbitrary error. Retain none of
        // it, including as a cause, and expose the same fixed refusal every time.
        return refused();
    }
}

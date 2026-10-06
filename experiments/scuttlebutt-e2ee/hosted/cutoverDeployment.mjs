/**
 * Pure isolated deployment contracts. No IO, CLI, network or state mutation.
 * Validation does not authenticate an unsigned receipt's producer, establish
 * freshness, prove compiled-source provenance or prove successful new actions.
 */
import { createHash } from 'node:crypto';
import { SOURCE_SHA256, TABLES, TARGETS } from './cutoverMigration.mjs';

const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const SLUG = 'scuttlebutt-e2ee-pilot';
const DATA_ALGORITHM = 'MD5/counts; change diagnostics, not cryptographic attestation';
const STATEMENT =
    'Isolated support only. No human account mode selection, enrollment, key replacement, old row rewrite, notification overlay, Edge deployment or production access.';
const RECEIPT_FIELDS = [
    'version',
    'operation',
    'status',
    'project',
    'organization',
    'schema',
    'completedAt',
    'cutoverInstalled',
    'sourceSqlSha256',
    'updaterSha256',
    'migrationModuleSha256',
    'deltaSha256',
    'functions',
    'preservedAuthoritySha256',
    'dataDiagnostics',
    'safety',
    'statement',
];
const SAFETY_FIELDS = [
    'cutoverSupportOnly',
    'existingFunctionOidsAndPermissionsPreserved',
    'atomicPrecommitInvariantsChecked',
    'newEmptyPolicyTableCreated',
    'accountProtectionSelected',
    'rolesSecretsParticipantsKeysOrOldRowsMutated',
    'notificationsInstalled',
    'edgeFunctionDeployed',
    'productionTouched',
    'secretsPrinted',
    'independentAuditPerformed',
];
const SHA256 = /^[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const validatedInspections = new WeakSet();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = () => {
    throw new Error('Isolated cutover deployment unavailable');
};
const requireValue = (value) => {
    if (!value) fail();
};
const match = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function dataObject(value, names, allowExtra = false) {
    requireValue(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value);
    requireValue(keys.length <= 64 && keys.every((key) => typeof key === 'string'));
    requireValue(
        allowExtra
            ? names.every((name) => keys.includes(name))
            : keys.length === names.length && keys.every((key) => names.includes(key)),
    );
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    }
    return Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(value, name).value]));
}
function dataArray(value, maximum) {
    requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    requireValue(Number.isSafeInteger(length) && length >= 0 && length <= maximum);
    const keys = Reflect.ownKeys(value);
    requireValue(
        keys.length === length + 1 &&
            keys.every(
                (key) =>
                    key === 'length' ||
                    (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length),
            ),
    );
    return Array.from({ length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        requireValue(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
        return descriptor.value;
    });
}
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
function equal(left, right) {
    if (Array.isArray(left) || Array.isArray(right))
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => equal(item, right[index]))
        );
    if ((left && typeof left === 'object') || (right && typeof right === 'object')) {
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        const keys = Object.keys(left).sort();
        return (
            keys.length === Object.keys(right).length &&
            keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
        );
    }
    return left === right;
}
function oid(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= 4_294_967_295;
}
function functionPins(value) {
    const entries = dataArray(value, 3).map((entry) => dataObject(entry, ['signature', 'bodySha256']));
    requireValue(entries.length === 3 && new Set(entries.map((entry) => entry.signature)).size === 3);
    for (const entry of entries) {
        const target = TARGETS.find((item) => item.signature === entry.signature);
        requireValue(target && match(entry.bodySha256, SHA256) && entry.bodySha256 !== target.baseline);
    }
    return entries.sort((left, right) => compare(left.signature, right.signature));
}
function pinsObject(value) {
    const pins = dataObject(value, [
        'project',
        'organization',
        'sourceSqlSha256',
        'updaterSha256',
        'migrationModuleSha256',
        'functions',
    ]);
    requireValue(
        pins.project === PROJECT && pins.organization === ORGANIZATION && pins.sourceSqlSha256 === SOURCE_SHA256,
    );
    requireValue(match(pins.updaterSha256, SHA256) && match(pins.migrationModuleSha256, SHA256));
    return { ...pins, functions: functionPins(pins.functions) };
}
function functions(value, pins) {
    const entries = dataArray(value, 3).map((entry) => dataObject(entry, ['signature', 'oid', 'bodySha256']));
    requireValue(
        entries.length === 3 &&
            new Set(entries.map((entry) => entry.signature)).size === 3 &&
            new Set(entries.map((entry) => entry.oid)).size === 3,
    );
    for (const entry of entries) {
        const expected = pins.functions.find((item) => item.signature === entry.signature);
        requireValue(expected && oid(entry.oid) && entry.bodySha256 === expected.bodySha256);
    }
    return entries.sort((left, right) => compare(left.signature, right.signature));
}
function dataDiagnosticsEntries(value, expectedNames) {
    const entries = dataArray(value, 6).map((entry) => dataObject(entry, ['name', 'count', 'digest']));
    requireValue(
        entries.length === expectedNames.length && new Set(entries.map((entry) => entry.name)).size === entries.length,
    );
    requireValue(equal(entries.map((entry) => entry.name).sort(), [...expectedNames].sort()));
    for (const entry of entries)
        requireValue(Number.isSafeInteger(entry.count) && entry.count >= 0 && match(entry.digest, MD5));
    return entries.sort((left, right) => compare(left.name, right.name));
}
function receipt(value, suppliedPins, inspection) {
    const pins = pinsObject(suppliedPins);
    const fields = dataObject(value, RECEIPT_FIELDS);
    requireValue(
        fields.version === 1 &&
            fields.project === PROJECT &&
            fields.organization === ORGANIZATION &&
            fields.schema === 'e2ee_research' &&
            fields.cutoverInstalled === true &&
            fields.statement === STATEMENT,
    );
    requireValue(
        fields.sourceSqlSha256 === pins.sourceSqlSha256 &&
            fields.updaterSha256 === pins.updaterSha256 &&
            fields.migrationModuleSha256 === pins.migrationModuleSha256 &&
            match(fields.preservedAuthoritySha256, SHA256),
    );
    requireValue(
        typeof fields.completedAt === 'string' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.completedAt) &&
            new Date(fields.completedAt).toISOString() === fields.completedAt,
    );
    const applied = fields.status === 'applied';
    requireValue(
        inspection
            ? fields.operation === 'inspect' && fields.status === 'inspected'
            : fields.operation === 'apply-cutover' && (applied || fields.status === 'already-applied'),
    );
    requireValue(applied ? match(fields.deltaSha256, SHA256) : fields.deltaSha256 === null);
    const safety = dataObject(fields.safety, SAFETY_FIELDS);
    for (const name of SAFETY_FIELDS) {
        const expected =
            ['cutoverSupportOnly', 'existingFunctionOidsAndPermissionsPreserved'].includes(name) ||
            (applied && ['atomicPrecommitInvariantsChecked', 'newEmptyPolicyTableCreated'].includes(name));
        requireValue(safety[name] === expected);
    }
    const diagnostics = dataObject(fields.dataDiagnostics, ['algorithm', 'before', 'after']);
    requireValue(diagnostics.algorithm === DATA_ALGORITHM);
    const before = dataDiagnosticsEntries(diagnostics.before, applied ? TABLES : [...TABLES, 'protected_accounts']);
    const after = dataDiagnosticsEntries(diagnostics.after, [...TABLES, 'protected_accounts']);
    if (!applied) requireValue(equal(before, after));
    // An applied receipt describes an initially empty table under its original
    // transaction; legitimate policy selections may exist by later postflight.
    // Do not turn historical creation flags into a current-empty-table rule.
    return freeze({
        ...fields,
        functions: functions(fields.functions, pins),
        safety,
        dataDiagnostics: { algorithm: DATA_ALGORITHM, before, after },
    });
}

/** Storage/shape/pin validation only, not producer authenticity or current DB state. */
export function validateSupportReceipt(value, pins) {
    try {
        return receipt(value, pins, false);
    } catch {
        return fail();
    }
}

/** The host must actually perform a fresh guarded inspection before calling. */
export function validateInstalledInspection(fresh, applied, pins) {
    try {
        const support = receipt(applied, pins, false);
        const inspected = receipt(fresh, pins, true);
        requireValue(equal(inspected.functions, support.functions));
        // Data and the old-state preservation hash can legitimately differ
        // from historical application receipts. Never restore them as targets.
        validatedInspections.add(inspected);
        return inspected;
    } catch {
        return fail();
    }
}

/** Normalize management metadata; this does not authenticate compiled bytes. */
export function normalizeRevisionSet(raw) {
    try {
        const entries = dataArray(raw, 32).map((value) => {
            const item = dataObject(value, ['slug', 'id', 'version', 'status', 'verify_jwt', 'ezbr_sha256'], true);
            requireValue(
                match(item.slug, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/) &&
                    item.slug.length <= 64 &&
                    match(item.id, UUID) &&
                    item.id !== NIL_UUID &&
                    Number.isSafeInteger(item.version) &&
                    item.version > 0 &&
                    ['ACTIVE', 'REMOVED', 'THROTTLED'].includes(item.status) &&
                    typeof item.verify_jwt === 'boolean' &&
                    match(item.ezbr_sha256, SHA256),
            );
            return {
                slug: item.slug,
                id: item.id,
                version: item.version,
                status: item.status,
                verifyJwt: item.verify_jwt,
                bundleSha256: item.ezbr_sha256,
            };
        });
        requireValue(
            entries.length > 0 &&
                new Set(entries.map((entry) => entry.slug)).size === entries.length &&
                new Set(entries.map((entry) => entry.id)).size === entries.length,
        );
        const selected = entries.find((entry) => entry.slug === SLUG);
        requireValue(selected?.status === 'ACTIVE' && selected.verifyJwt === true);
        return freeze(entries.sort((left, right) => compare(left.slug, right.slug)));
    } catch {
        return fail();
    }
}

/** Returns a hash only. CLI `value` must be bounded digest metadata, never a secret. */
export function fingerprintSecretMetadata(raw) {
    try {
        const entries = dataArray(raw, 64)
            .map((value) => {
                const item = dataObject(value, ['name', 'value'], true);
                requireValue(match(item.name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/) && match(item.value, SHA256));
                return { name: item.name, digest: item.value };
            })
            .sort((left, right) => compare(left.name, right.name));
        requireValue(
            new Set(entries.map((entry) => entry.name)).size === entries.length &&
                entries.find((entry) => entry.name === 'SUPABASE_URL')?.digest === hash(ORIGIN) &&
                ['E2EE_PILOT_DATABASE_URL', 'E2EE_PILOT_PARTICIPANTS'].every((name) =>
                    entries.some((entry) => entry.name === name),
                ),
        );
        return hash(JSON.stringify(entries));
    } catch {
        return fail();
    }
}

function sourceHashes(value) {
    requireValue(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value);
    requireValue(
        keys.length > 0 &&
            keys.length <= 64 &&
            keys.every(
                (key) =>
                    typeof key === 'string' &&
                    match(key, /^[A-Za-z0-9._/-]{1,512}$/) &&
                    !key.startsWith('/') &&
                    !key.split('/').some((part) => !part || part === '.' || part === '..'),
            ),
    );
    return Object.fromEntries(
        keys.sort().map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            requireValue(
                descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && match(descriptor.value, SHA256),
            );
            return [key, descriptor.value];
        }),
    );
}
function deploymentState(value) {
    const state = dataObject(value, ['inspection', 'secretsFingerprint', 'sourceHashes']);
    requireValue(validatedInspections.has(state.inspection) && match(state.secretsFingerprint, SHA256));
    return { ...state, sourceHashes: sourceHashes(state.sourceHashes) };
}

/**
 * Compare the fresh deployment interval, including permanent policy rows.
 * Inventory coverage belongs to the host; supplied hashes are not a compiled
 * bundle attestation. No timestamp or success count grants message authority.
 */
export function assertDeploymentPreserved(before, after) {
    try {
        const first = deploymentState(before),
            last = deploymentState(after);
        requireValue(
            equal(first.inspection.functions, last.inspection.functions) &&
                ['sourceSqlSha256', 'updaterSha256', 'migrationModuleSha256'].every(
                    (key) => first.inspection[key] === last.inspection[key],
                ) &&
                first.inspection.preservedAuthoritySha256 === last.inspection.preservedAuthoritySha256 &&
                equal(first.inspection.dataDiagnostics.after, last.inspection.dataDiagnostics.after) &&
                first.secretsFingerprint === last.secretsFingerprint &&
                equal(first.sourceHashes, last.sourceHashes),
        );
        return true;
    } catch {
        return fail();
    }
}

// @vitest-environment node
/** Pure receipt/metadata fixtures only. No CLI, credentials, network, hosted
 * deployment, account selection or independent security evidence. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
    assertDeploymentPreserved,
    fingerprintSecretMetadata,
    normalizeRevisionSet,
    validateInstalledInspection,
    validateSupportReceipt,
} from '../experiments/scuttlebutt-e2ee/hosted/cutoverDeployment.mjs';
import { SOURCE_SHA256, TABLES, extractDefinitions } from '../experiments/scuttlebutt-e2ee/hosted/cutoverMigration.mjs';

const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const SLUG = 'scuttlebutt-e2ee-pilot';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const FIXTURE_TIME = '2026-10-07T00:00:00.000Z';
const DIAGNOSTIC_ALGORITHM = 'MD5/counts; change diagnostics, not cryptographic attestation';
const STATEMENT =
    'Isolated support only. No human account mode selection, enrollment, key replacement, old row rewrite, notification overlay, Edge deployment or production access.';
const read = (path: string) =>
    readFileSync(new NodeURL(`../experiments/scuttlebutt-e2ee/${path}`, import.meta.url), 'utf8');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// These identifiers are ASCII; SQL COLLATE C ordering is independent of locale.
const byteOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const definitions = extractDefinitions(read('relay/relay.sql'));
const pinnedFunctions: { signature: string; bodySha256: string }[] = definitions.targets
    .map((target: { signature: string; target: string }) => ({
        signature: target.signature,
        bodySha256: target.target,
    }))
    .sort((a: { signature: string }, b: { signature: string }) => byteOrder(a.signature, b.signature));
const pins = {
    project: PROJECT,
    organization: ORGANIZATION,
    sourceSqlSha256: SOURCE_SHA256,
    updaterSha256: sha256(read('hosted/updateCutover.mjs')),
    migrationModuleSha256: sha256(read('hosted/cutoverMigration.mjs')),
    functions: pinnedFunctions,
};
type DataRow = { name: string; count: number; digest: string };
type Receipt = {
    version: number;
    operation: string;
    status: string;
    project: string;
    organization: string;
    schema: string;
    completedAt: string;
    cutoverInstalled: boolean;
    sourceSqlSha256: string;
    updaterSha256: string;
    migrationModuleSha256: string;
    deltaSha256: string | null;
    functions: { signature: string; oid: number; bodySha256: string }[];
    preservedAuthoritySha256: string;
    dataDiagnostics: { algorithm: string; before: DataRow[]; after: DataRow[] };
    safety: Record<string, boolean>;
    statement: string;
};
function receipt(status: 'applied' | 'already-applied' | 'inspected' = 'applied'): Receipt {
    const applied = status === 'applied';
    const after = [...TABLES, 'protected_accounts'].map((name: string, index: number) => ({
        name,
        count: index === 5 ? 3 : index + 1,
        digest: md5(`synthetic current rows ${name}`),
    }));
    return {
        version: 1,
        operation: status === 'inspected' ? 'inspect' : 'apply-cutover',
        status,
        project: PROJECT,
        organization: ORGANIZATION,
        schema: 'e2ee_research',
        completedAt: FIXTURE_TIME,
        cutoverInstalled: true,
        sourceSqlSha256: pins.sourceSqlSha256,
        updaterSha256: pins.updaterSha256,
        migrationModuleSha256: pins.migrationModuleSha256,
        deltaSha256: applied ? sha256('synthetic applied delta') : null,
        functions: pinnedFunctions.map((fn, index) => ({ ...fn, oid: 100 + index })),
        preservedAuthoritySha256: sha256('synthetic current preserved old catalog and data'),
        dataDiagnostics: {
            algorithm: DIAGNOSTIC_ALGORITHM,
            before: clone(applied ? after.slice(0, 5) : after),
            after,
        },
        safety: {
            cutoverSupportOnly: true,
            existingFunctionOidsAndPermissionsPreserved: true,
            atomicPrecommitInvariantsChecked: applied,
            newEmptyPolicyTableCreated: applied,
            accountProtectionSelected: false,
            rolesSecretsParticipantsKeysOrOldRowsMutated: false,
            notificationsInstalled: false,
            edgeFunctionDeployed: false,
            productionTouched: false,
            secretsPrinted: false,
            independentAuditPerformed: false,
        },
        statement: STATEMENT,
    };
}
function secretMetadata() {
    return [
        { name: 'SUPABASE_URL', value: sha256(ORIGIN) },
        { name: 'E2EE_PILOT_DATABASE_URL', value: sha256('synthetic database secret') },
        { name: 'E2EE_PILOT_PARTICIPANTS', value: sha256('synthetic participant allowlist') },
        { name: 'EXTRA_SECRET', value: sha256('synthetic additional secret') },
    ];
}
function revisions() {
    return [
        {
            slug: SLUG,
            id: '11111111-1111-4111-8111-111111111111',
            version: 8,
            status: 'ACTIVE',
            verify_jwt: true,
            ezbr_sha256: sha256('synthetic pilot bundle'),
        },
        {
            slug: 'other-isolated-function',
            id: '22222222-2222-4222-8222-222222222222',
            version: 2,
            status: 'REMOVED',
            verify_jwt: false,
            ezbr_sha256: sha256('synthetic unrelated bundle'),
        },
    ];
}

describe('cutover deployment fixture source bindings', () => {
    it('uses the real pinned relay targets and current local updater/module hashes', () => {
        expect(SOURCE_SHA256).toBe('15236d599574be3a087859b4ff60ba4acb2b0ed89559def4de6aa9cc5c933c01');
        expect(sha256(read('relay/relay.sql'))).toBe(SOURCE_SHA256);
        expect(pinnedFunctions).toHaveLength(3);
        expect(new Set(pinnedFunctions.map((fn) => fn.signature)).size).toBe(3);
        expect(pins.updaterSha256).toBe(sha256(read('hosted/updateCutover.mjs')));
        expect(pins.migrationModuleSha256).toBe(sha256(read('hosted/cutoverMigration.mjs')));
    });
});

type ReceiptMutation = { name: string; mutate: (value: Receipt) => void };
describe('support receipt consistency — synthetic local JSON, not producer authentication', () => {
    it.each(['applied', 'already-applied'] as const)(
        'accepts a consistent %s receipt with permanent protected rows',
        (status) => {
            const value = receipt(status);
            const result = validateSupportReceipt(value, pins);
            expect(result.status).toBe(status);
            expect(result.dataDiagnostics.after.find((row: DataRow) => row.name === 'protected_accounts').count).toBe(
                3,
            );
            const expected = clone(value);
            expected.dataDiagnostics.before.sort((a, b) => byteOrder(a.name, b.name));
            expected.dataDiagnostics.after.sort((a, b) => byteOrder(a.name, b.name));
            expect(result).toEqual(expected);
            expect(result).not.toBe(value);
        },
    );

    const invalid: ReceiptMutation[] = [
        {
            name: 'unsupported version',
            mutate: (value) => {
                value.version = 2;
            },
        },
        {
            name: 'inspection passed as support',
            mutate: (value) => {
                value.operation = 'inspect';
                value.status = 'inspected';
            },
        },
        {
            name: 'wrong project',
            mutate: (value) => {
                value.project = 'pcisdplnodrphauixcau';
            },
        },
        {
            name: 'wrong organization',
            mutate: (value) => {
                value.organization = 'unapproved';
            },
        },
        {
            name: 'wrong schema',
            mutate: (value) => {
                value.schema = 'public';
            },
        },
        {
            name: 'uninstalled support',
            mutate: (value) => {
                value.cutoverInstalled = false;
            },
        },
        {
            name: 'source pin drift',
            mutate: (value) => {
                value.sourceSqlSha256 = sha256('different relay');
            },
        },
        {
            name: 'updater pin drift',
            mutate: (value) => {
                value.updaterSha256 = sha256('different updater');
            },
        },
        {
            name: 'migration pin drift',
            mutate: (value) => {
                value.migrationModuleSha256 = sha256('different migration');
            },
        },
        {
            name: 'missing function',
            mutate: (value) => {
                value.functions.pop();
            },
        },
        {
            name: 'duplicate function',
            mutate: (value) => {
                value.functions[1] = { ...value.functions[0] };
            },
        },
        {
            name: 'wrong function body hash',
            mutate: (value) => {
                value.functions[0].bodySha256 = sha256('different body');
            },
        },
        {
            name: 'numeric string function OID',
            mutate: (value) => {
                Object.assign(value.functions[0], { oid: '100' });
            },
        },
        {
            name: 'nonpositive function OID',
            mutate: (value) => {
                value.functions[0].oid = 0;
            },
        },
        {
            name: 'noncanonical timestamp',
            mutate: (value) => {
                value.completedAt = '2026-10-07';
            },
        },
        {
            name: 'invalid authority hash',
            mutate: (value) => {
                value.preservedAuthoritySha256 = 'not-a-hash';
            },
        },
        {
            name: 'widened diagnostic claim',
            mutate: (value) => {
                value.dataDiagnostics.algorithm = 'cryptographic attestation';
            },
        },
        {
            name: 'missing protected data',
            mutate: (value) => {
                value.dataDiagnostics.after.pop();
            },
        },
        {
            name: 'duplicate data table',
            mutate: (value) => {
                value.dataDiagnostics.after[1] = { ...value.dataDiagnostics.after[0] };
            },
        },
        {
            name: 'negative protected count',
            mutate: (value) => {
                value.dataDiagnostics.after[5].count = -1;
            },
        },
        {
            name: 'unsafe count',
            mutate: (value) => {
                value.dataDiagnostics.after[0].count = Number.MAX_SAFE_INTEGER + 1;
            },
        },
        {
            name: 'noncanonical digest',
            mutate: (value) => {
                value.dataDiagnostics.after[0].digest += '\n';
            },
        },
        {
            name: 'coerced safety boolean',
            mutate: (value) => {
                Object.assign(value.safety, { cutoverSupportOnly: 'true' });
            },
        },
        {
            name: 'missing safety field',
            mutate: (value) => {
                delete value.safety.secretsPrinted;
            },
        },
        {
            name: 'extra safety field',
            mutate: (value) => {
                value.safety.customPermission = true;
            },
        },
        {
            name: 'account selection claim',
            mutate: (value) => {
                value.safety.accountProtectionSelected = true;
            },
        },
        {
            name: 'production change claim',
            mutate: (value) => {
                value.safety.productionTouched = true;
            },
        },
        {
            name: 'changed fixed statement',
            mutate: (value) => {
                value.statement = 'independently audited';
            },
        },
    ];
    it.each(invalid)('refuses $name for either support status', ({ mutate }) => {
        for (const status of ['applied', 'already-applied'] as const) {
            const value = receipt(status);
            mutate(value);
            expect(() => validateSupportReceipt(value, pins)).toThrow();
        }
    });

    it.each([
        { name: 'applied without delta', status: 'applied' as const, patch: { deltaSha256: null } },
        {
            name: 'applied without atomic check',
            status: 'applied' as const,
            patch: { atomicPrecommitInvariantsChecked: false },
        },
        {
            name: 'applied without table creation',
            status: 'applied' as const,
            patch: { newEmptyPolicyTableCreated: false },
        },
        {
            name: 'already-applied with delta',
            status: 'already-applied' as const,
            patch: { deltaSha256: sha256('delta') },
        },
        {
            name: 'already-applied with atomic check',
            status: 'already-applied' as const,
            patch: { atomicPrecommitInvariantsChecked: true },
        },
        {
            name: 'already-applied with table creation',
            status: 'already-applied' as const,
            patch: { newEmptyPolicyTableCreated: true },
        },
    ])('refuses inconsistent $name history', ({ status, patch }) => {
        const value = receipt(status);
        if ('deltaSha256' in patch) Object.assign(value, patch);
        else Object.assign(value.safety, patch);
        expect(() => validateSupportReceipt(value, pins)).toThrow();
    });

    it('requires old-five applied predata and identical all-six already-applied diagnostics', () => {
        const applied = receipt();
        applied.dataDiagnostics.before = clone(applied.dataDiagnostics.after);
        expect(() => validateSupportReceipt(applied, pins)).toThrow();
        const already = receipt('already-applied');
        already.dataDiagnostics.before.pop();
        expect(() => validateSupportReceipt(already, pins)).toThrow();
        const changed = receipt('already-applied');
        changed.dataDiagnostics.before[0].count += 1;
        expect(() => validateSupportReceipt(changed, pins)).toThrow();
    });

    it('returns an independent deeply frozen support receipt', () => {
        const input = receipt();
        const result = validateSupportReceipt(input, pins);
        const original = clone(result);
        input.functions[0].oid = 999;
        input.dataDiagnostics.after[5].count = 0;
        input.safety.cutoverSupportOnly = false;
        expect(result).toEqual(original);
        for (const object of [
            result,
            result.functions,
            result.functions[0],
            result.dataDiagnostics,
            result.dataDiagnostics.after,
            result.dataDiagnostics.after[5],
            result.safety,
        ])
            expect(Object.isFrozen(object)).toBe(true);
        expect(() => Object.assign(result.dataDiagnostics.after[5], { count: 0 })).toThrow();
    });
});

function inspection(fresh = receipt('inspected'), appliedInput = receipt(), suppliedPins = pins) {
    return validateInstalledInspection(fresh, validateSupportReceipt(appliedInput, suppliedPins), suppliedPins);
}
describe('fresh installed inspection binding — synthetic receipts', () => {
    it('accepts later legitimate data and authority diagnostics instead of restoring historical support data', () => {
        const historical = receipt();
        const fresh = receipt('inspected');
        fresh.dataDiagnostics.after[0].count += 2;
        fresh.dataDiagnostics.after[0].digest = md5('later old message rows');
        fresh.dataDiagnostics.after[5].count += 1;
        fresh.dataDiagnostics.after[5].digest = md5('later protected selections');
        fresh.dataDiagnostics.before = clone(fresh.dataDiagnostics.after);
        fresh.preservedAuthoritySha256 = sha256('later legitimate preserved state');
        const result = inspection(fresh, historical);
        expect(result.dataDiagnostics.after).toEqual(
            clone(fresh.dataDiagnostics.after).sort((a, b) => byteOrder(a.name, b.name)),
        );
        expect(result.preservedAuthoritySha256).toBe(fresh.preservedAuthoritySha256);
        expect(result.dataDiagnostics.after.find((row: DataRow) => row.name === 'protected_accounts').count).toBe(4);
        expect(result).not.toHaveProperty('producerAuthenticated');
    });

    it.each([
        {
            name: 'wrong operation',
            mutate: (value: Receipt) => {
                value.operation = 'apply-cutover';
            },
        },
        {
            name: 'wrong status',
            mutate: (value: Receipt) => {
                value.status = 'already-applied';
            },
        },
        {
            name: 'unexpected delta',
            mutate: (value: Receipt) => {
                value.deltaSha256 = sha256('delta');
            },
        },
        {
            name: 'atomic mutation claim',
            mutate: (value: Receipt) => {
                value.safety.atomicPrecommitInvariantsChecked = true;
            },
        },
        {
            name: 'table creation claim',
            mutate: (value: Receipt) => {
                value.safety.newEmptyPolicyTableCreated = true;
            },
        },
        {
            name: 'changed original function OID',
            mutate: (value: Receipt) => {
                value.functions[0].oid += 100;
            },
        },
        {
            name: 'different pre/post data',
            mutate: (value: Receipt) => {
                value.dataDiagnostics.before[0].count += 1;
            },
        },
    ])('refuses $name on fresh inspection', ({ mutate }) => {
        const fresh = receipt('inspected');
        mutate(fresh);
        expect(() => inspection(fresh)).toThrow();
    });

    it('copies and freezes fresh inspection without observing later input mutation', () => {
        const fresh = receipt('inspected');
        const result = inspection(fresh);
        fresh.functions[0].bodySha256 = sha256('changed');
        fresh.dataDiagnostics.after[5].count = 0;
        expect(result.functions[0].bodySha256).toBe(pinnedFunctions[0].bodySha256);
        expect(result.dataDiagnostics.after.find((row: DataRow) => row.name === 'protected_accounts').count).toBe(3);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.functions[0])).toBe(true);
        expect(Object.isFrozen(result.dataDiagnostics.after[5])).toBe(true);
    });
});

describe('closed receipt reflection and input pins', () => {
    it('refuses extra fields, accessors and hostile reflection without reading getters or exposing canaries', () => {
        const getter = vi.fn(() => 'applied');
        const accessor = receipt();
        Object.defineProperty(accessor, 'status', { get: getter, enumerable: true });
        const hostile = new Proxy(receipt(), {
            ownKeys() {
                throw new Error('private-deployment-canary');
            },
        });
        for (const value of [
            { ...receipt(), bearer: 'private-deployment-canary' },
            accessor,
            hostile,
            Object.assign(Object.create(null) as Record<string, unknown>, receipt()),
        ])
            expect(() => validateSupportReceipt(value, pins)).toThrow('Isolated cutover deployment unavailable');
        expect(getter).not.toHaveBeenCalled();
    });

    it('refuses sparse/accessor function arrays and duplicate target OIDs', () => {
        const sparse = receipt();
        delete sparse.functions[1];
        expect(() => validateSupportReceipt(sparse, pins)).toThrow();
        const accessor = receipt();
        const getter = vi.fn(() => accessor.functions[0]);
        Object.defineProperty(accessor.functions, '1', { get: getter, enumerable: true });
        expect(() => validateSupportReceipt(accessor, pins)).toThrow();
        expect(getter).not.toHaveBeenCalled();
        const duplicate = receipt();
        duplicate.functions[1].oid = duplicate.functions[0].oid;
        expect(() => validateSupportReceipt(duplicate, pins)).toThrow();
    });

    it('refuses changed project/source pins and baseline-function pins', () => {
        expect(() => validateSupportReceipt(receipt(), { ...pins, project: 'pcisdplnodrphauixcau' })).toThrow();
        expect(() =>
            validateSupportReceipt(receipt(), { ...pins, sourceSqlSha256: sha256('unreviewed source') }),
        ).toThrow();
        const baselinePins = clone(pins);
        baselinePins.functions[0].bodySha256 = definitions.targets.find(
            (target: { signature: string }) => target.signature === baselinePins.functions[0].signature,
        )!.baseline;
        expect(() => validateSupportReceipt(receipt(), baselinePins)).toThrow();
    });
});

describe('revision metadata normalization — no compiled-bundle attestation', () => {
    it('copies only six normalized fields, sorts slugs and freezes an independent result', () => {
        const raw = revisions();
        Object.assign(raw[0], { managementExtra: 'discarded-metadata-canary' });
        const result = normalizeRevisionSet(raw);
        const expected = raw
            .map(({ slug, id, version, status, verify_jwt, ezbr_sha256 }) => ({
                slug,
                id,
                version,
                status,
                verifyJwt: verify_jwt,
                bundleSha256: ezbr_sha256,
            }))
            .sort((a, b) => byteOrder(a.slug, b.slug));
        expect(result).toEqual(expected);
        expect(JSON.stringify(result)).not.toContain('discarded-metadata-canary');
        raw[0].version = 999;
        expect(result.find((item: { slug: string }) => item.slug === SLUG).version).toBe(8);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
    });

    it.each(['ACTIVE', 'REMOVED', 'THROTTLED'])('permits known %s status for another function', (status) => {
        const raw = revisions();
        raw[1].status = status;
        expect(normalizeRevisionSet(raw).find((item: { slug: string }) => item.slug !== SLUG).status).toBe(status);
    });

    it.each([
        {
            name: 'missing pilot',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw.shift();
            },
        },
        {
            name: 'duplicate slug',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[1].slug = raw[0].slug;
            },
        },
        {
            name: 'duplicate ID',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[1].id = raw[0].id;
            },
        },
        {
            name: 'pilot JWT disabled',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].verify_jwt = false;
            },
        },
        {
            name: 'pilot removed',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].status = 'REMOVED';
            },
        },
        {
            name: 'unknown status',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[1].status = 'DEPLOYED';
            },
        },
        {
            name: 'nil UUID',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].id = '00000000-0000-0000-0000-000000000000';
            },
        },
        {
            name: 'uppercase UUID',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].id = 'AAAAAAAA-1111-4111-8111-111111111111';
            },
        },
        {
            name: 'zero revision',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].version = 0;
            },
        },
        {
            name: 'fractional revision',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].version = 1.5;
            },
        },
        {
            name: 'coerced JWT boolean',
            mutate: (raw: ReturnType<typeof revisions>) => {
                Object.assign(raw[0], { verify_jwt: 'true' });
            },
        },
        {
            name: 'malformed bundle hash',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[0].ezbr_sha256 += '\n';
            },
        },
        {
            name: 'malformed slug',
            mutate: (raw: ReturnType<typeof revisions>) => {
                raw[1].slug = '../other';
            },
        },
    ])('refuses $name', ({ mutate }) => {
        const raw = revisions();
        mutate(raw);
        expect(() => normalizeRevisionSet(raw)).toThrow('Isolated cutover deployment unavailable');
    });

    it('does not invoke accessors even on extra management fields', () => {
        const raw = revisions();
        const getter = vi.fn(() => 'private-deployment-canary');
        Object.defineProperty(raw[0], 'extra', { get: getter, enumerable: true });
        expect(() => normalizeRevisionSet(raw)).toThrow('Isolated cutover deployment unavailable');
        expect(getter).not.toHaveBeenCalled();
    });
});

describe('secret digest fingerprint — synthetic metadata, hash output only', () => {
    it('is order independent and changes when an optional secret digest changes', () => {
        const raw = secretMetadata();
        const first = fingerprintSecretMetadata(raw);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintSecretMetadata([...raw].reverse())).toBe(first);
        raw[3].value = sha256('changed optional secret');
        expect(fingerprintSecretMetadata(raw)).not.toBe(first);
        expect(typeof first).toBe('string');
    });

    it.each(['SUPABASE_URL', 'E2EE_PILOT_DATABASE_URL', 'E2EE_PILOT_PARTICIPANTS'])(
        'refuses missing mandatory %s',
        (name) => {
            expect(() => fingerprintSecretMetadata(secretMetadata().filter((item) => item.name !== name))).toThrow();
        },
    );

    it.each([
        {
            name: 'wrong project URL digest',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw[0].value = sha256('https://wrong-project.supabase.co');
            },
        },
        {
            name: 'duplicate name',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw.push({ ...raw[1] });
            },
        },
        {
            name: 'plaintext value',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw[1].value = 'private-deployment-canary';
            },
        },
        {
            name: 'uppercase digest',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw[1].value = raw[1].value.toUpperCase();
            },
        },
        {
            name: 'trailing digest newline',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw[1].value += '\n';
            },
        },
        {
            name: 'invalid secret name',
            mutate: (raw: ReturnType<typeof secretMetadata>) => {
                raw[3].name = 'bad-name';
            },
        },
    ])('refuses $name without exposing raw values', ({ mutate }) => {
        const raw = secretMetadata();
        mutate(raw);
        expect(() => fingerprintSecretMetadata(raw)).toThrow('Isolated cutover deployment unavailable');
    });
});

function deploymentState(fresh = receipt('inspected'), support = receipt(), suppliedPins = pins) {
    return {
        inspection: inspection(fresh, support, suppliedPins),
        secretsFingerprint: fingerprintSecretMetadata(secretMetadata()),
        sourceHashes: {
            'hosted/cutoverDeployment.mjs': sha256(read('hosted/cutoverDeployment.mjs')),
            'hosted/updateCutover.mjs': pins.updaterSha256,
            'hosted/cutoverMigration.mjs': pins.migrationModuleSha256,
            'relay/relay.sql': SOURCE_SHA256,
        } as Record<string, string>,
    };
}
describe('fresh deployment interval preservation — all six data tables', () => {
    it('accepts independently validated unchanged inspections and ignores map insertion order', () => {
        const before = deploymentState(),
            after = deploymentState();
        after.sourceHashes = Object.fromEntries(Object.entries(after.sourceHashes).reverse());
        expect(assertDeploymentPreserved(before, after)).toBe(true);
        expect(before.inspection).not.toBe(after.inspection);
        expect(
            before.inspection.dataDiagnostics.after.find((row: DataRow) => row.name === 'protected_accounts').count,
        ).toBe(3);
    });

    it.each([...TABLES, 'protected_accounts'])(
        'refuses %s count or digest drift even with unchanged authority hash',
        (name: string) => {
            for (const field of ['count', 'digest']) {
                const fresh = receipt('inspected');
                const row = fresh.dataDiagnostics.after.find((item) => item.name === name)!;
                if (field === 'count') row.count += 1;
                else row.digest = md5(`changed ${name}`);
                fresh.dataDiagnostics.before = clone(fresh.dataDiagnostics.after);
                const before = deploymentState(),
                    after = deploymentState(fresh);
                expect(before.inspection.preservedAuthoritySha256).toBe(after.inspection.preservedAuthoritySha256);
                expect(() => assertDeploymentPreserved(before, after)).toThrow(
                    'Isolated cutover deployment unavailable',
                );
            }
        },
    );

    it('refuses resetting permanent policy rows to an empty table', () => {
        const fresh = receipt('inspected');
        const policy = fresh.dataDiagnostics.after.find((row) => row.name === 'protected_accounts')!;
        policy.count = 0;
        policy.digest = md5('');
        fresh.dataDiagnostics.before = clone(fresh.dataDiagnostics.after);
        expect(() => assertDeploymentPreserved(deploymentState(), deploymentState(fresh))).toThrow();
    });

    it('refuses catalog-authority and secret metadata changes', () => {
        const authority = receipt('inspected');
        authority.preservedAuthoritySha256 = sha256('changed catalog authority');
        expect(() => assertDeploymentPreserved(deploymentState(), deploymentState(authority))).toThrow();
        const secrets = deploymentState();
        secrets.secretsFingerprint = sha256('changed secret metadata');
        expect(() => assertDeploymentPreserved(deploymentState(), secrets)).toThrow();
    });

    it('refuses changed, added or removed source inventory entries', () => {
        for (const change of ['changed', 'added', 'removed']) {
            const after = deploymentState();
            if (change === 'changed') after.sourceHashes['hosted/updateCutover.mjs'] = sha256('changed bytes');
            else if (change === 'added') after.sourceHashes['hosted/unexpected.ts'] = sha256('unexpected file');
            else delete after.sourceHashes['hosted/updateCutover.mjs'];
            expect(() => assertDeploymentPreserved(deploymentState(), after)).toThrow();
        }
    });

    it('refuses function identity drift even when each inspection matches its own support receipt', () => {
        const support = receipt(),
            fresh = receipt('inspected');
        support.functions[0].oid += 100;
        fresh.functions[0].oid += 100;
        expect(() => assertDeploymentPreserved(deploymentState(), deploymentState(fresh, support))).toThrow();
    });

    it('refuses function-body drift under different internally consistent supplied pins', () => {
        const changedPins = clone(pins),
            support = receipt(),
            fresh = receipt('inspected');
        const digest = sha256('different supplied target body');
        changedPins.functions[0].bodySha256 = digest;
        support.functions[0].bodySha256 = digest;
        fresh.functions[0].bodySha256 = digest;
        expect(() =>
            assertDeploymentPreserved(deploymentState(), deploymentState(fresh, support, changedPins)),
        ).toThrow();
    });

    it.each(['updaterSha256', 'migrationModuleSha256'] as const)(
        'refuses receipt %s drift even when a supplied inventory omits that distinction',
        (field) => {
            const changedPins = { ...pins, [field]: sha256(`changed ${field}`) };
            const support = receipt(),
                fresh = receipt('inspected');
            support[field] = changedPins[field];
            fresh[field] = changedPins[field];
            const before = deploymentState(),
                after = deploymentState(fresh, support, changedPins);
            expect(after.sourceHashes).toEqual(before.sourceHashes);
            expect(() => assertDeploymentPreserved(before, after)).toThrow();
        },
    );

    it('requires an owned validated inspection rather than raw or cloned JSON', () => {
        const before = deploymentState(),
            after = deploymentState();
        expect(() => assertDeploymentPreserved(before, { ...after, inspection: receipt('inspected') })).toThrow();
        expect(() => assertDeploymentPreserved(before, { ...after, inspection: clone(after.inspection) })).toThrow();
        expect(() => assertDeploymentPreserved({ ...before, extra: true }, after)).toThrow();
    });

    it.each([
        { name: 'empty inventory', hashes: {} },
        { name: 'absolute path', hashes: { '/hosted/test.mjs': sha256('bytes') } },
        { name: 'parent path', hashes: { '../relay/relay.sql': sha256('bytes') } },
        { name: 'empty path component', hashes: { 'hosted//test.mjs': sha256('bytes') } },
        { name: 'invalid digest', hashes: { 'hosted/test.mjs': 'private-deployment-canary' } },
    ])('refuses $name', ({ hashes }) => {
        const before = deploymentState(),
            after = deploymentState();
        expect(() => assertDeploymentPreserved(before, { ...after, sourceHashes: hashes })).toThrow();
    });
});

// @vitest-environment node
/**
 * Pure source/catalog fixtures only. No PostgreSQL, CLI, hosted connection,
 * credentials, deployment, human account or independent security evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    SOURCE_SHA256,
    TABLES,
    TARGETS,
    classifySnapshot,
    extractDefinitions,
    guardedDelta,
    preserved,
    validateSnapshot,
} from '../experiments/scuttlebutt-e2ee/hosted/cutoverMigration.mjs';

const SOURCE = readFileSync(new NodeURL('../experiments/scuttlebutt-e2ee/relay/relay.sql', import.meta.url), 'utf8');
const PINNED_SOURCE_SHA256 = '15236d599574be3a087859b4ff60ba4acb2b0ed89559def4de6aa9cc5c933c01';
// Independent pins copied from the existing policy updater's approved target,
// not recalculated from the new cutover module's baseline declarations.
const BASELINE_SHA256: Record<string, string> = {
    parse_request: '786eaa38c2fd7d401a216c3c884e1e14a0d22b06fba4927a1f8f11afa54f1870',
    parse_request_payload: 'd667b1e7df629208ff6c152a97fb723ae0c4b1d90d1eeb7b39518567f02b7e77',
    execute_request: 'd5c5f2344583514692da2e59488af2b57476d46f503dce288c4e1a615c9a632c',
};
const HELPER_DEFINITION = `CREATE FUNCTION e2ee_research.requires_protected(actor text) RETURNS boolean
LANGUAGE sql VOLATILE STRICT SET search_path = pg_catalog
AS $$ SELECT EXISTS (SELECT 1 FROM e2ee_research.protected_accounts WHERE owner_id = actor) $$;`;
const TABLE_DEFINITION = `CREATE TABLE e2ee_research.protected_accounts (
    owner_id e2ee_research.identifier PRIMARY KEY,
    selecting_device_id e2ee_research.identifier NOT NULL,
    selecting_request_id e2ee_research.identifier NOT NULL,
    selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (owner_id, selecting_device_id) REFERENCES e2ee_research.devices(user_id, device_id)
);`;
const DEFINITIONS = extractDefinitions(SOURCE);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function baselineBody(name: string, body: string): string {
    if (name === 'parse_request') return body.replace("'policy','require-protected','account-mode'", "'policy'");
    if (name === 'parse_request_payload')
        return body.replace("WHEN 'revoke', 'require-protected', 'account-mode' THEN", "WHEN 'revoke' THEN");
    if (name !== 'execute_request') throw new Error('Unknown synthetic target');
    return body
        .replace(/ {4}IF action = 'account-mode' THEN[\s\S]*?(?= {4}IF action = 'policy' THEN)/, '')
        .replace('-- Send/block/revoke/cutover receipts', '-- Send/block/revoke receipts')
        .replace(/ {4}-- The bounded 512-mutation\/request pilot budget[\s\S]*?(?= {4}IF NOT FOUND)/, '')
        .replace(/ {4}WHEN 'require-protected' THEN[\s\S]*?(?= {4}WHEN 'revoke' THEN)/, '');
}

type Grant = { grantee: string; grantor: string; privilege: string; grantable: boolean };
type CatalogRow = Record<string, unknown>;
type FunctionSnapshot = {
    oid: number;
    name: string;
    signature: string;
    owner: string;
    acl: string | null;
    grants: Grant[];
    securityDefiner: boolean;
    configuration: string[];
    volatility: string;
    language: string;
    result: string;
    arguments: string;
    argumentNames: string[];
    strict: boolean;
    leakproof: boolean;
    parallel: string;
    kind: string;
    returnsSet: boolean;
    cost: number;
    rows: number;
    body?: string;
    bodyDigest?: string;
};
type Relation = {
    oid: number;
    name: string;
    kind: string;
    owner: string;
    acl: string | null;
    grants: Grant[];
    rls: boolean;
    forceRls: boolean;
    persistence: string;
    options: null;
    replicaIdentity: string;
    tablespace: number;
    hasTriggers: boolean;
    checkCount: number;
};
type Column = {
    tableOid: number;
    tableName: string;
    name: string;
    position: number;
    type: string;
    typeOid: number;
    typeModifier: number;
    notNull: boolean;
    identity: string;
    generated: string;
    collation: string | null;
    default: string | null;
    acl: string | null;
    grants: Grant[];
};
type Constraint = {
    oid: number;
    name: string;
    tableName: string | null;
    type: string;
    columns: string[];
    referencedSchema: string | null;
    referencedTable: string | null;
    referencedColumns: string[];
    deleteAction: string;
    updateAction: string;
    matchType: string;
    validated: boolean;
    deferrable: boolean;
    deferred: boolean;
    definition: string;
};
type Index = {
    oid: number;
    tableOid: number;
    tableName: string;
    name: string;
    method: string;
    unique: boolean;
    primary: boolean;
    valid: boolean;
    ready: boolean;
    live: boolean;
    exclusion: boolean;
    columns: string[];
    expressions: string | null;
    predicate: string | null;
    definition: string;
};
type Trigger = {
    oid: number;
    tableName: string;
    name: string;
    function: string;
    internal: boolean;
    enabled: string;
    type: number;
    constraintOid: number;
    definition: string;
};
type Snapshot = {
    functions: FunctionSnapshot[];
    otherFunctions: FunctionSnapshot[];
    schema: { oid: number; owner: string; acl: string | null; grants: Grant[] };
    relations: Relation[];
    constraints: Constraint[];
    policies: CatalogRow[];
    roles: CatalogRow[];
    memberships: CatalogRow[];
    data: { name: string; count: number; digest: string }[];
    privileges: Record<string, boolean>;
    columns: Column[];
    indexes: Index[];
    triggers: Trigger[];
    domains: CatalogRow[];
    defaultAcls: CatalogRow[];
};
type Definition = {
    name: string;
    signature: string;
    immutable: boolean;
    arguments: string;
    argumentNames: readonly string[];
    body: string;
    target: string;
    baseline: string;
    replacement: string;
};
const OWNER = 'e2ee_research_owner';
const GATEWAY = 'e2ee_research_gateway';
const NEW_TABLE = 'protected_accounts';
const NEW_PK = 'protected_accounts_pkey';
const NEW_FK = 'protected_accounts_owner_id_selecting_device_id_fkey';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const grant = (privilege: string, grantee = OWNER): Grant => ({
    grantee,
    grantor: OWNER,
    privilege,
    grantable: false,
});
const ownerTableGrants = () =>
    ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map((name) => grant(name));

function functionMetadata(name: string, oid: number): FunctionSnapshot {
    return {
        oid,
        name,
        signature: `e2ee_research.${name}(text)`,
        owner: OWNER,
        acl: `{${OWNER}=X/${OWNER}}`,
        grants: [grant('EXECUTE')],
        securityDefiner: false,
        configuration: ['search_path=pg_catalog'],
        volatility: 'v',
        language: 'plpgsql',
        result: 'jsonb',
        arguments: 'value text',
        argumentNames: ['value'],
        strict: false,
        leakproof: false,
        parallel: 'u',
        kind: 'f',
        returnsSet: false,
        cost: 100,
        rows: 0,
    };
}
function relation(name: string, oid: number, kind = 'r'): Relation {
    return {
        oid,
        name,
        kind,
        owner: OWNER,
        acl: kind === 'r' ? `{${OWNER}=arwdDxt/${OWNER}}` : null,
        grants: kind === 'r' ? ownerTableGrants() : [],
        rls: kind === 'r',
        forceRls: false,
        persistence: 'p',
        options: null,
        replicaIdentity: kind === 'r' ? 'd' : 'n',
        tablespace: 0,
        hasTriggers: kind === 'r',
        checkCount: 0,
    };
}
function column(tableName: string, tableOid: number, name: string, position: number): Column {
    return {
        tableOid,
        tableName,
        name,
        position,
        type: 'e2ee_research.identifier',
        typeOid: 900,
        typeModifier: -1,
        notNull: true,
        identity: '',
        generated: '',
        collation: 'pg_catalog.C',
        default: null,
        acl: null,
        grants: [],
    };
}
function primaryKey(tableName: string, oid: number, name = `${tableName}_pkey`): Constraint {
    return {
        oid,
        name,
        tableName,
        type: 'p',
        columns: ['owner_id'],
        referencedSchema: null,
        referencedTable: null,
        referencedColumns: [],
        deleteAction: ' ',
        updateAction: ' ',
        matchType: ' ',
        validated: true,
        deferrable: false,
        deferred: false,
        definition: 'PRIMARY KEY (owner_id)',
    };
}
function notNullConstraint(tableName: string, name: string, oid: number): Constraint {
    return {
        ...primaryKey(tableName, oid, `${tableName}_${name}_not_null`),
        type: 'n',
        columns: [name],
        definition: `NOT NULL ${name}`,
    };
}
function newNotNullConstraints(): Constraint[] {
    return ['owner_id', 'selecting_device_id', 'selecting_request_id', 'selected_at'].map((name, i) =>
        notNullConstraint(NEW_TABLE, name, 610 + i),
    );
}
function index(tableName: string, tableOid: number, oid: number): Index {
    return {
        oid,
        tableOid,
        tableName,
        name: `${tableName}_pkey`,
        method: 'btree',
        unique: true,
        primary: true,
        valid: true,
        ready: true,
        live: true,
        exclusion: false,
        columns: ['owner_id'],
        expressions: null,
        predicate: null,
        definition: `CREATE UNIQUE INDEX ${tableName}_pkey ON e2ee_research.${tableName} USING btree (owner_id)`,
    };
}
function trigger(tableName: string, constraintOid: number, oid: number): Trigger {
    return {
        oid,
        tableName,
        name: `RI_ConstraintTrigger_fixture_${oid}`,
        function: 'pg_catalog."RI_FKey_check_ins"()',
        internal: true,
        enabled: 'O',
        type: 5,
        constraintOid,
        definition: `synthetic internal FK trigger ${oid}`,
    };
}
function baselineSnapshot(): Snapshot {
    const functions = DEFINITIONS.targets
        .map(
            (target: Definition, index: number): FunctionSnapshot => ({
                ...functionMetadata(target.name, 100 + index),
                signature: target.signature,
                securityDefiner: !target.immutable,
                volatility: target.immutable ? 'i' : 'v',
                arguments: target.arguments,
                argumentNames: [...target.argumentNames],
                grants: target.immutable ? [grant('EXECUTE')] : [grant('EXECUTE'), grant('EXECUTE', GATEWAY)],
                body: baselineBody(target.name, target.body),
            }),
        )
        .sort((a: FunctionSnapshot, b: FunctionSnapshot) => a.signature.localeCompare(b.signature));
    const names = DEFINITIONS.functionNames.filter(
        (name: string) =>
            name !== 'requires_protected' && !TARGETS.some((target: { name: string }) => target.name === name),
    );
    return {
        functions,
        // These unchanged old catalog entries are synthetic; only the three
        // authority-bearing target bodies use independent approved SHA256 pins.
        otherFunctions: names
            .map((name: string, index: number) => ({
                ...functionMetadata(name, 200 + index),
                bodyDigest: md5(`synthetic old ${name}`),
            }))
            .sort((a: FunctionSnapshot, b: FunctionSnapshot) => a.signature.localeCompare(b.signature)),
        schema: {
            oid: 90,
            owner: OWNER,
            acl: null,
            grants: [grant('USAGE'), grant('CREATE'), grant('USAGE', GATEWAY)],
        },
        relations: TABLES.map((name: string, i: number) => relation(name, 300 + i)),
        constraints: [primaryKey('devices', 500)],
        policies: [],
        roles: [OWNER, GATEWAY, 'e2ee_pilot_edge'].map((name, i) => ({
            oid: 10 + i,
            name,
            login: name === 'e2ee_pilot_edge',
            super: false,
            createRole: false,
            createDb: false,
            bypassRls: false,
            inherit: false,
            connectionLimit: name === 'e2ee_pilot_edge' ? 2 : -1,
            configuration:
                name === 'e2ee_pilot_edge'
                    ? ['search_path=pg_catalog', 'statement_timeout=4s', 'lock_timeout=1s']
                    : null,
        })),
        memberships: [
            { role: GATEWAY, member: 'e2ee_pilot_edge', grantor: 'postgres', admin: false, inherit: false, set: true },
        ],
        data: TABLES.map((name: string, i: number) => ({
            name,
            count: i + 1,
            digest: md5(`synthetic old rows ${name}`),
        })),
        privileges: {
            signedOnly: true,
            tablesClosed: true,
            columnsClosed: true,
            sequencesClosed: true,
            publicClosed: true,
            schemaClosed: true,
            gatewaySet: true,
            ownerForbidden: true,
        },
        columns: TABLES.map((name: string, i: number) => column(name, 300 + i, 'owner_id', 1)),
        indexes: [index('devices', 300, 400)],
        triggers: [trigger('devices', 499, 700)],
        domains: [
            {
                oid: 900,
                name: 'identifier',
                owner: OWNER,
                baseType: 'text',
                typeModifier: -1,
                notNull: false,
                collation: 'pg_catalog.C',
                default: null,
                acl: null,
            },
        ],
        defaultAcls: [
            { oid: 901, owner: OWNER, schema: 'e2ee_research', objectType: 'f', acl: `{${OWNER}=X/${OWNER}}` },
        ],
    };
}
function installedSnapshot(): Snapshot {
    const state = baselineSnapshot();
    for (const fn of state.functions) {
        const target = DEFINITIONS.targets.find((value: Definition) => value.signature === fn.signature)!;
        fn.body = target.body;
    }
    state.otherFunctions.push({
        ...functionMetadata('requires_protected', 250),
        signature: 'e2ee_research.requires_protected(text)',
        language: 'sql',
        result: 'boolean',
        arguments: 'actor text',
        argumentNames: ['actor'],
        strict: true,
        body: DEFINITIONS.helper.body,
        bodyDigest: md5(DEFINITIONS.helper.body),
    });
    state.otherFunctions.sort((a, b) => a.signature.localeCompare(b.signature));
    state.relations.push(relation(NEW_TABLE, 350), relation(NEW_PK, 450, 'i'));
    state.columns.push(
        ...['owner_id', 'selecting_device_id', 'selecting_request_id', 'selected_at'].map((name, i) => ({
            ...column(NEW_TABLE, 350, name, i + 1),
            ...(i === 3
                ? { type: 'timestamp with time zone', typeOid: 1184, collation: null, default: 'clock_timestamp()' }
                : {}),
        })),
    );
    state.constraints.push(
        {
            oid: 600,
            name: NEW_FK,
            tableName: NEW_TABLE,
            type: 'f',
            columns: ['owner_id', 'selecting_device_id'],
            referencedSchema: 'e2ee_research',
            referencedTable: 'devices',
            referencedColumns: ['user_id', 'device_id'],
            deleteAction: 'a',
            updateAction: 'a',
            matchType: 's',
            validated: true,
            deferrable: false,
            deferred: false,
            definition:
                'FOREIGN KEY (owner_id, selecting_device_id) REFERENCES e2ee_research.devices(user_id, device_id)',
        },
        primaryKey(NEW_TABLE, 601),
    );
    state.indexes.push(index(NEW_TABLE, 350, 450));
    state.triggers.push(
        trigger(NEW_TABLE, 600, 710),
        trigger(NEW_TABLE, 600, 711),
        trigger('devices', 600, 712),
        trigger('devices', 600, 713),
    );
    state.data.push({ name: NEW_TABLE, count: 0, digest: EMPTY_MD5 });
    return state;
}

describe('isolated cutover source pin — pure fixtures', () => {
    it('pins the real relay bytes and the exact three already-approved baseline hashes', () => {
        expect(SOURCE_SHA256).toBe(PINNED_SOURCE_SHA256);
        expect(sha256(SOURCE)).toBe(PINNED_SOURCE_SHA256);
        expect(TABLES).toEqual(['devices', 'blocks', 'claims', 'decisions', 'requests']);
        expect(
            Object.fromEntries(
                TARGETS.map((target: { name: string; baseline: string }) => [target.name, target.baseline]),
            ),
        ).toEqual(BASELINE_SHA256);
    });

    it.each(Object.keys(BASELINE_SHA256))('reconstructs independently pinned baseline body for %s', (name) => {
        const target = DEFINITIONS.targets.find((value: { name: string }) => value.name === name)!;
        expect(target).toBeDefined();
        expect(sha256(baselineBody(name, target.body))).toBe(BASELINE_SHA256[name]);
        expect(sha256(target.body)).toBe(target.target);
        expect(target.replacement).toMatch(new RegExp(`^CREATE OR REPLACE FUNCTION e2ee_research\\.${name}\\(`));
        expect(target.replacement.match(/^CREATE OR REPLACE FUNCTION /gm)).toHaveLength(1);
    });

    it('extracts only the exact table, internal helper and three function replacements', () => {
        expect(
            DEFINITIONS.targets.map((target: { name: string; signature: string; immutable: boolean }) => ({
                name: target.name,
                signature: target.signature,
                immutable: target.immutable,
            })),
        ).toEqual([
            { name: 'parse_request', signature: 'e2ee_research.parse_request(text)', immutable: true },
            {
                name: 'parse_request_payload',
                signature: 'e2ee_research.parse_request_payload(text,text)',
                immutable: true,
            },
            {
                name: 'execute_request',
                signature: 'e2ee_research.execute_request(text,text,text,text,text,bigint,text)',
                immutable: false,
            },
        ]);
        expect(DEFINITIONS.helper.name).toBe('requires_protected');
        expect(DEFINITIONS.helper.signature).toBe('e2ee_research.requires_protected(text)');
        expect(DEFINITIONS.helper.definition).toBe(HELPER_DEFINITION);
        expect(sha256(DEFINITIONS.helper.body)).toBe(DEFINITIONS.helper.target);
        expect(DEFINITIONS.table.definition).toBe(TABLE_DEFINITION);
        expect(DEFINITIONS.functionNames).toHaveLength(21);
        expect(new Set(DEFINITIONS.functionNames).size).toBe(21);
    });

    it.each([
        { name: 'extra newline', change: (source: string) => `${source}\n` },
        {
            name: 'changed framing comment',
            change: (source: string) => source.replace('ISOLATED RESEARCH ONLY', 'changed'),
        },
        {
            name: 'changed helper volatility',
            change: (source: string) => source.replace('LANGUAGE sql VOLATILE STRICT', 'LANGUAGE sql STABLE STRICT'),
        },
        {
            name: 'changed table default',
            change: (source: string) =>
                source.replace(
                    'selected_at timestamptz NOT NULL DEFAULT clock_timestamp()',
                    'selected_at timestamptz NOT NULL DEFAULT now()',
                ),
        },
        {
            name: 'widened table grant',
            change: (source: string) => `${source}GRANT SELECT ON e2ee_research.protected_accounts TO PUBLIC;\n`,
        },
        { name: 'duplicate parser', change: (source: string) => `${source}\n${DEFINITIONS.targets[0].replacement}` },
    ])('refuses $name before constructing an executable delta', ({ change }) => {
        expect(() => extractDefinitions(change(SOURCE))).toThrow();
    });
});

const helper = (state: Snapshot) => state.otherFunctions.find((fn) => fn.name === 'requires_protected')!;
const table = (state: Snapshot) => state.relations.find((item) => item.name === NEW_TABLE)!;
const fk = (state: Snapshot) => state.constraints.find((item) => item.name === NEW_FK)!;
const newColumn = (state: Snapshot) => state.columns.find((item) => item.tableName === NEW_TABLE)!;
type Mutation = { name: string; mutate: (state: Snapshot) => void };

describe('closed baseline and installed catalog shapes — synthetic snapshots', () => {
    it.each(['baseline', 'installed'] as const)('accepts only a complete %s shape and does not mutate it', (kind) => {
        const state = kind === 'baseline' ? baselineSnapshot() : installedSnapshot();
        const original = JSON.stringify(state);
        expect(classifySnapshot(state, DEFINITIONS)).toBe(kind);
        expect(validateSnapshot(state, DEFINITIONS)).toBe(kind);
        expect(state.functions.length + state.otherFunctions.length).toBe(kind === 'baseline' ? 20 : 21);
        expect(state.relations.filter((item) => item.kind === 'r')).toHaveLength(kind === 'baseline' ? 5 : 6);
        expect(JSON.stringify(state)).toBe(original);
    });

    it('accepts existing protected selections on inspection and never generates a second installation', () => {
        const state = installedSnapshot();
        state.data.find((item) => item.name === NEW_TABLE)!.count = 2;
        expect(classifySnapshot(state, DEFINITIONS)).toBe('installed');
        expect(() => guardedDelta(state, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
    });

    it('permits only the owner nongrantable PG17 MAINTAIN addition without changing its snapshot', () => {
        const state = installedSnapshot();
        table(state).grants.push(grant('MAINTAIN'));
        const original = JSON.stringify(state);
        expect(classifySnapshot(state, DEFINITIONS)).toBe('installed');
        expect(JSON.stringify(state)).toBe(original);
    });

    const malformed: Mutation[] = [
        {
            name: 'missing target',
            mutate: (state) => {
                state.functions.pop();
            },
        },
        {
            name: 'duplicate target signature',
            mutate: (state) => {
                state.functions[1] = { ...state.functions[0] };
            },
        },
        {
            name: 'unknown body',
            mutate: (state) => {
                state.functions[0].body = `${state.functions[0].body}\n-- private-body-canary`;
            },
        },
        {
            name: 'numeric string OID',
            mutate: (state) => {
                Object.assign(state.functions[0], { oid: '100' });
            },
        },
        {
            name: 'wrong target owner',
            mutate: (state) => {
                state.functions[0].owner = 'postgres';
            },
        },
        {
            name: 'changed security definer',
            mutate: (state) => {
                state.functions[0].securityDefiner = !state.functions[0].securityDefiner;
            },
        },
        {
            name: 'widened search path',
            mutate: (state) => {
                state.functions[0].configuration = ['search_path=public,pg_catalog'];
            },
        },
        {
            name: 'changed target arguments',
            mutate: (state) => {
                state.functions[0].arguments = 'actor text';
            },
        },
        {
            name: 'changed target argument names',
            mutate: (state) => {
                state.functions[0].argumentNames = ['actor'];
            },
        },
        {
            name: 'target set result',
            mutate: (state) => {
                state.functions[0].returnsSet = true;
            },
        },
        {
            name: 'target strictness',
            mutate: (state) => {
                state.functions[0].strict = true;
            },
        },
        {
            name: 'open column privilege',
            mutate: (state) => {
                state.privileges.columnsClosed = false;
            },
        },
        {
            name: 'extra privilege field',
            mutate: (state) => {
                state.privileges.customPermit = true;
            },
        },
        {
            name: 'duplicate role',
            mutate: (state) => {
                state.roles[1] = { ...state.roles[0] };
            },
        },
        {
            name: 'privileged edge role',
            mutate: (state) => {
                state.roles[2].bypassRls = true;
            },
        },
        {
            name: 'owner login',
            mutate: (state) => {
                state.roles[0].login = true;
            },
        },
        {
            name: 'wrong edge connection limit',
            mutate: (state) => {
                state.roles[2].connectionLimit = -1;
            },
        },
        {
            name: 'missing old table',
            mutate: (state) => {
                state.relations = state.relations.filter((item) => item.name !== 'blocks');
            },
        },
        {
            name: 'open old table RLS',
            mutate: (state) => {
                state.relations[0].rls = false;
            },
        },
        {
            name: 'unapproved old function',
            mutate: (state) => {
                state.otherFunctions[0].name = 'unapproved';
            },
        },
        {
            name: 'invalid old function digest',
            mutate: (state) => {
                state.otherFunctions[0].bodyDigest = 'ciphertext-canary';
            },
        },
        {
            name: 'missing identifier domain',
            mutate: (state) => {
                state.domains = [];
            },
        },
        {
            name: 'invalid domain OID',
            mutate: (state) => {
                state.domains[0].oid = 0;
            },
        },
        {
            name: 'negative row count',
            mutate: (state) => {
                state.data[0].count = -1;
            },
        },
        {
            name: 'unsafe row count',
            mutate: (state) => {
                state.data[0].count = Number.MAX_SAFE_INTEGER + 1;
            },
        },
        {
            name: 'invalid data digest',
            mutate: (state) => {
                state.data[0].digest = 'not-a-digest';
            },
        },
        {
            name: 'duplicate data table',
            mutate: (state) => {
                state.data[1] = { ...state.data[0] };
            },
        },
        {
            name: 'custom trigger',
            mutate: (state) => {
                state.triggers[0].internal = false;
            },
        },
    ];
    it.each(malformed)('refuses $name in either complete shape', ({ mutate }) => {
        for (const state of [baselineSnapshot(), installedSnapshot()]) {
            mutate(state);
            expect(() => classifySnapshot(state, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
        }
    });

    it.each([
        'functions',
        'otherFunctions',
        'schema',
        'relations',
        'constraints',
        'policies',
        'roles',
        'memberships',
        'data',
        'privileges',
        'columns',
        'indexes',
        'triggers',
        'domains',
        'defaultAcls',
    ])('refuses missing or null top-level %s instead of defaulting catalog evidence', (field) => {
        const missing: CatalogRow = { ...baselineSnapshot() };
        delete missing[field];
        expect(() => classifySnapshot(missing, DEFINITIONS)).toThrow();
        expect(() => classifySnapshot({ ...baselineSnapshot(), [field]: null }, DEFINITIONS)).toThrow();
    });

    it('refuses widened, inherited and array snapshot framing', () => {
        expect(() => classifySnapshot({ ...baselineSnapshot(), extra: true }, DEFINITIONS)).toThrow();
        expect(() => classifySnapshot(Object.create(baselineSnapshot()), DEFINITIONS)).toThrow();
        expect(() => classifySnapshot([baselineSnapshot()], DEFINITIONS)).toThrow();
    });

    it.each(Object.keys(BASELINE_SHA256))('refuses a mixed body version for %s', (name) => {
        const state = installedSnapshot();
        const current = state.functions.find((fn) => fn.name === name)!;
        current.body = baselineBody(name, current.body!);
        expect(() => classifySnapshot(state, DEFINITIONS)).toThrow();
    });

    const partials: Mutation[] = [
        {
            name: 'new bodies without catalog additions',
            mutate: (state) => {
                for (const fn of state.functions)
                    fn.body = DEFINITIONS.targets.find((target: Definition) => target.signature === fn.signature)!.body;
            },
        },
        {
            name: 'orphan new table',
            mutate: (state) => {
                state.relations.push(relation(NEW_TABLE, 350));
            },
        },
        {
            name: 'orphan new index relation',
            mutate: (state) => {
                state.relations.push(relation(NEW_PK, 450, 'i'));
            },
        },
        {
            name: 'orphan new helper',
            mutate: (state) => {
                state.otherFunctions.push(helper(installedSnapshot()));
            },
        },
        {
            name: 'orphan new columns',
            mutate: (state) => {
                state.columns.push(newColumn(installedSnapshot()));
            },
        },
        {
            name: 'orphan new FK',
            mutate: (state) => {
                state.constraints.push(fk(installedSnapshot()));
            },
        },
        {
            name: 'orphan new index metadata',
            mutate: (state) => {
                state.indexes.push(index(NEW_TABLE, 350, 450));
            },
        },
        {
            name: 'orphan new trigger',
            mutate: (state) => {
                state.triggers.push(trigger(NEW_TABLE, 600, 710));
            },
        },
    ];
    it.each(partials)('refuses baseline with $name', ({ mutate }) => {
        const state = baselineSnapshot();
        mutate(state);
        expect(() => classifySnapshot(state, DEFINITIONS)).toThrow();
        expect(() => guardedDelta(state, DEFINITIONS)).toThrow();
    });
});

describe('exact protected account additions — synthetic installed catalog', () => {
    const invalidAdditions: Mutation[] = [
        {
            name: 'missing helper',
            mutate: (state) => {
                state.otherFunctions = state.otherFunctions.filter((fn) => fn.name !== 'requires_protected');
            },
        },
        {
            name: 'definer helper',
            mutate: (state) => {
                helper(state).securityDefiner = true;
            },
        },
        {
            name: 'stable helper',
            mutate: (state) => {
                helper(state).volatility = 's';
            },
        },
        {
            name: 'nonstrict helper',
            mutate: (state) => {
                helper(state).strict = false;
            },
        },
        {
            name: 'wrong helper language',
            mutate: (state) => {
                helper(state).language = 'plpgsql';
            },
        },
        {
            name: 'wrong helper result',
            mutate: (state) => {
                helper(state).result = 'jsonb';
            },
        },
        {
            name: 'changed helper body',
            mutate: (state) => {
                helper(state).body = ' SELECT true ';
            },
        },
        {
            name: 'changed helper digest',
            mutate: (state) => {
                helper(state).bodyDigest = md5('changed');
            },
        },
        {
            name: 'gateway helper grant',
            mutate: (state) => {
                helper(state).grants.push(grant('EXECUTE', GATEWAY));
            },
        },
        {
            name: 'public helper grant',
            mutate: (state) => {
                helper(state).grants.push(grant('EXECUTE', 'PUBLIC'));
            },
        },
        {
            name: 'grantable helper owner',
            mutate: (state) => {
                helper(state).grants[0].grantable = true;
            },
        },
        {
            name: 'open table RLS',
            mutate: (state) => {
                table(state).rls = false;
            },
        },
        {
            name: 'forced table RLS',
            mutate: (state) => {
                table(state).forceRls = true;
            },
        },
        {
            name: 'public table grant',
            mutate: (state) => {
                table(state).grants.push(grant('SELECT', 'PUBLIC'));
            },
        },
        {
            name: 'nonowner MAINTAIN',
            mutate: (state) => {
                table(state).grants.push(grant('MAINTAIN', GATEWAY));
            },
        },
        {
            name: 'grantable MAINTAIN',
            mutate: (state) => {
                table(state).grants.push({ ...grant('MAINTAIN'), grantable: true });
            },
        },
        {
            name: 'wrong MAINTAIN grantor',
            mutate: (state) => {
                table(state).grants.push({ ...grant('MAINTAIN'), grantor: 'postgres' });
            },
        },
        {
            name: 'missing table triggers flag',
            mutate: (state) => {
                table(state).hasTriggers = false;
            },
        },
        {
            name: 'extra table column',
            mutate: (state) => {
                state.columns.push(column(NEW_TABLE, 350, 'preview', 5));
            },
        },
        {
            name: 'wrong column type',
            mutate: (state) => {
                newColumn(state).type = 'text';
            },
        },
        {
            name: 'wrong column domain OID',
            mutate: (state) => {
                newColumn(state).typeOid = 25;
            },
        },
        {
            name: 'wrong column table OID',
            mutate: (state) => {
                newColumn(state).tableOid = 300;
            },
        },
        {
            name: 'nullable owner column',
            mutate: (state) => {
                newColumn(state).notNull = false;
            },
        },
        {
            name: 'changed identifier collation',
            mutate: (state) => {
                newColumn(state).collation = 'pg_catalog.default';
            },
        },
        {
            name: 'column grant',
            mutate: (state) => {
                newColumn(state).grants.push(grant('SELECT', GATEWAY));
            },
        },
        {
            name: 'changed selection clock',
            mutate: (state) => {
                state.columns.find((item) => item.name === 'selected_at')!.default = 'now()';
            },
        },
        {
            name: 'cascading FK delete',
            mutate: (state) => {
                fk(state).deleteAction = 'c';
            },
        },
        {
            name: 'cascading FK update',
            mutate: (state) => {
                fk(state).updateAction = 'c';
            },
        },
        {
            name: 'wrong FK target',
            mutate: (state) => {
                fk(state).referencedTable = 'requests';
            },
        },
        {
            name: 'reversed FK columns',
            mutate: (state) => {
                fk(state).columns.reverse();
            },
        },
        {
            name: 'unvalidated FK',
            mutate: (state) => {
                fk(state).validated = false;
            },
        },
        {
            name: 'deferrable FK',
            mutate: (state) => {
                fk(state).deferrable = true;
            },
        },
        {
            name: 'extra table constraint',
            mutate: (state) => {
                state.constraints.push(primaryKey(NEW_TABLE, 602, 'unexpected_constraint'));
            },
        },
        {
            name: 'missing primary index',
            mutate: (state) => {
                state.indexes.pop();
            },
        },
        {
            name: 'wrong index relation OID',
            mutate: (state) => {
                state.indexes[1].oid = 999;
            },
        },
        {
            name: 'wrong index table OID',
            mutate: (state) => {
                state.indexes[1].tableOid = 300;
            },
        },
        {
            name: 'nonunique primary index',
            mutate: (state) => {
                state.indexes[1].unique = false;
            },
        },
        {
            name: 'index predicate',
            mutate: (state) => {
                state.indexes[1].predicate = 'owner_id IS NOT NULL';
            },
        },
        {
            name: 'new table policy',
            mutate: (state) => {
                state.policies.push({ tablename: NEW_TABLE, policyname: 'unexpected_client_policy' });
            },
        },
        {
            name: 'missing device-side FK trigger',
            mutate: (state) => {
                state.triggers.pop();
            },
        },
        {
            name: 'disabled new FK trigger',
            mutate: (state) => {
                state.triggers[1].enabled = 'D';
            },
        },
        {
            name: 'wrong trigger FK binding',
            mutate: (state) => {
                state.triggers[1].constraintOid = 499;
            },
        },
    ];
    it.each(invalidAdditions)('refuses $name', ({ mutate }) => {
        const state = installedSnapshot();
        mutate(state);
        expect(() => classifySnapshot(state, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
    });
});

describe('PostgreSQL 18 NOT NULL catalog constraints — synthetic snapshots', () => {
    it.each([0, 4])(
        'accepts %i complete new NOT NULL records with exact old-state preservation and guarded generation',
        (count) => {
            const before = baselineSnapshot(),
                after = installedSnapshot();
            if (count === 4) {
                before.constraints.push(notNullConstraint('devices', 'owner_id', 510));
                after.constraints.push(notNullConstraint('devices', 'owner_id', 510), ...newNotNullConstraints());
            }
            expect(classifySnapshot(before, DEFINITIONS)).toBe('baseline');
            expect(classifySnapshot(after, DEFINITIONS)).toBe('installed');
            expect(after.constraints.filter((item) => item.tableName === NEW_TABLE && item.type === 'n')).toHaveLength(
                count,
            );
            expect(preserved(after)).toEqual(preserved(before));
            expect(preserved(after).constraints).toEqual(before.constraints);
            const delta = guardedDelta(before, DEFINITIONS);
            const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
            expect(delta).toContain(literal(before));
            expect(delta).toContain(literal(preserved(before)));
            expect(delta).toContain('DO $cutover_after$');
            expect(delta).toMatch(/RESET ROLE; COMMIT;\n$/);
        },
    );

    it.each([1, 2, 3])('refuses a partial set of %i new NOT NULL records', (count) => {
        const state = installedSnapshot();
        state.constraints.push(...newNotNullConstraints().slice(0, count));
        expect(() => classifySnapshot(state, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
    });

    const nn = (state: Snapshot) =>
        state.constraints.find((item) => item.tableName === NEW_TABLE && item.type === 'n')!;
    const malformed: Mutation[] = [
        {
            name: 'renamed constraint',
            mutate: (state) => {
                nn(state).name = 'renamed_not_null';
            },
        },
        {
            name: 'duplicate name replacing a required column',
            mutate: (state) => {
                const entries = state.constraints.filter((item) => item.tableName === NEW_TABLE && item.type === 'n');
                entries[1].name = entries[0].name;
            },
        },
        {
            name: 'fifth unapproved constraint',
            mutate: (state) => {
                state.constraints.push(notNullConstraint(NEW_TABLE, 'extra', 614));
            },
        },
        {
            name: 'fifth duplicated approved constraint',
            mutate: (state) => {
                state.constraints.push({ ...nn(state), oid: 614 });
            },
        },
        {
            name: 'wrong constraint type',
            mutate: (state) => {
                nn(state).type = 'c';
            },
        },
        {
            name: 'wrong bound column',
            mutate: (state) => {
                nn(state).columns = ['selecting_device_id'];
            },
        },
        {
            name: 'multiple bound columns',
            mutate: (state) => {
                nn(state).columns.push('selected_at');
            },
        },
        {
            name: 'changed definition',
            mutate: (state) => {
                nn(state).definition = 'NOT NULL selecting_device_id';
            },
        },
        {
            name: 'unvalidated constraint',
            mutate: (state) => {
                nn(state).validated = false;
            },
        },
        {
            name: 'deferrable constraint',
            mutate: (state) => {
                nn(state).deferrable = true;
            },
        },
        {
            name: 'deferred constraint',
            mutate: (state) => {
                nn(state).deferred = true;
            },
        },
        {
            name: 'referenced schema',
            mutate: (state) => {
                nn(state).referencedSchema = 'public';
            },
        },
        {
            name: 'referenced table',
            mutate: (state) => {
                nn(state).referencedTable = 'devices';
            },
        },
        {
            name: 'referenced columns',
            mutate: (state) => {
                nn(state).referencedColumns = ['owner_id'];
            },
        },
        {
            name: 'delete action',
            mutate: (state) => {
                nn(state).deleteAction = 'a';
            },
        },
        {
            name: 'update action',
            mutate: (state) => {
                nn(state).updateAction = 'a';
            },
        },
        {
            name: 'match type',
            mutate: (state) => {
                nn(state).matchType = 's';
            },
        },
        {
            name: 'nonpositive OID',
            mutate: (state) => {
                nn(state).oid = 0;
            },
        },
        {
            name: 'numeric string OID',
            mutate: (state) => {
                Object.assign(nn(state), { oid: '610' });
            },
        },
        {
            name: 'missing validated field',
            mutate: (state) => {
                delete (nn(state) as unknown as CatalogRow).validated;
            },
        },
    ];
    it.each(malformed)('refuses $name rather than normalizing it as a PG18 addition', ({ mutate }) => {
        const state = installedSnapshot();
        state.constraints.push(...newNotNullConstraints());
        mutate(state);
        expect(() => classifySnapshot(state, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
    });

    it('retains existing-table NOT NULL records and detects changes to them', () => {
        const before = baselineSnapshot(),
            after = installedSnapshot();
        const existing = notNullConstraint('devices', 'owner_id', 510);
        before.constraints.push(existing);
        after.constraints.push({ ...existing, columns: [...existing.columns] }, ...newNotNullConstraints());
        expect(preserved(after)).toEqual(preserved(before));
        const old = after.constraints.find((item) => item.oid === 510)!;
        old.definition = 'NOT NULL changed_old_column';
        expect(preserved(after).constraints).toContainEqual(old);
        expect(preserved(after)).not.toEqual(preserved(before));
    });
});

describe('exact old-state preservation projection — synthetic catalogs', () => {
    it('excludes only the authorized helper/table additions and four new-FK internal triggers', () => {
        const before = baselineSnapshot(),
            after = installedSnapshot();
        expect(preserved(after)).toEqual(preserved(before));
        expect(preserved(after).triggers).toEqual(before.triggers);
        expect(after.triggers.filter((item) => item.constraintOid === 600)).toHaveLength(4);
        expect(
            after.triggers.filter((item) => item.constraintOid === 600 && item.tableName === 'devices'),
        ).toHaveLength(2);
        expect(preserved(after).functions.every((fn: CatalogRow) => !Object.hasOwn(fn, 'body'))).toBe(true);
    });

    const changes: Mutation[] = [
        {
            name: 'old function OID',
            mutate: (state) => {
                state.functions[0].oid += 1;
            },
        },
        {
            name: 'old target ACL',
            mutate: (state) => {
                state.functions[0].acl = 'changed';
            },
        },
        {
            name: 'old helper body digest',
            mutate: (state) => {
                state.otherFunctions[0].bodyDigest = md5('changed');
            },
        },
        {
            name: 'schema ACL',
            mutate: (state) => {
                state.schema.acl = 'changed';
            },
        },
        {
            name: 'old relation ACL',
            mutate: (state) => {
                state.relations[0].acl = 'changed';
            },
        },
        {
            name: 'old constraint definition',
            mutate: (state) => {
                state.constraints[0].definition = 'changed';
            },
        },
        {
            name: 'old column default',
            mutate: (state) => {
                state.columns[0].default = 'changed';
            },
        },
        {
            name: 'old index definition',
            mutate: (state) => {
                state.indexes[0].definition = 'changed';
            },
        },
        {
            name: 'old internal trigger',
            mutate: (state) => {
                state.triggers[0].enabled = 'D';
            },
        },
        {
            name: 'extra old-device internal trigger',
            mutate: (state) => {
                state.triggers.push(trigger('devices', 499, 799));
            },
        },
        {
            name: 'domain definition',
            mutate: (state) => {
                state.domains[0].collation = 'changed';
            },
        },
        {
            name: 'default ACL',
            mutate: (state) => {
                state.defaultAcls[0].acl = 'changed';
            },
        },
        {
            name: 'role configuration',
            mutate: (state) => {
                state.roles[2].configuration = ['search_path=public'];
            },
        },
        {
            name: 'membership grant',
            mutate: (state) => {
                state.memberships[0].admin = true;
            },
        },
        {
            name: 'old row count',
            mutate: (state) => {
                state.data[0].count += 1;
            },
        },
        {
            name: 'old row bytes diagnostic',
            mutate: (state) => {
                state.data[0].digest = md5('changed');
            },
        },
    ];
    it.each(changes)('retains a $name change for exact precommit comparison', ({ mutate }) => {
        const before = baselineSnapshot(),
            after = installedSnapshot();
        mutate(after);
        expect(preserved(after)).not.toEqual(preserved(before));
    });

    it('does not hide unrelated additions merely because they reference the new table or old devices', () => {
        const before = baselineSnapshot(),
            after = installedSnapshot();
        after.columns.push(column(NEW_TABLE, 350, 'unapproved_extra', 5));
        after.constraints.push(primaryKey(NEW_TABLE, 603, 'unapproved_extra'));
        after.indexes.push({ ...index(NEW_TABLE, 350, 451), name: 'unapproved_extra' });
        after.triggers.push(trigger('devices', 499, 799));
        const projection = preserved(after);
        expect(projection.columns.some((item: Column) => item.name === 'unapproved_extra')).toBe(true);
        expect(projection.constraints.some((item: Constraint) => item.name === 'unapproved_extra')).toBe(true);
        expect(projection.indexes.some((item: Index) => item.name === 'unapproved_extra')).toBe(true);
        expect(projection.triggers.some((item: Trigger) => item.oid === 799)).toBe(true);
        expect(projection).not.toEqual(preserved(before));
    });
});

describe('closed generated transaction — source inspection, no SQL execution', () => {
    it('contains the sole allowed DDL after exact locked preflight and verifies authority/data/bodies before commit', () => {
        const before = baselineSnapshot();
        const delta = guardedDelta(before, DEFINITIONS);
        const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
        expect(delta).toMatch(/^BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;/);
        expect(delta).toContain('SET LOCAL standard_conforming_strings = on;');
        expect(delta).toContain("SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s';");
        expect(delta).toContain("SET LOCAL idle_in_transaction_session_timeout = '15s';");
        expect(delta).toContain('SET LOCAL ROLE e2ee_research_owner;');
        expect(delta.indexOf('SELECT e2ee_research.lock_pilot();')).toBeLessThan(delta.indexOf('DO $cutover_before$'));
        expect(delta.indexOf('END $cutover_before$;')).toBeLessThan(delta.indexOf(TABLE_DEFINITION));
        expect(delta).toContain(literal(before));
        expect(delta).toContain(literal(preserved(before)));
        const expectedFunctions = before.functions.map((fn) => ({
            ...fn,
            body: DEFINITIONS.targets.find((target: Definition) => target.signature === fn.signature)!.body,
        }));
        expect(delta).toContain(`state->'functions' IS DISTINCT FROM ${literal(expectedFunctions)}`);
        expect(delta).toContain(TABLE_DEFINITION);
        expect(delta).toContain(HELPER_DEFINITION);
        for (const target of DEFINITIONS.targets) expect(delta).toContain(target.replacement);
        expect(delta.match(/^CREATE TABLE /gm)).toHaveLength(1);
        expect(delta.match(/^CREATE FUNCTION /gm)).toHaveLength(1);
        expect(delta.match(/^CREATE OR REPLACE FUNCTION /gm)).toHaveLength(3);
        expect(delta).toContain('ALTER TABLE e2ee_research.protected_accounts ENABLE ROW LEVEL SECURITY;');
        const revokes = 'PUBLIC, anon, authenticated, service_role, e2ee_pilot_edge, e2ee_research_gateway';
        expect(delta).toContain(`REVOKE ALL ON TABLE e2ee_research.protected_accounts FROM ${revokes};`);
        expect(delta).toContain(`REVOKE ALL ON FUNCTION e2ee_research.requires_protected(text) FROM ${revokes};`);
        expect(delta).toContain("WHERE item->>'name'='protected_accounts') <> '0'");
        expect(delta).toContain("WHERE item->>'tablename'='protected_accounts') <> 0");
        expect(delta).toContain("item->>'enabled'='O'");
        expect(delta).toContain("'protected_accounts','devices'");
        expect(delta).toMatch(/END \$cutover_after\$;\nRESET ROLE; COMMIT;\n$/);
        expect(delta).not.toMatch(/^CREATE ROLE |^CREATE SCHEMA |^GRANT |^ALTER DEFAULT PRIVILEGES |^DROP /m);
    });

    it('requires an immutable definition capability produced by exact source extraction', () => {
        expect(Object.isFrozen(DEFINITIONS)).toBe(true);
        expect(Object.isFrozen(DEFINITIONS.targets)).toBe(true);
        expect(Object.isFrozen(DEFINITIONS.targets[0])).toBe(true);
        expect(Object.isFrozen(DEFINITIONS.targets[0].argumentNames)).toBe(true);
        expect(Object.isFrozen(DEFINITIONS.helper)).toBe(true);
        expect(Object.isFrozen(DEFINITIONS.table)).toBe(true);
        for (const cloned of [{ ...DEFINITIONS }, JSON.parse(JSON.stringify(DEFINITIONS))]) {
            expect(() => classifySnapshot(baselineSnapshot(), cloned)).toThrow();
            expect(() => guardedDelta(baselineSnapshot(), cloned)).toThrow();
        }
        expect(() =>
            Object.assign(DEFINITIONS.targets[0], { replacement: 'DROP SCHEMA e2ee_research CASCADE;' }),
        ).toThrow();
    });

    it.each(['$cutover_before$', '$cutover_after$'])(
        'refuses %s delimiter collision in captured catalog data',
        (tag) => {
            const before = baselineSnapshot();
            before.schema.acl = tag;
            expect(classifySnapshot(before, DEFINITIONS)).toBe('baseline');
            expect(() => guardedDelta(before, DEFINITIONS)).toThrow('Isolated cutover migration unavailable');
        },
    );

    it('quotes single quotes in captured metadata as JSON literal data', () => {
        const before = baselineSnapshot();
        before.defaultAcls[0].acl = "synthetic'; DROP SCHEMA e2ee_research CASCADE; --";
        const delta = guardedDelta(before, DEFINITIONS);
        const escaped = JSON.stringify(before).replaceAll("'", "''");
        expect(delta).toContain(`'${escaped}'::jsonb`);
        expect(delta).not.toContain(`'${JSON.stringify(before)}'::jsonb`);
    });
});

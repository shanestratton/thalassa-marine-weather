/** Pure isolated cutover migration contract. No IO, CLI, credentials or deployment. */
import { createHash } from 'node:crypto';

export const SOURCE_SHA256 = '15236d599574be3a087859b4ff60ba4acb2b0ed89559def4de6aa9cc5c933c01';
export const TABLES = Object.freeze(['devices', 'blocks', 'claims', 'decisions', 'requests']);
export const TARGETS = Object.freeze([
    Object.freeze({
        name: 'parse_request',
        signature: 'e2ee_research.parse_request(text)',
        immutable: true,
        baseline: '786eaa38c2fd7d401a216c3c884e1e14a0d22b06fba4927a1f8f11afa54f1870',
        arguments: 'raw text',
        argumentNames: Object.freeze(['raw']),
    }),
    Object.freeze({
        name: 'parse_request_payload',
        signature: 'e2ee_research.parse_request_payload(text,text)',
        immutable: true,
        baseline: 'd667b1e7df629208ff6c152a97fb723ae0c4b1d90d1eeb7b39518567f02b7e77',
        arguments: 'action text, payload text',
        argumentNames: Object.freeze(['action', 'payload']),
    }),
    Object.freeze({
        name: 'execute_request',
        signature: 'e2ee_research.execute_request(text,text,text,text,text,bigint,text)',
        immutable: false,
        baseline: 'd5c5f2344583514692da2e59488af2b57476d46f503dce288c4e1a615c9a632c',
        arguments:
            'actor text, device text, request_id text, action text, payload text, expires_at bigint, request_wire text',
        argumentNames: Object.freeze([
            'actor',
            'device',
            'request_id',
            'action',
            'payload',
            'expires_at',
            'request_wire',
        ]),
    }),
]);
export const targets = TARGETS;
const OWNER = 'e2ee_research_owner';
const GATEWAY = 'e2ee_research_gateway';
const HELPER = 'e2ee_research.requires_protected(text)';
const NEW_TABLE = 'protected_accounts';
const NEW_INDEX = 'protected_accounts_pkey';
const NEW_FK = 'protected_accounts_owner_id_selecting_device_id_fkey';
const NEW_COLUMNS = ['owner_id', 'selecting_device_id', 'selecting_request_id', 'selected_at'];
const PUBLIC_ROLES = ['anon', 'authenticated', 'service_role', 'e2ee_pilot_edge', GATEWAY];
const SIGNED_FUNCTIONS = [
    'e2ee_research.register_device(text,text)',
    'e2ee_research.lookup_request_key(text,text)',
    TARGETS[2].signature,
];
const SNAPSHOT_FIELDS = [
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
];
const ownedDefinitions = new WeakSet();
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const values = (items) => items.map((item) => `(${literal(item)})`).join(',');
const fail = () => {
    throw new Error('Isolated cutover migration unavailable');
};
const requireValue = (value) => {
    if (!value) fail();
};
const equal = (left, right) => canonical(left) === canonical(right);
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return (
            '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
                .join(',') +
            '}'
        );
    return JSON.stringify(value);
}
function plain(value) {
    return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function id(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function definitions(value) {
    requireValue(ownedDefinitions.has(value));
    return value;
}

/** Extraction is authorized by the WHOLE reviewed relay pin, not caller markers. */
export function extractDefinitions(source) {
    try {
        requireValue(typeof source === 'string' && hash(source) === SOURCE_SHA256);
        const extracted = TARGETS.map((target) => {
            const marker = `CREATE FUNCTION e2ee_research.${target.name}(`;
            requireValue(source.split(marker).length === 2);
            const start = source.indexOf(marker),
                end = source.indexOf('\nEND $$;', start);
            requireValue(end > start);
            const definition = source.slice(start, end + '\nEND $$;'.length);
            const body = definition.slice(definition.indexOf('AS $$') + 5, definition.lastIndexOf('$$;'));
            return Object.freeze({
                ...target,
                argumentNames: Object.freeze([...target.argumentNames]),
                body,
                target: hash(body),
                replacement: definition.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION '),
            });
        });
        const helperStart = source.indexOf('CREATE FUNCTION e2ee_research.requires_protected(');
        const helperEnd = source.indexOf('$$;', helperStart);
        requireValue(helperStart > 0 && helperEnd > helperStart);
        const helperDefinition = source.slice(helperStart, helperEnd + 3);
        const helperBody = helperDefinition.slice(
            helperDefinition.indexOf('AS $$') + 5,
            helperDefinition.lastIndexOf('$$;'),
        );
        const tableStart = source.indexOf('CREATE TABLE e2ee_research.protected_accounts (');
        const tableEnd = source.indexOf('\n);', tableStart);
        requireValue(tableStart > 0 && tableEnd > tableStart);
        const functionNames = [...source.matchAll(/^CREATE FUNCTION e2ee_research\.([a-z_]+)\(/gm)].map(
            (match) => match[1],
        );
        requireValue(functionNames.length === 21 && new Set(functionNames).size === 21);
        const result = Object.freeze({
            targets: Object.freeze(extracted),
            functionNames: Object.freeze(functionNames),
            helper: Object.freeze({
                name: 'requires_protected',
                signature: HELPER,
                body: helperBody,
                target: hash(helperBody),
                definition: helperDefinition,
            }),
            table: Object.freeze({ definition: source.slice(tableStart, tableEnd + 3) }),
        });
        ownedDefinitions.add(result);
        return result;
    } catch {
        return fail();
    }
}

function grants(acl, kind, owner) {
    return `(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb)
      FROM aclexplode(COALESCE(${acl},acldefault('${kind}',${owner}))) a)`;
}

/** Caller uses its owner READ COMMITTED snapshot, UTC and search_path=pg_catalog. */
export function snapshotExpression(installed) {
    requireValue(typeof installed === 'boolean');
    const tables = installed ? [...TABLES, NEW_TABLE] : TABLES;
    const signatures = TARGETS.map((target) => `${literal(target.signature)}::regprocedure`).join(',');
    const metadata = `jsonb_build_object('oid',p.oid::bigint,'name',p.proname,'signature',p.oid::regprocedure::text,
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'grants',${grants('p.proacl', 'f', 'p.proowner')},
      'securityDefiner',p.prosecdef,'configuration',p.proconfig,'volatility',p.provolatile,'language',l.lanname,
      'result',pg_get_function_result(p.oid),'arguments',pg_get_function_arguments(p.oid),'argumentNames',p.proargnames,
      'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind,
      'returnsSet',p.proretset,'cost',p.procost,'rows',p.prorows)`;
    const tableData = tables
        .map(
            (name) => `jsonb_build_object('name',${literal(name)},'count',(SELECT count(*) FROM e2ee_research.${name}),
      'digest',(SELECT md5(COALESCE(string_agg(fingerprint,'' ORDER BY fingerprint COLLATE "C"),''))
      FROM (SELECT md5(row_to_json(row_value)::text) fingerprint FROM e2ee_research.${name} row_value) hashes))`,
        )
        .join(',');
    return `jsonb_build_object(
      'functions',(SELECT jsonb_agg(${metadata} || jsonb_build_object('body',p.prosrc) ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid IN (${signatures})),
      'otherFunctions',(SELECT jsonb_agg(${metadata} || jsonb_build_object('bodyDigest',md5(p.prosrc)) ||
        CASE WHEN p.proname='requires_protected' THEN jsonb_build_object('body',p.prosrc) ELSE '{}'::jsonb END
        ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='e2ee_research' AND p.oid NOT IN (${signatures})),
      'schema',(SELECT jsonb_build_object('oid',oid::bigint,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text,
        'grants',${grants('nspacl', 'n', 'nspowner')}) FROM pg_namespace WHERE nspname='e2ee_research'),
      'relations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',c.oid::bigint,'name',c.relname,'kind',c.relkind,
        'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'grants',CASE WHEN c.relkind='r' THEN ${grants('c.relacl', 'r', 'c.relowner')} ELSE '[]'::jsonb END,
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'persistence',c.relpersistence,'options',c.reloptions,
        'replicaIdentity',c.relreplident,'tablespace',c.reltablespace::bigint,'hasTriggers',c.relhastriggers,'checkCount',c.relchecks)
        ORDER BY c.relname COLLATE "C"),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='e2ee_research'),
      'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',c.oid::bigint,'name',c.conname,'tableName',t.relname,
        'type',c.contype,'columns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum),'[]'::jsonb),
        'referencedSchema',rn.nspname,'referencedTable',r.relname,
        'referencedColumns',COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum),'[]'::jsonb),
        'deleteAction',c.confdeltype,'updateAction',c.confupdtype,'matchType',c.confmatchtype,
        'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid))
        ORDER BY c.oid),'[]'::jsonb) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
        LEFT JOIN pg_class t ON t.oid=c.conrelid LEFT JOIN pg_class r ON r.oid=c.confrelid LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
        WHERE n.nspname='e2ee_research'),
      'policies',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname),'[]'::jsonb) FROM pg_policies p WHERE p.schemaname='e2ee_research'),
      'roles',(SELECT jsonb_agg(jsonb_build_object('oid',oid::bigint,'name',rolname,'login',rolcanlogin,'super',rolsuper,
        'createRole',rolcreaterole,'createDb',rolcreatedb,'bypassRls',rolbypassrls,'inherit',rolinherit,
        'connectionLimit',rolconnlimit,'configuration',rolconfig) ORDER BY rolname COLLATE "C")
        FROM pg_roles WHERE rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge')),
      'memberships',(SELECT COALESCE(jsonb_agg(jsonb_build_object('role',r.rolname,'member',u.rolname,'grantor',g.rolname,
        'admin',m.admin_option,'inherit',to_jsonb(m)->'inherit_option','set',to_jsonb(m)->'set_option') ORDER BY r.rolname,u.rolname,g.rolname),'[]'::jsonb)
        FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member JOIN pg_roles g ON g.oid=m.grantor
        WHERE r.rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge') OR u.rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge')),
      'columns',(SELECT COALESCE(jsonb_agg(jsonb_build_object('tableOid',c.oid::bigint,'tableName',c.relname,'name',a.attname,'position',a.attnum,
        'type',format_type(a.atttypid,a.atttypmod),'typeOid',a.atttypid::bigint,'typeModifier',a.atttypmod,'notNull',a.attnotnull,
        'identity',a.attidentity,'generated',a.attgenerated,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||coll.collname END,
        'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text,
        'grants',(SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',CASE WHEN z.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(z.grantee) END,
          'grantor',pg_get_userbyid(z.grantor),'privilege',z.privilege_type,'grantable',z.is_grantable) ORDER BY z.grantee,z.grantor,z.privilege_type),'[]'::jsonb)
          FROM aclexplode(a.attacl) z)) ORDER BY c.relname COLLATE "C",a.attnum),'[]'::jsonb)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
        LEFT JOIN pg_namespace cn ON cn.oid=coll.collnamespace WHERE n.nspname='e2ee_research' AND c.relkind IN ('r','S') AND a.attnum>0 AND NOT a.attisdropped),
      'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',i.indexrelid::bigint,'tableOid',i.indrelid::bigint,'tableName',t.relname,'name',c.relname,
        'method',am.amname,'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'exclusion',i.indisexclusion,
        'columns',(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinality)
          LEFT JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum),
        'expressions',pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_get_expr(i.indpred,i.indrelid),'definition',pg_get_indexdef(i.indexrelid))
        ORDER BY c.relname COLLATE "C"),'[]'::jsonb) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am am ON am.oid=c.relam WHERE n.nspname='e2ee_research'),
      'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',t.oid::bigint,'tableName',c.relname,'name',t.tgname,
        'function',t.tgfoid::regprocedure::text,'internal',t.tgisinternal,'enabled',t.tgenabled,'type',t.tgtype,
        'constraintOid',t.tgconstraint::bigint,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname COLLATE "C",t.tgname),'[]'::jsonb)
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='e2ee_research'),
      'domains',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',t.oid::bigint,'name',t.typname,'owner',pg_get_userbyid(t.typowner),
        'baseType',format_type(t.typbasetype,t.typtypmod),'typeModifier',t.typtypmod,'notNull',t.typnotnull,
        'collation',CASE WHEN t.typcollation=0 THEN NULL ELSE cn.nspname||'.'||coll.collname END,'default',t.typdefault,'acl',t.typacl::text)
        ORDER BY t.typname COLLATE "C"),'[]'::jsonb) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        LEFT JOIN pg_collation coll ON coll.oid=t.typcollation LEFT JOIN pg_namespace cn ON cn.oid=coll.collnamespace
        WHERE n.nspname='e2ee_research' AND t.typtype='d'),
      'defaultAcls',(SELECT COALESCE(jsonb_agg(jsonb_build_object('oid',d.oid::bigint,'owner',pg_get_userbyid(d.defaclrole),
        'schema',n.nspname,'objectType',d.defaclobjtype,'acl',d.defaclacl::text) ORDER BY d.oid),'[]'::jsonb)
        FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace),
      'data',jsonb_build_array(${tableData}),
      'privileges',jsonb_build_object(
        'signedOnly',(SELECT bool_and(has_function_privilege(roles.name,p.oid,'EXECUTE')=(roles.name='e2ee_research_gateway' AND p.oid IN (${SIGNED_FUNCTIONS.map((item) => `${literal(item)}::regprocedure`).join(',')})))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='e2ee_research'),
        'tablesClosed',(SELECT bool_and(NOT has_table_privilege(roles.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='e2ee_research' AND c.relkind='r'),
        'columnsClosed',(SELECT bool_and(NOT has_column_privilege(roles.name,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='e2ee_research' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
        'sequencesClosed',(SELECT COALESCE(bool_and(NOT has_sequence_privilege(roles.name,c.oid,'USAGE,SELECT,UPDATE')),true)
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='e2ee_research' AND c.relkind='S'),
        'publicClosed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
          LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='e2ee_research' AND a.grantee=0),
        'schemaClosed',(SELECT bool_and(has_schema_privilege(roles.name,'e2ee_research','USAGE')=(roles.name='e2ee_research_gateway')) FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name)),
        'gatewaySet',pg_has_role('e2ee_pilot_edge','e2ee_research_gateway','SET'),
        'ownerForbidden',NOT pg_has_role('e2ee_pilot_edge','e2ee_research_owner','SET'))) `;
}

function pick(value, keys) {
    return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
function helperSpec(defs) {
    return {
        name: 'requires_protected',
        signature: HELPER,
        owner: OWNER,
        securityDefiner: false,
        configuration: ['search_path=pg_catalog'],
        volatility: 'v',
        language: 'sql',
        result: 'boolean',
        arguments: 'actor text',
        argumentNames: ['actor'],
        strict: true,
        leakproof: false,
        parallel: 'u',
        kind: 'f',
        returnsSet: false,
        cost: 100,
        rows: 0,
        body: defs.helper.body,
        bodyDigest: hash(defs.helper.body, 'md5'),
        grants: [{ grantee: OWNER, grantor: OWNER, privilege: 'EXECUTE', grantable: false }],
    };
}
function notNullSpec(column) {
    return {
        name: `${NEW_TABLE}_${column}_not_null`,
        tableName: NEW_TABLE,
        type: 'n',
        columns: [column],
        referencedSchema: null,
        referencedTable: null,
        referencedColumns: [],
        deleteAction: ' ',
        updateAction: ' ',
        matchType: ' ',
        validated: true,
        deferrable: false,
        deferred: false,
        definition: `NOT NULL ${column}`,
    };
}
function allowedNotNullConstraint(item) {
    if (!plain(item) || !id(item.oid) || !Array.isArray(item.columns) || item.columns.length !== 1) return false;
    const column = item.columns[0];
    if (!NEW_COLUMNS.includes(column)) return false;
    const metadata = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'oid'));
    return equal(metadata, notNullSpec(column));
}
function validateNotNullConstraints(state) {
    const rows = state.constraints.filter((item) => item.tableName === NEW_TABLE && item.type === 'n');
    requireValue(
        rows.length === 0 ||
            (rows.length === 4 &&
                rows.every(allowedNotNullConstraint) &&
                new Set(rows.map((item) => item.name)).size === 4),
    );
}
function notNullConstraintSql(value) {
    const specs = NEW_COLUMNS.map((column) => `${literal(JSON.stringify(notNullSpec(column)))}::jsonb`).join(',');
    return `(jsonb_typeof(${value}->'oid')='number' AND ${value}->>'oid' ~ '^[1-9][0-9]*$'
      AND (${value}-'oid') IN (${specs}))`;
}
function additions(state, defs) {
    const helper = state.otherFunctions.find((item) => item.signature === HELPER);
    const table = state.relations.find((item) => item.name === NEW_TABLE);
    const index = state.relations.find((item) => item.name === NEW_INDEX);
    const tableProjection =
        table &&
        pick(table, [
            'name',
            'kind',
            'owner',
            'grants',
            'rls',
            'forceRls',
            'persistence',
            'options',
            'replicaIdentity',
            'tablespace',
            'hasTriggers',
            'checkCount',
        ]);
    if (tableProjection) {
        // PG 17 adds owner MAINTAIN to the default table ACL. Normalize only
        // that exact owner tuple; any non-owner or grantable privilege refuses.
        tableProjection.grants = tableProjection.grants.filter(
            (grant) =>
                !(
                    grant.grantee === OWNER &&
                    grant.grantor === OWNER &&
                    grant.privilege === 'MAINTAIN' &&
                    grant.grantable === false
                ),
        );
    }
    return {
        helper: helper && pick(helper, Object.keys(helperSpec(defs))),
        table: tableProjection,
        indexRelation:
            index &&
            pick(index, [
                'name',
                'kind',
                'owner',
                'grants',
                'rls',
                'forceRls',
                'persistence',
                'options',
                'tablespace',
                'hasTriggers',
                'checkCount',
            ]),
        columns: state.columns
            .filter((item) => item.tableName === NEW_TABLE)
            .map((item) =>
                pick(item, [
                    'tableName',
                    'name',
                    'position',
                    'type',
                    'typeModifier',
                    'notNull',
                    'identity',
                    'generated',
                    'collation',
                    'default',
                    'grants',
                ]),
            ),
        constraints: state.constraints
            .filter((item) => item.tableName === NEW_TABLE && !allowedNotNullConstraint(item))
            .map((item) =>
                pick(item, [
                    'name',
                    'tableName',
                    'type',
                    'columns',
                    'referencedSchema',
                    'referencedTable',
                    'referencedColumns',
                    'deleteAction',
                    'updateAction',
                    'matchType',
                    'validated',
                    'deferrable',
                    'deferred',
                    'definition',
                ]),
            )
            .sort((a, b) => a.name.localeCompare(b.name)),
        indexes: state.indexes
            .filter((item) => item.tableName === NEW_TABLE)
            .map((item) =>
                pick(item, [
                    'tableName',
                    'name',
                    'method',
                    'unique',
                    'primary',
                    'valid',
                    'ready',
                    'live',
                    'exclusion',
                    'columns',
                    'expressions',
                    'predicate',
                    'definition',
                ]),
            ),
    };
}
function expectedAdditions(defs) {
    return {
        helper: helperSpec(defs),
        table: {
            name: NEW_TABLE,
            kind: 'r',
            owner: OWNER,
            grants: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map((privilege) => ({
                grantee: OWNER,
                grantor: OWNER,
                privilege,
                grantable: false,
            })),
            rls: true,
            forceRls: false,
            persistence: 'p',
            options: null,
            replicaIdentity: 'd',
            tablespace: 0,
            hasTriggers: true,
            checkCount: 0,
        },
        indexRelation: {
            name: NEW_INDEX,
            kind: 'i',
            owner: OWNER,
            grants: [],
            rls: false,
            forceRls: false,
            persistence: 'p',
            options: null,
            tablespace: 0,
            hasTriggers: false,
            checkCount: 0,
        },
        columns: NEW_COLUMNS.map((name, index) => ({
            tableName: NEW_TABLE,
            name,
            position: index + 1,
            type: index < 3 ? 'e2ee_research.identifier' : 'timestamp with time zone',
            typeModifier: -1,
            notNull: true,
            identity: '',
            generated: '',
            collation: index < 3 ? 'pg_catalog.C' : null,
            default: index < 3 ? null : 'clock_timestamp()',
            grants: [],
        })),
        constraints: [
            {
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
            {
                name: NEW_INDEX,
                tableName: NEW_TABLE,
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
            },
        ],
        indexes: [
            {
                tableName: NEW_TABLE,
                name: NEW_INDEX,
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
                definition:
                    'CREATE UNIQUE INDEX protected_accounts_pkey ON e2ee_research.protected_accounts USING btree (owner_id)',
            },
        ],
    };
}

/** Refuse partial installations, mixed old/new bodies and unrelated additions. */
export function classifySnapshot(state, definitionSet) {
    try {
        const defs = definitions(definitionSet);
        requireValue(plain(state) && equal(Object.keys(state).sort(), [...SNAPSHOT_FIELDS].sort()));
        for (const field of SNAPSHOT_FIELDS.filter((key) => !['schema', 'privileges'].includes(key)))
            requireValue(Array.isArray(state[field]));
        requireValue(state.functions.length === 3 && id(state.schema?.oid) && state.schema.owner === OWNER);
        requireValue(
            equal(state.privileges, {
                signedOnly: true,
                tablesClosed: true,
                columnsClosed: true,
                sequencesClosed: true,
                publicClosed: true,
                schemaClosed: true,
                gatewaySet: true,
                ownerForbidden: true,
            }),
        );
        const expectedRoleNames = [OWNER, GATEWAY, 'e2ee_pilot_edge'].sort();
        requireValue(equal(state.roles.map((role) => role.name).sort(), expectedRoleNames));
        for (const role of state.roles) {
            requireValue(
                id(role.oid) &&
                    ['super', 'createRole', 'createDb', 'bypassRls', 'inherit'].every((key) => role[key] === false),
            );
            requireValue(
                role.login === (role.name === 'e2ee_pilot_edge') && role.connectionLimit === (role.login ? 2 : -1),
            );
        }
        const bodies = state.functions.map((fn) => {
            const target = defs.targets.find((item) => item.signature === fn.signature);
            requireValue(
                target && id(fn.oid) && fn.name === target.name && fn.owner === OWNER && typeof fn.body === 'string',
            );
            requireValue(
                equal(
                    pick(fn, [
                        'securityDefiner',
                        'configuration',
                        'volatility',
                        'language',
                        'result',
                        'arguments',
                        'argumentNames',
                        'strict',
                        'leakproof',
                        'parallel',
                        'kind',
                        'returnsSet',
                        'cost',
                        'rows',
                    ]),
                    {
                        securityDefiner: !target.immutable,
                        configuration: ['search_path=pg_catalog'],
                        volatility: target.immutable ? 'i' : 'v',
                        language: 'plpgsql',
                        result: 'jsonb',
                        arguments: target.arguments,
                        argumentNames: target.argumentNames,
                        strict: false,
                        leakproof: false,
                        parallel: 'u',
                        kind: 'f',
                        returnsSet: false,
                        cost: 100,
                        rows: 0,
                    },
                ),
            );
            const digest = hash(fn.body);
            return digest === target.baseline ? 'baseline' : digest === target.target ? 'installed' : fail();
        });
        requireValue(new Set(state.functions.map((fn) => fn.signature)).size === 3 && new Set(bodies).size === 1);
        const installed = bodies[0] === 'installed';
        const tableNames = state.relations
            .filter((item) => item.kind === 'r')
            .map((item) => item.name)
            .sort();
        requireValue(equal(tableNames, (installed ? [...TABLES, NEW_TABLE] : [...TABLES]).sort()));
        requireValue(state.otherFunctions.length === (installed ? 18 : 17));
        const expectedNames = defs.functionNames
            .filter(
                (name) =>
                    !TARGETS.some((target) => target.name === name) && (installed || name !== 'requires_protected'),
            )
            .sort();
        requireValue(equal(state.otherFunctions.map((fn) => fn.name).sort(), expectedNames));
        for (const fn of state.otherFunctions)
            requireValue(id(fn.oid) && fn.owner === OWNER && /^[0-9a-f]{32}$/.test(fn.bodyDigest));
        for (const relation of state.relations) {
            requireValue(id(relation.oid) && relation.owner === OWNER);
            if (relation.kind === 'r') requireValue(relation.rls === true);
        }
        requireValue(equal(state.data.map((item) => item.name).sort(), tableNames));
        for (const item of state.data)
            requireValue(Number.isSafeInteger(item.count) && item.count >= 0 && /^[0-9a-f]{32}$/.test(item.digest));
        requireValue(
            state.domains.length === 1 && state.domains[0].name === 'identifier' && state.domains[0].owner === OWNER,
        );
        requireValue(id(state.domains[0].oid));
        requireValue(!state.policies.some((item) => item.tablename === NEW_TABLE));
        // Foreign keys create internal RI triggers on BOTH tables. No custom
        // triggers are permitted in this hosted cutover slice.
        requireValue(state.triggers.every((item) => item.internal === true));
        if (installed) {
            // PG 18 records the four ordinary column NOT NULL declarations as
            // separate constraints. Accept only the complete exact set or the
            // older PostgreSQL representation with none of these catalog rows.
            validateNotNullConstraints(state);
            requireValue(equal(additions(state, defs), expectedAdditions(defs)));
            const table = state.relations.find((item) => item.name === NEW_TABLE);
            const index = state.relations.find((item) => item.name === NEW_INDEX);
            requireValue(
                state.columns
                    .filter((item) => item.tableName === NEW_TABLE)
                    .every(
                        (column) =>
                            column.tableOid === table.oid &&
                            column.typeOid === (column.name === 'selected_at' ? 1184 : state.domains[0].oid),
                    ),
            );
            requireValue(
                state.indexes
                    .filter((item) => item.tableName === NEW_TABLE)
                    .every((item) => item.tableOid === table.oid && item.oid === index.oid),
            );
            requireValue(state.triggers.filter((item) => item.tableName === NEW_TABLE).length === 2);
            const fk = state.constraints.find((item) => item.name === NEW_FK && item.tableName === NEW_TABLE);
            requireValue(
                id(fk.oid) &&
                    state.constraints.filter((item) => item.tableName === NEW_TABLE).every((item) => id(item.oid)),
            );
            const related = state.triggers.filter((item) => item.constraintOid === fk.oid);
            requireValue(
                related.length === 4 &&
                    related.every(
                        (item) =>
                            item.internal === true &&
                            item.enabled === 'O' &&
                            [NEW_TABLE, 'devices'].includes(item.tableName),
                    ),
            );
        } else {
            requireValue(!state.relations.some((item) => item.name === NEW_TABLE || item.name === NEW_INDEX));
            requireValue(!state.columns.some((item) => item.tableName === NEW_TABLE));
            requireValue(!state.constraints.some((item) => item.tableName === NEW_TABLE));
            requireValue(!state.indexes.some((item) => item.tableName === NEW_TABLE));
            requireValue(!state.triggers.some((item) => item.tableName === NEW_TABLE));
        }
        return installed ? 'installed' : 'baseline';
    } catch {
        return fail();
    }
}
export const validateSnapshot = classifySnapshot;

/** Exact old-state projection. Only the permitted additions are excluded. */
export function preserved(state) {
    const fk = state.constraints.find((item) => item.name === NEW_FK && item.tableName === NEW_TABLE);
    return {
        ...state,
        functions: state.functions.map(({ body, ...metadata }) => metadata),
        otherFunctions: state.otherFunctions.filter((item) => item.signature !== HELPER),
        relations: state.relations.filter((item) => ![NEW_TABLE, NEW_INDEX].includes(item.name)),
        constraints: state.constraints.filter(
            (item) =>
                !(item.tableName === NEW_TABLE && [NEW_INDEX, NEW_FK].includes(item.name)) &&
                !allowedNotNullConstraint(item),
        ),
        columns: state.columns.filter((item) => !(item.tableName === NEW_TABLE && NEW_COLUMNS.includes(item.name))),
        indexes: state.indexes.filter((item) => !(item.tableName === NEW_TABLE && item.name === NEW_INDEX)),
        triggers: state.triggers.filter(
            (item) =>
                !(
                    fk &&
                    item.constraintOid === fk.oid &&
                    item.internal === true &&
                    [NEW_TABLE, 'devices'].includes(item.tableName)
                ),
        ),
        data: state.data.filter((item) => item.name !== NEW_TABLE),
    };
}

function filteredArray(state, field, keep, strip = '') {
    return `(SELECT COALESCE(jsonb_agg(item.value${strip} ORDER BY item.ordinality),'[]'::jsonb)
      FROM jsonb_array_elements(${state}->'${field}') WITH ORDINALITY item(value,ordinality) WHERE ${keep})`;
}
function preservedSql(state) {
    const fk = `(SELECT item->>'oid' FROM jsonb_array_elements(${state}->'constraints') item
      WHERE item->>'tableName'='protected_accounts' AND item->>'name'='${NEW_FK}')`;
    return `${state} || jsonb_build_object(
      'functions',${filteredArray(state, 'functions', 'true', "-'body'")},
      'otherFunctions',${filteredArray(state, 'otherFunctions', `item.value->>'signature'<>${literal(HELPER)}`)},
      'relations',${filteredArray(state, 'relations', `item.value->>'name' NOT IN ('${NEW_TABLE}','${NEW_INDEX}')`)},
      'constraints',${filteredArray(state, 'constraints', `NOT (COALESCE(item.value->>'tableName','')='${NEW_TABLE}' AND item.value->>'name' IN ('${NEW_INDEX}','${NEW_FK}')) AND NOT COALESCE(${notNullConstraintSql('item.value')},false)`)},
      'columns',${filteredArray(state, 'columns', `NOT (item.value->>'tableName'='${NEW_TABLE}' AND item.value->>'name' IN (${NEW_COLUMNS.map(literal).join(',')}))`)},
      'indexes',${filteredArray(state, 'indexes', `NOT (item.value->>'tableName'='${NEW_TABLE}' AND item.value->>'name'='${NEW_INDEX}')`)},
      'triggers',${filteredArray(state, 'triggers', `NOT (COALESCE(item.value->>'constraintOid','')=COALESCE(${fk},'') AND item.value->'internal'='true'::jsonb AND item.value->>'tableName' IN ('${NEW_TABLE}','devices'))`)},
      'data',${filteredArray(state, 'data', `item.value->>'name'<>'${NEW_TABLE}'`)})`;
}
function additionsSql(state, defs) {
    const json = (keys, normalizeTable = false) =>
        keys
            .map(
                (key) =>
                    `${literal(key)},${
                        normalizeTable && key === 'grants'
                            ? `(SELECT COALESCE(jsonb_agg(g.value ORDER BY g.ordinality),'[]'::jsonb) FROM jsonb_array_elements(item.value->'grants') WITH ORDINALITY g(value,ordinality)
          WHERE NOT (g.value->>'grantee'='${OWNER}' AND g.value->>'grantor'='${OWNER}' AND g.value->>'privilege'='MAINTAIN' AND g.value->'grantable'='false'::jsonb))`
                            : `item.value->${literal(key)}`
                    }`,
            )
            .join(',');
    const object = (field, predicate, keys, normalizeTable = false) =>
        `(SELECT jsonb_build_object(${json(keys, normalizeTable)}) FROM jsonb_array_elements(${state}->'${field}') item(value) WHERE ${predicate})`;
    const array = (
        field,
        predicate,
        keys,
        order = 'item.ordinality',
    ) => `(SELECT COALESCE(jsonb_agg(jsonb_build_object(${json(keys)}) ORDER BY ${order}),'[]'::jsonb)
      FROM jsonb_array_elements(${state}->'${field}') WITH ORDINALITY item(value,ordinality) WHERE ${predicate})`;
    return `jsonb_build_object(
      'helper',${object('otherFunctions', `item.value->>'signature'=${literal(HELPER)}`, Object.keys(helperSpec(defs)))},
      'table',${object('relations', `item.value->>'name'='${NEW_TABLE}'`, Object.keys(expectedAdditions(defs).table), true)},
      'indexRelation',${object('relations', `item.value->>'name'='${NEW_INDEX}'`, Object.keys(expectedAdditions(defs).indexRelation))},
      'columns',${array('columns', `item.value->>'tableName'='${NEW_TABLE}'`, Object.keys(expectedAdditions(defs).columns[0]))},
      'constraints',${array('constraints', `item.value->>'tableName'='${NEW_TABLE}' AND NOT COALESCE(${notNullConstraintSql('item.value')},false)`, Object.keys(expectedAdditions(defs).constraints[0]), "item.value->>'name'")},
      'indexes',${array('indexes', `item.value->>'tableName'='${NEW_TABLE}'`, Object.keys(expectedAdditions(defs).indexes[0]))})`;
}

/** Generates the sole allowed owner transaction; never executes it. */
export function guardedDelta(before, definitionSet) {
    try {
        const defs = definitions(definitionSet);
        requireValue(classifySnapshot(before, defs) === 'baseline');
        const targetFunctions = before.functions.map((fn) => ({
            ...fn,
            body: defs.targets.find((target) => target.signature === fn.signature).body,
        }));
        for (const value of [before, preserved(before), expectedAdditions(defs), targetFunctions])
            requireValue(!['$cutover_before$', '$cutover_after$'].some((tag) => JSON.stringify(value).includes(tag)));
        const revokes = ['PUBLIC', ...PUBLIC_ROLES].join(', ');
        return `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL standard_conforming_strings = on;
SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL search_path = pg_catalog; SET LOCAL TimeZone = 'UTC';
SET LOCAL ROLE e2ee_research_owner;
SELECT e2ee_research.lock_pilot();
DO $cutover_before$ BEGIN
  IF (${snapshotExpression(false)}) IS DISTINCT FROM ${literal(JSON.stringify(before))}::jsonb THEN
    RAISE EXCEPTION 'Isolated cutover preflight changed' USING ERRCODE='22023';
  END IF;
END $cutover_before$;
${defs.table.definition}
ALTER TABLE e2ee_research.protected_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2ee_research.protected_accounts FROM ${revokes};
${defs.helper.definition}
REVOKE ALL ON FUNCTION e2ee_research.requires_protected(text) FROM ${revokes};
${defs.targets.map((target) => target.replacement).join('\n\n')}
DO $cutover_after$ DECLARE state jsonb; fk_oid text; BEGIN
  state := (${snapshotExpression(true)});
  IF (SELECT count(*) FROM jsonb_array_elements(state->'constraints') item
      WHERE item->>'tableName'='protected_accounts' AND item->>'type'='n') NOT IN (0,4)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'constraints') item
      WHERE item->>'tableName'='protected_accounts' AND item->>'type'='n'
        AND NOT COALESCE(${notNullConstraintSql('item')},false))
     OR (SELECT count(*) FROM jsonb_array_elements(state->'constraints') item
      WHERE item->>'tableName'='protected_accounts' AND item->>'type'='n') <>
        (SELECT count(DISTINCT item->>'name') FROM jsonb_array_elements(state->'constraints') item
          WHERE item->>'tableName'='protected_accounts' AND item->>'type'='n') THEN
    RAISE EXCEPTION 'Isolated cutover not-null topology changed' USING ERRCODE='22023';
  END IF;
  IF (${preservedSql('state')}) IS DISTINCT FROM ${literal(JSON.stringify(preserved(before)))}::jsonb
     OR (${additionsSql('state', defs)}) IS DISTINCT FROM ${literal(JSON.stringify(expectedAdditions(defs)))}::jsonb
     OR state->'functions' IS DISTINCT FROM ${literal(JSON.stringify(targetFunctions))}::jsonb
     OR (SELECT item->>'count' FROM jsonb_array_elements(state->'data') item WHERE item->>'name'='protected_accounts') <> '0'
     OR (SELECT count(*) FROM jsonb_array_elements(state->'policies') item WHERE item->>'tablename'='protected_accounts') <> 0
     OR (SELECT count(*) FROM jsonb_array_elements(state->'functions')) <> 3
     OR (SELECT count(*) FROM jsonb_array_elements(state->'otherFunctions')) <> 18
     OR (SELECT count(*) FROM jsonb_array_elements(state->'relations') item WHERE item->>'kind'='r') <> 6
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'triggers') item WHERE item->'internal'<>'true'::jsonb) THEN
    RAISE EXCEPTION 'Isolated cutover invariants changed' USING ERRCODE='22023';
  END IF;
  fk_oid := (SELECT item->>'oid' FROM jsonb_array_elements(state->'constraints') item
    WHERE item->>'tableName'='protected_accounts' AND item->>'name'='${NEW_FK}');
  IF (SELECT count(*) FROM jsonb_array_elements(state->'triggers') item WHERE item->>'constraintOid'=fk_oid
      AND item->'internal'='true'::jsonb AND item->>'enabled'='O' AND item->>'tableName' IN ('protected_accounts','devices')) <> 4
     OR (SELECT count(*) FROM jsonb_array_elements(state->'triggers') item WHERE item->>'tableName'='protected_accounts') <> 2 THEN
    RAISE EXCEPTION 'Isolated cutover topology changed' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(state->'columns') item WHERE item->>'tableName'='protected_accounts'
      AND (item->>'tableOid' IS DISTINCT FROM (SELECT t->>'oid' FROM jsonb_array_elements(state->'relations') t WHERE t->>'name'='protected_accounts')
        OR item->>'typeOid' IS DISTINCT FROM CASE WHEN item->>'name'='selected_at' THEN '1184'
          ELSE (SELECT d->>'oid' FROM jsonb_array_elements(state->'domains') d WHERE d->>'name'='identifier') END))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'indexes') item WHERE item->>'tableName'='protected_accounts'
      AND (item->>'tableOid' IS DISTINCT FROM (SELECT t->>'oid' FROM jsonb_array_elements(state->'relations') t WHERE t->>'name'='protected_accounts')
        OR item->>'oid' IS DISTINCT FROM (SELECT t->>'oid' FROM jsonb_array_elements(state->'relations') t WHERE t->>'name'='protected_accounts_pkey'))) THEN
    RAISE EXCEPTION 'Isolated cutover catalog binding changed' USING ERRCODE='22023';
  END IF;
END $cutover_after$;
RESET ROLE; COMMIT;\n`;
    } catch {
        return fail();
    }
}

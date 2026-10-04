/**
 * Explicit existing-schema policy-only update for the isolated hosted pilot.
 * Default/inspect is read-only. apply-policy replaces exactly three functions;
 * no Edge deployment, grants, roles, tables, participants, keys or rows change.
 * Never use this script against the production project or print CLI diagnostics.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECT = 'kmtupdvwdgbhtssqqova';
const FORBIDDEN_PROJECT = 'pcisdplnodrphauixcau';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const CLI = '/opt/homebrew/bin/supabase';
const SOURCE_HASH = '96112dc474c8df60c36a5b8a2aded33b6c5b8e81d7a36b94b52ba8311d074a9f';
const TARGETS = [
    { name: 'parse_request', signature: 'e2ee_research.parse_request(text)', immutable: true,
      baseline: '5b38e6c31729c03fa0ba505ccc80fc256bdc74d4e0cf99409ddbf1b483f066a4',
      target: '786eaa38c2fd7d401a216c3c884e1e14a0d22b06fba4927a1f8f11afa54f1870' },
    { name: 'parse_request_payload', signature: 'e2ee_research.parse_request_payload(text,text)', immutable: true,
      baseline: '15107d32ebb644b17fcb0a46dea1ecbcac663c34278dabe3651dc7194e0d8aef',
      target: 'd667b1e7df629208ff6c152a97fb723ae0c4b1d90d1eeb7b39518567f02b7e77' },
    { name: 'execute_request', signature: 'e2ee_research.execute_request(text,text,text,text,text,bigint,text)', immutable: false,
      baseline: 'a0768ebed4045b02b31f72e20cb5d1cd91ff06f5225a1f16886c33c67aad9641',
      target: 'd5c5f2344583514692da2e59488af2b57476d46f503dce288c4e1a615c9a632c' },
];
const TABLES = ['devices', 'blocks', 'claims', 'decisions', 'requests'];
const SIGNED_FUNCTIONS = [
    'e2ee_research.register_device(text,text)',
    'e2ee_research.lookup_request_key(text,text)',
    'e2ee_research.execute_request(text,text,text,text,text,bigint,text)',
];
const PUBLIC_ROLES = ['anon', 'authenticated', 'service_role', 'e2ee_pilot_edge', 'e2ee_research_gateway'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const values = (items) => items.map((item) => `(${literal(item)})`).join(',');
let stage = 'local isolation guards';
let scratch;
let applyAttempted = false;
let diagnostic = 'not-classified';
const temporarySql = [];

function invariant(condition, name) {
    // Labels come only from fixed local constants, never a server key/value.
    if (!condition) { diagnostic = name; assert(condition); }
}
function equalInvariant(actual, expected, name) {
    try { assert.deepEqual(actual, expected); }
    catch { diagnostic = name; throw new Error('Isolated invariant refused'); }
}

function requireLink() {
    assert(realpathSync(CHECKOUT).includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert.equal(realpathSync(HERE), join(realpathSync(CHECKOUT), 'experiments/scuttlebutt-e2ee/hosted'));
    const refPath = join(HERE, 'supabase/.temp/project-ref');
    assert(lstatSync(refPath).isFile() && !lstatSync(refPath).isSymbolicLink());
    const ref = readFileSync(refPath, 'utf8').trim();
    assert.equal(ref, PROJECT);
    assert.notEqual(ref, FORBIDDEN_PROJECT);
    const config = readFileSync(join(HERE, 'supabase/config.toml'), 'utf8');
    assert.deepEqual([...config.matchAll(/^project_id\s*=\s*"([^"]+)"\s*$/gm)].map((match) => match[1]), [PROJECT]);
    assert(config.includes('[functions.scuttlebutt-e2ee-pilot]\nverify_jwt = true'));
    assert(!config.includes(FORBIDDEN_PROJECT));
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    for (const key of ['SUPABASE_DB_URL', 'PGHOST', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE'])
        assert(!process.env[key], 'Ambient database routing override refused');
    for (const key of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        assert(!process.env[key] || process.env[key] === PROJECT, 'Ambient project override refused');
}

function cliResult(args, parseJson = true) {
    requireLink();
    const result = spawnSync(CLI, args, {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    if (result.error || result.status !== 0) {
        const safeStates = ['22023', '22P02', '22004', '25000', '25006', '25P02', '42501', '42601', '42703', '42803',
            '42883', '42P01', '42P07', '55P03', '57014', '53300', '54000', '08000', '08006', '28P01'];
        const privateOutput = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
        const sqlState = privateOutput.match(/(?:ERROR:\s*|SQLSTATE\s*[:=]\s*|"code"\s*:\s*")([0-9A-Z]{5})/i)?.[1]?.toUpperCase();
        diagnostic = result.error?.code === 'ETIMEDOUT' ? 'cli-timeout'
            : safeStates.includes(sqlState) ? `sqlstate-${sqlState}` : 'cli-refused-unclassified';
        throw new Error('Isolated command refused');
    }
    // A malformed management response can retain its raw text in parser errors.
    // main's fixed-label catch never prints that text, a stack, cause or argv.
    if (!parseJson) return undefined;
    try { return JSON.parse(result.stdout); }
    catch { diagnostic = 'cli-json-framing'; throw new Error('Isolated JSON refused'); }
}

function sqlFile(label, sql) {
    const path = join(scratch, `${label}.local.sql`);
    writeFileSync(path, sql, { mode: 0o600, flag: 'wx' });
    temporarySql.push(path);
    return path;
}

function queryFile(label, sql, parseJson = true) {
    return cliResult(['db', 'query', '--linked', '--workdir', HERE, '--output', 'json', '--file', sqlFile(label, sql)], parseJson);
}

function extractDefinitions(source) {
    assert.equal(sha256(source), SOURCE_HASH, 'Approved policy SQL source changed');
    return TARGETS.map((target) => {
        const marker = `CREATE FUNCTION e2ee_research.${target.name}(`;
        assert.equal(source.split(marker).length, 2);
        const start = source.indexOf(marker), end = source.indexOf('\nEND $$;', start);
        assert(end > start);
        const definition = source.slice(start, end + '\nEND $$;'.length);
        assert.equal((definition.match(/^CREATE FUNCTION /gm) ?? []).length, 1);
        const bodyStart = definition.indexOf('AS $$');
        assert(bodyStart > 0 && definition.lastIndexOf('$$;') > bodyStart);
        const body = definition.slice(bodyStart + 'AS $$'.length, definition.lastIndexOf('$$;'));
        assert.equal(sha256(body), target.target);
        return { ...target, body, replacement: definition.replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ') };
    });
}

// One SELECT snapshot: raw target bodies stay private in memory; only their
// SHA-256 hashes enter receipts. Data MD5s are change diagnostics, not an audit
// or cryptographic attestation. No keys, ciphertext or rows are returned.
function snapshotExpression() {
    const targetSignatures = TARGETS.map((item) => `${literal(item.signature)}::regprocedure`).join(',');
    const tableSnapshots = TABLES.map((name) => `jsonb_build_object('name',${literal(name)},
        'count',(SELECT count(*) FROM e2ee_research.${name}),
        'digest',(SELECT md5(COALESCE(string_agg(fingerprint,'' ORDER BY fingerprint COLLATE "C"),''))
          FROM (SELECT md5(row_to_json(row_value)::text) AS fingerprint FROM e2ee_research.${name} row_value) hashes))`).join(',');
    const metadata = `jsonb_build_object('oid',p.oid::bigint,'signature',p.oid::regprocedure::text,
        'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'securityDefiner',p.prosecdef,
        'configuration',p.proconfig,'volatility',p.provolatile,'language',l.lanname,
        'result',pg_get_function_result(p.oid),'arguments',pg_get_function_arguments(p.oid),
        'argumentNames',p.proargnames,'strict',p.proisstrict,'leakproof',p.proleakproof,
        'parallel',p.proparallel,'kind',p.prokind,'returnsSet',p.proretset,'cost',p.procost,'rows',p.prorows)`;
    return `jsonb_build_object(
      'functions',(SELECT jsonb_agg(${metadata} || jsonb_build_object('body',p.prosrc) ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid IN (${targetSignatures})),
      'otherFunctions',(SELECT jsonb_agg(${metadata} || jsonb_build_object('bodyDigest',md5(p.prosrc)) ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='e2ee_research' AND p.oid NOT IN (${targetSignatures})),
      'schema',(SELECT jsonb_build_object('oid',oid,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text)
        FROM pg_namespace WHERE nspname='e2ee_research'),
      'relations',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'kind',c.relkind,
        'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity)
        ORDER BY c.relname COLLATE "C") FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='e2ee_research'),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.conname,'definition',pg_get_constraintdef(c.oid))
        ORDER BY c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='e2ee_research'),
      'policies',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname),'[]'::jsonb)
        FROM pg_policies p WHERE p.schemaname='e2ee_research'),
      'roles',(SELECT jsonb_agg(jsonb_build_object('oid',oid,'name',rolname,'login',rolcanlogin,'super',rolsuper,
        'createRole',rolcreaterole,'createDb',rolcreatedb,'bypassRls',rolbypassrls,'inherit',rolinherit,
        'connectionLimit',rolconnlimit,'configuration',rolconfig) ORDER BY rolname COLLATE "C")
        FROM pg_roles WHERE rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge')),
      'memberships',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',u.rolname,'grantor',g.rolname,
        'admin',m.admin_option,'inherit',to_jsonb(m)->'inherit_option','set',to_jsonb(m)->'set_option')
        ORDER BY r.rolname,u.rolname,g.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
        JOIN pg_roles u ON u.oid=m.member JOIN pg_roles g ON g.oid=m.grantor
        WHERE r.rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge')
           OR u.rolname IN ('e2ee_research_owner','e2ee_research_gateway','e2ee_pilot_edge')),
      'data',jsonb_build_array(${tableSnapshots}),
      'privileges',jsonb_build_object(
        'signedOnly',(SELECT bool_and(has_function_privilege(roles.name,p.oid,'EXECUTE') =
          (roles.name='e2ee_research_gateway' AND p.oid IN (${SIGNED_FUNCTIONS.map((item) => `${literal(item)}::regprocedure`).join(',')})))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='e2ee_research'),
        'tablesClosed',(SELECT bool_and(NOT has_table_privilege(roles.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='e2ee_research' AND c.relkind='r'),
        'sequencesClosed',(SELECT COALESCE(bool_and(NOT has_sequence_privilege(roles.name,c.oid,'USAGE,SELECT,UPDATE')),true)
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name) CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='e2ee_research' AND c.relkind='S'),
        'publicClosed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
          LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='e2ee_research' AND a.grantee=0),
        'schemaClosed',(SELECT bool_and(has_schema_privilege(roles.name,'e2ee_research','USAGE') = (roles.name='e2ee_research_gateway'))
          FROM (VALUES ${values(PUBLIC_ROLES)}) roles(name)),
        'gatewaySet',pg_has_role('e2ee_pilot_edge','e2ee_research_gateway','SET'),
        'ownerForbidden',NOT pg_has_role('e2ee_pilot_edge','e2ee_research_owner','SET'))) `;
}

function readSnapshot(label, expression) {
    const result = queryFile(label, `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog; SET LOCAL TimeZone = 'UTC';
SET LOCAL ROLE e2ee_research_owner;
SELECT ${expression} AS state;
RESET ROLE; COMMIT;\n`);
    // Refuse unknown CLI framing rather than guess or continue to an update.
    invariant(result && typeof result === 'object' && !Array.isArray(result), 'snapshot-framing-object');
    invariant(Array.isArray(result.rows), 'snapshot-framing-rows-array');
    invariant(result.rows.length === 1, result.rows.length === 0 ? 'snapshot-framing-zero-rows' : 'snapshot-framing-row-count');
    invariant(result.rows[0] && typeof result.rows[0] === 'object' && !Array.isArray(result.rows[0]), 'snapshot-framing-row-object');
    invariant(Object.keys(result.rows[0]).length === 1 && Object.hasOwn(result.rows[0], 'state'), 'snapshot-framing-state-field');
    invariant(result.rows[0].state && typeof result.rows[0].state === 'object' && !Array.isArray(result.rows[0].state), 'snapshot-framing-state-object');
    return result.rows[0].state;
}

function validateSnapshot(state, definitions, sourceFunctionCount, targetOnly = false) {
    invariant(state && Array.isArray(state.functions) && state.functions.length === 3, 'invariant-target-function-count');
    invariant(Array.isArray(state.otherFunctions) && state.otherFunctions.length === sourceFunctionCount - 3, 'invariant-other-function-count');
    equalInvariant(state.schema?.owner, 'e2ee_research_owner', 'invariant-schema-owner');
    equalInvariant(state.privileges, { signedOnly: true, tablesClosed: true, sequencesClosed: true,
        publicClosed: true, schemaClosed: true, gatewaySet: true, ownerForbidden: true }, 'invariant-closed-privileges');
    invariant(Array.isArray(state.roles) && state.roles.length === 3, 'invariant-role-count');
    for (const role of state.roles) {
        invariant(['e2ee_research_owner', 'e2ee_research_gateway', 'e2ee_pilot_edge'].includes(role.name), 'invariant-role-name');
        invariant(['super', 'createRole', 'createDb', 'bypassRls', 'inherit'].every((field) => role[field] === false), 'invariant-role-capabilities');
        equalInvariant(role.login, role.name === 'e2ee_pilot_edge', 'invariant-role-login');
        equalInvariant(role.connectionLimit, role.name === 'e2ee_pilot_edge' ? 2 : -1, 'invariant-role-connection-limit');
    }
    invariant(Array.isArray(state.relations), 'invariant-relation-array');
    equalInvariant(state.relations.filter((item) => item.kind === 'r').map((item) => item.name).sort(), [...TABLES].sort(), 'invariant-table-set');
    for (const relation of state.relations) {
        equalInvariant(relation.owner, 'e2ee_research_owner', 'invariant-relation-owner');
        if (relation.kind === 'r') equalInvariant(relation.rls, true, 'invariant-table-rls');
    }
    invariant(Array.isArray(state.data) && state.data.length === TABLES.length, 'invariant-data-table-count');
    for (const item of state.data) invariant(Number.isSafeInteger(item.count) && item.count >= 0 && /^[0-9a-f]{32}$/.test(item.digest), 'invariant-data-count-digest');
    for (const definition of definitions) {
        const current = state.functions.find((item) => item.signature === definition.signature);
        const prefix = `invariant-${definition.name}`;
        invariant(current, `${prefix}-signature-missing`);
        const oidShape = typeof current.oid === 'string'
            ? (/^[1-9][0-9]{0,9}$/.test(current.oid) ? 'canonical-numeric-string' : 'noncanonical-string')
            : typeof current.oid === 'number' ? 'number' : 'other-type';
        invariant(Number.isSafeInteger(current.oid), `${prefix}-oid-${oidShape}`);
        equalInvariant(current.owner, 'e2ee_research_owner', `${prefix}-owner`);
        equalInvariant(current.securityDefiner, !definition.immutable, `${prefix}-security-definer`);
        equalInvariant(current.volatility, definition.immutable ? 'i' : 'v', `${prefix}-volatility`);
        equalInvariant(current.language, 'plpgsql', `${prefix}-language`);
        equalInvariant(current.result, 'jsonb', `${prefix}-result-type`);
        equalInvariant(current.configuration, ['search_path=pg_catalog'], `${prefix}-search-path`);
        equalInvariant(current.strict, false, `${prefix}-strict`);
        equalInvariant(current.leakproof, false, `${prefix}-leakproof`);
        equalInvariant(current.parallel, 'u', `${prefix}-parallel`);
        equalInvariant(current.kind, 'f', `${prefix}-kind`);
        equalInvariant(current.returnsSet, false, `${prefix}-returns-set`);
        equalInvariant(current.cost, 100, `${prefix}-cost`);
        equalInvariant(current.rows, 0, `${prefix}-rows`);
        invariant(typeof current.body === 'string', `${prefix}-body-type`);
        const digest = sha256(current.body);
        invariant(digest === definition.target || (!targetOnly && digest === definition.baseline), `${prefix}-approved-body-hash`);
    }
}

function preserved(state) {
    return { ...state, functions: state.functions.map(({ body, ...metadata }) => metadata) };
}

async function main() {
    const args = process.argv.slice(2);
    assert(args.length <= 1);
    const operation = args[0] ?? 'inspect';
    assert(['inspect', 'apply-policy'].includes(operation), 'Explicit isolated operation required');
    requireLink();
    const source = readFileSync(join(HERE, '../relay/relay.sql'), 'utf8');
    const definitions = extractDefinitions(source);
    const sourceFunctionCount = (source.match(/^CREATE FUNCTION /gm) ?? []).length;
    scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-policy-'));
    chmodSync(scratch, 0o700);
    stage = 'approved isolated project lookup';
    const projects = cliResult(['projects', 'list', '--output', 'json']);
    assert(Array.isArray(projects));
    const selected = projects.find((item) => item.id === PROJECT);
    assert(selected?.organization_id === ORGANIZATION && selected.name === 'Thalassa E2EE Pilot' && selected.status === 'ACTIVE_HEALTHY');
    const expression = snapshotExpression();
    stage = 'read-only policy preflight';
    const before = readSnapshot('preflight', expression);
    validateSnapshot(before, definitions, sourceFunctionCount);
    let after = before;
    const alreadyApplied = definitions.every((definition) =>
        sha256(before.functions.find((item) => item.signature === definition.signature).body) === definition.target);
    let deltaHash = null;
    if (operation === 'apply-policy' && !alreadyApplied) {
        stage = 'atomic policy-only replacement';
        const expectedAfter = { ...before, functions: before.functions.map((item) => ({ ...item,
            body: definitions.find((definition) => definition.signature === item.signature).body })) };
        // Catalog names are data, never SQL. Refuse a dollar-delimiter collision
        // in either embedded JSON snapshot before constructing a DO body.
        for (const state of [before, expectedAfter])
            assert(!['$policy_before$', '$policy_after$'].some((tag) => JSON.stringify(state).includes(tag)));
        const guardedDelta = `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL standard_conforming_strings = on;
SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL search_path = pg_catalog; SET LOCAL TimeZone = 'UTC';
SET LOCAL ROLE e2ee_research_owner;
SELECT e2ee_research.lock_pilot();
DO $policy_before$ BEGIN
  IF (${expression}) IS DISTINCT FROM ${literal(JSON.stringify(before))}::jsonb THEN
    RAISE EXCEPTION 'Isolated policy preflight changed' USING ERRCODE='22023';
  END IF;
END $policy_before$;
${definitions.map((item) => item.replacement).join('\n\n')}
DO $policy_after$ BEGIN
  IF (${expression}) IS DISTINCT FROM ${literal(JSON.stringify(expectedAfter))}::jsonb THEN
    RAISE EXCEPTION 'Isolated policy invariants changed' USING ERRCODE='22023';
  END IF;
END $policy_after$;
RESET ROLE; COMMIT;\n`;
        deltaHash = sha256(guardedDelta);
        applyAttempted = true;
        queryFile('apply-policy', guardedDelta, false);
        stage = 'read-only policy postflight';
        after = readSnapshot('postflight', expression);
        validateSnapshot(after, definitions, sourceFunctionCount, true);
        // Data may legitimately change after COMMIT. The stronger exact data,
        // ACL and catalog comparison already ran under the pilot lock BEFORE
        // COMMIT; only unchanged authority/catalog is required by this readback.
        const withoutData = (value) => { const { data, ...rest } = preserved(value); return rest; };
        assert.deepEqual(withoutData(after), withoutData(before));
    }
    stage = 'nonsecret policy receipt';
    const receipt = {
        version: 1, operation, status: operation === 'inspect' ? 'inspected' : alreadyApplied ? 'already-applied' : 'applied',
        project: PROJECT, organization: ORGANIZATION, schema: 'e2ee_research', completedAt: new Date().toISOString(),
        sourceSqlSha256: SOURCE_HASH, updaterSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), deltaSha256: deltaHash,
        functions: after.functions.map(({ signature, oid, body }) => ({ signature, oid, bodySha256: sha256(body) })),
        dataDiagnostics: { algorithm: 'MD5/counts; change diagnostics, not cryptographic attestation', before: before.data, after: after.data },
        preservedAuthoritySha256: sha256(JSON.stringify(preserved(before))),
        safety: {
            policyFunctionsOnly: true, existingFunctionOidsPreserved: true, existingPrivilegesChecked: true,
            atomicPrecommitInvariantsChecked: operation === 'apply-policy' && !alreadyApplied,
            rolesGrantsTablesParticipantsKeysOrRowsMutated: false, productionTouched: false, secretsPrinted: false,
            edgeFunctionDeployed: false, hostedPolicyHttpVerified: false, independentAuditPerformed: false,
        },
        statement: 'Isolated SQL policy support only. No Edge deployment, Auth changes, participant allowlist changes, registration, key rotation, row rewrite or production access. Hosted signed-policy success remains separately unverified.',
    };
    const receiptPath = join(scratch, 'policy-update-receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.info(`PASS isolated policy ${receipt.status}; nonsecret receipt ${receiptPath}`);
}

await main().catch(() => {
    console.error(`FAIL ${stage} (${diagnostic}); private diagnostics suppressed`);
    if (applyAttempted) console.error('Policy application may have committed; rerun inspect before any further action. Never reset or delete pilot data.');
    process.exitCode = 1;
}).finally(() => {
    for (const path of temporarySql) {
        try { unlinkSync(path); }
        catch { console.error('FAIL exact private SQL cleanup; private diagnostics suppressed'); process.exitCode = 1; }
    }
});

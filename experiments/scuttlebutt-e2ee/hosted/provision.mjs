// Deliberately separate from production migrations. No password/PAT in output.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const project = 'kmtupdvwdgbhtssqqova';
const organization = 'tideqlkywysyczrqreiz';
const cli = '/opt/homebrew/bin/supabase';
const common = ['--workdir', here, '--output', 'json'];
assert(checkout.includes('/.codex/worktrees/scuttlebutt-e2ee/'), 'Isolated worktree required');
const operation = process.argv[2];
assert(['bootstrap', 'repair-gateway-schema'].includes(operation), 'Explicit isolated operation required');
assert.equal(readFileSync(join(here, 'supabase/.temp/project-ref'), 'utf8').trim(), project);
assert(readFileSync(join(here, 'supabase/config.toml'), 'utf8').includes(`project_id = "${project}"`));
function run(arguments_, secrets = []) {
    const outcome = spawnSync(cli, arguments_, {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    // Do not echo query/secret-bearing error bodies from management APIs or SQL.
    if (outcome.error || outcome.status !== 0) {
        let diagnostic = outcome.stderr + outcome.stdout;
        for (const secret of secrets) diagnostic = diagnostic.replaceAll(secret, '<redacted>');
        const sqlError = diagnostic.match(/ERROR:\s+([0-9A-Z]{5}):/);
        if (sqlError) console.error(`Isolated SQL failure ${sqlError[1]}; private message suppressed`);
        throw new Error('Isolated provisioning command failed; secret-bearing command output suppressed');
    }
    return outcome.stdout;
}
const selected = JSON.parse(run(['projects', 'list', '--output', 'json'])).find((item) => item.id === project);
assert(
    selected &&
        selected.organization_id === organization &&
        selected.name === 'Thalassa E2EE Pilot' &&
        selected.status === 'ACTIVE_HEALTHY',
    'Approved test project must be healthy in its separate organization',
);
if (operation === 'repair-gateway-schema') {
    // Supabase's postgres bootstrap role is not a superuser and NOINHERIT owner
    // membership does not grant schema authority. Issue the exact grant as owner.
    const statement =
        'BEGIN; SET LOCAL ROLE e2ee_research_owner; GRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_gateway; RESET ROLE; COMMIT;';
    run(['db', 'query', '--linked', ...common, statement]);
    const checked = JSON.parse(
        run([
            'db',
            'query',
            '--linked',
            ...common,
            "SELECT has_schema_privilege('e2ee_research_gateway','e2ee_research','USAGE') AS gateway_schema_access;",
        ]),
    );
    assert.deepEqual(checked.rows, [{ gateway_schema_access: true }]);
    console.info('PASS isolated gateway schema USAGE restored; no table or owner privileges added');
    process.exit(0);
}
const before = JSON.parse(
    run([
        'db',
        'query',
        '--linked',
        ...common,
        "select (select count(*) from pg_roles where rolname like 'e2ee_%') as roles, (select count(*) from pg_namespace where nspname='e2ee_research') as schemas;",
    ]),
).rows[0];
assert.equal(before.roles, 0, 'Existing roles require investigation, never overwrite');
assert.equal(before.schemas, 0, 'Existing schema requires investigation, never overwrite');
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-hosted-'));
chmodSync(scratch, 0o700);
const password = randomBytes(32).toString('hex');
const secretPath = join(scratch, 'edge-secrets.local');
const databaseUrl = `postgresql://e2ee_pilot_edge:${password}@db.${project}.supabase.co:5432/postgres`;
// Recoverable on this Mac, owner-only; never a repo file or shell argument.
writeFileSync(secretPath, `E2EE_PILOT_DATABASE_URL=${databaseUrl}\nE2EE_PILOT_PARTICIPANTS=\n`, {
    mode: 0o600,
    flag: 'wx',
});
const original = readFileSync(join(here, '../relay/relay.sql'), 'utf8');
// Supabase's non-superuser postgres creator does not automatically receive SET.
// Grant only the existing administrative bootstrap role these capabilities;
// the hosted edge login below must NEVER receive owner membership.
const marker = 'CREATE ROLE e2ee_research_gateway NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;';
assert.equal(original.split(marker).length, 2, 'Unexpected research role framing');
const schemaGrant =
    'GRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_gateway;\nSET LOCAL ROLE e2ee_research_owner;';
assert.equal(original.split(schemaGrant).length, 2, 'Unexpected schema grant framing');
const research = original
    .replace(
        marker,
        marker +
            '\nGRANT e2ee_research_owner TO postgres WITH INHERIT FALSE, SET TRUE;\nGRANT e2ee_research_gateway TO postgres WITH INHERIT FALSE, SET TRUE;',
    )
    .replace(
        schemaGrant,
        'SET LOCAL ROLE e2ee_research_owner;\nGRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_gateway;',
    );
assert(research.endsWith('COMMIT;\n'), 'Unexpected SQL bootstrap framing');
const hardening = `
SET LOCAL ROLE e2ee_research_owner;
REVOKE EXECUTE ON FUNCTION e2ee_research.revoke_device(text,text) FROM e2ee_research_gateway;
REVOKE EXECUTE ON FUNCTION e2ee_research.set_block(text,text,boolean) FROM e2ee_research_gateway;
REVOKE EXECUTE ON FUNCTION e2ee_research.claim_prekey(text,text,text,text,text) FROM e2ee_research_gateway;
REVOKE EXECUTE ON FUNCTION e2ee_research.send_message(text,jsonb) FROM e2ee_research_gateway;
REVOKE EXECUTE ON FUNCTION e2ee_research.list_messages(text,text,bigint,integer) FROM e2ee_research_gateway;
RESET ROLE;
CREATE ROLE e2ee_pilot_edge LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2;
GRANT e2ee_research_gateway TO e2ee_pilot_edge WITH INHERIT FALSE, SET TRUE;
ALTER ROLE e2ee_pilot_edge SET search_path = pg_catalog;
ALTER ROLE e2ee_pilot_edge SET statement_timeout = '4s';
ALTER ROLE e2ee_pilot_edge SET lock_timeout = '1s';
COMMIT;
`;
const sqlPath = join(scratch, 'bootstrap.local');
writeFileSync(sqlPath, research.slice(0, -'COMMIT;\n'.length) + hardening, { mode: 0o600, flag: 'wx' });
try {
    run(['db', 'query', '--linked', ...common, '--file', sqlPath], [password, databaseUrl]);
    run(['secrets', 'set', '--project-ref', project, '--env-file', secretPath, ...common], [password, databaseUrl]);
    const receipt = {
        project,
        organization,
        schema: 'e2ee_research',
        login: 'e2ee_pilot_edge',
        participantEnrollment: 'closed',
        at: new Date().toISOString(),
        source: 'live management API',
        secretsPrinted: false,
    };
    const receiptPath = join(scratch, 'provision-receipt.json');
    assert(!existsSync(receiptPath));
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.info(JSON.stringify({ ...receipt, receiptPath, secretPath }));
} finally {
    // This exact private temporary SQL contains a password, not user voyage data.
    unlinkSync(sqlPath);
}

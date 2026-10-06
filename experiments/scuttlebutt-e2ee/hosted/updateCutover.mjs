/** Explicit existing-project cutover support ONLY. Default inspect is read-only.
 * No account selection, enrollment, keys, old rows, secrets, role changes,
 * notification overlay or Edge deployment. Never bootstrap an existing pilot.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SOURCE_SHA256,
    extractDefinitions,
    snapshotExpression,
    validateSnapshot,
    preserved,
    guardedDelta,
} from './cutoverMigration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const PROJECT = 'kmtupdvwdgbhtssqqova',
    ORGANIZATION = 'tideqlkywysyczrqreiz';
const CLI = '/opt/homebrew/bin/supabase';
const hash = (value) => createHash('sha256').update(value).digest('hex');
let stage = 'isolation guards',
    diagnostic = 'unclassified',
    scratch,
    applyAttempted = false;
const sqlPaths = [];
function guards() {
    assert(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert.equal(realpathSync(HERE), join(CHECKOUT, 'experiments/scuttlebutt-e2ee/hosted'));
    const ref = join(HERE, 'supabase/.temp/project-ref');
    assert(lstatSync(ref).isFile() && !lstatSync(ref).isSymbolicLink());
    assert.equal(readFileSync(ref, 'utf8').trim(), PROJECT);
    assert.equal(
        readFileSync(join(HERE, 'supabase/config.toml'), 'utf8'),
        "# Isolated pilot only. Never use the repository's production Supabase config.\n" +
            `project_id = "${PROJECT}"\n\n[functions.scuttlebutt-e2ee-pilot]\nverify_jwt = true\n`,
    );
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    for (const key of ['SUPABASE_DB_URL', 'PGHOST', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE'])
        assert(!process.env[key]);
    for (const key of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        assert(!process.env[key] || process.env[key] === PROJECT);
}
function cli(args, json = true) {
    guards();
    const result = spawnSync(CLI, args, {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    if (result.error || result.status !== 0) {
        const code = (result.stderr + '\n' + result.stdout)
            .match(/(?:ERROR:\s*|SQLSTATE\s*[:=]\s*|"code"\s*:\s*")([0-9A-Z]{5})/i)?.[1]
            ?.toUpperCase();
        diagnostic =
            result.error?.code === 'ETIMEDOUT'
                ? 'cli-timeout'
                : [
                        '22023',
                        '25000',
                        '42501',
                        '42601',
                        '42883',
                        '42P01',
                        '42P07',
                        '55P03',
                        '57014',
                        '53300',
                        '28P01',
                    ].includes(code)
                  ? `sqlstate-${code}`
                  : 'cli-unavailable';
        throw new Error('Isolated command refused');
    }
    if (!json) return undefined;
    try {
        return JSON.parse(result.stdout);
    } catch {
        diagnostic = 'cli-framing';
        throw new Error('Isolated framing refused');
    }
}
function query(label, sql, json = true) {
    const path = join(scratch, label + '.local.sql');
    writeFileSync(path, sql, { mode: 0o600, flag: 'wx' });
    sqlPaths.push(path);
    return cli(['db', 'query', '--linked', '--workdir', HERE, '--output', 'json', '--file', path], json);
}
function rows(value) {
    assert(
        value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Array.isArray(value.rows) &&
            value.rows.length === 1,
    );
    return value.rows[0];
}
function inspect(label) {
    const exists = rows(
        query(
            label + '-existence',
            `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL search_path=pg_catalog; SET LOCAL ROLE e2ee_research_owner;
SELECT to_regclass('e2ee_research.protected_accounts') IS NOT NULL AS table_present,
       to_regprocedure('e2ee_research.requires_protected(text)') IS NOT NULL AS helper_present;
RESET ROLE; COMMIT;`,
        ),
    );
    assert(
        typeof exists.table_present === 'boolean' && exists.table_present === exists.helper_present,
        'Mixed cutover state refused',
    );
    const result = rows(
        query(
            label,
            `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'; SET LOCAL TimeZone='UTC';
SET LOCAL search_path=pg_catalog; SET LOCAL ROLE e2ee_research_owner;
SELECT ${snapshotExpression(exists.table_present)} AS state;
RESET ROLE; COMMIT;`,
        ),
    );
    assert(Object.keys(result).length === 1 && result.state && typeof result.state === 'object');
    return result.state;
}
async function main() {
    const args = process.argv.slice(2),
        operation = args[0] ?? 'inspect';
    assert(args.length <= 1 && ['inspect', 'apply-cutover'].includes(operation));
    guards();
    const source = readFileSync(join(HERE, '../relay/relay.sql'), 'utf8');
    assert.equal(hash(source), SOURCE_SHA256);
    const definitions = extractDefinitions(source);
    scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-cutover-update-'));
    chmodSync(scratch, 0o700);
    stage = 'approved project lookup';
    const projects = cli(['projects', 'list', '--output', 'json']);
    assert(Array.isArray(projects));
    const selected = projects.find((p) => p.id === PROJECT);
    assert(
        selected?.organization_id === ORGANIZATION &&
            selected.name === 'Thalassa E2EE Pilot' &&
            selected.status === 'ACTIVE_HEALTHY',
    );
    stage = 'read-only cutover preflight';
    const before = inspect('preflight'),
        kind = validateSnapshot(before, definitions);
    let after = before,
        deltaSha256 = null;
    if (operation === 'apply-cutover' && kind === 'baseline') {
        stage = 'atomic scoped cutover support';
        const delta = guardedDelta(before, definitions);
        deltaSha256 = hash(delta);
        applyAttempted = true;
        query('apply-cutover', delta, false);
        stage = 'read-only cutover postflight';
        after = inspect('postflight');
        assert.equal(validateSnapshot(after, definitions), 'installed');
        // Exact old data/catalog checks ran under lock before COMMIT. Later
        // legitimate row activity is not disguised as migration corruption.
        const withoutData = (value) => {
            const { data, ...rest } = preserved(value);
            return rest;
        };
        assert.deepEqual(withoutData(after), withoutData(before));
    }
    const functions = after.functions.map(({ signature, oid, body }) => ({ signature, oid, bodySha256: hash(body) }));
    const receipt = {
        version: 1,
        operation,
        status: operation === 'inspect' ? 'inspected' : kind === 'installed' ? 'already-applied' : 'applied',
        project: PROJECT,
        organization: ORGANIZATION,
        schema: 'e2ee_research',
        completedAt: new Date().toISOString(),
        cutoverInstalled: validateSnapshot(after, definitions) === 'installed',
        sourceSqlSha256: SOURCE_SHA256,
        updaterSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
        migrationModuleSha256: hash(readFileSync(join(HERE, 'cutoverMigration.mjs'))),
        deltaSha256,
        functions,
        preservedAuthoritySha256: hash(JSON.stringify(preserved(after))),
        dataDiagnostics: {
            algorithm: 'MD5/counts; change diagnostics, not cryptographic attestation',
            before: before.data,
            after: after.data,
        },
        safety: {
            cutoverSupportOnly: true,
            existingFunctionOidsAndPermissionsPreserved: true,
            atomicPrecommitInvariantsChecked: applyAttempted,
            newEmptyPolicyTableCreated: applyAttempted,
            accountProtectionSelected: false,
            rolesSecretsParticipantsKeysOrOldRowsMutated: false,
            notificationsInstalled: false,
            edgeFunctionDeployed: false,
            productionTouched: false,
            secretsPrinted: false,
            independentAuditPerformed: false,
        },
        statement:
            'Isolated support only. No human account mode selection, enrollment, key replacement, old row rewrite, notification overlay, Edge deployment or production access.',
    };
    const path = join(scratch, 'cutover-update-receipt.json');
    writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.info(`PASS isolated cutover ${receipt.status}; nonsecret receipt ${path}`);
}
await main()
    .catch(() => {
        console.error(`FAIL ${stage} (${diagnostic}); private diagnostics suppressed`);
        if (applyAttempted)
            console.error('Application may have committed; inspect before any further action. Never reset pilot data.');
        process.exitCode = 1;
    })
    .finally(() => {
        for (const path of sqlPaths) {
            try {
                unlinkSync(path);
            } catch {
                console.error('FAIL exact temporary SQL cleanup');
                process.exitCode = 1;
            }
        }
    });

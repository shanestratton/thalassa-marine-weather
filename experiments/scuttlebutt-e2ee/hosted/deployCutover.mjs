/** Explicit isolated Edge deployment after guarded cutover SQL support.
 * Requires --deploy ABS_SUPPORT_RECEIPT. No secret/allowlist/SQL/account change.
 * Durable attempt record precedes CLI dispatch; uncertain outcomes require
 * read-only revision reconciliation, never automatic redeploy or rollback.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    fsyncSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDefinitions, SOURCE_SHA256 } from './cutoverMigration.mjs';
import {
    validateSupportReceipt,
    validateInstalledInspection,
    normalizeRevisionSet,
    fingerprintSecretMetadata,
    assertDeploymentPreserved,
} from './cutoverDeployment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)),
    CHECKOUT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const PROJECT = 'kmtupdvwdgbhtssqqova',
    ORGANIZATION = 'tideqlkywysyczrqreiz',
    SLUG = 'scuttlebutt-e2ee-pilot';
const ORIGIN = 'https://' + PROJECT + '.supabase.co',
    CLI = '/opt/homebrew/bin/supabase';
const SOURCE_NAMES = [
    'hosted/deployCutover.mjs',
    'hosted/cutoverDeployment.mjs',
    'hosted/updateCutover.mjs',
    'hosted/cutoverMigration.mjs',
    'hosted/supabase/config.toml',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.json',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.lock',
    'relay/hostedGateway.ts',
    'relay/httpGateway.ts',
    'relay/gateway.ts',
    'relay/supabaseAuth.ts',
    'relay/signedGateway.ts',
    'relay/deviceBundle.ts',
    'relay/signedRequest.ts',
    'relay/relay.sql',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let stage = 'isolation guards',
    receipt,
    receiptPath,
    attempted = false,
    expectedInputs,
    pins;
function guards() {
    assert(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert.equal(realpathSync(HERE), join(CHECKOUT, 'experiments/scuttlebutt-e2ee/hosted'));
    assert.equal(readFileSync(join(HERE, 'supabase/.temp/project-ref'), 'utf8').trim(), PROJECT);
    assert.equal(
        readFileSync(join(HERE, 'supabase/config.toml'), 'utf8'),
        "# Isolated pilot only. Never use the repository's production Supabase config.\n" +
            `project_id = "${PROJECT}"\n\n[functions.${SLUG}]\nverify_jwt = true\n`,
    );
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    for (const key of ['SUPABASE_DB_URL', 'PGHOST', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE'])
        assert(!process.env[key]);
    for (const key of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        assert(!process.env[key] || process.env[key] === PROJECT);
}
function sources() {
    const files = SOURCE_NAMES.map((name) => join(HERE, '..', name)).concat([
        join(CHECKOUT, 'services/chat/e2ee/directMessageEnvelope.ts'),
        join(CHECKOUT, 'services/chat/e2ee/encryptedDmDelivery.ts'),
    ]);
    return Object.fromEntries(
        files.map((path) => {
            assert(
                lstatSync(path).isFile() &&
                    !lstatSync(path).isSymbolicLink() &&
                    realpathSync(path).startsWith(CHECKOUT + '/'),
            );
            return [path.slice(CHECKOUT.length + 1), hash(readFileSync(path))];
        }),
    );
}
function stable() {
    guards();
    if (expectedInputs) assert.deepEqual(sources(), expectedInputs, 'Candidate sources changed');
}
function cli(args, json = true) {
    stable();
    const value = spawnSync(CLI, args, {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    stable();
    assert(!value.error && value.status === 0, 'Private CLI output suppressed');
    if (!json) return undefined;
    try {
        return JSON.parse(value.stdout);
    } catch {
        throw new Error('Isolated CLI framing refused');
    }
}
function privateJson(path) {
    assert(isAbsolute(path) && !realpathSync(path).startsWith(CHECKOUT + '/'));
    const file = lstatSync(path),
        parent = lstatSync(dirname(path));
    assert(
        file.isFile() &&
            !file.isSymbolicLink() &&
            file.uid === process.getuid() &&
            file.size < 128 * 1024 &&
            (file.mode & 0o777) === 0o600,
    );
    assert(
        parent.isDirectory() &&
            !parent.isSymbolicLink() &&
            parent.uid === process.getuid() &&
            (parent.mode & 0o777) === 0o700,
    );
    return JSON.parse(readFileSync(path));
}
function save() {
    if (!receiptPath) return;
    const temporary = receiptPath + '.next-' + randomUUID();
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
        writeFileSync(descriptor, JSON.stringify(receipt, null, 2) + '\n');
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, receiptPath);
    // No independent power-loss/parent-directory durability claim. A separate
    // immutable flushed attempt survives later progress/catch write failures.
}
function saveAttempt() {
    const path = join(dirname(receiptPath), 'immutable-attempt.json');
    receipt.immutableAttemptPath = path;
    const descriptor = openSync(path, 'wx', 0o600);
    try {
        writeFileSync(descriptor, JSON.stringify(receipt, null, 2) + '\n');
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}
function revisions() {
    return normalizeRevisionSet(
        cli(['functions', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']),
    );
}
function secrets() {
    return fingerprintSecretMetadata(
        cli(['secrets', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']),
    );
}
function inspect(applied) {
    stable();
    const result = spawnSync(process.execPath, [join(HERE, 'updateCutover.mjs'), 'inspect'], {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    stable();
    assert(!result.error && result.status === 0, 'Private SQL inspection output suppressed');
    const path = result.stdout.match(/^PASS isolated cutover inspected; nonsecret receipt (\/[^\r\n]+)$/m)?.[1];
    assert(path);
    return { path, state: validateInstalledInspection(privateJson(path), applied, pins) };
}
async function negative(name, path, init, status, runtimeBody) {
    stable();
    const url = ORIGIN + '/functions/v1/' + SLUG + path;
    const response = await fetch(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: globalThis.AbortSignal.timeout(15000),
    });
    assert(!response.redirected && response.url === url && response.status === status && response.body);
    const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
        chunks = 0,
        body = '';
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.byteLength;
            assert(++chunks <= 64 && bytes <= 4096);
            body += decoder.decode(item.value, { stream: true });
        }
        body += decoder.decode();
        if (runtimeBody) {
            assert.deepEqual(JSON.parse(body), { version: 1, error: 'request-unresolved' });
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    stable();
    receipt.httpChecks.push({ name, status, genericRuntimeBodyChecked: runtimeBody });
    save();
}
async function main() {
    const [action, path, ...extra] = process.argv.slice(2);
    assert(action === '--deploy' && path && !extra.length);
    guards();
    expectedInputs = sources();
    const defs = extractDefinitions(readFileSync(join(HERE, '../relay/relay.sql'), 'utf8'));
    pins = {
        project: PROJECT,
        organization: ORGANIZATION,
        sourceSqlSha256: SOURCE_SHA256,
        updaterSha256: hash(readFileSync(join(HERE, 'updateCutover.mjs'))),
        migrationModuleSha256: hash(readFileSync(join(HERE, 'cutoverMigration.mjs'))),
        functions: defs.targets.map((target) => ({ signature: target.signature, bodySha256: target.target })),
    };
    const applied = validateSupportReceipt(privateJson(path), pins);
    const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-cutover-deploy-'));
    chmodSync(scratch, 0o700);
    receiptPath = join(scratch, 'deployment-receipt.json');
    receipt = {
        version: 1,
        status: 'preparing',
        project: PROJECT,
        organization: ORGANIZATION,
        sqlReceipt: path,
        localSourceHashes: expectedInputs,
        httpChecks: [],
        deploymentOutcome: 'not-attempted',
        positiveSignedCutoverHttpExecuted: false,
        humanEnrollmentExecuted: false,
        nativeExchangeExecuted: false,
        productionTouched: false,
        secretsPrinted: false,
        independentAuditPerformed: false,
        deployedSourceIndependentlyAttested: false,
        sourceEvidence:
            'Local candidate source hashes and server-reported bundle digest are separate; no independently matched compiled artifact.',
    };
    save();
    console.info('Nonsecret isolated deployment receipt: ' + receiptPath);
    stage = 'approved isolated project';
    const projects = cli(['projects', 'list', '--output', 'json']);
    assert(Array.isArray(projects));
    const selectedProject = projects.find((p) => p.id === PROJECT);
    assert(
        selectedProject?.organization_id === ORGANIZATION &&
            selectedProject.name === 'Thalassa E2EE Pilot' &&
            selectedProject.status === 'ACTIVE_HEALTHY',
    );
    stage = 'fresh installed SQL and deployment preflight';
    const beforeSql = inspect(applied),
        beforeRevisions = revisions();
    const selected = beforeRevisions.find((v) => v.slug === SLUG);
    assert(selected && selected.status === 'ACTIVE' && selected.verifyJwt === true);
    const before = { inspection: beforeSql.state, secretsFingerprint: secrets(), sourceHashes: sources() };
    receipt.beforeSqlInspection = beforeSql.path;
    receipt.beforeRevision = selected;
    receipt.secretsFingerprintBefore = before.secretsFingerprint;
    receipt.status = 'attempting';
    receipt.deploymentOutcome = 'unknown';
    attempted = true;
    saveAttempt();
    save();
    stage = 'single explicit isolated Edge deployment';
    cli(['functions', 'deploy', SLUG, '--project-ref', PROJECT, '--workdir', HERE, '--use-api'], false);
    stage = 'revision and unchanged secret verification';
    const afterRevisions = revisions(),
        deployed = afterRevisions.find((v) => v.slug === SLUG);
    assert(
        deployed?.id === selected.id &&
            deployed.status === 'ACTIVE' &&
            deployed.verifyJwt === true &&
            deployed.version === selected.version + 1,
    );
    assert.deepEqual(
        afterRevisions.filter((v) => v.slug !== SLUG),
        beforeRevisions.filter((v) => v.slug !== SLUG),
    );
    receipt.afterRevision = deployed;
    receipt.deploymentOutcome = 'revision-observed';
    save();
    stage = 'negative Auth and runtime checks';
    const keys = cli(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
    assert(Array.isArray(keys));
    const publicKey = keys.find((v) => v.name === 'anon')?.api_key;
    assert(typeof publicKey === 'string' && publicKey.length > 100 && publicKey.length < 8192);
    await negative('missing-authorization', '/v1/dispatch', { method: 'POST', body: '{}' }, 401, false);
    const headers = { authorization: 'Bearer ' + publicKey, apikey: publicKey, 'content-type': 'application/json' };
    await negative('unknown-route', '/v1/unknown', { method: 'POST', headers, body: '{}' }, 404, true);
    await negative('wrong-method', '/v1/dispatch', { method: 'GET', headers }, 405, true);
    const wire = JSON.stringify({
        version: 1,
        protocol: 'olm-v1',
        userId: 'pilot-owner',
        deviceId: 'pilot-device',
        action: 'account-mode',
        requestId: 'cutover-negative',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        payload: '[]',
        signature: Buffer.alloc(64).toString('base64').replace(/=+$/, ''),
    });
    await negative('anon-is-not-user', '/v1/dispatch', { method: 'POST', headers, body: wire }, 503, true);
    stage = 'full six-table state and authority postflight';
    const afterSql = inspect(applied);
    const after = { inspection: afterSql.state, secretsFingerprint: secrets(), sourceHashes: sources() };
    assertDeploymentPreserved(before, after);
    receipt.afterSqlInspection = afterSql.path;
    receipt.secretsFingerprintAfter = after.secretsFingerprint;
    receipt.existingSixTableDataCheckedAuthoritySecretsAndHumanAllowlistPreserved = true;
    receipt.status = 'passed';
    receipt.completedAt = new Date().toISOString();
    save();
    console.info('PASS isolated cutover Edge deployment and four negative checks; nonsecret receipt ' + receiptPath);
}
await main().catch(() => {
    if (receipt) {
        receipt.status = 'failed';
        receipt.failedStage = stage;
    }
    try {
        save();
    } catch {
        console.error('FAIL progress receipt persistence; immutable attempt evidence retained if created');
    }
    console.error('FAIL ' + stage + '; private diagnostics suppressed');
    if (attempted)
        console.error(
            'Deployment may have committed. Reconcile revision/state read-only before any retry; never reset policy or autoredeploy.',
        );
    process.exitCode = 1;
});

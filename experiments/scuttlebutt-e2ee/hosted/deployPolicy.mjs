/** Explicit isolated Edge deployment AFTER the guarded SQL policy update.
 * node deployPolicy.mjs --deploy /absolute/private/policy-update-receipt.json
 * Keeps secrets/allowlist/JWT unchanged. Negative HTTP checks are not a signed
 * policy success, human login, native exchange or independent security audit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const SLUG = 'scuttlebutt-e2ee-pilot';
const CLI = '/opt/homebrew/bin/supabase';
const SOURCE_PATHS = [
    'hosted/deployPolicy.mjs', 'hosted/updatePolicy.mjs', 'hosted/supabase/config.toml',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.json',
    'hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.lock',
    'relay/hostedGateway.ts', 'relay/httpGateway.ts', 'relay/gateway.ts', 'relay/supabaseAuth.ts',
    'relay/signedGateway.ts', 'relay/deviceBundle.ts', 'relay/signedRequest.ts', 'relay/relay.sql',
].map((path) => join(HERE, '..', path)).concat([
    join(CHECKOUT, 'services/chat/e2ee/directMessageEnvelope.ts'),
    join(CHECKOUT, 'services/chat/e2ee/encryptedDmDelivery.ts'),
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
let stage = 'isolated configuration';
let receipt;
let receiptPath;
let deploymentAttempted = false;

function guards() {
    assert(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert.equal(realpathSync(HERE), join(CHECKOUT, 'experiments/scuttlebutt-e2ee/hosted'));
    assert.equal(readFileSync(join(HERE, 'supabase/.temp/project-ref'), 'utf8').trim(), PROJECT);
    assert.equal(readFileSync(join(HERE, 'supabase/config.toml'), 'utf8'),
        '# Isolated pilot only. Never use the repository\'s production Supabase config.\n' +
        `project_id = "${PROJECT}"\n\n[functions.${SLUG}]\nverify_jwt = true\n`);
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    for (const key of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        assert(!process.env[key] || process.env[key] === PROJECT);
}

function privateReceipt(path) {
    assert(isAbsolute(path) && !realpathSync(path).startsWith(CHECKOUT + '/'));
    const file = lstatSync(path), parent = lstatSync(dirname(path));
    assert(file.isFile() && !file.isSymbolicLink() && file.size < 64 * 1024);
    assert(parent.isDirectory() && !parent.isSymbolicLink());
    assert(file.uid === process.getuid() && parent.uid === process.getuid());
    assert((file.mode & 0o777) === 0o600 && (parent.mode & 0o777) === 0o700);
    return JSON.parse(readFileSync(path, 'utf8'));
}

function cli(args, json = true) {
    guards();
    const result = spawnSync(CLI, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } });
    assert(!result.error && result.status === 0, 'Private CLI output suppressed');
    return json ? JSON.parse(result.stdout) : undefined;
}

function sources() {
    return Object.fromEntries(SOURCE_PATHS.map((path) => {
        assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
        assert(realpathSync(path).startsWith(CHECKOUT + '/experiments/scuttlebutt-e2ee/') ||
            ['services/chat/e2ee/directMessageEnvelope.ts', 'services/chat/e2ee/encryptedDmDelivery.ts']
                .some((name) => realpathSync(path) === join(CHECKOUT, name)));
        return [path.slice(CHECKOUT.length + 1), hash(readFileSync(path))];
    }));
}

function revisions() {
    const result = cli(['functions', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']);
    assert(Array.isArray(result));
    return result.map(({ slug, id, version, status, verify_jwt, ezbr_sha256 }) =>
        ({ slug, id, version, status, verifyJwt: verify_jwt, bundleSha256: ezbr_sha256 }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
}

function secretFingerprint() {
    // This management endpoint returns names and digests, never secret values.
    const result = cli(['secrets', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']);
    assert(Array.isArray(result));
    const metadata = result.map(({ name, digest }) => {
        assert(typeof name === 'string' && /^[0-9a-f]{64}$/.test(digest));
        return { name, digest };
    }).sort((a, b) => a.name.localeCompare(b.name));
    assert(['E2EE_PILOT_DATABASE_URL', 'E2EE_PILOT_PARTICIPANTS'].every((name) => metadata.some((item) => item.name === name)));
    return hash(JSON.stringify(metadata));
}

function inspectSql() {
    const result = spawnSync(process.execPath, [join(HERE, 'updatePolicy.mjs'), 'inspect'], {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    assert(!result.error && result.status === 0);
    const path = result.stdout.match(/^PASS isolated policy inspected; nonsecret receipt (\/[^\r\n]+)$/m)?.[1];
    assert(path);
    const state = privateReceipt(path);
    assert.equal(state.project, PROJECT);
    assert.equal(state.organization, ORGANIZATION);
    return { path, state };
}

async function negativeHttp(name, path, init, expectedStatus, runtimeBody) {
    const url = `${ORIGIN}/functions/v1/${SLUG}${path}`;
    const response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(15_000) });
    assert(response.url === url && !response.redirected && response.status === expectedStatus);
    assert(response.body);
    const reader = response.body.getReader();
    let bytes = 0, chunks = 0, body = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
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
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    receipt.httpChecks.push({ name, status: response.status, genericRuntimeBodyChecked: runtimeBody });
}

async function main() {
    const [action, appliedPath, ...extra] = process.argv.slice(2);
    assert(action === '--deploy' && appliedPath && !extra.length);
    guards();
    const applied = privateReceipt(appliedPath);
    assert(['applied', 'already-applied'].includes(applied.status));
    assert.equal(applied.project, PROJECT); assert.equal(applied.organization, ORGANIZATION);
    assert.equal(applied.updaterSha256, hash(readFileSync(join(HERE, 'updatePolicy.mjs'))));
    assert.equal(applied.sourceSqlSha256, hash(readFileSync(join(HERE, '../relay/relay.sql'))));
    assert(applied.safety.policyFunctionsOnly && !applied.safety.productionTouched);
    const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-policy-deploy-')); chmodSync(scratch, 0o700);
    receiptPath = join(scratch, 'deployment-receipt.json');
    receipt = { version: 1, status: 'preparing', project: PROJECT, organization: ORGANIZATION,
        sqlReceipt: appliedPath, sourceHashes: sources(), httpChecks: [],
        positiveSignedPolicyHttpExecuted: false, humanEnrollmentExecuted: false, nativeExchangeExecuted: false,
        productionTouched: false, secretsPrinted: false, independentAuditPerformed: false };
    stage = 'approved isolated project';
    const projects = cli(['projects', 'list', '--output', 'json']);
    const project = projects.find((item) => item.id === PROJECT);
    assert(project?.organization_id === ORGANIZATION && project.name === 'Thalassa E2EE Pilot' && project.status === 'ACTIVE_HEALTHY');
    stage = 'policy and deployment preflight';
    const beforeSql = inspectSql(); receipt.beforeSqlInspection = beforeSql.path;
    assert.deepEqual(beforeSql.state.functions, applied.functions);
    const before = revisions(), selected = before.find((item) => item.slug === SLUG);
    assert(selected?.status === 'ACTIVE' && selected.verifyJwt === true && Number.isSafeInteger(selected.version));
    receipt.beforeRevision = selected;
    receipt.secretsFingerprintBefore = secretFingerprint();
    stage = 'single isolated Edge deployment';
    deploymentAttempted = true;
    cli(['functions', 'deploy', SLUG, '--project-ref', PROJECT, '--workdir', HERE, '--use-api'], false);
    stage = 'deployment and unchanged secrets verification';
    const after = revisions(), deployed = after.find((item) => item.slug === SLUG);
    assert(deployed?.id === selected.id && deployed.status === 'ACTIVE' && deployed.verifyJwt === true);
    assert(Number.isSafeInteger(deployed.version) && deployed.version > selected.version);
    assert(/^[0-9a-f]{64}$/.test(deployed.bundleSha256));
    assert.deepEqual(after.filter((item) => item.slug !== SLUG), before.filter((item) => item.slug !== SLUG));
    receipt.afterRevision = deployed;
    receipt.secretsFingerprintAfter = secretFingerprint();
    assert.equal(receipt.secretsFingerprintAfter, receipt.secretsFingerprintBefore);
    assert.deepEqual(sources(), receipt.sourceHashes);
    stage = 'negative runtime and Auth boundary checks';
    const keys = cli(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
    const publicKey = keys.find((item) => item.name === 'anon')?.api_key;
    assert(typeof publicKey === 'string' && publicKey.length > 100 && publicKey.length < 8192);
    await negativeHttp('missing-authorization', '/v1/dispatch', { method: 'POST', body: '{}' }, 401, false);
    const headers = { authorization: `Bearer ${publicKey}`, apikey: publicKey, 'content-type': 'application/json' };
    await negativeHttp('unknown-route', '/v1/unknown', { method: 'POST', headers, body: '{}' }, 404, true);
    await negativeHttp('wrong-method', '/v1/dispatch', { method: 'GET', headers }, 405, true);
    const wire = JSON.stringify({ version: 1, protocol: 'olm-v1', userId: 'pilot-owner', deviceId: 'pilot-device',
        action: 'policy', requestId: 'pilot-policy-negative', expiresAt: Math.floor(Date.now() / 1000) + 60,
        payload: '["pilot-peer","pilot-peer-device","pilot-peer-key"]',
        signature: Buffer.alloc(64).toString('base64').replace(/=+$/, '') });
    await negativeHttp('public-key-is-not-user-credential', '/v1/dispatch', { method: 'POST', headers, body: wire }, 503, true);
    stage = 'unchanged policy authority and data readback';
    const afterSql = inspectSql(); receipt.afterSqlInspection = afterSql.path;
    assert.deepEqual(afterSql.state.functions, beforeSql.state.functions);
    assert.equal(afterSql.state.preservedAuthoritySha256, beforeSql.state.preservedAuthoritySha256);
    assert.deepEqual(afterSql.state.dataDiagnostics.after, beforeSql.state.dataDiagnostics.after);
    receipt.status = 'passed'; receipt.completedAt = new Date().toISOString();
    receipt.existingSecretsAndParticipantAllowlistUnchanged = true;
    receipt.existingCatalogPrivilegesAndDataUnchanged = true;
    console.info(`PASS isolated policy Edge deployment and four negative checks; nonsecret receipt ${receiptPath}`);
}

await main().catch(() => {
    if (receipt) { receipt.status = 'failed'; receipt.failedStage = stage; }
    console.error(`FAIL ${stage}; private diagnostics suppressed`);
    if (deploymentAttempted) console.error('Deployment may have committed; inspect its revision before retrying. Never reset data or change participants to make a check pass.');
    process.exitCode = 1;
}).finally(() => {
    if (receiptPath && receipt) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
});

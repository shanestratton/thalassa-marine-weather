/**
 * EXPLICIT ISOLATED HOSTED CUTOVER FIXTURES ONLY. Run through fixtureRelayProof
 * with --cutover, using its separate fixed .invalid account pair. Human accounts
 * and the earlier liveProof fixture pair are refused before external operations.
 * Real Auth/HTTPS/Ed25519/SQL account policy; no native client, Olm ciphertext,
 * legacy production table, notification sink, reset, rotation or audit claim.
 * Selecting/revoking these disposable fixtures is one-way. A completed run
 * cannot re-prove a fresh legacy-before-selection state by resetting accounts.
 * Private keys persist beside credentials. Only fixed labels/status/receipt path
 * are printed; response bodies, exceptions, keys and tokens never escape.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceBundleSigningBytes, encodeDeviceBundle, parseAndVerifyDeviceBundle } from '../relay/deviceBundle.ts';
import { encodeSignedResearchRequest } from '../relay/signedRequest.ts';
import { PILOT_BASE_PATH, PILOT_ORIGIN, PILOT_PROJECT_REF } from '../relay/hostedGateway.ts';

const HERE = dirname(fileURLToPath(import.meta.url)),
    CHECKOUT = resolve(HERE, '../../..');
const PROJECT = 'kmtupdvwdgbhtssqqova',
    ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = `https://${PROJECT}.supabase.co`,
    BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
const CLI = '/opt/homebrew/bin/supabase';
const EMAILS = ['e2ee-cutover-fixture-a@thalassa.invalid', 'e2ee-cutover-fixture-b@thalassa.invalid'];
const RESERVED_HUMANS = ['f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73', '8fb85554-2385-49e9-8928-80d9407c05b1'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const now = () => Math.floor(Date.now() / 1000);
const passed = [],
    sqlPaths = [];
let stage = 'isolated configuration',
    lastHttpStatus,
    scratch,
    failureContext;

function guards() {
    assert(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert(PILOT_PROJECT_REF === PROJECT && PILOT_ORIGIN === ORIGIN && PILOT_BASE_PATH === BASE_PATH);
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    assert(readFileSync(join(HERE, 'supabase/.temp/project-ref'), 'utf8').trim() === PROJECT);
    assert(readFileSync(join(HERE, 'supabase/config.toml'), 'utf8').includes(`project_id = "${PROJECT}"`));
    for (const name of ['SUPABASE_DB_URL', 'PGHOST', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE'])
        assert(!process.env[name]);
    for (const name of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        assert(!process.env[name] || process.env[name] === PROJECT);
}
function privateJson(path) {
    assert(isAbsolute(path) && !resolve(path).startsWith(CHECKOUT + '/'));
    const file = lstatSync(path),
        parent = lstatSync(dirname(path));
    assert(file.isFile() && !file.isSymbolicLink() && file.size <= 65536 && file.uid === process.getuid());
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
    assert((file.mode & 0o777) === 0o600 && (parent.mode & 0o777) === 0o700);
    return JSON.parse(readFileSync(path, 'utf8'));
}
function cli(args) {
    guards();
    const result = spawnSync(CLI, args, {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    assert(!result.error && result.status === 0);
    return JSON.parse(result.stdout);
}
function query(label, sql) {
    const path = join(scratch, `cutover-${label}-${randomUUID()}.local.sql`);
    writeFileSync(path, sql, { mode: 0o600, flag: 'wx' });
    sqlPaths.push(path);
    const result = cli(['db', 'query', '--linked', '--workdir', HERE, '--output', 'json', '--file', path]);
    assert(Array.isArray(result.rows) && result.rows.length === 1);
    return result.rows[0];
}
function revision() {
    const values = cli(['functions', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']);
    assert(Array.isArray(values));
    const value = values.find((item) => item.slug === 'scuttlebutt-e2ee-pilot');
    assert(value?.status === 'ACTIVE' && value.verify_jwt === true && exact(UUID, value.id));
    assert(Number.isSafeInteger(value.version) && value.version > 0 && exact(/^[0-9a-f]{64}$/, value.ezbr_sha256));
    return { id: value.id, version: value.version, bundleSha256: value.ezbr_sha256, verifyJwt: true };
}
function sourceHashes() {
    const paths = [
        'hosted/cutoverLiveProof.mjs',
        'hosted/fixtureRelayProof.mjs',
        'relay/relay.sql',
        'relay/signedRequest.ts',
        'relay/signedGateway.ts',
        'relay/hostedGateway.ts',
        'relay/httpGateway.ts',
        'relay/deviceBundle.ts',
        'relay/supabaseAuth.ts',
        'hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
    ];
    return Object.fromEntries(paths.map((path) => [path, hash(readFileSync(join(HERE, '..', path)))]));
}
async function request(url, init, statuses, limit = 8192) {
    const target = new URL(url);
    assert(
        target.origin === ORIGIN &&
            target.protocol === 'https:' &&
            !target.username &&
            !target.password &&
            !target.hash,
    );
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url, {
            ...init,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
        });
        lastHttpStatus = response.status;
        assert(
            !controller.signal.aborted &&
                !response.redirected &&
                response.url === url &&
                statuses.includes(response.status),
        );
        assert(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''));
        const declared = response.headers.get('content-length');
        assert(declared === null || (/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= limit));
        assert(response.body);
        const reader = response.body.getReader(),
            decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '',
            bytes = 0,
            chunks = 0;
        try {
            for (;;) {
                assert(!controller.signal.aborted);
                const value = await reader.read();
                assert(!controller.signal.aborted);
                if (value.done) break;
                assert(++chunks <= 4096 && value.value instanceof Uint8Array);
                bytes += value.value.byteLength;
                assert(bytes <= limit);
                text += decoder.decode(value.value, { stream: true });
            }
            text += decoder.decode();
            assert(bytes > 0 && !controller.signal.aborted);
            return { status: response.status, body: JSON.parse(text) };
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
async function group(label, body) {
    stage = label;
    await body();
    passed.push(label);
    console.info(`PASS ${label}`);
}
async function post(actor, wire, endpoint = 'dispatch', statuses = [200], credential = actor.credential) {
    assert(exact(BEARER, credential) && credential.length <= 8192);
    return request(
        `${ORIGIN}${BASE_PATH}/v1/${endpoint}`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${credential}`,
                'content-type': 'application/json',
                accept: 'application/json',
                'accept-encoding': 'identity',
            },
            body: wire,
        },
        statuses,
    );
}
async function success(actor, wire, endpoint = 'dispatch') {
    const { body } = await post(actor, wire, endpoint);
    assert(body && body.version === 1 && JSON.stringify(Object.keys(body).sort()) === '["result","version"]');
    return body.result;
}
async function refuse(actor, wire, credential) {
    const { body } = await post(actor, wire, 'dispatch', [503], credential);
    assert(
        body &&
            JSON.stringify(Object.keys(body).sort()) === '["error","version"]' &&
            body.version === 1 &&
            body.error === 'request-unresolved',
    );
}
function signedWire(actor, action, payload = '[]', patch = {}, canonical = true) {
    const value = {
        version: 1,
        protocol: 'olm-v1',
        userId: actor.userId,
        deviceId: actor.deviceId,
        action,
        requestId: `cutover-${randomUUID()}`,
        expiresAt: now() + 240,
        payload,
        ...patch,
    };
    // Independent shared domain, including deliberately malformed signed inputs.
    const bytes = Buffer.from(
        JSON.stringify([
            'thalassa-relay-request',
            value.version,
            value.protocol,
            value.userId,
            value.deviceId,
            value.action,
            value.requestId,
            value.expiresAt,
            value.payload,
        ]),
    );
    const signed = { ...value, signature: b64(sign(null, bytes, actor.privateKey)) };
    const wire = JSON.stringify(signed);
    if (canonical) assert(encodeSignedResearchRequest(signed) === wire);
    return wire;
}
function assertMode(value, wire, mode) {
    const sent = JSON.parse(wire);
    assert(value && JSON.stringify(Object.keys(value).sort()) === '["mode","ownerDeviceId","ownerUserId","requestId"]');
    assert(
        value.requestId === sent.requestId &&
            value.ownerUserId === sent.userId &&
            value.ownerDeviceId === sent.deviceId &&
            value.mode === mode,
    );
}
function newFixture(userId) {
    const signing = generateKeyPairSync('ed25519'),
        curve = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
    const prekey = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }),
        tag = `cutover-${randomUUID()}`;
    const value = {
        version: 1,
        protocol: 'olm-v1',
        userId,
        deviceId: `${tag}-device`,
        identityKeyId: `${tag}-identity`,
        signingKey: b64(Buffer.from(signing.publicKey.export({ format: 'jwk' }).x, 'base64url')),
        curveKey: b64(Buffer.from(curve.x, 'base64url')),
        prekeyId: `${tag}-prekey`,
        prekey: b64(Buffer.from(prekey.x, 'base64url')),
        expiresAt: now() + 604740,
    };
    return {
        userId,
        deviceId: value.deviceId,
        bundle: encodeDeviceBundle({
            ...value,
            signature: b64(sign(null, deviceBundleSigningBytes(value), signing.privateKey)),
        }),
        signingJwk: signing.privateKey.export({ format: 'jwk' }),
    };
}
async function fixtureActor(value, account, credential) {
    assert(value && value.userId === account.userId && exact(UUID, value.userId));
    const bundle = await parseAndVerifyDeviceBundle(value.bundle, account.userId, now());
    assert(bundle.deviceId === value.deviceId);
    const privateKey = createPrivateKey({ key: value.signingJwk, format: 'jwk' });
    assert(
        b64(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')) === bundle.signingKey,
    );
    return { ...value, privateKey, credential };
}
function snapshot(accounts) {
    assert(accounts.every((account) => exact(UUID, account.userId)));
    const ids = accounts.map((account) => `'${account.userId}'`).join(',');
    const filters = {
        devices: `user_id NOT IN (${ids})`,
        blocks: `owner_id NOT IN (${ids}) AND other_id NOT IN (${ids})`,
        claims: `owner_id NOT IN (${ids}) AND target_user_id NOT IN (${ids})`,
        decisions: `owner_id NOT IN (${ids}) AND recipient_user_id NOT IN (${ids})`,
        requests: `owner_id NOT IN (${ids})`,
        protected_accounts: `owner_id NOT IN (${ids})`,
    };
    const preserved = Object.entries(filters)
        .map(
            ([table, filter]) => `'${table}',
        (SELECT jsonb_build_object('count',count(*),'md5',md5(COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text COLLATE "C")::text,'[]')))
         FROM e2ee_research.${table} entry WHERE ${filter})`,
        )
        .join(',');
    const result = query(
        'snapshot',
        `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'; SET LOCAL TimeZone='UTC';
SET LOCAL search_path=pg_catalog; SET LOCAL ROLE e2ee_research_owner;
DO $$ BEGIN PERFORM e2ee_research.lock_pilot(); END $$;
SELECT jsonb_build_object('preserved',jsonb_build_object(${preserved}),
 'devices',(SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY user_id),'[]') FROM e2ee_research.devices entry WHERE user_id IN (${ids})),
 'modes',(SELECT COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY owner_id),'[]') FROM e2ee_research.protected_accounts entry WHERE owner_id IN (${ids})),
 'requestCount',(SELECT count(*) FROM e2ee_research.requests WHERE owner_id IN (${ids})),
 'selectedRequests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('ownerId',request.owner_id,'deviceId',request.device_id,
    'requestId',request.request_id,'wireMd5',md5(request.request_wire),'outcome',request.outcome) ORDER BY request.owner_id),'[]')
    FROM e2ee_research.requests request JOIN e2ee_research.protected_accounts mode
    ON mode.owner_id=request.owner_id AND mode.selecting_device_id=request.device_id AND mode.selecting_request_id=request.request_id
    WHERE mode.owner_id IN (${ids}))) AS state;
RESET ROLE; COMMIT;`,
    );
    assert(result.state && Object.keys(result).length === 1);
    return result.state;
}
function checkAcl() {
    const result = query(
        'acl',
        `WITH roles(name) AS (VALUES ('anon'),('authenticated'),('service_role'),('e2ee_pilot_edge'),('e2ee_research_gateway'))
SELECT (SELECT bool_and(NOT has_table_privilege(name,'e2ee_research.protected_accounts','SELECT,INSERT,UPDATE,DELETE')) FROM roles) AS table_closed,
 (SELECT bool_and(NOT has_function_privilege(name,'e2ee_research.requires_protected(text)','EXECUTE')) FROM roles) AS helper_closed,
 (SELECT relrowsecurity FROM pg_class WHERE oid='e2ee_research.protected_accounts'::regclass) AS rls,
 (SELECT bool_and(has_function_privilege(name,'e2ee_research.execute_request(text,text,text,text,text,bigint,text)','EXECUTE')=(name='e2ee_research_gateway')) FROM roles) AS signed_boundary;`,
    );
    const fields = ['table_closed', 'helper_closed', 'rls', 'signed_boundary'];
    assert(
        result &&
            typeof result === 'object' &&
            !Array.isArray(result) &&
            Object.keys(result).length === fields.length &&
            fields.every((name) => Object.hasOwn(result, name) && result[name] === true),
    );
}

function failureReceipt(failedPhase) {
    if (!scratch || !failureContext) return;
    try {
        const path = join(scratch, `hosted-cutover-incomplete-receipt-${randomUUID()}.json`);
        writeFileSync(
            path,
            JSON.stringify(
                {
                    version: 1,
                    status: 'failed-or-incomplete',
                    project: PROJECT,
                    organization: ORGANIZATION,
                    fixtureActorsOnly: true,
                    completedAt: new Date().toISOString(),
                    failedPhase,
                    completedCheckCategories: [...passed],
                    localSourceHashes: failureContext.sourceHashes,
                    deployment: failureContext.deployment ?? null,
                    irreversibleState: {
                        gate: failureContext.gate,
                        selectionAttempted: failureContext.selectionAttempted,
                        selectionObserved: failureContext.selectionObserved,
                        fixtureRevocationAttempted: failureContext.fixtureRevocationAttempted,
                    },
                    instruction:
                        'Inspect authoritative hosted state. An attempted selection or revocation may have committed. Never reset accounts, replace keys, remove policy rows or resume this as a fresh-before/after pass.',
                    evidence: {
                        completePositiveProof: false,
                        humanAccountModeSelected: false,
                        productionTouched: false,
                        credentialsKeysSignaturesOrResponseBodiesRecorded: false,
                    },
                },
                null,
                2,
            ) + '\n',
            { mode: 0o600, flag: 'wx' },
        );
        console.error(`FAIL nonsecret incomplete cutover receipt ${path}`);
    } catch {
        console.error(
            'FAIL incomplete cutover receipt persistence; inspect existing private artifacts and hosted state',
        );
    }
}

async function main() {
    const [credentialsPath, option, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && (option === undefined || option === '--check-acl'));
    guards();
    const credentials = privateJson(credentialsPath);
    assert(
        credentials.project === PROJECT &&
            credentials.fixtureAccountsOnly === true &&
            Array.isArray(credentials.accounts) &&
            credentials.accounts.length === 2,
    );
    const accounts = credentials.accounts;
    assert(
        accounts.every(
            (account, index) =>
                exact(UUID, account.userId) &&
                account.email === EMAILS[index] &&
                !RESERVED_HUMANS.includes(account.userId) &&
                typeof account.password === 'string' &&
                account.password.length >= 24 &&
                account.password.length <= 256,
        ),
    );
    assert(accounts[0].userId !== accounts[1].userId);
    scratch = dirname(credentialsPath);
    failureContext = {
        sourceHashes: sourceHashes(),
        gate: 'fresh-preselection',
        selectionAttempted: false,
        selectionObserved: false,
        fixtureRevocationAttempted: false,
    };
    await group('cutover approved project and deployment pins', async () => {
        const selected = cli(['projects', 'list', '--output', 'json']).find((item) => item.id === PROJECT);
        assert(
            selected?.organization_id === ORGANIZATION &&
                selected.name === 'Thalassa E2EE Pilot' &&
                selected.status === 'ACTIVE_HEALTHY',
        );
    });
    const deployment = revision(),
        sources = sourceHashes();
    failureContext.deployment = deployment;
    stage = 'cutover fresh-policy preflight';
    const initial = snapshot(accounts);
    if (initial.modes.length !== 0) failureContext.gate = 'preexisting-selection-inspect-only';
    assert(initial.modes.length === 0, 'One-way selection already exists; never reset it to manufacture a fresh proof');
    if (option === '--check-acl')
        await group('cutover private policy table helper and signed ACL', async () => checkAcl());
    const keys = cli(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
    assert(Array.isArray(keys));
    const anon = keys.find((key) => key.name === 'anon')?.api_key;
    assert(exact(BEARER, anon) && anon.length <= 8192);
    const tokens = [];
    await group('cutover two fresh Auth tokens and authoritative users', async () => {
        for (const account of accounts) {
            const { body } = await request(
                `${ORIGIN}/auth/v1/token?grant_type=password`,
                {
                    method: 'POST',
                    headers: { apikey: anon, 'content-type': 'application/json', 'accept-encoding': 'identity' },
                    body: JSON.stringify({ email: account.email, password: account.password }),
                },
                [200],
                512 * 1024,
            );
            assert(
                exact(BEARER, body.access_token) &&
                    body.access_token.length <= 8192 &&
                    body.user?.id === account.userId,
            );
            const verified = await request(
                `${ORIGIN}/auth/v1/user`,
                {
                    method: 'GET',
                    headers: {
                        apikey: anon,
                        authorization: `Bearer ${body.access_token}`,
                        'accept-encoding': 'identity',
                    },
                },
                [200],
                512 * 1024,
            );
            assert(verified.body.id === account.userId && verified.body.email === account.email);
            tokens.push(body.access_token);
        }
    });
    const keyPath = join(scratch, 'hosted-cutover-signed-fixtures.local');
    let saved;
    try {
        saved = privateJson(keyPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        assert(
            initial.devices.length === 0,
            'Existing registrations require original private fixture keys, never replacements',
        );
        saved = {
            version: 1,
            project: PROJECT,
            organization: ORGANIZATION,
            fixtureAccountsOnly: true,
            actors: accounts.map((account) => newFixture(account.userId)),
        };
        writeFileSync(keyPath, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' });
    }
    assert(
        saved.version === 1 &&
            saved.project === PROJECT &&
            saved.organization === ORGANIZATION &&
            saved.fixtureAccountsOnly === true &&
            Array.isArray(saved.actors) &&
            saved.actors.length === 2,
    );
    const actors = [];
    for (let i = 0; i < 2; i++) actors.push(await fixtureActor(saved.actors[i], accounts[i], tokens[i]));
    const [alice, bob] = actors;
    await group('cutover real signed registration preserves immutable fixture keys', async () => {
        for (const actor of actors) {
            const prior = initial.devices.find((row) => row.user_id === actor.userId);
            if (prior) assert(prior.device_id === actor.deviceId && prior.signed_bundle === actor.bundle);
            if (prior?.revoked) continue;
            const result = await success(actor, actor.bundle, 'register');
            assert(result.registered === true && result.userId === actor.userId && result.deviceId === actor.deviceId);
        }
    });
    const registered = snapshot(accounts),
        diagnostic = signedWire(alice, 'account-mode');
    await group('cutover fresh legacy diagnostics do not consume ledger', async () => {
        assertMode(await success(alice, diagnostic), diagnostic, 'legacy-permitted');
        assertMode(await success(alice, diagnostic), diagnostic, 'legacy-permitted');
        const other = signedWire(bob, 'account-mode');
        assertMode(await success(bob, other), other, 'legacy-permitted');
        assert(snapshot(accounts).requestCount === registered.requestCount);
    });
    await group('cutover wrong Auth signing key and mutation signature refuse', async () => {
        const mutation = signedWire(alice, 'require-protected');
        await refuse(bob, mutation);
        await refuse(
            alice,
            signedWire(bob, 'require-protected', '[]', { userId: alice.userId, deviceId: alice.deviceId }),
        );
        const altered = JSON.parse(mutation),
            signature = Buffer.from(altered.signature, 'base64');
        signature[0] ^= 1;
        await refuse(alice, encodeSignedResearchRequest({ ...altered, signature: b64(signature) }));
        assert(snapshot(accounts).requestCount === registered.requestCount);
    });
    const selection = signedWire(alice, 'require-protected');
    writeFileSync(join(scratch, `cutover-original-request-${randomUUID()}.local`), selection + '\n', {
        mode: 0o600,
        flag: 'wx',
    });
    await group('cutover one-way selection and byte-exact signed retry', async () => {
        failureContext.selectionAttempted = true;
        failureContext.gate = 'selection-may-have-committed';
        assertMode(await success(alice, selection), selection, 'protected-required');
        failureContext.selectionObserved = true;
        failureContext.gate = 'selection-observed-not-fresh-replayable';
        const first = snapshot(accounts);
        assert(first.requestCount === registered.requestCount + 1 && first.modes.length === 1);
        assertMode(await success(alice, selection), selection, 'protected-required');
        const repeat = snapshot(accounts);
        assert(
            JSON.stringify(repeat.modes) === JSON.stringify(first.modes) && repeat.requestCount === first.requestCount,
        );
        assert(
            repeat.selectedRequests.length === 1 &&
                repeat.selectedRequests[0].requestId === JSON.parse(selection).requestId &&
                repeat.selectedRequests[0].wireMd5 === createHash('md5').update(selection).digest('hex'),
        );
    });
    await group('cutover original diagnostic reads current mode without ledger budget', async () => {
        const before = snapshot(accounts);
        assertMode(await success(alice, diagnostic), diagnostic, 'protected-required');
        assertMode(await success(alice, diagnostic), diagnostic, 'protected-required');
        const fresh = signedWire(alice, 'account-mode');
        assertMode(await success(alice, fresh), fresh, 'protected-required');
        assert(snapshot(accounts).requestCount === before.requestCount);
    });
    await group('cutover fresh revoked device cannot select protection', async () => {
        const before = snapshot(accounts);
        if (!before.devices.find((row) => row.user_id === bob.userId)?.revoked) {
            failureContext.fixtureRevocationAttempted = true;
            const revoked = await success(bob, signedWire(bob, 'revoke'));
            assert(revoked.revoked === true && revoked.userId === bob.userId && revoked.deviceId === bob.deviceId);
        }
        const revokedState = snapshot(accounts);
        await refuse(bob, signedWire(bob, 'require-protected'));
        const read = signedWire(bob, 'account-mode');
        assertMode(await success(bob, read), read, 'legacy-permitted');
        const after = snapshot(accounts);
        assert(
            after.requestCount === revokedState.requestCount &&
                after.modes.length === 1 &&
                !after.modes.some((row) => row.owner_id === bob.userId),
        );
    });
    await group('cutover downgrade payload nonce relabel and unsigned mode access refuse', async () => {
        const before = snapshot(accounts);
        for (const [action, payload] of [
            ['require-protected', '["legacy-permitted"]'],
            ['account-mode', '["legacy-permitted"]'],
            ['allow-legacy', '[]'],
        ])
            await refuse(alice, signedWire(alice, action, payload, {}, false));
        const original = JSON.parse(selection);
        await refuse(
            alice,
            signedWire(alice, 'require-protected', '[]', {
                requestId: original.requestId,
                expiresAt: original.expiresAt + 1,
            }),
        );
        const publicResult = await post(alice, diagnostic, 'dispatch', [401, 403, 503], anon);
        assert(publicResult.body && !Object.hasOwn(publicResult.body, 'result'));
        const after = snapshot(accounts);
        assert(
            after.requestCount === before.requestCount && JSON.stringify(after.modes) === JSON.stringify(before.modes),
        );
    });
    await group('cutover old human baseline rows keys and deployment stay unchanged', async () => {
        const after = snapshot(accounts);
        assert(JSON.stringify(after.preserved) === JSON.stringify(initial.preserved));
        assert(
            after.devices.every((row) =>
                actors.some(
                    (actor) =>
                        actor.userId === row.user_id &&
                        actor.deviceId === row.device_id &&
                        actor.bundle === row.signed_bundle,
                ),
            ),
        );
        assert(
            JSON.stringify(revision()) === JSON.stringify(deployment) &&
                JSON.stringify(sourceHashes()) === JSON.stringify(sources),
        );
    });
    const receiptPath = join(scratch, `hosted-cutover-live-receipt-${randomUUID()}.json`);
    writeFileSync(
        receiptPath,
        JSON.stringify(
            {
                version: 1,
                status: 'passed',
                project: PROJECT,
                organization: ORGANIZATION,
                fixtureActorsOnly: true,
                separateCutoverFixtures: true,
                completedAt: new Date().toISOString(),
                checkCategories: passed,
                leastPrivilegeAclChecked: option === '--check-acl',
                deployment,
                localSourceHashes: sources,
                oldDataPreservation: {
                    algorithm: 'MD5/counts change diagnostics, not cryptographic attestation',
                    before: initial.preserved,
                    after: snapshot(accounts).preserved,
                },
                evidence: {
                    liveSupabaseAuth: true,
                    hostedHttps: true,
                    realEd25519FixtureSignatures: true,
                    durableHostedAccountMode: true,
                    diagnosticsDoNotConsumeMutationLedger: true,
                    actualOlmEncryption: false,
                    ciphertextSent: false,
                    nativeClientsExecuted: false,
                    physicalDevicesExecuted: false,
                    productionLegacyTableEnforcement: false,
                    notificationsDispatched: false,
                    humanAccountModeSelected: false,
                    originalHumanAndBaselineRowsPreserved: true,
                    fixtureDeviceRevoked: true,
                    productionTouched: false,
                    independentSecurityAuditPerformed: false,
                    deployedSourceIndependentlyAttested: false,
                },
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
    );
    console.info(`PASS nonsecret cutover proof receipt ${receiptPath}`);
}
await main()
    .catch(() => {
        console.error(
            `FAIL ${stage}${Number.isInteger(lastHttpStatus) ? ` (HTTP ${lastHttpStatus})` : ''}; private diagnostics suppressed`,
        );
        failureReceipt(stage);
        process.exitCode = 1;
    })
    .finally(() => {
        let cleanupFailed = false;
        for (const path of sqlPaths) {
            try {
                unlinkSync(path);
            } catch {
                cleanupFailed = true;
                console.error('FAIL exact cutover SQL scratch cleanup');
                process.exitCode = 1;
            }
        }
        if (cleanupFailed) failureReceipt('exact cutover SQL scratch cleanup');
    });

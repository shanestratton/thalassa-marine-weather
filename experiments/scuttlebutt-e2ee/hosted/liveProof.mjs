/**
 * Explicit isolated LIVE relay smoke proof. Root must supply the owner-only
 * fixture account-credentials.local after deploying/enrolling ONLY disposable
 * actors. Requires fixtureAccountsOnly:true and the two fixed .invalid addresses
 * below. Human iPhone/iPad credentials are refused before any external operation.
 *
 * node --experimental-strip-types liveProof.mjs /absolute/private/account-credentials.local [--check-acl]
 *
 * Real Supabase Auth, HTTPS, Ed25519 signatures and hosted SQL receipts; synthetic
 * one-byte ciphertext ONLY. No Olm encryption, native clients, physical devices,
 * app integration, delivered/read acknowledgement or independent security audit.
 * This script signs in and writes fixture registrations/claims/relay requests.
 * It never deletes, resets, migrates, approves enrollment or changes server roles.
 * Private signing fixtures persist beside the credentials so reruns do not rotate
 * immutable registered keys or consume another one-time prekey. Never log inputs,
 * response bodies, exceptions, credentials, signatures, keys or ciphertext.
 */
import assert from 'node:assert/strict';
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomUUID,
    sign,
    verify,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceBundleSigningBytes, encodeDeviceBundle, parseAndVerifyDeviceBundle } from '../relay/deviceBundle.ts';
import { encodeResearchOutbox } from '../relay/gateway.ts';
import { encodeSignedResearchRequest, researchRequestSigningBytes } from '../relay/signedRequest.ts';
import { PILOT_BASE_PATH, PILOT_ORIGIN, PILOT_PROJECT_REF } from '../relay/hostedGateway.ts';
import {
    decodeDirectMessageEnvelope,
    encodeDirectMessageEnvelope,
} from '../../../services/chat/e2ee/directMessageEnvelope.ts';

const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(HERE, '../../..');
const CLI = '/opt/homebrew/bin/supabase';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const PRIVATE_FILE_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const DEADLINE_MS = 15_000;
const FIXTURE_EMAILS = ['e2ee-fixture-a@thalassa.invalid', 'e2ee-fixture-b@thalassa.invalid'];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const unpadded = (value) => Buffer.from(value).toString('base64').replace(/=+$/, '');
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
let activeGroup = 'isolated configuration';
let lastHttpStatus;
const passed = [];
const sourcePaths = [
    'experiments/scuttlebutt-e2ee/hosted/liveProof.mjs',
    'experiments/scuttlebutt-e2ee/hosted/provision.mjs',
    'experiments/scuttlebutt-e2ee/hosted/supabase/config.toml',
    'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/index.ts',
    'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.json',
    'experiments/scuttlebutt-e2ee/hosted/supabase/functions/scuttlebutt-e2ee-pilot/deno.lock',
    'experiments/scuttlebutt-e2ee/relay/hostedGateway.ts',
    'experiments/scuttlebutt-e2ee/relay/httpGateway.ts',
    'experiments/scuttlebutt-e2ee/relay/gateway.ts',
    'experiments/scuttlebutt-e2ee/relay/supabaseAuth.ts',
    'experiments/scuttlebutt-e2ee/relay/signedGateway.ts',
    'experiments/scuttlebutt-e2ee/relay/deviceBundle.ts',
    'experiments/scuttlebutt-e2ee/relay/signedRequest.ts',
    'experiments/scuttlebutt-e2ee/relay/relay.sql',
    'services/chat/e2ee/directMessageEnvelope.ts',
    'services/chat/e2ee/encryptedDmDelivery.ts',
];
function sourceHashes() {
    return Object.fromEntries(
        sourcePaths.map((path) => [
            path,
            createHash('sha256')
                .update(readFileSync(join(CHECKOUT, path)))
                .digest('hex'),
        ]),
    );
}
function deployedRevision() {
    const functions = cliJson(['functions', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json']);
    assert(Array.isArray(functions));
    const selected = functions.find((item) => item.slug === 'scuttlebutt-e2ee-pilot');
    assert(selected?.status === 'ACTIVE' && selected.verify_jwt === true && exact(UUID, selected.id));
    assert(
        Number.isSafeInteger(selected.version) && selected.version > 0 && exact(/^[0-9a-f]{64}$/, selected.ezbr_sha256),
    );
    return { id: selected.id, version: selected.version, bundleSha256: selected.ezbr_sha256, verifyJwt: true };
}

function requirePrivateFile(path) {
    assert(isAbsolute(path));
    const file = lstatSync(path),
        parent = lstatSync(dirname(path));
    assert(file.isFile() && !file.isSymbolicLink() && file.size <= PRIVATE_FILE_LIMIT);
    assert(parent.isDirectory() && !parent.isSymbolicLink());
    assert(file.uid === process.getuid() && parent.uid === process.getuid());
    assert((file.mode & 0o777) === 0o600 && (parent.mode & 0o777) === 0o700);
    assert(!resolve(path).startsWith(`${CHECKOUT}/`));
    return JSON.parse(readFileSync(path, 'utf8'));
}

function cliJson(arguments_) {
    const result = spawnSync(CLI, arguments_, {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    assert(!result.error && result.status === 0 && typeof result.stdout === 'string');
    // stdout may include service keys; neither it nor parser errors escape main().
    return JSON.parse(result.stdout);
}

function assertJsonBounds(value) {
    const pending = [{ value, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
        const item = pending.pop();
        assert(++nodes <= 32_768 && item.depth <= 64);
        if (item.value !== null && typeof item.value === 'object') {
            for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
        } else assert(typeof item.value !== 'number' || Number.isFinite(item.value));
    }
}

async function boundedJson(response, limit, signal) {
    assert(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''));
    const declared = response.headers.get('content-length');
    if (declared !== null) assert(/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= limit);
    assert(response.body);
    const reader = response.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
        chunks = 0,
        text = '';
    try {
        for (;;) {
            assert(!signal.aborted);
            const item = await reader.read();
            assert(!signal.aborted);
            if (item.done) break;
            assert(++chunks <= 4096 && item.value instanceof Uint8Array);
            bytes += item.value.byteLength;
            assert(bytes <= limit);
            text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
        // Fetch may decompress even when the server ignores Accept-Encoding:
        // identity. Content-Length then describes compressed transport bytes,
        // not the decoded stream. Both declared and decoded sizes are bounded.
        assert(bytes > 0 && !signal.aborted);
        const parsed = JSON.parse(text);
        assertJsonBounds(parsed);
        return parsed;
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

async function requestJson(url, init, acceptedStatuses, limit = RESPONSE_LIMIT) {
    const target = new URL(url);
    assert(
        target.origin === ORIGIN &&
            target.protocol === 'https:' &&
            !target.username &&
            !target.password &&
            !target.hash,
    );
    const headers = new Headers(init.headers);
    headers.set('accept-encoding', 'identity');
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
        const response = await fetch(url, {
            ...init,
            headers,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
        });
        lastHttpStatus = response.status;
        assert(!controller.signal.aborted && !response.redirected && response.url === url);
        assert(acceptedStatuses.includes(response.status));
        const body = await boundedJson(response, limit, controller.signal);
        assert(!controller.signal.aborted);
        return { status: response.status, body };
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

async function group(name, operation) {
    activeGroup = name;
    await operation();
    passed.push(name);
    console.info(`PASS ${name}`);
}

function fixture(userId) {
    const signing = generateKeyPairSync('ed25519');
    const curve = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
    const prekey = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
    const tag = `hosted-${randomUUID()}`;
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId,
        deviceId: `${tag}-device`,
        identityKeyId: `${tag}-identity`,
        signingKey: unpadded(Buffer.from(signing.publicKey.export({ format: 'jwk' }).x, 'base64url')),
        curveKey: unpadded(Buffer.from(curve.x, 'base64url')),
        prekeyId: `${tag}-prekey`,
        prekey: unpadded(Buffer.from(prekey.x, 'base64url')),
        expiresAt: nowSeconds() + 86400,
    };
    const bundle = encodeDeviceBundle({
        ...unsigned,
        signature: unpadded(sign(null, deviceBundleSigningBytes(unsigned), signing.privateKey)),
    });
    return {
        userId,
        deviceId: unsigned.deviceId,
        identityKeyId: unsigned.identityKeyId,
        claimId: `${tag}-claim`,
        clientMessageId: `${tag}-message`,
        bundle,
        signingJwk: signing.privateKey.export({ format: 'jwk' }),
    };
}

async function validateFixture(value, account) {
    assert(value && value.userId === account.userId && exact(UUID, value.userId));
    const bundle = await parseAndVerifyDeviceBundle(value.bundle, account.userId, nowSeconds());
    assert(bundle.deviceId === value.deviceId && bundle.identityKeyId === value.identityKeyId);
    assert(typeof value.claimId === 'string' && typeof value.clientMessageId === 'string');
    const privateKey = createPrivateKey({ key: value.signingJwk, format: 'jwk' });
    const signingKey = unpadded(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url'));
    assert(signingKey === bundle.signingKey);
    const control = new Uint8Array([1, 2, 3]);
    assert(verify(null, control, createPublicKey(privateKey), sign(null, control, privateKey)));
    return { ...value, privateKey, publicBundle: bundle };
}

function signedRequest(actor, action, payload, overrides = {}) {
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: actor.userId,
        deviceId: actor.deviceId,
        action,
        requestId: `live-${randomUUID()}`,
        expiresAt: nowSeconds() + 180,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ...overrides,
    };
    return encodeSignedResearchRequest({
        ...unsigned,
        signature: unpadded(sign(null, researchRequestSigningBytes(unsigned), actor.privateKey)),
    });
}

function outbox(sender, recipient) {
    return {
        ownerUserId: sender.userId,
        ownerSessionGeneration: 1,
        recipientUserId: recipient.userId,
        recipientIdentityKeyId: recipient.identityKeyId,
        recipientIdentityGeneration: 1,
        serializedEnvelope: encodeDirectMessageEnvelope({
            version: 2,
            protocol: 'olm-v1',
            messageType: 'prekey',
            clientMessageId: sender.clientMessageId,
            senderDeviceId: sender.deviceId,
            recipientDeviceId: recipient.deviceId,
            ciphertext: 'YQ==',
        }),
    };
}

async function post(path, credential, wire, statuses = [200]) {
    assert(exact(BEARER, credential) && credential.length <= 8192);
    return requestJson(
        `${ORIGIN}${path}`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${credential}`,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: wire,
        },
        statuses,
    );
}

async function success(actor, wire, endpoint = 'dispatch') {
    const { body } = await post(`${BASE_PATH}/v1/${endpoint}`, actor.credential, wire);
    assert(body && typeof body === 'object' && !Array.isArray(body));
    assert.deepEqual(Object.keys(body).sort(), ['result', 'version']);
    assert(body.version === 1);
    return body.result;
}

async function refuse(actor, wire, options = {}) {
    const { body } = await post(
        options.path ?? `${BASE_PATH}/v1/dispatch`,
        options.credential ?? actor.credential,
        wire,
        options.statuses ?? [503],
    );
    assert(body && typeof body === 'object' && !Array.isArray(body));
    assert(body.version === 1 && body.error === 'request-unresolved');
}

function assertInbox(rows, sender, recipient, record) {
    assert(Array.isArray(rows) && rows.length <= 16);
    let previous = 0;
    for (const row of rows) {
        assert(row && row.accepted === true && Number.isSafeInteger(row.serverId) && row.serverId > previous);
        previous = row.serverId;
        const envelope = decodeDirectMessageEnvelope(row.serializedEnvelope);
        assert(row.recipientUserId === recipient.userId && envelope.recipientDeviceId === recipient.deviceId);
    }
    const matches = rows.filter(
        (row) => decodeDirectMessageEnvelope(row.serializedEnvelope).clientMessageId === sender.clientMessageId,
    );
    assert(matches.length === 1);
    const { serverId, ...actual } = matches[0];
    assert.deepEqual(actual, { ...record, accepted: true });
    return serverId;
}

async function checkAcl() {
    assert(readFileSync(join(HERE, 'supabase/.temp/project-ref'), 'utf8').trim() === PROJECT);
    assert(readFileSync(join(HERE, 'supabase/config.toml'), 'utf8').includes(`project_id = "${PROJECT}"`));
    const query = `WITH functions(signature, signed_path) AS (VALUES
        ('e2ee_research.register_device(text,text)',true),
        ('e2ee_research.lookup_request_key(text,text)',true),
        ('e2ee_research.execute_request(text,text,text,text,text,bigint,text)',true),
        ('e2ee_research.revoke_device(text,text)',false),
        ('e2ee_research.set_block(text,text,boolean)',false),
        ('e2ee_research.claim_prekey(text,text,text,text,text)',false),
        ('e2ee_research.send_message(text,jsonb)',false),
        ('e2ee_research.list_messages(text,text,bigint,integer)',false)),
        roles(name) AS (VALUES ('anon'),('authenticated'),('service_role'),('e2ee_pilot_edge'),('e2ee_research_gateway')),
        tables(name) AS (VALUES ('devices'),('blocks'),('claims'),('decisions'),('requests'))
        SELECT
          (SELECT bool_and(has_function_privilege(roles.name,functions.signature,'EXECUTE') =
            (roles.name='e2ee_research_gateway' AND functions.signed_path)) FROM roles CROSS JOIN functions) AS function_acl_closed,
          (SELECT bool_and(NOT has_table_privilege(roles.name,'e2ee_research.' || tables.name,'SELECT,INSERT,UPDATE,DELETE'))
            FROM roles CROSS JOIN tables) AS table_acl_closed,
          (SELECT bool_and(NOT has_schema_privilege(name,'e2ee_research','USAGE')) FROM roles WHERE name <> 'e2ee_research_gateway') AS schema_acl_closed,
          has_schema_privilege('e2ee_research_gateway','e2ee_research','USAGE') AS gateway_schema_available,
          (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolinherit
            AND rolconnlimit=2 FROM pg_roles WHERE rolname='e2ee_pilot_edge') AS login_restricted,
          pg_has_role('e2ee_pilot_edge','e2ee_research_gateway','SET') AS gateway_role_available,
          NOT pg_has_role('e2ee_pilot_edge','e2ee_research_owner','SET') AS owner_role_forbidden,
          (SELECT bool_and(relrowsecurity) FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace
            WHERE pg_namespace.nspname='e2ee_research' AND relkind='r') AS row_security_enabled;`;
    const result = cliJson(['db', 'query', '--linked', '--workdir', HERE, '--output', 'json', query]);
    assert(Array.isArray(result.rows) && result.rows.length === 1);
    assert.deepEqual(result.rows[0], {
        function_acl_closed: true,
        table_acl_closed: true,
        schema_acl_closed: true,
        gateway_schema_available: true,
        login_restricted: true,
        gateway_role_available: true,
        owner_role_forbidden: true,
        row_security_enabled: true,
    });
}

async function main() {
    const args = process.argv.slice(2);
    assert((args.length === 1 || (args.length === 2 && args[1] === '--check-acl')) && isAbsolute(args[0]));
    assert(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert(PILOT_PROJECT_REF === PROJECT && PILOT_ORIGIN === ORIGIN && PILOT_BASE_PATH === BASE_PATH);
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    const privatePath = args[0],
        checkPrivileges = args[1] === '--check-acl';
    const credentials = requirePrivateFile(privatePath);
    assert(
        credentials.project === PROJECT &&
            credentials.fixtureAccountsOnly === true &&
            Array.isArray(credentials.accounts) &&
            credentials.accounts.length === 2,
    );
    const accounts = credentials.accounts;
    assert(
        accounts.every(
            (account) =>
                exact(UUID, account.userId) &&
                typeof account.email === 'string' &&
                typeof account.password === 'string' &&
                account.password.length >= 24 &&
                account.password.length <= 256,
        ),
    );
    assert(
        new Set(accounts.map((account) => account.userId)).size === 2 &&
            new Set(accounts.map((account) => account.email)).size === 2,
    );
    assert.deepEqual(accounts.map((account) => account.email).sort(), [...FIXTURE_EMAILS].sort());
    await group('approved project and organization pin', async () => {
        const projects = cliJson(['projects', 'list', '--output', 'json']);
        assert(Array.isArray(projects));
        const selected = projects.find((project) => project.id === PROJECT);
        assert(
            selected &&
                selected.organization_id === ORGANIZATION &&
                selected.name === 'Thalassa E2EE Pilot' &&
                selected.status === 'ACTIVE_HEALTHY',
        );
    });
    const deployment = deployedRevision();
    const localSourceHashes = sourceHashes();
    const keys = cliJson(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
    assert(Array.isArray(keys));
    const anon = keys.find((key) => key.name === 'anon')?.api_key;
    assert(exact(BEARER, anon) && anon.length <= 8192);
    const sessions = [];
    await group('two fresh password tokens and authoritative Auth users', async () => {
        for (const account of accounts) {
            const { body: session } = await requestJson(
                `${ORIGIN}/auth/v1/token?grant_type=password`,
                {
                    method: 'POST',
                    headers: { apikey: anon, 'content-type': 'application/json' },
                    body: JSON.stringify({ email: account.email, password: account.password }),
                },
                [200],
                512 * 1024,
            );
            assert(
                session &&
                    exact(BEARER, session.access_token) &&
                    session.access_token.length <= 8192 &&
                    session.user?.id === account.userId,
            );
            const { body: principal } = await requestJson(
                `${ORIGIN}/auth/v1/user`,
                {
                    method: 'GET',
                    headers: {
                        apikey: anon,
                        authorization: `Bearer ${session.access_token}`,
                        accept: 'application/json',
                    },
                },
                [200],
                512 * 1024,
            );
            assert(principal?.id === account.userId && principal.email === account.email);
            sessions.push(session.access_token);
        }
    });
    const fixturePath = join(dirname(privatePath), 'hosted-signed-fixtures.local');
    let stored;
    try {
        stored = requirePrivateFile(fixturePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        stored = {
            version: 1,
            project: PROJECT,
            organization: ORGANIZATION,
            fixtureAccountsOnly: true,
            actors: accounts.map((account) => fixture(account.userId)),
        };
        writeFileSync(fixturePath, JSON.stringify(stored) + '\n', { mode: 0o600, flag: 'wx' });
    }
    assert(
        stored.version === 1 &&
            stored.project === PROJECT &&
            stored.organization === ORGANIZATION &&
            stored.fixtureAccountsOnly === true &&
            Array.isArray(stored.actors) &&
            stored.actors.length === 2,
    );
    const actors = [];
    for (let i = 0; i < 2; i++)
        actors.push({ ...(await validateFixture(stored.actors[i], accounts[i])), credential: sessions[i] });
    const [alice, bob] = actors;
    assert(alice.deviceId !== bob.deviceId);
    if (checkPrivileges) await group('read-only private RPC role ACL and RLS checks', checkAcl);
    await group('live Ed25519 registration and exact registration retry', async () => {
        for (const actor of actors) {
            const expected = { registered: true, userId: actor.userId, deviceId: actor.deviceId };
            assert.deepEqual(await success(actor, actor.bundle, 'register'), expected);
            assert.deepEqual(await success(actor, actor.bundle, 'register'), expected);
        }
    });
    await group('reciprocal prekey claims and exact claim retry', async () => {
        for (const [sender, recipient] of [
            [alice, bob],
            [bob, alice],
        ]) {
            const wire = signedRequest(sender, 'claim', [recipient.userId, recipient.deviceId, sender.claimId]);
            const expected = {
                signedBundle: recipient.bundle,
                prekeyId: recipient.publicBundle.prekeyId,
                prekey: recipient.publicBundle.prekey,
            };
            assert.deepEqual(await success(sender, wire), expected);
            assert.deepEqual(await success(sender, wire), expected);
        }
    });
    const records = [outbox(alice, bob), outbox(bob, alice)];
    await group('bidirectional synthetic fixture relay acceptance and exact send retry', async () => {
        for (let i = 0; i < actors.length; i++) {
            const wire = signedRequest(actors[i], 'send', encodeResearchOutbox(records[i]));
            assert.deepEqual(await success(actors[i], wire), { ...records[i], accepted: true });
            assert.deepEqual(await success(actors[i], wire), { ...records[i], accepted: true });
            // New signed nonce, SAME outbox: records must still deduplicate.
            assert.deepEqual(
                await success(actors[i], signedRequest(actors[i], 'send', encodeResearchOutbox(records[i]))),
                { ...records[i], accepted: true },
            );
        }
    });
    const serverIds = [];
    await group('recipient-only inbox visibility and exact list snapshot retry', async () => {
        for (const [sender, recipient, record] of [
            [alice, bob, records[0]],
            [bob, alice, records[1]],
        ]) {
            const wire = signedRequest(recipient, 'list', [0, 16]);
            const first = await success(recipient, wire);
            serverIds.push(assertInbox(first, sender, recipient, record));
            assert.deepEqual(await success(recipient, wire), first);
            const later = await success(recipient, signedRequest(recipient, 'list', [0, 16]));
            assert(assertInbox(later, sender, recipient, record) === serverIds.at(-1));
        }
    });
    await group('mutated device request and bundle signatures refused', async () => {
        const wire = signedRequest(alice, 'list', [0, 16]),
            request = JSON.parse(wire);
        const signature = Buffer.from(request.signature, 'base64');
        signature[0] ^= 1;
        await refuse(alice, encodeSignedResearchRequest({ ...request, signature: unpadded(signature) }));
        const bundle = JSON.parse(alice.bundle),
            bundleSignature = Buffer.from(bundle.signature, 'base64');
        bundleSignature[0] ^= 1;
        const response = await post(
            `${BASE_PATH}/v1/register`,
            alice.credential,
            encodeDeviceBundle({ ...bundle, signature: unpadded(bundleSignature) }),
            [503],
        );
        assert.deepEqual(response.body, { version: 1, error: 'request-unresolved' });
    });
    await group('account substitution and another device key refused', async () => {
        await refuse(bob, signedRequest(alice, 'list', [0, 16]));
        await refuse(alice, signedRequest(bob, 'list', [0, 16], { userId: alice.userId, deviceId: alice.deviceId }));
        const response = await post(`${BASE_PATH}/v1/register`, bob.credential, alice.bundle, [503]);
        assert.deepEqual(response.body, { version: 1, error: 'request-unresolved' });
    });
    await group('public API key is not an authenticated user', async () => {
        const response = await post(
            `${BASE_PATH}/v1/dispatch`,
            anon,
            signedRequest(alice, 'list', [0, 16]),
            [401, 403, 503],
        );
        assert(response.body && typeof response.body === 'object' && !Array.isArray(response.body));
        assert(response.body.version !== 1 || !Object.hasOwn(response.body, 'result'));
        if (response.status === 503) assert.deepEqual(response.body, { version: 1, error: 'request-unresolved' });
    });
    await group('root endpoint and query aliases refused', async () => {
        const wire = signedRequest(alice, 'list', [0, 16]);
        const root = await post('/v1/dispatch', alice.credential, wire, [404]);
        assert(
            root.body &&
                typeof root.body === 'object' &&
                !Array.isArray(root.body) &&
                !Object.hasOwn(root.body, 'result'),
        );
        await refuse(alice, wire, { path: `${BASE_PATH}/v1/dispatch?actor=fixture`, statuses: [404] });
    });
    await group('valid signed controls still work after refusal cases', async () => {
        for (const [sender, recipient, record, id] of [
            [alice, bob, records[0], serverIds[0]],
            [bob, alice, records[1], serverIds[1]],
        ]) {
            assert(
                assertInbox(
                    await success(recipient, signedRequest(recipient, 'list', [0, 16])),
                    sender,
                    recipient,
                    record,
                ) === id,
            );
            assert.deepEqual(await success(recipient, signedRequest(recipient, 'list', [id, 16])), []);
        }
    });
    await group('deployed JWT gate and unchanged hosted revision', async () => {
        assert.deepEqual(deployedRevision(), deployment);
        assert.deepEqual(sourceHashes(), localSourceHashes);
    });
    activeGroup = 'nonsecret proof receipt';
    const receiptPath = join(dirname(privatePath), `hosted-live-receipt-${randomUUID()}.json`);
    const receipt = {
        version: 1,
        status: 'passed',
        project: PROJECT,
        organization: ORGANIZATION,
        fixtureActorsOnly: true,
        loginRole: 'e2ee_pilot_edge',
        rpcRole: 'e2ee_research_gateway',
        completedAt: new Date().toISOString(),
        checkCategories: passed,
        leastPrivilegeAclChecked: checkPrivileges,
        deployment,
        localSourceHashes,
        evidence: {
            liveSupabaseAuth: true,
            hostedHttps: true,
            realEd25519FixtureSignatures: true,
            syntheticCiphertextOnly: true,
            actualOlmEncryption: false,
            nativeClientsExecuted: false,
            physicalDevicesExecuted: false,
            applicationPrivateMessagesActivated: false,
            relayAcceptanceIsNotDeviceDelivery: true,
            independentSecurityAuditPerformed: false,
            privateSigningFixturesPersistedForExactRerun: true,
            humanAccountDeviceSlotsUsed: false,
            productionTouched: false,
            deployedSourceIndependentlyAttested: false,
        },
    };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.info(`PASS nonsecret proof receipt ${receiptPath}`);
}

await main().catch(() => {
    // Assertions/HTTP/crypto/CLI failures may retain private values internally.
    // Printing an exception, its stack/cause or its actual/expected is forbidden.
    console.error(`FAIL ${activeGroup}${Number.isInteger(lastHttpStatus) ? ` (HTTP ${lastHttpStatus})` : ''}`);
    process.exitCode = 1;
});

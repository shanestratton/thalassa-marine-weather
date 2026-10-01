/**
 * Isolated real HTTPS socket + signed gateway + PostgreSQL-engine proof.
 * node --experimental-strip-types httpProof.mjs /absolute/path/to/pinned/pglite.tgz
 * No downloads, live accounts, production writes or native encryption claims.
 * Auth responses and message ciphertext are explicit fixtures; Ed25519 signatures,
 * TLS hostname/CA validation, gateway checks and SQL transactions are real.
 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deviceBundleSigningBytes, encodeDeviceBundle } from './deviceBundle.ts';
import { encodeResearchOutbox } from './gateway.ts';
import { createResearchHttpGateway } from './httpGateway.ts';
import { createResearchSignedGateway } from './signedGateway.ts';
import { encodeSignedResearchRequest, researchRequestSigningBytes } from './signedRequest.ts';
import { createSupabaseResearchAuthenticator } from './supabaseAuth.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const [source, ...extra] = process.argv.slice(2);
assert(source && !extra.length && isAbsolute(source), 'Supply the pinned archive absolute path');
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-http-'));
console.log(`Isolated HTTPS research directory: ${scratch}`);
const pin = JSON.parse(readFileSync(join(here, 'pglite-pin.json'), 'utf8'));
const archive = readFileSync(source);
assert.equal(pin.shippingApproved, false);
assert(archive.length < 32 * 1024 * 1024);
assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), pin.integrity);
const archivePath = join(scratch, 'pglite.tgz');
writeFileSync(archivePath, archive, { mode: 0o600, flag: 'wx' });
const listing = spawnSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30_000 });
assert.equal(listing.status, 0);
assert(
    listing.stdout
        .trim()
        .split('\n')
        .every((name) => name.startsWith('package/') && !name.split('/').includes('..')),
);
assert.equal(spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', scratch], { timeout: 30_000 }).status, 0);
function checkTree(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        assert(entry.isFile() || entry.isDirectory(), 'No dependency links or special files');
        if (entry.isDirectory()) checkTree(join(path, entry.name));
    }
}
checkTree(join(scratch, 'package'));
const metadata = JSON.parse(readFileSync(join(scratch, 'package/package.json'), 'utf8'));
assert.equal(metadata.name, pin.package);
assert.equal(metadata.version, pin.version);
assert.equal(metadata.license, pin.license);
assert(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);
assert(!metadata.scripts?.install && !metadata.scripts?.postinstall);

// One heavy job at a time on the shared Mac; do not reserve while waiting.
let waiting = false;
for (;;) {
    const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!p.error && [0, 1].includes(p.status), 'Must inspect the shared build slot');
    const others = p.stdout
        .trim()
        .split('\n')
        .filter(
            (line) =>
                line &&
                !line.startsWith(`${process.pid} `) &&
                !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|tail|grep|rg|pgrep)\s/.test(line),
        );
    if (!others.length) break;
    if (!waiting) console.log('Waiting for shared-Mac build slot.');
    waiting = true;
    await delay(5_000);
}
process.title = 'vite build slot: isolated E2EE HTTPS proof';

// This fresh one-day certificate is trusted ONLY by the injected fixture fetch.
// No global CA mutation, NODE_TLS_REJECT_UNAUTHORIZED, hostname bypass or HTTP.
const certConfig = join(scratch, 'localhost.cnf');
const certPath = join(scratch, 'localhost.crt');
const keyPath = join(scratch, 'localhost.key');
writeFileSync(
    certConfig,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',
    { mode: 0o600, flag: 'wx' },
);
const oldUmask = process.umask(0o077);
try {
    const cert = spawnSync(
        '/usr/bin/openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-sha256',
            '-nodes',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-days',
            '1',
            '-config',
            certConfig,
        ],
        { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(cert.status, 0, 'Create the isolated localhost certificate');
} finally {
    process.umask(oldUmask);
}
const ca = readFileSync(certPath);
const { PGlite } = await import(pathToFileURL(join(scratch, 'package/dist/index.js')).href);
let db;
let server;
let origin;
let boundary;
let group = 'isolated TLS and PostgreSQL initialization';
let checks = 0;
let authCalls = 0;
let rpcCalls = 0;
const credentials = new Map();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const token = (actor) => `fixture-${actor.name}-bearer`;
const signatures = {
    register_device: 'text,text',
    revoke_device: 'text,text',
    set_block: 'text,text,boolean',
    claim_prekey: 'text,text,text,text,text',
    send_message: 'text,jsonb',
    list_messages: 'text,text,bigint,integer',
    lookup_request_key: 'text,text',
    execute_request: 'text,text,text,text,text,bigint,text',
};
async function rpc(name, args) {
    assert(Object.hasOwn(signatures, name), 'Fixed RPC allowlist');
    const casts = signatures[name].split(',');
    assert.equal(args.length, casts.length);
    rpcCalls++;
    // PGlite resolves this transaction only after commit. Never return a row
    // observed before a rollback as a successful HTTP receipt.
    return db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
        const parameters = casts.map((cast, i) => `$${i + 1}::${cast}`).join(',');
        const values = args.map((value, i) => (casts[i] === 'jsonb' ? JSON.stringify(value) : value));
        return (await tx.query(`SELECT e2ee_research.${name}(${parameters}) AS result`, values)).rows[0].result;
    });
}

/** Normal TLS verification with this fixture CA; network target is loopback. */
async function fixtureFetch(input, init) {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, origin, 'Fixture transport stays on the owned TLS origin');
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    return new Promise((resolve, reject) => {
        const outgoing = httpsRequest(
            url,
            {
                method: req.method,
                headers: Object.fromEntries(req.headers),
                ca,
                agent: false,
                signal: req.signal,
                family: 4,
                // Resolve localhost to the exclusively owned listener; hostname
                // and certificate verification remain Node's normal defaults.
                lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4),
            },
            (incoming) => {
                const headers = new Headers();
                for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                    headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
                const response = new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers });
                Object.defineProperty(response, 'url', { value: url.href });
                resolve(response);
            },
        );
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}
async function post(path, credential, wire, headers = {}) {
    const response = await fixtureFetch(`${origin}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...headers },
        body: wire,
        signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const raw = await response.text();
    assert(Buffer.byteLength(raw) <= 2 * 1024 * 1024);
    return { status: response.status, body: JSON.parse(raw) };
}
async function accepted(path, actor, wire) {
    const response = await post(path, token(actor), wire);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), ['version', 'result']);
    assert.equal(response.body.version, 1);
    return response.body.result;
}
function unresolved(response, expectedStatus) {
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(response.body, { version: 1, error: 'request-unresolved' });
}
async function actor(name, userId) {
    const key = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const curve = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const prekey = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId,
        deviceId: `${name}-phone`,
        identityKeyId: `${name}-identity`,
        signingKey: b64(await webcrypto.subtle.exportKey('raw', key.publicKey)),
        curveKey: b64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
        prekeyId: `${name}-prekey`,
        prekey: b64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
        expiresAt: nowSeconds() + 3600,
    };
    return {
        ...unsigned,
        name,
        privateKey: key.privateKey,
        bundle: encodeDeviceBundle({
            ...unsigned,
            signature: b64(await webcrypto.subtle.sign('Ed25519', key.privateKey, deviceBundleSigningBytes(unsigned))),
        }),
    };
}
async function sign(sender, action, payload, requestId) {
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: sender.userId,
        deviceId: sender.deviceId,
        action,
        requestId,
        expiresAt: nowSeconds() + 120,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
    return encodeSignedResearchRequest({
        ...unsigned,
        signature: b64(
            await webcrypto.subtle.sign('Ed25519', sender.privateKey, researchRequestSigningBytes(unsigned)),
        ),
    });
}
function record(sender, recipient, id, ciphertext = 'YQ==') {
    return {
        ownerUserId: sender.userId,
        ownerSessionGeneration: 7,
        recipientUserId: recipient.userId,
        recipientIdentityKeyId: recipient.identityKeyId,
        recipientIdentityGeneration: 3,
        serializedEnvelope: encodeDirectMessageEnvelope({
            version: 2,
            protocol: 'olm-v1',
            messageType: 'prekey',
            clientMessageId: id,
            senderDeviceId: sender.deviceId,
            recipientDeviceId: recipient.deviceId,
            ciphertext,
        }),
    };
}
async function check(name, body) {
    group = name;
    await body();
    checks++;
    console.log(`PASS ${name}`);
}
async function count(table) {
    assert(['decisions', 'requests', 'devices'].includes(table));
    return Number((await db.query(`SELECT count(*) AS n FROM e2ee_research.${table}`)).rows[0].n);
}

try {
    db = await PGlite.create(join(scratch, 'database'));
    await db.exec(readFileSync(join(here, 'relay.sql'), 'utf8'));
    server = createServer({ key: readFileSync(keyPath), cert: ca }, async (incoming, outgoing) => {
        try {
            if (incoming.method === 'GET' && incoming.url === '/auth/v1/user') {
                authCalls++;
                assert.equal(incoming.headers.apikey, 'sb_publishable_fixture-only');
                const userId = credentials.get(incoming.headers.authorization);
                outgoing.writeHead(userId ? 200 : 401, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                outgoing.end(
                    JSON.stringify(
                        userId
                            ? { id: userId, user_metadata: { actor: 'ignored-fixture-metadata' } }
                            : { error: 'fixture-unrecognized-user' },
                    ),
                );
                return;
            }
            // The local Node adapter has its own bounded buffer. The HTTP
            // boundary still independently enforces each smaller endpoint cap.
            const chunks = [];
            let bytes = 0;
            for await (const chunk of incoming) {
                bytes += chunk.length;
                assert(bytes <= 256 * 1024, 'Fixture adapter input cap');
                chunks.push(chunk);
            }
            const headers = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            const request = new Request(`${origin}${incoming.url}`, {
                method: incoming.method,
                headers,
                ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
            });
            const response = await boundary(request);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
            outgoing.writeHead(503, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            outgoing.end('{"version":1,"error":"request-unresolved"}');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    origin = `https://localhost:${server.address().port}`;
    const authenticate = createSupabaseResearchAuthenticator({
        supabaseUrl: origin,
        publicApiKey: 'sb_publishable_fixture-only',
        fetch: fixtureFetch,
    });
    const gateway = createResearchSignedGateway({ authenticate, rpc, nowSeconds });
    boundary = createResearchHttpGateway({ serviceOrigin: origin, gateway });
    const alice = await actor('http-alice', '00000000-0000-4000-8000-000000000001');
    const bob = await actor('http-bob', '00000000-0000-4000-8000-000000000002');
    for (const person of [alice, bob]) credentials.set(`Bearer ${token(person)}`, person.userId);
    const dispatch = (person, wire) => accepted('/v1/dispatch', person, wire);

    await check('untrusted localhost certificate is rejected; fixture trust is request-local only', async () => {
        await assert.rejects(
            () =>
                new Promise((resolve, reject) => {
                    const req = httpsRequest(
                        `${origin}/auth/v1/user`,
                        {
                            agent: false,
                            family: 4,
                            lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4),
                        },
                        resolve,
                    );
                    req.on('error', reject);
                    req.end();
                }),
            (error) => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.code),
        );
        assert.equal(authCalls, 0);
    });
    await check('signed bundles register over real HTTPS and fresh fixture Auth GETs before SQL commits', async () => {
        for (const person of [alice, bob])
            assert.deepEqual(await accepted('/v1/register', person, person.bundle), {
                registered: true,
                userId: person.userId,
                deviceId: person.deviceId,
            });
        assert.equal(authCalls, 2);
        assert.equal(await count('devices'), 2);
        const wire = await sign(alice, 'claim', [bob.userId, bob.deviceId, 'http-prekey'], 'http-claim');
        assert.equal((await dispatch(alice, wire)).signedBundle, bob.bundle);
    });
    const messages = [
        record(alice, bob, 'http-first'),
        record(bob, alice, 'http-reply'),
        record(alice, bob, 'http-third'),
    ];
    const wires = await Promise.all(
        messages.map((message, index) =>
            sign(index === 1 ? bob : alice, 'send', encodeResearchOutbox(message), `http-send-${index}`),
        ),
    );
    await check('three signed fixture ciphertexts and exact retries cross HTTPS and persist once each', async () => {
        for (let i = 0; i < messages.length; i++)
            assert.deepEqual(await dispatch(i === 1 ? bob : alice, wires[i]), { ...messages[i], accepted: true });
        const before = await count('requests');
        assert.deepEqual(await dispatch(alice, wires[0]), { ...messages[0], accepted: true });
        assert.equal(await count('requests'), before);
        assert.equal(await count('decisions'), 3);
    });
    await check('tampering and record conflicts cannot replace accepted ciphertext or leak server errors', async () => {
        const changed = JSON.parse(wires[0]);
        changed.payload = changed.payload.replace('YQ==', 'Yg==');
        const before = await count('requests');
        const beforeRpc = rpcCalls;
        unresolved(await post('/v1/dispatch', token(alice), JSON.stringify(changed)), 503);
        assert.equal(rpcCalls, beforeRpc + 1, 'Only registered-key lookup; no execution after bad signature');
        assert.equal(await count('requests'), before);
        const conflicting = record(alice, bob, 'http-first', 'Yg==');
        assert.deepEqual(
            await dispatch(alice, await sign(alice, 'send', encodeResearchOutbox(conflicting), 'http-conflict')),
            { ...conflicting, accepted: false, reason: 'record-conflict' },
        );
        assert.equal(await count('decisions'), 3);
    });
    await check(
        'boundary rejects invalid credentials, origin, media and oversized bodies before Auth or SQL',
        async () => {
            const beforeAuth = authCalls;
            const beforeRpc = rpcCalls;
            unresolved(
                await post('/v1/dispatch', token(alice), wires[0], { Authorization: 'Bearer token with whitespace' }),
                401,
            );
            unresolved(
                await post('/v1/dispatch', token(alice), wires[0], { Origin: 'https://untrusted.invalid' }),
                400,
            );
            unresolved(await post('/v1/dispatch', token(alice), wires[0], { 'Content-Type': 'text/plain' }), 415);
            unresolved(await post('/v1/register', token(alice), 'x'.repeat(4097)), 413);
            unresolved(await post('/v1/dispatch', token(alice), 'x'.repeat(102401)), 413);
            assert.equal(authCalls, beforeAuth);
            assert.equal(rpcCalls, beforeRpc);
        },
    );
    await check('account credentials are checked afresh across real HTTP Auth responses', async () => {
        credentials.delete(`Bearer ${token(alice)}`);
        const beforeAuth = authCalls;
        const beforeRpc = rpcCalls;
        unresolved(await post('/v1/dispatch', token(alice), wires[0]), 503);
        assert.equal(authCalls, beforeAuth + 1);
        assert.equal(rpcCalls, beforeRpc);
        credentials.set(`Bearer ${token(alice)}`, alice.userId);
    });
    const listWire = await sign(bob, 'list', [0, 16], 'http-list');
    let snapshot;
    await check(
        'HTTP reads enforce current blocks and restore only the original cached snapshot after unblock',
        async () => {
            snapshot = await dispatch(bob, listWire);
            assert.equal(snapshot.length, 2);
            assert.deepEqual(
                snapshot.map((item) => JSON.parse(item.serializedEnvelope).clientMessageId),
                ['http-first', 'http-third'],
            );
            await dispatch(bob, await sign(bob, 'block', [alice.userId, true], 'http-block'));
            assert.deepEqual(await dispatch(bob, listWire), []);
            await dispatch(bob, await sign(bob, 'block', [alice.userId, false], 'http-unblock'));
            assert.deepEqual(await dispatch(bob, listWire), snapshot);
        },
    );
    await check(
        'device revocation denies cached reads and new messages but retains exact accepted receipts',
        async () => {
            await dispatch(bob, await sign(bob, 'revoke', [], 'http-revoke'));
            unresolved(await post('/v1/dispatch', token(bob), listWire), 503);
            assert.deepEqual(await dispatch(alice, wires[0]), { ...messages[0], accepted: true });
            const fresh = record(alice, bob, 'http-after-revoke');
            assert.deepEqual(
                await dispatch(alice, await sign(alice, 'send', encodeResearchOutbox(fresh), 'http-revoked-send')),
                { ...fresh, accepted: false, reason: 'device-revoked' },
            );
            assert.equal(await count('decisions'), 4);
        },
    );
    await check(
        'database restart preserves accepted decisions, immutable ciphertext and revoked device policy',
        async () => {
            await db.close();
            db = await PGlite.create(join(scratch, 'database'));
            assert.deepEqual(await dispatch(alice, wires[0]), { ...messages[0], accepted: true });
            unresolved(await post('/v1/dispatch', token(bob), listWire), 503);
            assert.equal(await count('decisions'), 4);
            const acceptedRows = (
                await db.query(
                    'SELECT serialized_envelope FROM e2ee_research.decisions WHERE accepted ORDER BY server_id',
                )
            ).rows;
            assert.deepEqual(
                acceptedRows.map((item) => item.serialized_envelope),
                messages.map((item) => item.serializedEnvelope),
            );
        },
    );
    console.log(`PASS ${checks} real HTTPS/PostgreSQL scenario groups; fixture Auth and ciphertext only.`);
} catch (error) {
    console.error(
        `FAIL HTTPS research scenario: ${group}; code ${typeof error?.code === 'string' ? error.code : 'research-check'}`,
    );
    process.exitCode = 1;
} finally {
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    if (db) await db.close();
}

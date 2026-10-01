/**
 * Research-only loopback HTTPS + on-disk SQL relay for actual native ciphertext.
 * The native URLSession uses its ordinary trust policy. The caller may install
 * this fresh test CA ONLY in a newly created disposable research simulator.
 * Authentication responses remain explicit fixtures, not live Supabase accounts.
 * No plaintext, private provider key, pickle or bearer is printed or returned.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSupabaseResearchAuthenticator } from './supabaseAuth.ts';
import { createResearchSignedGateway } from './signedGateway.ts';
import { createResearchHttpGateway } from './httpGateway.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const signatures = Object.freeze({
    register_device: 'text,text',
    revoke_device: 'text,text',
    set_block: 'text,text,boolean',
    claim_prekey: 'text,text,text,text,text',
    send_message: 'text,jsonb',
    list_messages: 'text,text,bigint,integer',
    lookup_request_key: 'text,text',
    execute_request: 'text,text,text,text,text,bigint,text',
});
const headers = Object.freeze({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
});

export async function createNativeExchangeServer({ archivePath, scratch }) {
    assert(isAbsolute(archivePath) && isAbsolute(scratch), 'Explicit absolute research paths required');
    assert(!lstatSync(scratch).isSymbolicLink() && lstatSync(scratch).isDirectory());
    const directory = join(realpathSync(scratch), 'native-exchange-relay');
    assert(!existsSync(directory), 'Never silently reuse an existing relay namespace');
    mkdirSync(directory, { mode: 0o700 });
    const pin = JSON.parse(readFileSync(join(here, 'pglite-pin.json'), 'utf8'));
    assert.equal(pin.shippingApproved, false);
    const archive = readFileSync(archivePath);
    assert(archive.length < 32 * 1024 * 1024);
    assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), pin.integrity);
    const localArchive = join(directory, 'pglite.tgz');
    writeFileSync(localArchive, archive, { mode: 0o600, flag: 'wx' });
    const listing = spawnSync('/usr/bin/tar', ['-tzf', localArchive], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(listing.status, 0);
    assert(
        listing.stdout
            .trim()
            .split('\n')
            .every((name) => name.startsWith('package/') && !name.split('/').includes('..')),
    );
    assert.equal(spawnSync('/usr/bin/tar', ['-xzf', localArchive, '-C', directory], { timeout: 30_000 }).status, 0);
    function checkTree(path) {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            assert(entry.isFile() || entry.isDirectory(), 'No dependency links or special files');
            if (entry.isDirectory()) checkTree(join(path, entry.name));
        }
    }
    checkTree(join(directory, 'package'));
    const metadata = JSON.parse(readFileSync(join(directory, 'package/package.json'), 'utf8'));
    assert.equal(metadata.name, pin.package);
    assert.equal(metadata.version, pin.version);
    assert.equal(metadata.license, pin.license);
    assert(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);
    assert(!metadata.scripts?.install && !metadata.scripts?.postinstall);

    // Private artifacts remain in this fresh scratch namespace. No Mac/system
    // trust store, existing simulator or physical-phone keychain is changed.
    const certPath = join(directory, 'localhost.crt');
    const keyPath = join(directory, 'localhost.key');
    const configPath = join(directory, 'localhost.cnf');
    writeFileSync(
        configPath,
        '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',
        { mode: 0o600, flag: 'wx' },
    );
    const oldUmask = process.umask(0o077);
    try {
        const certificate = spawnSync(
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
                configPath,
            ],
            { encoding: 'utf8', timeout: 30_000 },
        );
        assert.equal(certificate.status, 0, 'Create only this isolated one-day TLS certificate');
    } finally {
        process.umask(oldUmask);
    }

    const { PGlite } = await import(pathToFileURL(join(directory, 'package/dist/index.js')).href);
    const databasePath = join(directory, 'database');
    let db = await PGlite.create(databasePath);
    try {
        await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN');
        await db.exec(readFileSync(join(here, 'relay.sql'), 'utf8'));
    } catch (error) {
        await db.close();
        throw error;
    }
    const users = new Map([
        ['fixture-alice', '11111111-1111-4111-8111-111111111111'],
        ['fixture-bob', '22222222-2222-4222-8222-222222222222'],
    ]);
    const counters = {
        httpRequests: 0,
        authRequests: 0,
        rpcCalls: 0,
        tlsRefusals: 0,
        registrations: 0,
        dispatches: 0,
        lostResponses: 0,
        wrongReceipts: 0,
        malformedLists: 0,
        poisonLists: 0,
        staleContextRequests: 0,
        databaseReopens: 0,
        unexpectedFailures: 0,
    };
    const authenticate = createSupabaseResearchAuthenticator({
        supabaseUrl: 'https://native-exchange-fixture.invalid',
        publicApiKey: 'sb_publishable_fixture',
        fetch: async (url, init) => {
            assert.equal(url, 'https://native-exchange-fixture.invalid/auth/v1/user');
            assert.equal(init.method, 'GET');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.redirect, 'error');
            const requestHeaders = new Headers(init.headers);
            assert.equal(requestHeaders.get('apikey'), 'sb_publishable_fixture');
            const user = users.get(requestHeaders.get('authorization')?.replace(/^Bearer /, ''));
            counters.authRequests++;
            return Response.json(
                user ? { id: user, user_metadata: { actor: 'ignored-fixture' } } : { error: 'fixture' },
                { status: user ? 200 : 401 },
            );
        },
    });
    const pendingRpc = new Set();
    const rpc = (name, args) => {
        assert(Object.hasOwn(signatures, name));
        const casts = signatures[name].split(',');
        assert.equal(args.length, casts.length);
        counters.rpcCalls++;
        const operation = db.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
            const result = await tx.query(
                `SELECT e2ee_research.${name}(${casts.map((cast, i) => `$${i + 1}::${cast}`).join(',')}) AS result`,
                args.map((value, i) => (casts[i] === 'jsonb' ? JSON.stringify(value) : value)),
            );
            return result.rows[0].result;
        }); // Receipt becomes available only after the transaction COMMIT.
        pendingRpc.add(operation);
        void operation.finally(() => pendingRpc.delete(operation)).catch(() => undefined);
        return operation;
    };
    const gateway = createResearchSignedGateway({ authenticate, rpc, nowSeconds: () => Math.floor(Date.now() / 1000) });
    let origin;
    let boundary;
    let active = 0;
    const sockets = new Set();
    const server = createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        async (incoming, outgoing) => {
            active++;
            try {
                counters.httpRequests++;
                const chunks = [];
                let bytes = 0;
                for await (const chunk of incoming) {
                    bytes += chunk.length;
                    assert(bytes <= 256 * 1024, 'Fixture host input cap');
                    chunks.push(chunk);
                }
                const body = Buffer.concat(chunks);
                if (
                    incoming.url === '/v1/dispatch' &&
                    ['stale-epoch-must-not-dispatch', 'callback-epoch-must-not-dispatch'].includes(
                        JSON.parse(body.toString('utf8')).requestId,
                    )
                ) {
                    counters.staleContextRequests++;
                }
                const requestHeaders = new Headers();
                for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                    requestHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
                const request = new Request(`${origin}${incoming.url}`, {
                    method: incoming.method,
                    headers: requestHeaders,
                    ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body }),
                });
                const response = await boundary(request);
                let responseBytes = Buffer.from(await response.arrayBuffer());
                // Faults apply only after successful authenticated/signed dispatch.
                // Neither body actor IDs nor these request IDs grant SQL authority.
                if (response.status === 200) {
                    if (incoming.url === '/v1/register') counters.registrations++;
                    if (incoming.url === '/v1/dispatch') {
                        counters.dispatches++;
                        const requestObject = JSON.parse(body.toString('utf8'));
                        if (
                            requestObject.action === 'send' &&
                            requestObject.requestId === 'lost-send' &&
                            counters.lostResponses === 0
                        ) {
                            assert.equal(JSON.parse(responseBytes.toString('utf8')).result.accepted, true);
                            counters.lostResponses++;
                            incoming.socket.destroy(); // Commit happened; client sees only an unresolved outcome.
                            return;
                        }
                        if (
                            requestObject.action === 'send' &&
                            requestObject.requestId === 'wrong-receipt-send' &&
                            counters.wrongReceipts === 0
                        ) {
                            const value = JSON.parse(responseBytes.toString('utf8'));
                            assert.equal(value.result.accepted, true);
                            assert(Number.isSafeInteger(value.result.recipientIdentityGeneration));
                            value.result.recipientIdentityGeneration++;
                            responseBytes = Buffer.from(JSON.stringify(value));
                            counters.wrongReceipts++;
                        }
                        if (
                            requestObject.action === 'list' &&
                            requestObject.requestId === 'malformed-list' &&
                            counters.malformedLists === 0
                        ) {
                            const value = JSON.parse(responseBytes.toString('utf8'));
                            assert(Array.isArray(value.result) && value.result.length > 0);
                            value.result.push({ serverId: 999999, serializedEnvelope: 'invalid-fixture-final-row' });
                            responseBytes = Buffer.from(JSON.stringify(value));
                            counters.malformedLists++;
                        }
                        if (
                            requestObject.action === 'list' &&
                            [
                                'partial-poison-list',
                                'partial-poison-reread',
                                'read-successor',
                                'verify-restart',
                                'old-peer-generation-rescan',
                                'old-generation-rescan',
                                'recovery-after-restart',
                                'recovery-rescan',
                            ].includes(requestObject.requestId)
                        ) {
                            const value = JSON.parse(responseBytes.toString('utf8'));
                            assert(Array.isArray(value.result) && value.result.length >= 1);
                            assert.equal(value.result[0].serverId, 1);
                            assert(value.result.length === 1 || value.result[1].serverId > 2);
                            const original = value.result[0];
                            const envelope = JSON.parse(original.serializedEnvelope);
                            // Structurally valid, but changing the outer message
                            // ID cannot authenticate that ID inside native content.
                            // This response-only fixture never enters the SQL ledger.
                            envelope.clientMessageId = 'exchange-poison';
                            value.result.splice(1, 0, {
                                ...original,
                                serverId: original.serverId + 1,
                                serializedEnvelope: encodeDirectMessageEnvelope(envelope),
                            });
                            responseBytes = Buffer.from(JSON.stringify(value));
                            counters.poisonLists++;
                        }
                    }
                }
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(responseBytes);
            } catch {
                counters.unexpectedFailures++;
                if (!outgoing.headersSent && !outgoing.destroyed) {
                    outgoing.writeHead(503, headers);
                    outgoing.end('{"version":1,"error":"request-unresolved"}');
                } else outgoing.destroy();
            } finally {
                active--;
            }
        },
    );
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => counters.tlsRefusals++);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    }).catch(async (error) => {
        for (const socket of sockets) socket.destroy();
        await db.close();
        throw error;
    });
    origin = `https://127.0.0.1:${server.address().port}`;
    boundary = createResearchHttpGateway({ serviceOrigin: origin, gateway });

    async function snapshot() {
        assert.equal(active, 0, 'Verification/reopen is between completed native phases');
        assert.equal(pendingRpc.size, 0, 'No uncertain in-flight SQL transaction is treated as a completed phase');
        return {
            devices: (await db.query('SELECT count(*)::integer AS n FROM e2ee_research.devices')).rows[0].n,
            decisions: (await db.query('SELECT * FROM e2ee_research.decisions ORDER BY server_id')).rows,
            requests: (await db.query('SELECT * FROM e2ee_research.requests ORDER BY owner_id,device_id,request_id'))
                .rows,
        };
    }
    return Object.freeze({
        origin,
        certPath,
        counters: () => Object.freeze({ ...counters }),
        async verify({
            expectedDecisions,
            expectedMessages,
            expectedClientIds,
            forbiddenPlaintexts = [],
            expectedFaults,
        } = {}) {
            const value = await snapshot();
            assert.equal(value.devices, 2, 'Only two native fixture devices registered');
            if (expectedDecisions !== undefined) assert.equal(value.decisions.length, expectedDecisions);
            const messages = value.decisions.filter((row) => row.accepted === true).length;
            if (expectedMessages !== undefined) assert.equal(messages, expectedMessages);
            assert(
                value.decisions.every((row) => row.accepted === true),
                'All durable decisions accepted once',
            );
            if (expectedClientIds)
                assert.deepEqual(
                    value.decisions.map((row) => row.client_message_id).sort(),
                    [...expectedClientIds].sort(),
                );
            const serialized = JSON.stringify(value);
            for (const plaintext of forbiddenPlaintexts) {
                assert(typeof plaintext === 'string' && plaintext.length > 0);
                assert(!serialized.includes(plaintext), 'Relay contains no native test plaintext');
            }
            if (expectedFaults)
                for (const [name, count] of Object.entries(expectedFaults)) {
                    assert(['lostResponses', 'wrongReceipts', 'malformedLists', 'poisonLists'].includes(name));
                    assert.equal(counters[name], count);
                }
            assert.equal(counters.unexpectedFailures, 0, 'No hidden fixture-host failure');
            assert.equal(counters.staleContextRequests, 0, 'Stale native epochs never reached HTTP/Auth/SQL');
            assert(
                counters.authRequests >= counters.registrations + counters.dispatches,
                'Each completed registration and signed request checked fresh fixture Auth',
            );
            return Object.freeze({
                devices: value.devices,
                decisions: value.decisions.length,
                messages,
                requests: value.requests.length,
                ...counters,
            });
        },
        async reopen() {
            const before = await snapshot();
            await db.close();
            db = await PGlite.create(databasePath);
            assert.deepEqual(await snapshot(), before, 'On-disk SQL decisions and requests survive reopen');
            counters.databaseReopens++;
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            // Destruction of a client socket does not cancel an accepted SQL
            // transaction. Observe its settlement before closing the database.
            const deadline = Date.now() + 12_000;
            while (active > 0 && Date.now() < deadline) await delay(50);
            assert.equal(active, 0, 'No relay operation remains while closing SQL');
            await Promise.allSettled([...pendingRpc]);
            if (!db.closed) await db.close();
        },
    });
}

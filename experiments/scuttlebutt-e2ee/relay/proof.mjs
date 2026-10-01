/** Isolated real PostgreSQL-engine proof; fixture Auth, not Supabase/network proof.
 * node --experimental-strip-types proof.mjs --fetch
 * Or pass the absolute path of an already downloaded, pinned package tarball.
 * Only --fetch accesses the network, solely for the pinned public test dependency.
 * All generated keys, downloaded code and database files remain in fresh temp dirs.
 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceBundleSigningBytes, encodeDeviceBundle } from './deviceBundle.ts';
import { createResearchGateway, encodeResearchOutbox } from './gateway.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, 'pglite-pin.json'), 'utf8'));
assert.equal(pin.shippingApproved, false);
const [source, ...extra] = process.argv.slice(2);
assert(
    source && !extra.length && (source === '--fetch' || isAbsolute(source)),
    'Supply --fetch or pinned archive absolute path',
);
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-relay-'));
console.log(`Isolated relay research directory: ${scratch}`);
let archive;
if (source === '--fetch') {
    const response = await fetch(pin.tarball, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
    assert(response.ok, 'Pinned public test dependency unavailable');
    archive = Buffer.from(await response.arrayBuffer());
} else archive = readFileSync(source);
assert(archive.length < 32 * 1024 * 1024, 'Bounded package');
assert.equal(
    'sha512-' + createHash('sha512').update(archive).digest('base64'),
    pin.integrity,
    'Pinned package integrity',
);
const archivePath = join(scratch, 'pglite.tgz');
writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 });
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
        assert(entry.isFile() || entry.isDirectory(), 'No test dependency links or special files');
        if (entry.isDirectory()) checkTree(join(path, entry.name));
    }
}
checkTree(join(scratch, 'package'));
const metadata = JSON.parse(readFileSync(join(scratch, 'package/package.json'), 'utf8'));
assert.equal(metadata.name, pin.package);
assert.equal(metadata.version, pin.version);
assert.equal(metadata.license, pin.license);
assert(!metadata.dependencies || Object.keys(metadata.dependencies).length === 0);
assert(!metadata.scripts?.install && !metadata.scripts?.postinstall, 'No dependency install scripts executed');

// Cooperate with Claude's shared-Mac build guard. Do not claim the slot while
// waiting (two waiting runners would otherwise block one another).
let waiting = false;
for (;;) {
    const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!p.error && [0, 1].includes(p.status), 'Must inspect build slot');
    const others = p.stdout
        .trim()
        .split('\n')
        .filter(
            (line) =>
                line && !line.startsWith(`${process.pid} `) && !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish)\s/.test(line),
        );
    if (!others.length) break;
    if (!waiting) console.log('Waiting for shared-Mac build slot.');
    waiting = true;
    await delay(5_000);
}
process.title = 'vite build slot: isolated E2EE PostgreSQL proof';
const { PGlite } = await import(pathToFileURL(join(scratch, 'package/dist/index.js')).href);
let pg = await PGlite.create(join(scratch, 'database'));
let checks = 0;
let currentGroup = 'schema and signed fixture registration';
let lastRpcFailure = null;
async function check(name, body) {
    currentGroup = name;
    await body();
    checks++;
    console.log(`PASS ${name}`);
}
const signatures = {
    register_device: 'text,text',
    revoke_device: 'text,text',
    set_block: 'text,text,boolean',
    claim_prekey: 'text,text,text,text,text',
    send_message: 'text,jsonb',
    list_messages: 'text,text,bigint,integer',
};
let rollbackNextSend = false;
async function rpc(name, args) {
    assert(Object.hasOwn(signatures, name), 'Fixed RPC allowlist');
    const casts = signatures[name].split(',');
    assert.equal(args.length, casts.length);
    return pg
        .transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
            const placeholders = casts.map((cast, i) => `$${i + 1}::${cast}`).join(',');
            const values = args.map((value, i) => (casts[i] === 'jsonb' ? JSON.stringify(value) : value));
            const result = await tx.query(`SELECT e2ee_research.${name}(${placeholders}) AS result`, values);
            if (rollbackNextSend && name === 'send_message') {
                rollbackNextSend = false;
                throw new Error('fixture rollback');
            }
            lastRpcFailure = null;
            return result.rows[0].result;
        })
        .catch((error) => {
            // Diagnostic identifiers only; never query/params/detail or raw error.
            lastRpcFailure = {
                rpc: name,
                code: error?.code ?? 'fixture-rollback',
                position: error?.position ?? error?.internalPosition ?? null,
                schemaDiagnostic: ['42501', '42702', '42883', '42601'].includes(error?.code) ? error.message : null,
            };
            throw error;
        });
}
const credentials = new Map();
const gateway = createResearchGateway({
    authenticate: async (token) => (credentials.has(token) ? { userId: credentials.get(token) } : null),
    rpc,
    nowSeconds: () => Math.floor(Date.now() / 1000),
});
const b64 = (value) => Buffer.from(value).toString('base64').replace(/=+$/, '');
async function bundle(user, options = {}) {
    const signing = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const curve = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const prekey = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: user,
        deviceId: `${user}-phone`,
        identityKeyId: `${user}-identity`,
        signingKey: b64(await webcrypto.subtle.exportKey('raw', signing.publicKey)),
        curveKey: b64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
        prekeyId: `${user}-prekey`,
        prekey: b64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        ...options,
    };
    const signature = b64(
        await webcrypto.subtle.sign('Ed25519', signing.privateKey, deviceBundleSigningBytes(unsigned)),
    );
    return encodeDeviceBundle({ ...unsigned, signature });
}
const token = (user) => `fixture-${user}`;
const frame = (message = 'first', changes = {}) => ({
    version: 2,
    protocol: 'olm-v1',
    messageType: 'prekey',
    clientMessageId: message,
    senderDeviceId: 'alice-phone',
    recipientDeviceId: 'bob-phone',
    ciphertext: 'YQ==',
    ...changes,
});
const record = (message = 'first', changes = {}, frameChanges = {}) => ({
    ownerUserId: 'alice',
    ownerSessionGeneration: 7,
    recipientUserId: 'bob',
    recipientIdentityKeyId: 'bob-identity',
    recipientIdentityGeneration: 3,
    serializedEnvelope: encodeDirectMessageEnvelope(frame(message, frameChanges)),
    ...changes,
});
const send = (value) => gateway.send(token('alice'), encodeResearchOutbox(value));
const count = async (table) => Number((await pg.query(`SELECT count(*) AS n FROM e2ee_research.${table}`)).rows[0].n);
const rejects = async (fn) => assert.rejects(async () => fn());
try {
    await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
    await pg.exec(readFileSync(join(here, 'relay.sql'), 'utf8'));
    await pg.exec('RESET SESSION AUTHORIZATION');
    await pg.exec('RESET ROLE');
    await check('private roles cannot inspect tables, mutate state, call RPCs or assume gateway', async () => {
        // Open distinct sequential role sessions. SET SESSION AUTHORIZATION is
        // not a reliable reset fixture in PGlite; it is not JWT authentication.
        for (const role of ['anon', 'authenticated', 'e2ee_research_gateway']) {
            await pg.close();
            pg = await PGlite.create({ dataDir: join(scratch, 'database') });
            // PGlite's username option executes SET ROLE rather than creating a
            // non-superuser login. Explicitly change session authorization in
            // this disposable session so SET ROLE escalation is really tested.
            await pg.exec(`SET SESSION AUTHORIZATION ${role}`);
            assert.deepEqual((await pg.query('SELECT session_user, current_user')).rows[0], {
                session_user: role,
                current_user: role,
            });
            const deniedQueries = [
                'SELECT * FROM e2ee_research.devices',
                'DELETE FROM e2ee_research.decisions',
                'SET ROLE e2ee_research_owner',
            ];
            if (role === 'e2ee_research_gateway') deniedQueries.push("SELECT e2ee_research.parse_bundle('{}')");
            else
                deniedQueries.push(
                    "SELECT e2ee_research.revoke_device('alice','alice-phone')",
                    'SET ROLE e2ee_research_gateway',
                );
            for (const query of deniedQueries) {
                currentGroup = `permission fixture ${role}: ${query}`;
                // A setup error or invalid input is NOT permission-denial evidence.
                await assert.rejects(
                    () => pg.exec(query),
                    (error) => error?.code === '42501',
                );
            }
        }
        await pg.close();
        pg = await PGlite.create({ dataDir: join(scratch, 'database'), username: 'postgres' });
        assert.deepEqual((await pg.query('SELECT session_user, current_user')).rows[0], {
            session_user: 'postgres',
            current_user: 'postgres',
        });
    });
    const bundles = {};
    for (const user of ['alice', 'bob', 'carol', 'dave']) {
        credentials.set(token(user), user);
        bundles[user] = await bundle(user);
        await gateway.register(token(user), bundles[user]);
    }
    await check('real signed registration: immutable retry, no other owner or second device', async () => {
        assert.deepEqual(await gateway.register(token('alice'), bundles.alice), {
            registered: true,
            userId: 'alice',
            deviceId: 'alice-phone',
        });
        await rejects(() => gateway.register(token('bob'), bundles.alice));
        await rejects(() => gateway.register('invalid-token', bundles.alice));
        await rejects(async () => gateway.register(token('alice'), await bundle('alice', { deviceId: 'alice-other' })));
        await rejects(() => rpc('register_device', ['bob', bundles.alice]));
        await rejects(async () => rpc('register_device', ['dave', await bundle('dave', { deviceId: 'bob-phone' })]));
        assert.equal(await count('devices'), 4);
    });
    await check('private SQL rejects malformed bundle, protocol and noncanonical JSON', async () => {
        for (const malformed of [
            'null',
            '{}',
            '[]',
            bundles.alice + ' ',
            bundles.alice.replace('"version":1', '"version":null'),
            bundles.alice.replace('"protocol":"olm-v1"', '"protocol":null'),
            bundles.alice.replace('"version":1', '"version":1,"version":1'),
        ]) {
            await rejects(() => rpc('register_device', ['alice', malformed]));
        }
    });
    await check('atomic prekey claim retries same reservation; no second claimant or retarget', async () => {
        const claimed = await gateway.claim(token('alice'), 'alice-phone', 'bob', 'bob-phone', 'claim1');
        assert.equal(claimed.signedBundle, bundles.bob);
        assert.deepEqual(await gateway.claim(token('alice'), 'alice-phone', 'bob', 'bob-phone', 'claim1'), claimed);
        await rejects(() => gateway.claim(token('carol'), 'carol-phone', 'bob', 'bob-phone', 'claim2'));
        await rejects(() => gateway.claim(token('alice'), 'alice-phone', 'carol', 'carol-phone', 'claim1'));
        await rejects(() => gateway.claim(token('carol'), 'alice-phone', 'dave', 'dave-phone', 'claim3'));
        assert.equal(await count('claims'), 1);
    });
    await check('self sends, claims and blocks denied in both gateway and SQL', async () => {
        await rejects(() => rpc('set_block', ['alice', 'alice', true]));
        await rejects(() => rpc('claim_prekey', ['alice', 'alice-phone', 'alice', 'alice-phone', 'self']));
        await rejects(() =>
            rpc('send_message', [
                'alice',
                record(
                    'self',
                    { recipientUserId: 'alice', recipientIdentityKeyId: 'alice-identity' },
                    { recipientDeviceId: 'alice-phone' },
                ),
            ]),
        );
    });
    let accepted;
    await check('send commit returns exact receipt; duplicate retry creates one decision', async () => {
        accepted = await send(record());
        assert.deepEqual(accepted, { ...record(), accepted: true });
        assert.deepEqual(await send(record()), accepted);
        assert.equal(await count('decisions'), 1);
    });
    await check('every changed immutable record field conflicts without overwriting winner', async () => {
        for (const changed of [
            record('first', { ownerSessionGeneration: 8 }),
            record('first', { recipientIdentityGeneration: 4 }),
            record('first', { recipientIdentityKeyId: 'changed' }),
            record('first', { recipientUserId: 'carol' }),
            record('first', {}, { ciphertext: 'Yg==' }),
            record('first', {}, { messageType: 'session' }),
        ])
            assert.deepEqual(await send(changed), { ...changed, accepted: false, reason: 'record-conflict' });
        assert.deepEqual(await send(record()), accepted);
        assert.equal(await count('decisions'), 1);
    });
    await check('sender ownership and recipient identity enforced independently of local generations', async () => {
        await rejects(() => gateway.send(token('bob'), encodeResearchOutbox(record('spoof'))));
        await rejects(() => rpc('send_message', ['bob', record('spoof')]));
        await rejects(() => send(record('wrong-device', {}, { senderDeviceId: 'bob-phone' })));
        await rejects(() => send(record('unknown-peer', { recipientIdentityKeyId: 'other-identity' })));
        await rejects(() => send(record('unknown-account', { recipientUserId: 'carol' })));
        assert.equal(await count('decisions'), 1);
    });
    await check('ciphertext retrieval is recipient/device scoped and cursor bounded', async () => {
        const inbox = await gateway.list(token('bob'), 'bob-phone');
        assert.equal(inbox.length, 1);
        assert.deepEqual(inbox[0], { ...accepted, serverId: inbox[0].serverId });
        assert.deepEqual(await gateway.list(token('bob'), 'bob-phone', inbox[0].serverId), []);
        assert.deepEqual(await gateway.list(token('carol'), 'carol-phone'), []);
        await rejects(() => gateway.list(token('carol'), 'bob-phone'));
        await rejects(() => rpc('list_messages', ['carol', 'bob-phone', 0, 16]));
        await rejects(() => rpc('list_messages', ['bob', 'bob-phone', 0, 17]));
        await rejects(() => rpc('list_messages', ['bob', 'bob-phone', -1, 16]));
    });
    await check('recipient block persists terminal refusal; unblock cannot revive it', async () => {
        await gateway.block(token('bob'), 'alice', true);
        const blocked = record('blocked');
        const refusal = await send(blocked);
        assert.deepEqual(refusal, { ...blocked, accepted: false, reason: 'blocked' });
        assert.deepEqual(await send(record()), accepted);
        assert.deepEqual(await gateway.list(token('bob'), 'bob-phone'), []);
        await rejects(() => gateway.claim(token('alice'), 'alice-phone', 'bob', 'bob-phone', 'claim1'));
        await gateway.block(token('bob'), 'alice', false);
        assert.deepEqual(await send(blocked), refusal);
        assert.equal((await gateway.list(token('bob'), 'bob-phone')).length, 1);
    });
    await check('sender block also prevents new send and claim', async () => {
        await gateway.block(token('alice'), 'dave', true);
        await rejects(() => gateway.claim(token('alice'), 'alice-phone', 'dave', 'dave-phone', 'dave-claim'));
        const blocked = record(
            'sender-block',
            { recipientUserId: 'dave', recipientIdentityKeyId: 'dave-identity' },
            { recipientDeviceId: 'dave-phone' },
        );
        assert.equal((await send(blocked)).reason, 'blocked');
        await gateway.block(token('alice'), 'dave', false);
        assert.equal((await send(blocked)).reason, 'blocked');
    });
    await check('rollback after SQL result produces no server decision or terminal receipt', async () => {
        const before = await count('decisions');
        rollbackNextSend = true;
        await rejects(() => send(record('rollback')));
        assert.equal(await count('decisions'), before);
        assert.equal((await send(record('rollback'))).accepted, true);
        assert.equal(await count('decisions'), before + 1);
    });
    await check('database independently refuses malformed/legacy/noncanonical frames and generations', async () => {
        const badFrames = [
            null,
            {},
            [],
            { ...frame(), version: null },
            { ...frame(), protocol: null },
            { ...frame(), messageType: null },
            { ...frame(), protocol: 'signal-triple-ratchet' },
            { ...frame(), ciphertext: 'YR==' },
            { ...frame(), ciphertext: Buffer.alloc(66561).toString('base64') },
            { ...frame(), clientMessageId: 'm\n' },
        ].map((x) => JSON.stringify(x));
        badFrames.push(
            record().serializedEnvelope + ' ',
            record().serializedEnvelope.replace('"version":2', '"version":2,"version":2'),
        );
        const before = await count('decisions');
        for (const serializedEnvelope of badFrames)
            await rejects(() => rpc('send_message', ['alice', { ...record('invalid'), serializedEnvelope }]));
        for (const value of [null, -1, 0.5, '7', 9007199254740992])
            await rejects(() => rpc('send_message', ['alice', record('invalid', { ownerSessionGeneration: value })]));
        for (const value of [null, [], { ...record(), plaintext: 'must-not-be-stored' }])
            await rejects(() => rpc('send_message', ['alice', value]));
        assert.equal(await count('decisions'), before);
    });
    await check('revocation permanent; old acceptance immutable, new sends refused', async () => {
        await rejects(() => gateway.revoke(token('carol'), 'bob-phone'));
        await gateway.revoke(token('bob'), 'bob-phone');
        await gateway.revoke(token('bob'), 'bob-phone');
        await rejects(() => gateway.register(token('bob'), bundles.bob));
        await rejects(() => gateway.claim(token('alice'), 'alice-phone', 'bob', 'bob-phone', 'claim1'));
        await rejects(() => gateway.list(token('bob'), 'bob-phone'));
        assert.deepEqual(await send(record()), accepted);
        assert.equal((await send(record('after-revoke'))).reason, 'device-revoked');
    });
    await check('expired public prekey cannot be claimed (wall-clock PostgreSQL check)', async () => {
        credentials.set(token('eve'), 'eve');
        await gateway.register(token('eve'), await bundle('eve', { expiresAt: Math.floor(Date.now() / 1000) + 2 }));
        await delay(2_100);
        await rejects(() => gateway.claim(token('carol'), 'carol-phone', 'eve', 'eve-phone', 'expired'));
    });
    await check('older transaction snapshots refused rather than bypass lifecycle changes', async () => {
        await rejects(() =>
            pg.transaction(async (tx) => {
                await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE e2ee_research_gateway');
                await tx.query("SELECT e2ee_research.list_messages('alice','alice-phone',0,16)");
            }),
        );
    });
    await check('bounded terminal ledger fails closed at capacity but preserves exact retries', async () => {
        const before = await count('decisions');
        for (let i = before; i < 256; i++) {
            assert.equal((await send(record(`cap-${i}`))).reason, 'device-revoked');
        }
        assert.equal(await count('decisions'), 256);
        await rejects(() => send(record('overflow')));
        assert.deepEqual(await send(record()), accepted);
        assert.equal((await send(record('first', { recipientIdentityGeneration: 4 }))).reason, 'record-conflict');
    });
    await check(
        'persisted rows have only public bundle/routing/ciphertext fields, no plaintext body column',
        async () => {
            const columns = (
                await pg.query("SELECT column_name FROM information_schema.columns WHERE table_schema='e2ee_research'")
            ).rows.map((row) => row.column_name);
            for (const forbidden of [
                'plaintext',
                'text',
                'body',
                'private_key',
                'pickle',
                'access_token',
                'refresh_token',
            ])
                assert(!columns.includes(forbidden));
            const value = (await pg.query('SELECT serialized_envelope FROM e2ee_research.decisions LIMIT 1')).rows[0]
                .serialized_envelope;
            assert.equal(value, record().serializedEnvelope);
        },
    );
    // Close/reopen the actual on-disk database; not an in-memory fake/repository cache.
    await pg.close();
    const reopened = await PGlite.create(join(scratch, 'database'));
    assert.equal(Number((await reopened.query('SELECT count(*) AS n FROM e2ee_research.decisions')).rows[0].n), 256);
    assert.equal(
        (await reopened.query("SELECT revoked FROM e2ee_research.devices WHERE user_id='bob'")).rows[0].revoked,
        true,
    );
    await reopened.close();
    checks++;
    console.log('PASS database close/reopen preserves terminal records and revocation');
    console.log(
        `${checks} research PostgreSQL scenario groups passed. Auth principals and ciphertext are fixtures; no live JWT, real-device relay, independent concurrent connections or security audit proved.`,
    );
} catch (error) {
    // Never dump a PostgreSQL error object: it can contain the complete query
    // and parameters. These fixed scenario names identify failures instead.
    console.error(`Scenario: ${currentGroup}; last RPC diagnostic: ${JSON.stringify(lastRpcFailure)}`);
    console.error(
        (error?.stack ?? '')
            .split('\n')
            .filter((line) => line.trimStart().startsWith('at ') && line.includes('/relay/proof.mjs:'))
            .slice(0, 3)
            .join('\n'),
    );
    console.error(
        `Research proof failed after ${checks} completed groups; code=${typeof error?.code === 'string' ? error.code : 'assertion-or-runtime'}; SQL position=${error?.position ?? error?.internalPosition ?? 'n/a'}`,
    );
    process.exitCode = 1;
} finally {
    if (!pg.closed) await pg.close();
}

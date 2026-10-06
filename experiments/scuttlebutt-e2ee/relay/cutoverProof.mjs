/**
 * Fresh on-disk PostgreSQL-engine fixture, real Ed25519 signatures, synthetic
 * Auth/legacy identity/ciphertext and no network/sink. Not a native, hosted,
 * independent-connection concurrency or encryption/security-audit result.
 * Supply only an absolute path to the pinned already-owned PGlite archive.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceBundleSigningBytes, encodeDeviceBundle } from './deviceBundle.ts';
import { createResearchSignedGateway } from './signedGateway.ts';
import { encodeResearchOutbox } from './gateway.ts';
import { encodeSignedResearchRequest, researchRequestSigningBytes } from './signedRequest.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';
import { encodePrivateNotificationProjection } from './privateNotification.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const [archiveSource, ...extra] = process.argv.slice(2);
assert(archiveSource && isAbsolute(archiveSource) && extra.length === 0, 'Pinned archive absolute path required');
const pin = JSON.parse(readFileSync(join(here, 'pglite-pin.json'), 'utf8'));
assert.equal(pin.shippingApproved, false);
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-cutover-'));
console.info(`Isolated SQL cutover directory: ${scratch}`);
const hashes = {};
const inputFiles = [
    'experiments/scuttlebutt-e2ee/relay/cutoverProof.mjs',
    'experiments/scuttlebutt-e2ee/relay/relay.sql',
    'experiments/scuttlebutt-e2ee/relay/privateNotifications.sql',
    'experiments/scuttlebutt-e2ee/relay/legacyCutoverFixture.sql',
    'experiments/scuttlebutt-e2ee/relay/pglite-pin.json',
    'experiments/scuttlebutt-e2ee/relay/deviceBundle.ts',
    'experiments/scuttlebutt-e2ee/relay/signedRequest.ts',
    'experiments/scuttlebutt-e2ee/relay/signedGateway.ts',
    'experiments/scuttlebutt-e2ee/relay/gateway.ts',
    'experiments/scuttlebutt-e2ee/relay/privateNotification.ts',
    'services/chat/e2ee/directMessageEnvelope.ts',
    'services/chat/e2ee/encryptedDmDelivery.ts',
];
const sourceDir = join(scratch, 'source');
mkdirSync(sourceDir, { mode: 0o700 });
const sql = {};
for (const path of inputFiles) {
    const bytes = readFileSync(join(root, path));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
    const target = join(sourceDir, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    if (path.endsWith('.sql')) sql[path.split('/').at(-1)] = bytes.toString('utf8');
}
const archive = readFileSync(archiveSource);
assert(archive.length < 32 * 1024 * 1024);
assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), pin.integrity);
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
        assert(entry.isFile() || entry.isDirectory(), 'No links or special files');
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
for (;;) {
    const p = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!p.error && [0, 1].includes(p.status), 'Build slot inspection required');
    const others = p.stdout
        .trim()
        .split('\n')
        .filter(
            (line) =>
                line && !line.startsWith(`${process.pid} `) && !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish)\s/.test(line),
        );
    if (!others.length) break;
    await delay(5_000);
}
process.title = 'vite build slot: isolated server cutover SQL';
const { PGlite } = await import(pathToFileURL(join(scratch, 'package/dist/index.js')).href);
const dataDir = join(scratch, 'database');
let pg = await PGlite.create(dataDir);
let group = 'schema setup';
const completedGroups = [];
const operations = [];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
async function check(name, operation) {
    group = name;
    await operation();
    completedGroups.push(name);
    console.info(`PASS ${name}`);
}
async function fixture(userId) {
    const signing = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const curve = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const prekey = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId,
        deviceId: `${userId}-device`,
        identityKeyId: `${userId}-identity`,
        signingKey: b64(await webcrypto.subtle.exportKey('raw', signing.publicKey)),
        curveKey: b64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
        prekeyId: `${userId}-prekey`,
        prekey: b64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
        expiresAt: nowSeconds() + 3600,
    };
    return {
        ...unsigned,
        privateKey: signing.privateKey,
        bundle: encodeDeviceBundle({
            ...unsigned,
            signature: b64(
                await webcrypto.subtle.sign('Ed25519', signing.privateKey, deviceBundleSigningBytes(unsigned)),
            ),
        }),
    };
}
async function sign(actor, action, payload, requestId = randomUUID()) {
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: actor.userId,
        deviceId: actor.deviceId,
        action,
        requestId,
        expiresAt: nowSeconds() + 120,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
    return encodeSignedResearchRequest({
        ...unsigned,
        signature: b64(await webcrypto.subtle.sign('Ed25519', actor.privateKey, researchRequestSigningBytes(unsigned))),
    });
}
function record(sender, recipient, id = randomUUID(), ciphertext = 'YQ==') {
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
const tokens = new Map();
let rollbackNextExecute = false;
const rpcTypes = {
    register_device: ['text', 'text'],
    lookup_request_key: ['text', 'text'],
    execute_request: ['text', 'text', 'text', 'text', 'text', 'bigint', 'text'],
};
async function rpc(name, args) {
    assert(Object.hasOwn(rpcTypes, name));
    const casts = rpcTypes[name];
    assert.equal(args.length, casts.length);
    operations.push(name);
    return pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
        const response = await tx.query(
            `SELECT e2ee_research.${name}(${casts.map((type, i) => `$${i + 1}::${type}`).join(',')}) AS result`,
            args,
        );
        if (rollbackNextExecute && name === 'execute_request') {
            rollbackNextExecute = false;
            throw new Error('Synthetic post-operation rollback');
        }
        return response.rows[0].result;
    });
}
const gateway = createResearchSignedGateway({
    authenticate: async (token) => (tokens.has(token) ? { userId: tokens.get(token) } : null),
    rpc,
    nowSeconds,
});
const token = (actor) => `fixture-${actor.userId}`;
const dispatch = (actor, wire) => gateway.dispatch(token(actor), wire);
const act = async (actor, action, payload, id) => dispatch(actor, await sign(actor, action, payload, id));
const mode = (actor, id) => act(actor, 'account-mode', [], id);
const protect = (actor, id) => act(actor, 'require-protected', [], id);
const block = (actor, peer, value) => act(actor, 'block', [peer.userId, value]);
const send = (actor, row, id) => act(actor, 'send', encodeResearchOutbox(row), id);
const count = async (table) => Number((await pg.query(`SELECT count(*) AS n FROM e2ee_research.${table}`)).rows[0].n);
const notification = async (row) =>
    (
        await pg.query(
            `SELECT notification.* FROM e2ee_research.private_notifications notification
    JOIN e2ee_research.decisions entry ON entry.server_id=notification.decision_server_id
    WHERE entry.owner_id=$1 AND entry.client_message_id=$2`,
            [row.ownerUserId, JSON.parse(row.serializedEnvelope).clientMessageId],
        )
    ).rows[0];
async function processor(fn, route, claim) {
    assert(['claim_private_notification', 'finish_private_notification'].includes(fn));
    return pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE e2ee_research_notification_processor');
        return (await tx.query(`SELECT e2ee_research.${fn}($1::uuid,$2::uuid) AS result`, [route, claim])).rows[0]
            .result;
    });
}
const claim = (route, token) => processor('claim_private_notification', route, token);
const finish = (route, token) => processor('finish_private_notification', route, token);
async function legacyAs(actor, query, args = []) {
    return pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE e2ee_research_legacy_fixture_client');
        await tx.query("SELECT set_config('e2ee_research_fixture.actor_id',$1,true)", [actor.userId]);
        return tx.query(query, args);
    });
}
async function legacyInsert(sender, recipient, body = 'SYNTHETIC-OLD-PRIVATE-CANARY') {
    return (
        await legacyAs(
            sender,
            `INSERT INTO e2ee_research.legacy_fixture_messages(sender_id,recipient_id,message)
        VALUES($1,$2,$3) RETURNING id`,
            [sender.userId, recipient.userId, body],
        )
    ).rows[0].id;
}
const legacyQueue = async (id) =>
    (await pg.query('SELECT * FROM e2ee_research.legacy_fixture_push WHERE message_id=$1::uuid', [id])).rows[0];
async function legacyClaim(id) {
    return pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE e2ee_research_legacy_fixture_processor');
        return (await tx.query('SELECT e2ee_research.claim_legacy_fixture_push($1::uuid) AS result', [id])).rows[0]
            .result;
    });
}
function projection(value, route) {
    const wire = encodePrivateNotificationProjection(value);
    assert.deepEqual(JSON.parse(wire), {
        version: 1,
        type: 'private-message',
        title: 'Thalassa',
        body: 'Open Thalassa to view your private messages.',
        route: { messageId: route },
    });
    for (const canary of [
        'SYNTHETIC-OLD-PRIVATE-CANARY',
        'Synthetic Sailor',
        'YQ==',
        'privateKey',
        'signingKey',
        'serializedEnvelope',
    ])
        assert(!wire.includes(canary));
}
const expectations = [];
try {
    await pg.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
    await pg.exec(sql['relay.sql']);
    await pg.exec(sql['privateNotifications.sql']);
    await pg.exec(sql['legacyCutoverFixture.sql']);
    const [alice, bob, carol, dave, eve, frank, revoked, capacity] = await Promise.all(
        [
            'cutover-alice',
            'cutover-bob',
            'cutover-carol',
            'cutover-dave',
            'cutover-eve',
            'cutover-frank',
            'cutover-revoked',
            'cutover-capacity',
        ].map(fixture),
    );
    for (const actor of [alice, bob, carol, dave, eve, frank, revoked, capacity]) {
        tokens.set(token(actor), actor.userId);
        await gateway.register(token(actor), actor.bundle);
    }
    await check('fresh mode query is signed, principal-bound and does not consume mutation budget', async () => {
        const wire = await sign(alice, 'account-mode', [], 'same-diagnostic');
        assert.equal((await dispatch(alice, wire)).mode, 'legacy-permitted');
        assert.equal((await dispatch(alice, wire)).mode, 'legacy-permitted');
        assert.equal(await count('requests'), 0);
        await assert.rejects(() => dispatch(bob, wire));
        const forged = JSON.stringify({ ...JSON.parse(wire), signature: 'A'.repeat(86) });
        const before = operations.filter((name) => name === 'execute_request').length;
        await assert.rejects(() => dispatch(alice, forged));
        assert.equal(operations.filter((name) => name === 'execute_request').length, before);
    });
    let oldId, oldPush, aliceWire;
    await check('positive legacy ownership, read-only update and generic queue control', async () => {
        oldId = await legacyInsert(alice, bob);
        oldPush = await legacyQueue(oldId);
        assert.equal(
            (await legacyAs(alice, 'SELECT id,message FROM e2ee_research.legacy_fixture_messages')).rows.length,
            1,
        );
        assert.equal((await legacyAs(bob, 'SELECT id FROM e2ee_research.legacy_fixture_messages')).rows.length, 1);
        assert.equal((await legacyAs(carol, 'SELECT id FROM e2ee_research.legacy_fixture_messages')).rows.length, 0);
        await legacyAs(bob, 'UPDATE e2ee_research.legacy_fixture_messages SET read=true WHERE id=$1::uuid', [oldId]);
        await assert.rejects(
            () => legacyAs(alice, "UPDATE e2ee_research.legacy_fixture_messages SET message='changed'"),
            (error) => error?.code === '42501',
        );
        projection(await legacyClaim(oldPush.id), oldPush.id);
    });
    const rollbackWire = await sign(carol, 'require-protected', [], 'rollback-cutover');
    await check('cutover and signed mutation ledger roll back together on post-operation failure', async () => {
        rollbackNextExecute = true;
        await assert.rejects(() => dispatch(carol, rollbackWire));
        assert.equal((await mode(carol)).mode, 'legacy-permitted');
        assert.equal(await count('protected_accounts'), 0);
        assert.equal(await count('requests'), 0);
    });
    await check(
        'durable one-way cutover denies client reads and privileged legacy writes without changing old bytes',
        async () => {
            aliceWire = await sign(alice, 'require-protected', [], 'alice-cutover');
            const receipt = await dispatch(alice, aliceWire);
            assert.equal(receipt.mode, 'protected-required');
            assert.deepEqual(await dispatch(alice, aliceWire), receipt);
            assert.equal(await count('protected_accounts'), 1);
            assert.equal(await count('requests'), 1);
            assert.equal((await mode(alice, 'same-diagnostic')).mode, 'protected-required');
            for (const actor of [alice, bob])
                assert.equal(
                    (await legacyAs(actor, 'SELECT id,message FROM e2ee_research.legacy_fixture_messages')).rows.length,
                    0,
                );
            await assert.rejects(() => legacyInsert(bob, alice));
            await assert.rejects(
                () =>
                    pg.query(
                        `INSERT INTO e2ee_research.legacy_fixture_messages(sender_id,recipient_id,message)
            VALUES($1,$2,'privileged')`,
                        [alice.userId, bob.userId],
                    ),
                (error) => error?.code === '22023',
            );
            await assert.rejects(
                () =>
                    pg.query('UPDATE e2ee_research.legacy_fixture_messages SET read=false WHERE id=$1::uuid', [oldId]),
                (error) => error?.code === '22023',
            );
            const old = (
                await pg.query('SELECT message,read FROM e2ee_research.legacy_fixture_messages WHERE id=$1::uuid', [
                    oldId,
                ])
            ).rows[0];
            assert.deepEqual(old, { message: 'SYNTHETIC-OLD-PRIVATE-CANARY', read: true });
            const after = await legacyQueue(oldId);
            assert.equal(after.state, 'suppressed');
            assert.equal(after.stored_preview, oldPush.stored_preview);
            assert.equal(after.stored_title, oldPush.stored_title);
            assert.equal(await legacyClaim(oldPush.id), null);
        },
    );
    await check(
        'new cutover nonce cannot downgrade or replace the original selection; old nonce contents conflict',
        async () => {
            const original = (
                await pg.query('SELECT * FROM e2ee_research.protected_accounts WHERE owner_id=$1', [alice.userId])
            ).rows[0];
            await protect(alice, 'later-cutover');
            assert.deepEqual(
                (await pg.query('SELECT * FROM e2ee_research.protected_accounts WHERE owner_id=$1', [alice.userId]))
                    .rows[0],
                original,
            );
            await assert.rejects(async () => dispatch(alice, await sign(alice, 'account-mode', [], 'alice-cutover')));
            assert.equal(await count('protected_accounts'), 1);
            assert.equal(await count('requests'), 2);
        },
    );
    await check('restriction remains effective when a permissive legacy policy is added', async () => {
        await pg.exec(
            'CREATE POLICY fixture_extra_permissive ON e2ee_research.legacy_fixture_messages FOR SELECT TO e2ee_research_legacy_fixture_client USING (true)',
        );
        assert.equal((await legacyAs(bob, 'SELECT id FROM e2ee_research.legacy_fixture_messages')).rows.length, 0);
        await pg.exec('DROP POLICY fixture_extra_permissive ON e2ee_research.legacy_fixture_messages');
    });
    let initiallySuppressed;
    await check(
        'accepted opaque send without both protected accounts gets a terminally suppressed notification',
        async () => {
            initiallySuppressed = record(alice, bob);
            assert.equal((await send(alice, initiallySuppressed)).accepted, true);
            const queued = await notification(initiallySuppressed);
            assert.equal(queued.state, 'suppressed');
            assert.equal(await claim(queued.message_id, randomUUID()), null);
            await protect(bob);
            assert.equal((await notification(initiallySuppressed)).state, 'suppressed');
            assert.equal(await claim(queued.message_id, randomUUID()), null);
        },
    );
    let accepted, acceptedRoute, acceptedToken;
    await check(
        'accepted decision and one UUID notification are atomic and exact retry does not duplicate',
        async () => {
            accepted = record(alice, bob, 'fixture-not-a-uuid');
            const wire = await sign(alice, 'send', encodeResearchOutbox(accepted), 'accepted-send');
            const receipt = await dispatch(alice, wire);
            assert.equal(receipt.accepted, true);
            const queued = await notification(accepted);
            assert.equal(queued.state, 'pending');
            acceptedRoute = queued.message_id;
            acceptedToken = randomUUID();
            assert.notEqual(acceptedRoute, 'fixture-not-a-uuid');
            const before = await count('private_notifications');
            assert.deepEqual(await dispatch(alice, wire), receipt);
            assert.deepEqual(await send(alice, accepted), receipt);
            assert.equal(await count('private_notifications'), before);
            assert.equal((await notification(accepted)).message_id, acceptedRoute);
            const changed = record(alice, bob, 'fixture-not-a-uuid', 'Yg==');
            const refusal = await send(alice, changed);
            assert.equal(refusal.accepted, false);
            assert.equal(refusal.reason, 'record-conflict');
            assert.equal(await count('private_notifications'), before);
            assert.equal((await notification(accepted)).message_id, acceptedRoute);
        },
    );
    await check(
        'processor token claim emits only fixed generic content and never marks delivered or read',
        async () => {
            assert.equal(await finish(acceptedRoute, acceptedToken), false);
            projection(await claim(acceptedRoute, acceptedToken), acceptedRoute);
            projection(await claim(acceptedRoute, acceptedToken), acceptedRoute);
            assert.equal(await claim(acceptedRoute, randomUUID()), null);
            assert.equal(await finish(acceptedRoute, randomUUID()), false);
            assert.equal(await finish(acceptedRoute, acceptedToken), true);
            assert.equal(await finish(acceptedRoute, acceptedToken), true);
            assert.equal(await claim(acceptedRoute, acceptedToken), null);
            assert.equal((await notification(accepted)).state, 'sink-accepted');
            assert.equal((await send(alice, accepted)).accepted, true);
        },
    );
    await check('post-operation rollback leaves no decision, notification or signed request orphan', async () => {
        const row = record(alice, bob);
        const before = [await count('decisions'), await count('private_notifications'), await count('requests')];
        const wire = await sign(alice, 'send', encodeResearchOutbox(row), 'rollback-send');
        rollbackNextExecute = true;
        await assert.rejects(() => dispatch(alice, wire));
        assert.deepEqual(
            [await count('decisions'), await count('private_notifications'), await count('requests')],
            before,
        );
        assert.equal(await notification(row), undefined);
        assert.equal((await dispatch(alice, wire)).accepted, true);
        assert.equal((await notification(row)).state, 'pending');
    });
    await check('block then unblock terminally suppresses both directions and already claimed work', async () => {
        const forward = record(alice, bob),
            reverse = record(bob, alice);
        await send(alice, forward);
        await send(bob, reverse);
        const first = await notification(forward),
            second = await notification(reverse);
        const token = randomUUID();
        projection(await claim(first.message_id, token), first.message_id);
        await block(bob, alice, true);
        for (const row of [forward, reverse]) assert.equal((await notification(row)).state, 'suppressed');
        assert.equal(await finish(first.message_id, token), false);
        await block(bob, alice, false);
        for (const entry of [first, second]) assert.equal(await claim(entry.message_id, randomUUID()), null);
        const fresh = record(alice, bob);
        await send(alice, fresh);
        assert.equal((await notification(fresh)).state, 'pending');
        // A historical acknowledgment remains true, not a current projection/grant.
        assert.equal(await finish(acceptedRoute, acceptedToken), true);
    });
    await check('blocked send refuses without adding a notification', async () => {
        await block(alice, bob, true);
        const before = await count('private_notifications');
        const refusal = await send(bob, record(bob, alice));
        assert.equal(refusal.accepted, false);
        assert.equal(refusal.reason, 'blocked');
        assert.equal(await count('private_notifications'), before);
        await block(alice, bob, false);
    });
    await check('either endpoint cutover blocks legacy and either endpoint block suppresses its queue', async () => {
        const first = await legacyInsert(carol, dave),
            second = await legacyInsert(dave, carol);
        const firstQueue = await legacyQueue(first),
            secondQueue = await legacyQueue(second);
        await block(carol, dave, true);
        await block(carol, dave, false);
        assert.equal(await legacyClaim(firstQueue.id), null);
        assert.equal(await legacyClaim(secondQueue.id), null);
        assert.equal((await legacyQueue(first)).stored_preview, 'SYNTHETIC-OLD-PRIVATE-CANARY');
        await protect(dave);
        for (const actor of [carol, dave])
            assert.equal(
                (
                    await legacyAs(
                        actor,
                        'SELECT id FROM e2ee_research.legacy_fixture_messages WHERE sender_id=$1 OR recipient_id=$1',
                        [carol.userId],
                    )
                ).rows.length,
                0,
            );
        await assert.rejects(() => legacyInsert(carol, dave));
        await assert.rejects(() => legacyInsert(dave, carol));
        await protect(carol);
    });
    await check(
        'registered revoked device can diagnose but cannot initiate fresh cutover; exact old receipt survives',
        async () => {
            const old = await protect(revoked, 'revoked-cutover');
            // Preserve the exact wire: freshly signed expiry/signature can differ.
            const originalWire = (
                await pg.query('SELECT request_wire FROM e2ee_research.requests WHERE owner_id=$1 AND request_id=$2', [
                    revoked.userId,
                    'revoked-cutover',
                ])
            ).rows[0].request_wire;
            await act(revoked, 'revoke', []);
            assert.equal((await mode(revoked)).mode, 'protected-required');
            await assert.rejects(() => protect(revoked));
            assert.deepEqual(await dispatch(revoked, originalWire), old);
        },
    );
    await check('device revocation terminally suppresses pending notifications and fresh sends refuse', async () => {
        await protect(eve);
        await protect(frank);
        const row = record(eve, frank);
        await send(eve, row);
        const queued = await notification(row);
        await act(frank, 'revoke', []);
        assert.equal((await notification(row)).state, 'suppressed');
        assert.equal(await claim(queued.message_id, randomUUID()), null);
        const before = await count('private_notifications');
        const refusal = await send(eve, record(eve, frank));
        assert.equal(refusal.accepted, false);
        assert.equal(refusal.reason, 'device-revoked');
        assert.equal(await count('private_notifications'), before);
    });
    await check(
        'mode diagnostics remain fresh at the bounded 512-request limit; no false cutover success',
        async () => {
            // Fill only synthetic historical ledger rows as test owner, not a gateway bypass claim.
            // Retain every canonical binding CHECK; the first proof correctly refused
            // placeholder wires. This seeds budget occupancy, not operation success.
            const occupied = [];
            for (let n = 1; n <= 512; n++) {
                const requestId = `capacity-${n}`;
                occupied.push({ requestId, wire: await sign(capacity, 'require-protected', [], requestId) });
            }
            await pg.query(
                `INSERT INTO e2ee_research.requests(owner_id,device_id,request_id,request_wire,outcome)
            SELECT $1,$2,item->>'requestId',item->>'wire','{}'::jsonb
            FROM jsonb_array_elements($3::jsonb) item`,
                [capacity.userId, capacity.deviceId, JSON.stringify(occupied)],
            );
            await assert.rejects(() => protect(capacity));
            assert.equal((await mode(capacity)).mode, 'legacy-permitted');
            assert.equal(
                Number(
                    (
                        await pg.query('SELECT count(*) AS n FROM e2ee_research.requests WHERE owner_id=$1', [
                            capacity.userId,
                        ])
                    ).rows[0].n,
                ),
                512,
            );
        },
    );
    await check('private tables/helpers are denied; processors have only projection claim/finish grants', async () => {
        const roles = [
            'anon',
            'authenticated',
            'e2ee_research_gateway',
            'e2ee_research_notification_processor',
            'e2ee_research_legacy_fixture_client',
            'e2ee_research_legacy_fixture_processor',
        ];
        for (const role of roles) {
            for (const table of ['protected_accounts', 'private_notifications', 'legacy_fixture_push'])
                assert.equal(
                    (
                        await pg.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed", [
                            role,
                            `e2ee_research.${table}`,
                        ])
                    ).rows[0].allowed,
                    false,
                );
            for (const fn of ['requires_protected(text)', 'lock_pilot()', 'private_notification_eligible(bigint)'])
                assert.equal(
                    (
                        await pg.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
                            role,
                            `e2ee_research.${fn}`,
                        ])
                    ).rows[0].allowed,
                    false,
                );
            const granted = role === 'e2ee_research_notification_processor';
            for (const fn of ['claim_private_notification(uuid,uuid)', 'finish_private_notification(uuid,uuid)'])
                assert.equal(
                    (
                        await pg.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
                            role,
                            `e2ee_research.${fn}`,
                        ])
                    ).rows[0].allowed,
                    granted,
                );
            await assert.rejects(
                () =>
                    pg.transaction(async (tx) => {
                        await tx.exec(`SET LOCAL ROLE ${role}`);
                        await tx.exec('SELECT * FROM e2ee_research.protected_accounts');
                    }),
                (error) => error?.code === '42501',
            );
        }
        assert.equal(
            (
                await pg.query(
                    "SELECT provolatile FROM pg_proc WHERE oid='e2ee_research.requires_protected(text)'::regprocedure",
                )
            ).rows[0].provolatile,
            'v',
        );
        await assert.rejects(
            () =>
                pg.transaction(async (tx) => {
                    await tx.exec(
                        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE e2ee_research_notification_processor',
                    );
                    await tx.query('SELECT e2ee_research.claim_private_notification($1::uuid,$2::uuid)', [
                        acceptedRoute,
                        acceptedToken,
                    ]);
                }),
            (error) => error?.code === '25000',
        );
    });
    await check(
        'independent sequential restricted sessions cannot assume owner or read private policy storage',
        async () => {
            for (const role of [
                'e2ee_research_gateway',
                'e2ee_research_notification_processor',
                'e2ee_research_legacy_fixture_client',
            ]) {
                await pg.close();
                pg = await PGlite.create({ dataDir });
                await pg.exec(`SET SESSION AUTHORIZATION ${role}`);
                assert.deepEqual((await pg.query('SELECT session_user,current_user')).rows[0], {
                    session_user: role,
                    current_user: role,
                });
                for (const query of [
                    'SET ROLE e2ee_research_owner',
                    'SELECT * FROM e2ee_research.protected_accounts',
                    'DELETE FROM e2ee_research.private_notifications',
                ])
                    await assert.rejects(
                        () => pg.exec(query),
                        (error) => error?.code === '42501',
                    );
            }
            await pg.close();
            pg = await PGlite.create({ dataDir });
        },
    );
    await check(
        'database close/reopen retains durable mode, original legacy bytes and terminal notification routes',
        async () => {
            const tables = [
                'protected_accounts',
                'private_notifications',
                'legacy_fixture_push',
                'legacy_fixture_messages',
                'requests',
                'decisions',
            ];
            for (const table of tables)
                expectations.push([table, (await pg.query(`SELECT * FROM e2ee_research.${table} ORDER BY 1,2`)).rows]);
            await pg.close();
            pg = await PGlite.create({ dataDir });
            for (const [table, rows] of expectations)
                assert.deepEqual((await pg.query(`SELECT * FROM e2ee_research.${table} ORDER BY 1,2`)).rows, rows);
            assert.equal((await mode(alice)).mode, 'protected-required');
            assert.equal(await legacyClaim(oldPush.id), null);
            assert.equal(await claim(acceptedRoute, randomUUID()), null);
        },
    );
    for (const path of inputFiles)
        assert.equal(
            createHash('sha256')
                .update(readFileSync(join(root, path)))
                .digest('hex'),
            hashes[path],
            'Source changed during proof',
        );
    writeFileSync(
        join(scratch, 'receipt.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                recordedAtUTC: new Date().toISOString(),
                status: 'passed',
                completedGroups,
                groupCount: completedGroups.length,
                sourceHashes: hashes,
                archiveIntegrity: pin.integrity,
                evidence:
                    'On-disk single-engine PostgreSQL, real Ed25519 fixture signatures, mocked Auth/legacy identity and ciphertext; no native/hosted/APNs/concurrency/audit result',
                shippingApproved: false,
                hostedChanged: false,
                humanDeviceChanged: false,
                databasePath: dataDir,
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
    );
    console.info(
        `PASS ${completedGroups.length} SQL scenario groups; sanitized receipt ${join(scratch, 'receipt.json')}`,
    );
} catch (error) {
    // Retain only category/code and fixed scenario names, never SQL/detail/params/content.
    writeFileSync(
        join(scratch, 'failure.json'),
        JSON.stringify(
            {
                status: 'failed',
                group,
                completedGroups,
                code: typeof error?.code === 'string' ? error.code : null,
                category: error?.name ?? 'Error',
                sourceHashes: hashes,
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
    );
    console.error(`FAIL SQL scenario: ${group}; category ${error?.name ?? 'Error'}; code ${error?.code ?? 'none'}`);
    process.exitCode = 1;
} finally {
    await pg.close();
}

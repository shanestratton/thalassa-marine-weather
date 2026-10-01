/**
 * Scenario helper for proof.mjs's EXISTING disposable PostgreSQL engine.
 * Importing this module neither opens a database nor runs any scenario.
 * Real Ed25519 fixture signatures; mocked account authentication and fixture
 * ciphertext. This does not prove Supabase Auth, native device transport,
 * independent connections, production concurrency or an independent audit.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceBundleSigningBytes, encodeDeviceBundle } from './deviceBundle.ts';
import { createResearchSignedGateway } from './signedGateway.ts';
import { encodeResearchOutbox } from './gateway.ts';
import { encodeSignedResearchRequest, researchRequestSigningBytes } from './signedRequest.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';

const b64 = (value) => Buffer.from(value).toString('base64').replace(/=+$/, '');
const nowSeconds = () => Math.floor(Date.now() / 1000);
const token = (user) => `signed-fixture-${user}`;
const executeSql =
    'SELECT e2ee_research.execute_request($1::text,$2::text,$3::text,$4::text,$5::text,$6::bigint,$7::text) AS result';
function executeArgs(wire) {
    const request = JSON.parse(wire);
    return [
        request.userId,
        request.deviceId,
        request.requestId,
        request.action,
        request.payload,
        request.expiresAt,
        wire,
    ];
}

async function fixture(userId, expiresAt = nowSeconds() + 3600) {
    const signing = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const curve = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const prekey = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId,
        deviceId: `${userId}-phone`,
        identityKeyId: `${userId}-identity`,
        signingKey: b64(await webcrypto.subtle.exportKey('raw', signing.publicKey)),
        curveKey: b64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
        prekeyId: `${userId}-prekey`,
        prekey: b64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
        expiresAt,
    };
    return {
        userId,
        deviceId: unsigned.deviceId,
        identityKeyId: unsigned.identityKeyId,
        signingKey: unsigned.signingKey,
        privateKey: signing.privateKey,
        bundle: encodeDeviceBundle({
            ...unsigned,
            signature: b64(
                await webcrypto.subtle.sign('Ed25519', signing.privateKey, deviceBundleSigningBytes(unsigned)),
            ),
        }),
    };
}

async function sign(actor, action, payload, requestId, options = {}) {
    const unsigned = {
        version: 1,
        protocol: 'olm-v1',
        userId: actor.userId,
        deviceId: actor.deviceId,
        action,
        requestId,
        expiresAt: nowSeconds() + 120,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ...options,
    };
    return encodeSignedResearchRequest({
        ...unsigned,
        signature: b64(await webcrypto.subtle.sign('Ed25519', actor.privateKey, researchRequestSigningBytes(unsigned))),
    });
}

function outbox(sender, recipient, message, changes = {}, envelopeChanges = {}) {
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
            clientMessageId: message,
            senderDeviceId: sender.deviceId,
            recipientDeviceId: recipient.deviceId,
            ciphertext: 'YQ==',
            ...envelopeChanges,
        }),
        ...changes,
    };
}

/** Returns the number of completed groups. The caller owns engine lifetime. */
export async function runSignedSqlProof(db, rpc) {
    let checks = 0;
    let group = 'signed fixture setup';
    const check = async (name, body) => {
        group = name;
        await body();
        checks++;
        console.log(`PASS ${name}`);
    };
    const [owner, peer, other, capacity] = await Promise.all([
        fixture('signed-owner'),
        fixture('signed-peer'),
        fixture('signed-other'),
        fixture('signed-capacity'),
    ]);
    const actors = new Map([owner, peer, other, capacity].map((actor) => [token(actor.userId), actor.userId]));
    const authenticate = async (credential) => (actors.has(credential) ? { userId: actors.get(credential) } : null);
    const gateway = createResearchSignedGateway({ authenticate, rpc, nowSeconds });
    const dispatch = (actor, wire) => gateway.dispatch(token(actor.userId), wire);
    const count = async (table, actor = null) =>
        Number(
            (
                await db.query(
                    `SELECT count(*) AS n FROM e2ee_research.${table}${actor ? ' WHERE owner_id=$1::text' : ''}`,
                    actor ? [actor.userId] : [],
                )
            ).rows[0].n,
        );
    const rejects = (operation) => assert.rejects(operation);
    for (const actor of [owner, peer, other, capacity]) await gateway.register(token(actor.userId), actor.bundle);

    try {
        await check('signed request RPCs and append-only ledger have no client/table grants', async () => {
            for (const role of ['anon', 'authenticated', 'e2ee_research_gateway']) {
                const grants = (
                    await db.query(
                        `SELECT
                    has_function_privilege($1::text, 'e2ee_research.lookup_request_key(text,text)', 'EXECUTE') AS lookup_allowed,
                    has_function_privilege($1::text, 'e2ee_research.execute_request(text,text,text,text,text,bigint,text)', 'EXECUTE') AS execute_allowed,
                    has_table_privilege($1::text, 'e2ee_research.requests', 'SELECT,INSERT,UPDATE,DELETE') AS table_allowed`,
                        [role],
                    )
                ).rows[0];
                assert.deepEqual(grants, {
                    lookup_allowed: role === 'e2ee_research_gateway',
                    execute_allowed: role === 'e2ee_research_gateway',
                    table_allowed: false,
                });
                await rejects(() =>
                    db
                        .transaction(async (tx) => {
                            await tx.exec(`SET LOCAL ROLE ${role}`);
                            await tx.query('SELECT * FROM e2ee_research.requests');
                        })
                        .catch((error) => {
                            assert.equal(error?.code, '42501');
                            throw error;
                        }),
                );
                if (role !== 'e2ee_research_gateway') {
                    for (const query of [
                        `SELECT e2ee_research.lookup_request_key('${owner.userId}','${owner.deviceId}')`,
                        'SELECT e2ee_research.execute_request(null,null,null,null,null,null,null)',
                    ])
                        await assert.rejects(
                            () =>
                                db.transaction(async (tx) => {
                                    await tx.exec(`SET LOCAL ROLE ${role}`);
                                    await tx.exec(query);
                                }),
                            (error) => error?.code === '42501',
                        );
                }
            }
            assert.equal(
                (await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='e2ee_research.requests'::regclass"))
                    .rows[0].relrowsecurity,
                true,
            );
            await assert.rejects(
                () =>
                    db.transaction(async (tx) => {
                        await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
                        await tx.query('SELECT e2ee_research.parse_request($1::text)', [
                            await sign(owner, 'list', [0, 16], 'internal-parser'),
                        ]);
                    }),
                (error) => error?.code === '42501',
            );
            await assert.rejects(
                () =>
                    db.transaction(async (tx) => {
                        await tx.exec(
                            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE e2ee_research_gateway',
                        );
                        await tx.query('SELECT e2ee_research.lookup_request_key($1::text,$2::text)', [
                            owner.userId,
                            owner.deviceId,
                        ]);
                    }),
                (error) => error?.code === '25000',
            );
        });

        let firstList;
        await check('signed exact retry is immutable; changed nonce contents and wrong principals fail', async () => {
            firstList = await sign(owner, 'list', [0, 16], 'exact-list');
            assert.deepEqual(await dispatch(owner, firstList), []);
            assert.deepEqual(await dispatch(owner, firstList), []);
            assert.equal(await count('requests', owner), 1);
            await rejects(async () => dispatch(owner, await sign(owner, 'list', [0, 1], 'exact-list')));
            await rejects(() => gateway.dispatch(token(other.userId), firstList));
            await rejects(() => gateway.dispatch('invalid-account-token', firstList));
            const forged = await sign(other, 'list', [0, 16], 'forged-owner', {
                userId: owner.userId,
                deviceId: owner.deviceId,
            });
            await rejects(() => dispatch(owner, forged));
            const stolenDevice = await sign(owner, 'list', [0, 16], 'stolen-device', { deviceId: peer.deviceId });
            await rejects(() => dispatch(owner, stolenDevice));
            const args = executeArgs(firstList);
            for (const [index, value] of [
                [0, other.userId],
                [1, peer.deviceId],
                [2, 'different-nonce'],
                [3, 'revoke'],
                [4, '[0,1]'],
                [5, args[5] + 1],
            ]) {
                const changed = [...args];
                changed[index] = value;
                await rejects(() => rpc('execute_request', changed));
            }
            assert.equal(await count('requests', owner), 1);
        });

        await check('SQL independently rejects noncanonical signed frames and invalid action payloads', async () => {
            const base = JSON.parse(firstList);
            for (const wire of [
                `${firstList} `,
                JSON.stringify(base, null, 2),
                JSON.stringify(Object.fromEntries(Object.entries(base).reverse())),
                firstList.replace('"version":1', '"version":1,"version":1'),
                firstList.replace('"protocol":"olm-v1"', '"protocol":null'),
                firstList.replace('signed-owner', '\\u0073igned-owner'),
                JSON.stringify({ ...base, extra: true }),
                'x'.repeat(102401),
            ])
                await rejects(() => rpc('execute_request', [...executeArgs(firstList).slice(0, 6), wire]));
            let nonce = 0;
            for (const [action, payload] of [
                ['revoke', '["another-device"]'],
                ['revoke', '[ ]'],
                ['block', ` ["${peer.userId}",true]`],
                ['block', `["${peer.userId}","true"]`],
                ['block', `["${owner.userId}",true]`],
                ['block', '[null,true]'],
                ['claim', `["${peer.userId}","${peer.deviceId}"]`],
                ['claim', `["${owner.userId}","${owner.deviceId}","self"]`],
                ['list', '[0,17]'],
                ['list', '[-1,16]'],
                ['list', '[0.0,16]'],
                ['list', '["0",16]'],
                ['list', '[0,16,null]'],
                ['send', JSON.stringify({ ...outbox(owner, peer, 'invalid'), plaintext: 'fixture-forbidden-extra' })],
                ['send', encodeResearchOutbox(outbox(other, peer, 'wrong-owner'))],
                [
                    'send',
                    encodeResearchOutbox(outbox(owner, peer, 'wrong-sender', {}, { senderDeviceId: other.deviceId })),
                ],
                ['send', ` ${encodeResearchOutbox(outbox(owner, peer, 'spaced-outbox'))}`],
            ]) {
                const request = { ...base, requestId: `bad-payload-${nonce++}`, action, payload };
                // SQL-only defense fixture: the gateway would reject before RPC.
                const wire = JSON.stringify(request);
                await rejects(() => rpc('execute_request', executeArgs(wire)));
            }
            assert.equal(await count('requests', owner), 1);
        });

        let accepted;
        let acceptedWire;
        let claimWire;
        await check(
            'signed claim retries recheck policy while block receipts do not reapply changed policy',
            async () => {
                claimWire = await sign(
                    owner,
                    'claim',
                    [peer.userId, peer.deviceId, 'signed-prekey-claim'],
                    'claim-once',
                );
                const claim = await dispatch(owner, claimWire);
                assert.equal(claim.signedBundle, peer.bundle);
                const blockWire = await sign(owner, 'block', [peer.userId, true], 'block-once');
                assert.deepEqual(await dispatch(owner, blockWire), { blocked: true });
                await rejects(() => dispatch(owner, claimWire));
                const before = await count('requests', owner);
                await rejects(async () =>
                    dispatch(
                        owner,
                        await sign(
                            owner,
                            'claim',
                            [peer.userId, peer.deviceId, 'signed-prekey-claim'],
                            'new-blocked-claim',
                        ),
                    ),
                );
                assert.equal(await count('requests', owner), before);
                const blockedRecord = outbox(owner, peer, 'signed-blocked');
                const blockedWire = await sign(owner, 'send', encodeResearchOutbox(blockedRecord), 'blocked-send-once');
                const refusal = await dispatch(owner, blockedWire);
                assert.deepEqual(refusal, { ...blockedRecord, accepted: false, reason: 'blocked' });
                await dispatch(owner, await sign(owner, 'block', [peer.userId, false], 'unblock-once'));
                assert.deepEqual(await dispatch(owner, claimWire), claim);
                assert.deepEqual(await dispatch(owner, blockWire), { blocked: true });
                assert.equal(
                    (
                        await db.query(
                            'SELECT blocked FROM e2ee_research.blocks WHERE owner_id=$1::text AND other_id=$2::text',
                            [owner.userId, peer.userId],
                        )
                    ).rows[0].blocked,
                    false,
                );
                assert.deepEqual(await dispatch(owner, blockedWire), refusal);
                accepted = outbox(owner, peer, 'signed-accepted');
                acceptedWire = await sign(owner, 'send', encodeResearchOutbox(accepted), 'accepted-send-once');
                assert.deepEqual(await dispatch(owner, acceptedWire), { ...accepted, accepted: true });
            },
        );

        await check(
            'nonempty list retries respect both block directions and revocation without adding later messages',
            async () => {
                const recipient = await fixture('signed-read-recipient');
                actors.set(token(recipient.userId), recipient.userId);
                await gateway.register(token(recipient.userId), recipient.bundle);
                const first = outbox(other, recipient, 'signed-read-first');
                await dispatch(other, await sign(other, 'send', encodeResearchOutbox(first), 'read-first-send'));
                const listWire = await sign(recipient, 'list', [0, 16], 'nonempty-list');
                const snapshot = await dispatch(recipient, listWire);
                assert.equal(snapshot.length, 1);
                assert.deepEqual(snapshot[0], { ...first, accepted: true, serverId: snapshot[0].serverId });
                assert.equal(typeof snapshot[0].serverId, 'number');
                const second = outbox(owner, recipient, 'signed-read-later');
                await dispatch(owner, await sign(owner, 'send', encodeResearchOutbox(second), 'read-later-send'));
                assert.deepEqual(await dispatch(recipient, listWire), snapshot);
                assert.equal(
                    (await dispatch(recipient, await sign(recipient, 'list', [0, 16], 'fresh-nonempty-list'))).length,
                    2,
                );

                await dispatch(recipient, await sign(recipient, 'block', [other.userId, true], 'read-recipient-block'));
                assert.deepEqual(await dispatch(recipient, listWire), []);
                await dispatch(
                    recipient,
                    await sign(recipient, 'block', [other.userId, false], 'read-recipient-unblock'),
                );
                assert.deepEqual(await dispatch(recipient, listWire), snapshot);
                await dispatch(other, await sign(other, 'block', [recipient.userId, true], 'read-sender-block'));
                assert.deepEqual(await dispatch(recipient, listWire), []);
                await dispatch(other, await sign(other, 'block', [recipient.userId, false], 'read-sender-unblock'));
                assert.deepEqual(await dispatch(recipient, listWire), snapshot);

                await dispatch(recipient, await sign(recipient, 'revoke', [], 'read-recipient-revoke'));
                const before = await count('requests', recipient);
                await rejects(() => dispatch(recipient, listWire));
                assert.equal(await count('requests', recipient), before);
                assert.deepEqual(
                    (
                        await db.query(
                            'SELECT outcome FROM e2ee_research.requests WHERE owner_id=$1::text AND request_id=$2::text',
                            [recipient.userId, 'nonempty-list'],
                        )
                    ).rows[0].outcome,
                    snapshot,
                );
            },
        );

        await check(
            'a replayed prekey reservation denies a now-revoked destination without altering its ledger',
            async () => {
                const destination = await fixture('signed-claim-target');
                actors.set(token(destination.userId), destination.userId);
                await gateway.register(token(destination.userId), destination.bundle);
                const wire = await sign(
                    other,
                    'claim',
                    [destination.userId, destination.deviceId, 'target-reservation'],
                    'target-claim',
                );
                const claim = await dispatch(other, wire);
                assert.equal(claim.signedBundle, destination.bundle);
                const before = await count('requests', other);
                await dispatch(destination, await sign(destination, 'revoke', [], 'target-revoke'));
                await rejects(() => dispatch(other, wire));
                assert.equal(await count('requests', other), before);
                assert.deepEqual(
                    (
                        await db.query(
                            'SELECT outcome FROM e2ee_research.requests WHERE owner_id=$1::text AND request_id=$2::text',
                            [other.userId, 'target-claim'],
                        )
                    ).rows[0].outcome,
                    claim,
                );
            },
        );

        await check(
            'signed revocation retains verification key and old outcomes; fresh operations enforce device state',
            async () => {
                await rejects(async () =>
                    gateway.dispatch(token(other.userId), await sign(owner, 'revoke', [], 'wrong-actor-revoke')),
                );
                const revokeWire = await sign(owner, 'revoke', [], 'own-device-revoke');
                assert.deepEqual(await dispatch(owner, revokeWire), {
                    revoked: true,
                    userId: owner.userId,
                    deviceId: owner.deviceId,
                });
                assert.deepEqual(await rpc('lookup_request_key', [owner.userId, owner.deviceId]), {
                    signingKey: owner.signingKey,
                });
                assert.deepEqual(await dispatch(owner, revokeWire), {
                    revoked: true,
                    userId: owner.userId,
                    deviceId: owner.deviceId,
                });
                assert.deepEqual(await dispatch(owner, acceptedWire), { ...accepted, accepted: true });
                assert.deepEqual(
                    await dispatch(
                        owner,
                        await sign(owner, 'send', encodeResearchOutbox(accepted), 'accepted-record-new-nonce'),
                    ),
                    {
                        ...accepted,
                        accepted: true,
                    },
                );
                await rejects(() => dispatch(owner, firstList));
                await rejects(() => dispatch(owner, claimWire));
                const fresh = outbox(owner, peer, 'signed-after-revoke');
                assert.deepEqual(
                    await dispatch(owner, await sign(owner, 'send', encodeResearchOutbox(fresh), 'revoked-send-once')),
                    {
                        ...fresh,
                        accepted: false,
                        reason: 'device-revoked',
                    },
                );
                const before = await count('requests', owner);
                for (const [action, payload] of [
                    ['list', [0, 16]],
                    ['claim', [peer.userId, peer.deviceId, 'signed-prekey-claim']],
                    ['block', [peer.userId, true]],
                ])
                    await rejects(async () =>
                        dispatch(owner, await sign(owner, action, payload, `revoked-fresh-${action}`)),
                    );
                assert.equal(await count('requests', owner), before);
                await rejects(() => rpc('lookup_request_key', [other.userId, owner.deviceId]));
            },
        );

        await check('post-execution rollback leaves neither signed ledger row nor message decision', async () => {
            const record = outbox(other, peer, 'signed-rollback');
            const wire = await sign(other, 'send', encodeResearchOutbox(record), 'rollback-once');
            const requestsBefore = await count('requests', other);
            const decisionsBefore = await count('decisions', other);
            let rollback = true;
            const rollbackGateway = createResearchSignedGateway({
                authenticate,
                nowSeconds,
                rpc: async (name, args) => {
                    if (name !== 'execute_request' || !rollback) return rpc(name, args);
                    rollback = false;
                    return db.transaction(async (tx) => {
                        await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
                        const result = await tx.query(executeSql, args);
                        assert.deepEqual(result.rows[0].result, { ...record, accepted: true });
                        throw new Error('signed fixture rollback');
                    });
                },
            });
            await rejects(() => rollbackGateway.dispatch(token(other.userId), wire));
            assert.equal(await count('requests', other), requestsBefore);
            assert.equal(await count('decisions', other), decisionsBefore);
            assert.deepEqual(await dispatch(other, wire), { ...record, accepted: true });
            assert.equal(await count('requests', other), requestsBefore + 1);
            assert.equal(await count('decisions', other), decisionsBefore + 1);
        });

        await check(
            'SQL durable outcomes survive TTL while gateway rejects expired wire and nonce renewal',
            async () => {
                const expiry = nowSeconds() + 2;
                const wire = await sign(other, 'list', [0, 16], 'ttl-once', { expiresAt: expiry });
                assert.deepEqual(await dispatch(other, wire), []);
                await delay(2100);
                assert.deepEqual(await rpc('execute_request', executeArgs(wire)), []);
                await rejects(() => dispatch(other, wire));
                const renewed = await sign(other, 'list', [0, 16], 'ttl-once');
                await rejects(() => dispatch(other, renewed));
                for (const expiresAt of [nowSeconds() - 1, nowSeconds() + 3600]) {
                    const invalid = await sign(other, 'list', [0, 16], `ttl-invalid-${expiresAt}`, { expiresAt });
                    await rejects(() => dispatch(other, invalid));
                    await rejects(() => rpc('execute_request', executeArgs(invalid)));
                }
                assert.deepEqual(await dispatch(other, await sign(other, 'list', [0, 16], 'ttl-fresh-nonce')), []);
            },
        );

        await check(
            'replayed prekey claims deny a now-expired destination even with a still-fresh signed request',
            async () => {
                const expiry = nowSeconds() + 2;
                const destination = await fixture('signed-expiring-target', expiry);
                actors.set(token(destination.userId), destination.userId);
                await gateway.register(token(destination.userId), destination.bundle);
                const wire = await sign(
                    other,
                    'claim',
                    [destination.userId, destination.deviceId, 'expiring-reservation'],
                    'expiring-claim',
                );
                const claim = await dispatch(other, wire);
                assert.equal(claim.signedBundle, destination.bundle);
                const before = await count('requests', other);
                await delay(2100);
                assert.ok(JSON.parse(wire).expiresAt > nowSeconds());
                await rejects(() => dispatch(other, wire));
                assert.equal(await count('requests', other), before);
            },
        );

        await check('512-request owner cap has no eviction and preserves exact SQL retries', async () => {
            let firstWire;
            for (let i = 0; i < 512; i++) {
                const wire = await sign(capacity, 'list', [0, 16], `capacity-${i}`);
                firstWire ??= wire;
                assert.deepEqual(await dispatch(capacity, wire), []);
            }
            assert.equal(await count('requests', capacity), 512);
            await rejects(async () => dispatch(capacity, await sign(capacity, 'list', [0, 16], 'capacity-overflow')));
            assert.deepEqual(await rpc('execute_request', executeArgs(firstWire)), []);
            await rejects(async () => dispatch(capacity, await sign(capacity, 'list', [0, 1], 'capacity-0')));
            assert.equal(await count('requests', capacity), 512);
        });
        return checks;
    } catch (error) {
        // A fixed scenario label helps the caller report failure without dumping
        // wire, SQL query parameters, key material or exception message details.
        console.error(`Signed SQL scenario: ${group}`);
        throw error;
    }
}

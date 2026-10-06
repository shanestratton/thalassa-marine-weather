/** Fresh local on-disk PostgreSQL migration proof. No hosted or Auth mutation.
 * Only an already-owned pinned package archive is accepted; no installation.
 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
    extractDefinitions,
    snapshotExpression,
    validateSnapshot,
    preserved,
    guardedDelta,
} from './cutoverMigration.mjs';
import { deviceBundleSigningBytes, encodeDeviceBundle } from '../relay/deviceBundle.ts';
import { createResearchSignedGateway } from '../relay/signedGateway.ts';
import { encodeSignedResearchRequest, researchRequestSigningBytes } from '../relay/signedRequest.ts';
import { encodeDirectMessageEnvelope } from '../../../services/chat/e2ee/directMessageEnvelope.ts';
import { encodeResearchOutbox } from '../relay/gateway.ts';

const HERE = dirname(fileURLToPath(import.meta.url)),
    ROOT = join(HERE, '../../..');
const [source, ...extra] = process.argv.slice(2);
assert(source && isAbsolute(source) && !extra.length);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const scratch = mkdtempSync(join(tmpdir(), 'thalassa-cutover-migration-proof-'));
const pin = JSON.parse(readFileSync(join(HERE, '../relay/pglite-pin.json'))),
    archive = readFileSync(source);
assert.equal(pin.shippingApproved, false);
assert(archive.length < 32 * 1024 * 1024);
assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), pin.integrity);
const tar = join(scratch, 'pglite.tgz');
writeFileSync(tar, archive, { mode: 0o600, flag: 'wx' });
const list = spawnSync('/usr/bin/tar', ['-tzf', tar], { encoding: 'utf8', timeout: 30000 });
assert.equal(list.status, 0);
assert(
    list.stdout
        .trim()
        .split('\n')
        .every((n) => n.startsWith('package/') && !n.split('/').includes('..')),
);
assert.equal(spawnSync('/usr/bin/tar', ['-xzf', tar, '-C', scratch], { timeout: 30000 }).status, 0);
function tree(p) {
    for (const e of readdirSync(p, { withFileTypes: true })) {
        assert(e.isFile() || e.isDirectory());
        if (e.isDirectory()) tree(join(p, e.name));
    }
}
tree(join(scratch, 'package'));
const metadata = JSON.parse(readFileSync(join(scratch, 'package/package.json')));
assert.equal(metadata.name, pin.package);
assert.equal(metadata.version, pin.version);
assert.equal(metadata.license, pin.license);
assert(!metadata.dependencies || !Object.keys(metadata.dependencies).length);
assert(!metadata.scripts?.install && !metadata.scripts?.postinstall);
for (;;) {
    const r = spawnSync('/usr/bin/pgrep', ['-fl', 'vite build|tsc|vitest'], { encoding: 'utf8' });
    assert(!r.error && [0, 1].includes(r.status));
    const others = r.stdout
        .trim()
        .split('\n')
        .filter((s) => s && !s.startsWith(process.pid + ' ') && !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish)\s/.test(s));
    if (!others.length) break;
    await delay(5000);
}
process.title = 'vite build slot: isolated cutover migration SQL';
const { PGlite } = await import(pathToFileURL(join(scratch, 'package/dist/index.js')).href);
const dataDir = join(scratch, 'database');
let db = await PGlite.create(dataDir),
    stage = 'bootstrap';
const inputs = [
    'experiments/scuttlebutt-e2ee/hosted/cutoverMigration.mjs',
    'experiments/scuttlebutt-e2ee/hosted/cutoverMigrationProof.mjs',
    'experiments/scuttlebutt-e2ee/relay/relay.sql',
    'experiments/scuttlebutt-e2ee/relay/pglite-pin.json',
    'experiments/scuttlebutt-e2ee/relay/deviceBundle.ts',
    'experiments/scuttlebutt-e2ee/relay/signedRequest.ts',
    'experiments/scuttlebutt-e2ee/relay/signedGateway.ts',
    'experiments/scuttlebutt-e2ee/relay/gateway.ts',
    'services/chat/e2ee/directMessageEnvelope.ts',
    'services/chat/e2ee/encryptedDmDelivery.ts',
];
const sourceHashes = Object.fromEntries(inputs.map((p) => [p, hash(readFileSync(join(ROOT, p)))]));
const baseline = execFileSync('git', ['show', '8c69793c:experiments/scuttlebutt-e2ee/relay/relay.sql'], { cwd: ROOT });
assert.equal(hash(baseline), '96112dc474c8df60c36a5b8a2aded33b6c5b8e81d7a36b94b52ba8311d074a9f');
const definitions = extractDefinitions(readFileSync(join(HERE, '../relay/relay.sql'), 'utf8'));
const groups = [];
const snapshot = async (installed) =>
    (await db.query('SELECT ' + snapshotExpression(installed) + ' AS state')).rows[0].state;
async function check(name, fn) {
    stage = name;
    await fn();
    groups.push(name);
    console.info('PASS ' + name);
}
async function seedExistingRows() {
    const now = Math.floor(Date.now() / 1000),
        b64 = (value) => Buffer.from(value).toString('base64').replace(/=+$/, '');
    const actors = [];
    for (const user of ['migration-fixture-a', 'migration-fixture-b']) {
        const signing = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
        const curve = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
        const prekey = await webcrypto.subtle.generateKey('X25519', true, ['deriveBits']);
        const unsigned = {
            version: 1,
            protocol: 'olm-v1',
            userId: user,
            deviceId: user + '-device',
            identityKeyId: user + '-identity',
            signingKey: b64(await webcrypto.subtle.exportKey('raw', signing.publicKey)),
            curveKey: b64(await webcrypto.subtle.exportKey('raw', curve.publicKey)),
            prekeyId: user + '-prekey',
            prekey: b64(await webcrypto.subtle.exportKey('raw', prekey.publicKey)),
            expiresAt: now + 3600,
        };
        actors.push({
            ...unsigned,
            privateKey: signing.privateKey,
            bundle: encodeDeviceBundle({
                ...unsigned,
                signature: b64(
                    await webcrypto.subtle.sign('Ed25519', signing.privateKey, deviceBundleSigningBytes(unsigned)),
                ),
            }),
        });
    }
    const gateway = createResearchSignedGateway({
        authenticate: async (token) => (actors.some((a) => a.userId === token) ? { userId: token } : null),
        nowSeconds: () => Math.floor(Date.now() / 1000),
        rpc: async (name, args) =>
            db.transaction(async (tx) => {
                const types = {
                    register_device: ['text', 'text'],
                    lookup_request_key: ['text', 'text'],
                    execute_request: ['text', 'text', 'text', 'text', 'text', 'bigint', 'text'],
                };
                assert(Object.hasOwn(types, name));
                await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
                return (
                    await tx.query(
                        'SELECT e2ee_research.' +
                            name +
                            '(' +
                            types[name].map((type, i) => '$' + (i + 1) + '::' + type).join(',') +
                            ') AS result',
                        args,
                    )
                ).rows[0].result;
            }),
    });
    for (const actor of actors) await gateway.register(actor.userId, actor.bundle);
    const [a, b] = actors;
    const dispatch = async (action, payload, id) => {
        const unsigned = {
            version: 1,
            protocol: 'olm-v1',
            userId: a.userId,
            deviceId: a.deviceId,
            action,
            requestId: id,
            expiresAt: now + 120,
            payload,
        };
        return gateway.dispatch(
            a.userId,
            encodeSignedResearchRequest({
                ...unsigned,
                signature: b64(
                    await webcrypto.subtle.sign('Ed25519', a.privateKey, researchRequestSigningBytes(unsigned)),
                ),
            }),
        );
    };
    const row = {
        ownerUserId: a.userId,
        ownerSessionGeneration: 7,
        recipientUserId: b.userId,
        recipientIdentityKeyId: b.identityKeyId,
        recipientIdentityGeneration: 3,
        serializedEnvelope: encodeDirectMessageEnvelope({
            version: 2,
            protocol: 'olm-v1',
            messageType: 'prekey',
            clientMessageId: 'migration-old-message',
            senderDeviceId: a.deviceId,
            recipientDeviceId: b.deviceId,
            ciphertext: 'YQ==',
        }),
    };
    assert.equal((await dispatch('send', encodeResearchOutbox(row), 'migration-old-send')).accepted, true);
    await dispatch('block', JSON.stringify([b.userId, true]), 'migration-old-block');
}
try {
    await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;');
    await db.exec(baseline.toString('utf8'));
    await db.exec(`BEGIN; SET LOCAL ROLE e2ee_research_owner;
REVOKE EXECUTE ON FUNCTION e2ee_research.revoke_device(text,text),e2ee_research.set_block(text,text,boolean),
e2ee_research.claim_prekey(text,text,text,text,text),e2ee_research.send_message(text,jsonb),
e2ee_research.list_messages(text,text,bigint,integer) FROM e2ee_research_gateway;
RESET ROLE; CREATE ROLE e2ee_pilot_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2;
GRANT e2ee_research_gateway TO e2ee_pilot_edge WITH INHERIT FALSE, SET TRUE;
ALTER ROLE e2ee_pilot_edge SET search_path=pg_catalog; ALTER ROLE e2ee_pilot_edge SET statement_timeout='4s';
ALTER ROLE e2ee_pilot_edge SET lock_timeout='1s'; COMMIT; SET search_path=pg_catalog; SET TimeZone='UTC';`);
    await seedExistingRows();
    let before;
    await check('exact approved baseline and narrow migration source', async () => {
        before = await snapshot(false);
        assert.equal(validateSnapshot(before, definitions), 'baseline');
        assert.equal(before.data.find((item) => item.name === 'devices').count, 2);
        assert.equal(before.data.find((item) => item.name === 'decisions').count, 1);
        assert.equal(before.data.find((item) => item.name === 'requests').count, 2);
        const delta = guardedDelta(before, definitions);
        assert(!/CREATE ROLE|DROP |TRUNCATE |GRANT |private_notifications|legacy_fixture/.test(delta));
    });
    await check('stale preflight refuses transaction and leaves no half installation', async () => {
        await db.exec("ALTER ROLE e2ee_pilot_edge SET lock_timeout='2s'");
        await assert.rejects(
            () => db.exec(guardedDelta(before, definitions)),
            (e) => e?.code === '22023',
        );
        await db.exec('ROLLBACK');
        assert.deepEqual(
            (
                await db.query(
                    "SELECT to_regclass('e2ee_research.protected_accounts') AS table_present,to_regprocedure('e2ee_research.requires_protected(text)') AS helper_present",
                )
            ).rows[0],
            { table_present: null, helper_present: null },
        );
        await db.exec("ALTER ROLE e2ee_pilot_edge SET lock_timeout='1s'");
        assert.deepEqual(await snapshot(false), before);
    });
    await check('atomic support addition preserves all old catalog/data and grants', async () => {
        await db.exec(guardedDelta(before, definitions));
        const after = await snapshot(true);
        assert.equal(validateSnapshot(after, definitions), 'installed');
        assert.deepEqual(preserved(after), preserved(before));
        assert.equal(
            Number((await db.query('SELECT count(*) AS n FROM e2ee_research.protected_accounts')).rows[0].n),
            0,
        );
    });
    await check('installed classification is inspectable without replaying DDL', async () => {
        const after = await snapshot(true);
        assert.equal(validateSnapshot(after, definitions), 'installed');
        assert.throws(() => guardedDelta(after, definitions));
    });
    await check('privilege and schema drift refuses rather than broadening permissions', async () => {
        await db.exec(
            'BEGIN; SET LOCAL ROLE e2ee_research_owner; GRANT EXECUTE ON FUNCTION e2ee_research.requires_protected(text) TO e2ee_research_gateway; COMMIT;',
        );
        const bad = await snapshot(true);
        assert.throws(() => validateSnapshot({}, definitions));
        assert.throws(() => validateSnapshot(bad, definitions));
        await db.exec(
            'BEGIN; SET LOCAL ROLE e2ee_research_owner; REVOKE EXECUTE ON FUNCTION e2ee_research.requires_protected(text) FROM e2ee_research_gateway; COMMIT;',
        );
    });
    await check('database reopen preserves complete installed snapshot', async () => {
        const saved = await snapshot(true);
        await db.close();
        db = await PGlite.create({ dataDir });
        await db.exec("SET search_path=pg_catalog; SET TimeZone='UTC'");
        assert.deepEqual(await snapshot(true), saved);
        assert.equal(validateSnapshot(saved, definitions), 'installed');
    });
    for (const [p, h] of Object.entries(sourceHashes))
        assert.equal(hash(readFileSync(join(ROOT, p))), h, 'Source changed during proof');
    const path = join(scratch, 'receipt.json');
    writeFileSync(
        path,
        JSON.stringify(
            {
                status: 'passed',
                recordedAtUTC: new Date().toISOString(),
                sourceHashes,
                baselineSourceSha256: hash(baseline),
                groups,
                groupCount: groups.length,
                archiveIntegrity: pin.integrity,
                category:
                    'Local pinned PostgreSQL engine with synthetic Auth, real fixture signatures and nonempty legacy device/decision/block/request rows; no hosted/native/live Auth/concurrency/audit evidence',
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
    );
    console.info('PASS local cutover migration; sanitized receipt ' + path);
} catch (error) {
    writeFileSync(
        join(scratch, 'failure.json'),
        JSON.stringify(
            {
                status: 'failed',
                stage,
                groups,
                sourceHashes,
                code: error?.code ?? null,
                category: error?.name ?? 'Error',
            },
            null,
            2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
    );
    console.error('FAIL local migration stage ' + stage + '; private diagnostics suppressed; artifact ' + scratch);
    process.exitCode = 1;
} finally {
    await db.close();
}

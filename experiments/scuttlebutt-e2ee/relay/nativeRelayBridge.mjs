/** Actual native ciphertext/local PostgreSQL bridge for the simulator runner.
 * Fresh Auth HTTP RESPONSE fixtures, not a live Supabase account or TLS transport.
 * No provider secret, plaintext, pickle or decrypted history enters this module.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSupabaseResearchAuthenticator } from './supabaseAuth.ts';
import { createResearchSignedGateway } from './signedGateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
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

export async function createNativeRelayBridge({ archivePath, scratch }) {
    assert(isAbsolute(archivePath) && isAbsolute(scratch));
    const pin = JSON.parse(readFileSync(join(here, 'pglite-pin.json'), 'utf8'));
    assert.equal(pin.shippingApproved, false);
    const archive = readFileSync(archivePath);
    assert(archive.length < 32 * 1024 * 1024);
    assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), pin.integrity);
    const directory = join(scratch, 'native-relay');
    assert(!existsSync(directory), 'New relay namespace, never reuse prior database');
    mkdirSync(directory);
    const localArchive = join(directory, 'pglite.tgz');
    writeFileSync(localArchive, archive, { flag: 'wx', mode: 0o600 });
    const listing = spawnSync('/usr/bin/tar', ['-tzf', localArchive], { encoding: 'utf8', timeout: 30000 });
    assert.equal(listing.status, 0);
    assert(
        listing.stdout
            .trim()
            .split('\n')
            .every((name) => name.startsWith('package/') && !name.split('/').includes('..')),
    );
    assert.equal(spawnSync('/usr/bin/tar', ['-xzf', localArchive, '-C', directory], { timeout: 30000 }).status, 0);
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
    const { PGlite } = await import(pathToFileURL(join(directory, 'package/dist/index.js')).href);
    let db = await PGlite.create(join(directory, 'database'));
    await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN');
    await db.exec(readFileSync(join(here, 'relay.sql'), 'utf8'));
    const users = new Map([
        ['fixture-alice', '11111111-1111-4111-8111-111111111111'],
        ['fixture-bob', '22222222-2222-4222-8222-222222222222'],
    ]);
    let authRequests = 0;
    const authenticate = createSupabaseResearchAuthenticator({
        supabaseUrl: 'https://native-relay-fixture.invalid',
        publicApiKey: 'sb_publishable_fixture',
        fetch: async (url, init) => {
            assert.equal(url, 'https://native-relay-fixture.invalid/auth/v1/user');
            assert.equal(init.method, 'GET');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.redirect, 'error');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('apikey'), 'sb_publishable_fixture');
            authRequests++;
            const user = users.get(headers.get('Authorization')?.replace(/^Bearer /, ''));
            return Response.json(
                user ? { id: user, user_metadata: { actor: 'ignored-fixture' } } : { error: 'fixture' },
                { status: user ? 200 : 401 },
            );
        },
    });
    const rpc = (name, args) => {
        assert(Object.hasOwn(signatures, name));
        const casts = signatures[name].split(',');
        assert.equal(args.length, casts.length);
        return db.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE e2ee_research_gateway');
            const result = await tx.query(
                `SELECT e2ee_research.${name}(${casts.map((cast, i) => `$${i + 1}::${cast}`).join(',')}) AS result`,
                args.map((value, i) => (casts[i] === 'jsonb' ? JSON.stringify(value) : value)),
            );
            return result.rows[0].result;
        }); // Resolve after transaction COMMIT, never the callback's provisional result.
    };
    const gateway = createResearchSignedGateway({ authenticate, rpc, nowSeconds: () => Math.floor(Date.now() / 1000) });
    let cycles = 0;
    let signedRequests = 0;
    const dispatch = async (wire) => {
        assert.equal(typeof wire, 'string');
        const request = JSON.parse(wire);
        const credential = [...users].find(([, user]) => user === request.userId)?.[0];
        assert(credential, 'Only explicit fixture accounts');
        signedRequests++;
        return gateway.dispatch(credential, wire);
    };
    function readOutput(documents, run) {
        const path = join(documents, `relay-output-${run}.json`);
        assert(!lstatSync(path).isSymbolicLink());
        const bytes = readFileSync(path);
        assert(bytes.length <= 512 * 1024);
        return JSON.parse(bytes.toString('utf8'));
    }
    function writeInput(documents, run, object) {
        const path = join(documents, `relay-input-${run}.json`);
        assert(!existsSync(path) || !lstatSync(path).isSymbolicLink());
        writeFileSync(path, JSON.stringify(object), { mode: 0o600 });
    }
    return {
        async afterPhase(phase, documents, run) {
            if (phase === 'relay-prepare') {
                const output = readOutput(documents, run);
                assert.deepEqual(Object.keys(output).sort(), ['aliceBundle', 'aliceClaim', 'bobBundle', 'bobClaim']);
                await gateway.register('fixture-alice', output.aliceBundle);
                await gateway.register('fixture-bob', output.bobBundle);
                writeInput(documents, run, {
                    aliceClaim: await dispatch(output.aliceClaim),
                    bobClaim: await dispatch(output.bobClaim),
                });
                console.log(
                    'PASS native provider bundle/request signatures verified against account and registered device',
                );
            } else if (['relay-send', 'relay-reply', 'relay-verify'].includes(phase)) {
                const output = readOutput(documents, run);
                assert.deepEqual(Object.keys(output).sort(), ['list', 'send']);
                const receipt = await dispatch(output.send);
                assert.equal(receipt.accepted, true);
                assert.deepEqual(await dispatch(output.send), receipt, 'Exact signed retry keeps the committed result');
                const bad = JSON.parse(output.send);
                bad.requestId += '-tampered';
                await assert.rejects(
                    () => dispatch(JSON.stringify(bad)),
                    'Native signature authenticates exact request bytes',
                );
                const messages = await dispatch(output.list);
                assert.equal(messages.length, 1);
                assert.equal(messages[0].serializedEnvelope, receipt.serializedEnvelope);
                writeInput(documents, run, { receipt, messages });
                cycles++;
                console.log(
                    'PASS committed PostgreSQL ciphertext delivery and exact retry (no native secret/plaintext in relay)',
                );
            } else if (phase === 'relay-replay') {
                assert.equal(cycles, 3);
                const before = (await db.query('SELECT count(*)::integer AS n FROM e2ee_research.decisions')).rows[0].n;
                assert.equal(before, 3);
                const persisted = JSON.stringify((await db.query('SELECT * FROM e2ee_research.decisions')).rows);
                for (const text of [
                    'native ciphertext via PostgreSQL opening',
                    'native ciphertext via PostgreSQL reply',
                    'native ciphertext via PostgreSQL successor',
                ])
                    assert(!persisted.includes(text), 'Relay database must not contain native test plaintext');
                await db.close();
                db = await PGlite.create(join(directory, 'database'));
                assert.equal(
                    (await db.query('SELECT count(*)::integer AS n FROM e2ee_research.decisions')).rows[0].n,
                    3,
                );
                assert.equal(
                    (await db.query('SELECT count(*)::integer AS n FROM e2ee_research.requests')).rows[0].n,
                    8,
                );
                assert(
                    authRequests >= signedRequests + 2,
                    'Fresh Auth response check for each native request and registration',
                );
                console.log(
                    'PASS native ↔ PostgreSQL: 3 actual Olm messages, process restarts, exact retries, tamper refusal and database reopen',
                );
            }
        },
        async close() {
            if (!db.closed) await db.close();
        },
    };
}

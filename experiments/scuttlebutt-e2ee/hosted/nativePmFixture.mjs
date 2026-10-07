/**
 * Explicit one-lifetime hosted actors for a separately owned native simulator.
 * No top-level execution. The parent warms/owns its simulator BEFORE prepare,
 * validates its READY input path and preserves incomplete native key state.
 * Never reset/delete hosted actors, keys, requests, policies or old fixture rows.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    closeSync,
    existsSync,
    fsyncSync,
    linkSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDefinitions, snapshotExpression, validateSnapshot } from './cutoverMigration.mjs';
import { fingerprintSecretMetadata, normalizeRevisionSet } from './cutoverDeployment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const PROJECT = 'kmtupdvwdgbhtssqqova';
const ORGANIZATION = 'tideqlkywysyczrqreiz';
const ORIGIN = `https://${PROJECT}.supabase.co`;
const BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
const CLI = '/opt/homebrew/bin/supabase';
const HUMANS = ['f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73', '8fb85554-2385-49e9-8928-80d9407c05b1'];
const OLD_EMAILS = [
    'e2ee-fixture-a@thalassa.invalid',
    'e2ee-fixture-b@thalassa.invalid',
    'e2ee-cutover-fixture-a@thalassa.invalid',
    'e2ee-cutover-fixture-b@thalassa.invalid',
];
const NATIVE_EMAILS = ['e2ee-native-fixture-a@thalassa.invalid', 'e2ee-native-fixture-b@thalassa.invalid'];
const MESSAGE_IDS = [
    '91000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000003',
];
// These are code-declared synthetic fixtures, never caller/human message input.
const CANARIES = ['Native hosted research opening', 'Native hosted research reply', 'Native hosted research uncertain'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const SHA = /^[0-9a-f]{64}$/;
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const TABLES = ['devices', 'blocks', 'claims', 'decisions', 'requests', 'protected_accounts'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const fail = () => {
    throw new Error('Isolated native PM fixture unavailable');
};
const need = (value) => {
    if (!value) fail();
};
const match = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const canonical = (value) =>
    Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : value && typeof value === 'object'
          ? '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
                .join(',') +
            '}'
          : JSON.stringify(value);
const equal = (left, right) => canonical(left) === canonical(right);
let activePreparation = null;
function preparationBudget(bypass = false) {
    if (bypass || activePreparation === null) return 60000;
    const remaining = activePreparation.readyDeadlineUnixMs - Date.now() - 30000;
    need(Number.isSafeInteger(remaining) && remaining > 0);
    return remaining;
}
function exact(value, names) {
    need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value);
    need(keys.length === names.length && keys.every((key) => typeof key === 'string' && names.includes(key)));
    const copy = {};
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
        copy[name] = descriptor.value;
    }
    return copy;
}
function arrayData(value, maximum) {
    need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
    const size = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    need(Number.isSafeInteger(size) && size >= 0 && size <= maximum);
    const keys = Reflect.ownKeys(value);
    need(
        keys.length === size + 1 &&
            keys.every(
                (key) =>
                    key === 'length' ||
                    (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < size),
            ),
    );
    return Array.from({ length: size }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
        return descriptor.value;
    });
}
function freezeCopy(value) {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freezeCopy(item);
        Object.freeze(value);
    }
    return value;
}
function uuid(value) {
    return match(value, UUID) && value !== NIL_UUID;
}
function publicKey(value) {
    if (match(value, /^sb_publishable_[A-Za-z0-9_-]{8,256}$/)) return true;
    if (!match(value, BEARER) || value.length > 4096) return false;
    try {
        const pieces = value.split('.');
        need(pieces.length === 3 && pieces.every((piece) => /^[A-Za-z0-9_-]+$/.test(piece)));
        return JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'))?.role === 'anon';
    } catch {
        return false;
    }
}
function userFields(value) {
    need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value);
    need(keys.length <= 64 && keys.every((key) => typeof key === 'string'));
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    }
    const id = Object.getOwnPropertyDescriptor(value, 'id')?.value;
    const email = Object.getOwnPropertyDescriptor(value, 'email')?.value;
    need(uuid(id) && typeof email === 'string' && email.length >= 1 && email.length <= 320);
    return { id, email };
}

/** Structural config guard only: actual native /user still establishes authority. */
export function validateNativePacket(value, expectedRunID, forbiddenUserIds = HUMANS) {
    try {
        need(uuid(expectedRunID));
        const packet = exact(value, [
            'version',
            'runID',
            'project',
            'projectOrigin',
            'serviceBasePath',
            'publicApiKey',
            'conversationId',
            'accounts',
        ]);
        need(
            packet.version === 1 &&
                packet.runID === expectedRunID &&
                packet.project === PROJECT &&
                packet.projectOrigin === ORIGIN &&
                packet.serviceBasePath === BASE_PATH &&
                packet.conversationId === `native-pm-${expectedRunID}` &&
                publicKey(packet.publicApiKey),
        );
        const forbidden = [...HUMANS, ...arrayData(forbiddenUserIds, 64)];
        need(forbidden.every(uuid));
        const accounts = arrayData(packet.accounts, 2).map((entry) => exact(entry, ['userId', 'email', 'accessToken']));
        need(
            accounts.length === 2 &&
                accounts.every(
                    (account, index) =>
                        uuid(account.userId) &&
                        !forbidden.includes(account.userId) &&
                        account.email === NATIVE_EMAILS[index] &&
                        match(account.accessToken, BEARER) &&
                        account.accessToken.length <= 8192 &&
                        account.accessToken !== packet.publicApiKey,
                ) &&
                new Set(accounts.map((account) => account.userId)).size === 2 &&
                new Set(accounts.map((account) => account.accessToken)).size === 2,
        );
        return freezeCopy({ ...packet, accounts });
    } catch {
        return fail();
    }
}

/** Exact fixture summary, never proof of physical-device or human peer identity. */
export function validateNativeSummary(value, expectations) {
    try {
        const { runID, userIds } = exact(expectations, ['runID', 'userIds']);
        need(uuid(runID));
        const expectedIds = arrayData(userIds, 2);
        need(
            expectedIds.length === 2 &&
                expectedIds.every((id) => uuid(id) && !HUMANS.includes(id)) &&
                new Set(expectedIds).size === 2,
        );
        const summary = exact(value, ['version', 'runID', 'status', 'assertions', 'accounts', 'messages']);
        need(
            summary.version === 1 &&
                summary.runID === runID &&
                summary.status === 'passed' &&
                Number.isSafeInteger(summary.assertions) &&
                summary.assertions > 0 &&
                summary.assertions <= 10000,
        );
        const accounts = arrayData(summary.accounts, 2).map((entry) =>
            exact(entry, ['userId', 'deviceId', 'identityKeyId', 'bundleSha256']),
        );
        need(
            accounts.length === 2 &&
                accounts.every(
                    (account) =>
                        expectedIds.includes(account.userId) &&
                        uuid(account.deviceId) &&
                        uuid(account.identityKeyId) &&
                        match(account.bundleSha256, SHA),
                ) &&
                new Set(accounts.map((account) => account.userId)).size === 2 &&
                new Set(accounts.map((account) => account.deviceId)).size === 2 &&
                new Set(accounts.map((account) => account.identityKeyId)).size === 2,
        );
        const messages = arrayData(summary.messages, 3).map((entry) =>
            exact(entry, ['senderUserId', 'recipientUserId', 'clientMessageId', 'envelopeSha256']),
        );
        need(
            messages.length >= 2 &&
                messages.length <= 3 &&
                messages.every(
                    (message) =>
                        expectedIds.includes(message.senderUserId) &&
                        expectedIds.includes(message.recipientUserId) &&
                        message.senderUserId !== message.recipientUserId &&
                        match(message.envelopeSha256, SHA),
                ) &&
                equal(
                    messages.map((message) => message.clientMessageId).sort(),
                    MESSAGE_IDS.slice(0, messages.length).sort(),
                ),
        );
        messages.sort((a, b) =>
            a.clientMessageId < b.clientMessageId ? -1 : a.clientMessageId > b.clientMessageId ? 1 : 0,
        );
        need(
            messages[0].senderUserId === messages[1].recipientUserId &&
                messages[0].recipientUserId === messages[1].senderUserId,
        );
        if (messages.length === 3)
            need(
                messages[2].senderUserId === messages[0].senderUserId &&
                    messages[2].recipientUserId === messages[0].recipientUserId,
            );
        return freezeCopy({ ...summary, accounts, messages });
    } catch {
        return fail();
    }
}

/** Initial six OR exact post-creation eight; never an expanded numeric ceiling.
 * Inputs are untrusted until the structural checks below succeed.
 * @param {unknown} value
 * @param {unknown} oldActors
 * @param {unknown} newActors
 */
export function validateActorInventory(value, oldActors = null, newActors = null) {
    try {
        const current = arrayData(value, 8).map(userFields);
        need(
            new Set(current.map((actor) => actor.id)).size === current.length &&
                new Set(current.map((actor) => actor.email)).size === current.length,
        );
        if (newActors === null) {
            need(
                oldActors === null &&
                    current.length === 6 &&
                    HUMANS.every((id) => current.some((actor) => actor.id === id)) &&
                    OLD_EMAILS.every(
                        (email) =>
                            current.filter((actor) => actor.email === email && !HUMANS.includes(actor.id)).length === 1,
                    ) &&
                    current.every((actor) => HUMANS.includes(actor.id) || OLD_EMAILS.includes(actor.email)) &&
                    !current.some((actor) => NATIVE_EMAILS.includes(actor.email)),
            );
        } else {
            const prior = validateActorInventory(oldActors);
            const added = arrayData(newActors, 2).map((entry) => exact(entry, ['userId', 'email']));
            need(
                added.length === 2 &&
                    added.every(
                        (actor, index) =>
                            uuid(actor.userId) &&
                            actor.email === NATIVE_EMAILS[index] &&
                            !prior.some((old) => old.id === actor.userId),
                    ) &&
                    new Set(added.map((actor) => actor.userId)).size === 2 &&
                    current.length === 8,
            );
            need(
                prior.every((actor) =>
                    current.some((candidate) => candidate.id === actor.id && candidate.email === actor.email),
                ) &&
                    added.every((actor) =>
                        current.some((candidate) => candidate.id === actor.userId && candidate.email === actor.email),
                    ) &&
                    current.every(
                        (actor) =>
                            prior.some((old) => old.id === actor.id && old.email === actor.email) ||
                            added.some((fresh) => fresh.userId === actor.id && fresh.email === actor.email),
                    ),
            );
        }
        return freezeCopy(current.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    } catch {
        return fail();
    }
}
function privateDirectory(path) {
    const physical = realpathSync(path);
    need(isAbsolute(path) && physical !== CHECKOUT && !physical.startsWith(CHECKOUT + '/'));
    const stat = lstatSync(path);
    need(
        stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    );
}
function flushDirectory(path) {
    const descriptor = openSync(path, 'r');
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}
function newPrivateFile(path, content) {
    privateDirectory(dirname(path));
    const descriptor = openSync(path, 'wx', 0o600);
    try {
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    flushDirectory(dirname(path));
}
function privateBytes(path) {
    privateDirectory(dirname(path));
    const stat = lstatSync(path);
    need(
        stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.uid === process.getuid() &&
            (stat.mode & 0o777) === 0o600 &&
            stat.size <= 128 * 1024,
    );
    return readFileSync(path);
}
function progressFile(path, value) {
    const temporary = `${path}.next-${randomUUID()}`;
    newPrivateFile(temporary, JSON.stringify(value, null, 2) + '\n');
    renameSync(temporary, path);
    flushDirectory(dirname(path));
}
function guards() {
    need(CHECKOUT.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    need(realpathSync(HERE) === join(CHECKOUT, 'experiments/scuttlebutt-e2ee/hosted'));
    const ref = join(HERE, 'supabase/.temp/project-ref');
    need(lstatSync(ref).isFile() && !lstatSync(ref).isSymbolicLink() && readFileSync(ref, 'utf8').trim() === PROJECT);
    need(
        readFileSync(join(HERE, 'supabase/config.toml'), 'utf8') ===
            "# Isolated pilot only. Never use the repository's production Supabase config.\n" +
                `project_id = "${PROJECT}"\n\n[functions.scuttlebutt-e2ee-pilot]\nverify_jwt = true\n`,
    );
    need(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    for (const name of ['SUPABASE_DB_URL', 'PGHOST', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE'])
        need(!process.env[name]);
    for (const name of ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID'])
        need(!process.env[name] || process.env[name] === PROJECT);
}
function cli(args, json = true, bypassPreparation = false) {
    guards();
    const budget = preparationBudget(bypassPreparation);
    const result = spawnSync(CLI, args, {
        encoding: 'utf8',
        timeout: Math.min(60000, budget),
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    guards();
    preparationBudget(bypassPreparation);
    need(!result.error && result.status === 0);
    if (!json) return undefined;
    return JSON.parse(result.stdout);
}
function metadata(bypassPreparation = false) {
    const raw = cli(
        ['secrets', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json'],
        true,
        bypassPreparation,
    );
    // This independently checks the pinned URL digest and required pilot names.
    fingerprintSecretMetadata(raw);
    return raw
        .map(({ name, value }) => ({ name, value }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function replacingParticipants(original, value) {
    return original.map((entry) =>
        entry.name === 'E2EE_PILOT_PARTICIPANTS' ? { ...entry, value: hash(value) } : { ...entry },
    );
}
async function boundedJson(url, init) {
    const target = new URL(url);
    need(
        target.origin === ORIGIN &&
            target.protocol === 'https:' &&
            !target.username &&
            !target.password &&
            !target.hash,
    );
    const budget = preparationBudget();
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), Math.min(15000, budget));
    let reader;
    try {
        const response = await fetch(url, {
            ...init,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
        });
        need(!controller.signal.aborted && response.url === url && !response.redirected && response.status === 200);
        need(
            /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') &&
                response.body,
        );
        const length = response.headers.get('content-length');
        need(length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= 2 * 1024 * 1024));
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '',
            bytes = 0,
            chunks = 0;
        for (;;) {
            need(!controller.signal.aborted);
            const item = await reader.read();
            if (item.done) break;
            need(item.value instanceof Uint8Array && ++chunks <= 4096);
            bytes += item.value.byteLength;
            need(bytes <= 2 * 1024 * 1024);
            text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
        need(bytes > 0 && !controller.signal.aborted);
        const parsed = JSON.parse(text),
            pending = [{ value: parsed, depth: 0 }];
        let nodes = 0;
        while (pending.length) {
            const item = pending.pop();
            need(++nodes <= 32768 && item.depth <= 64);
            if (item.value && typeof item.value === 'object')
                for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
        }
        preparationBudget();
        return parsed;
    } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }
}
function auth(path, key, body) {
    return boundedJson(`${ORIGIN}/auth/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            accept: 'application/json',
            'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
async function users(admin) {
    const body = await auth('admin/users?page=1&per_page=100', admin);
    need(Array.isArray(body.users) && body.users.length <= 8);
    need(body.users.every((user) => match(user.id, UUID) && typeof user.email === 'string'));
    need(
        new Set(body.users.map((user) => user.id)).size === body.users.length &&
            new Set(body.users.map((user) => user.email)).size === body.users.length,
    );
    if (body.total !== undefined) need(body.total === body.users.length);
    return body.users;
}
function originalInventory(existing) {
    validateActorInventory(existing);
}
function allInventory(existing, originals, accounts) {
    validateActorInventory(
        existing,
        originals,
        accounts.map(({ userId, email }) => ({ userId, email })),
    );
}
function authDiagnostics(existing, ids) {
    return ids
        .map((id) => {
            const user = existing.find((candidate) => candidate.id === id);
            need(user);
            return { id, digest: hash(canonical(user)) };
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Fresh-only: the caller must reconcile retained artifacts after any failure. */
export async function prepareNativeFixture(options) {
    let journal, lifetime, journalPath, lifetimePath, preparation;
    const rememberFailure = () => {
        if (lifetime && lifetimePath) {
            lifetime.status = 'failed-or-incomplete';
            lifetime.updatedAt = new Date().toISOString();
            try {
                progressFile(lifetimePath, lifetime);
            } catch {
                /* Original immutable plan remains. */
            }
        }
    };
    try {
        const { runID, scratch, readyDeadlineUnixMs } = exact(options, ['runID', 'scratch', 'readyDeadlineUnixMs']);
        const now = Date.now();
        need(
            activePreparation === null &&
                Number.isSafeInteger(readyDeadlineUnixMs) &&
                readyDeadlineUnixMs > now + 30000 &&
                readyDeadlineUnixMs <= now + 300000,
        );
        preparation = { readyDeadlineUnixMs };
        activePreparation = preparation;
        need(uuid(runID));
        privateDirectory(scratch);
        guards();
        need(basename(scratch).startsWith('thalassa-native-hosted-pm-'));
        need(
            !existsSync(join(scratch, 'native-fixture-lifetime.json')) &&
                !existsSync(join(scratch, 'native-fixture-creation-plan.json')),
        );
        const project = cli(['projects', 'list', '--output', 'json']);
        need(Array.isArray(project));
        const selected = project.find((item) => item.id === PROJECT);
        need(
            selected?.organization_id === ORGANIZATION &&
                selected.name === 'Thalassa E2EE Pilot' &&
                selected.status === 'ACTIVE_HEALTHY',
        );
        function currentRevision(bypassPreparation = false) {
            return normalizeRevisionSet(
                cli(
                    ['functions', 'list', '--project-ref', PROJECT, '--workdir', HERE, '--output', 'json'],
                    true,
                    bypassPreparation,
                ),
            ).find((item) => item.slug === 'scuttlebutt-e2ee-pilot');
        }
        const revision = currentRevision();
        function sameDeployedArtifact(current) {
            need(
                current &&
                    current.id === revision.id &&
                    current.slug === revision.slug &&
                    current.status === 'ACTIVE' &&
                    current.verifyJwt === true &&
                    current.bundleSha256 === revision.bundleSha256 &&
                    current.version >= revision.version,
            );
        }
        const originalSecrets = metadata(),
            humanValue = HUMANS.join(',');
        need(originalSecrets.find((entry) => entry.name === 'E2EE_PILOT_PARTICIPANTS')?.value === hash(humanValue));
        const keys = cli(['projects', 'api-keys', '--project-ref', PROJECT, '--output', 'json']);
        need(Array.isArray(keys));
        const admin = keys.find((item) => item.name === 'service_role')?.api_key;
        const publicApiKey = keys.find((item) => item.name === 'anon')?.api_key;
        need(
            match(admin, BEARER) && admin.length <= 8192 && match(publicApiKey, BEARER) && publicApiKey.length <= 8192,
        );
        const originals = await users(admin);
        originalInventory(originals);
        const oldIDs = originals.map((user) => user.id).sort();
        const oldAuth = authDiagnostics(originals, oldIDs);
        let queryCounter = 0;
        function query(sql) {
            const path = join(scratch, `native-pm-query-${++queryCounter}.sql`);
            newPrivateFile(path, sql);
            try {
                const result = cli(['db', 'query', '--linked', '--workdir', HERE, '--output', 'json', '--file', path]);
                need(
                    Array.isArray(result.rows) &&
                        result.rows.length === 1 &&
                        result.rows[0] &&
                        Object.keys(result.rows[0]).length === 1,
                );
                return result.rows[0].state;
            } finally {
                unlinkSync(path);
            }
        }
        const frame = (expression) => `BEGIN; SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'; SET LOCAL TimeZone='UTC'; SET LOCAL search_path=pg_catalog;
SET LOCAL ROLE e2ee_research_owner;
DO $$ BEGIN PERFORM e2ee_research.lock_pilot(); END $$;
SELECT ${expression} AS state; RESET ROLE; COMMIT;\n`;
        const defs = extractDefinitions(readFileSync(join(HERE, '../relay/relay.sql'), 'utf8'));
        function installedState() {
            const state = query(frame(snapshotExpression(true)));
            need(validateSnapshot(state, defs) === 'installed');
            return state;
        }
        const initialInstalled = installedState();
        const initialCatalog = Object.fromEntries(Object.entries(initialInstalled).filter(([name]) => name !== 'data'));
        const initialCatalogHash = hash(canonical(initialCatalog));
        const oldList = oldIDs.map(literal).join(',');
        const rowPredicates = {
            devices: `user_id IN (${oldList})`,
            blocks: `owner_id IN (${oldList}) OR other_id IN (${oldList})`,
            claims: `owner_id IN (${oldList}) OR target_user_id IN (${oldList})`,
            decisions: `owner_id IN (${oldList}) OR recipient_user_id IN (${oldList})`,
            requests: `owner_id IN (${oldList})`,
            protected_accounts: `owner_id IN (${oldList})`,
        };
        function oldRows() {
            return query(
                frame(
                    `jsonb_build_array(${TABLES.map(
                        (table) => `jsonb_build_object('name',${literal(table)},
              'count',(SELECT count(*) FROM e2ee_research.${table} WHERE ${rowPredicates[table]}),
              'digest',(SELECT md5(COALESCE(string_agg(fingerprint,'' ORDER BY fingerprint COLLATE "C"),''))
                FROM (SELECT md5(row_to_json(value)::text) fingerprint FROM e2ee_research.${table} value WHERE ${rowPredicates[table]}) hashes))`,
                    ).join(',')})`,
                ),
            );
        }
        need(
            query(frame(`(SELECT COALESCE(bool_and(user_id IN (${oldList})),true) FROM e2ee_research.devices)`)) ===
                true,
        );
        const originalRows = oldRows();
        const credentialsPath = join(scratch, 'native-fixture-credentials.local');
        const creationPlanPath = join(scratch, 'native-fixture-creation-plan.json');
        const restorePath = join(scratch, 'native-fixture-human-restore.local');
        lifetimePath = join(scratch, 'native-fixture-lifetime.json');
        journalPath = join(scratch, 'native-fixture-restore-journal.json');
        const planned = NATIVE_EMAILS.map((email) => ({ email, password: randomBytes(24).toString('hex') }));
        const creationPlan = {
            version: 1,
            runID,
            project: PROJECT,
            organization: ORGANIZATION,
            fixtureAccountsOnly: true,
            oneLifetimeOnly: true,
            pendingAccounts: planned,
            createdAt: new Date().toISOString(),
        };
        newPrivateFile(creationPlanPath, JSON.stringify(creationPlan, null, 2) + '\n');
        newPrivateFile(restorePath, `E2EE_PILOT_PARTICIPANTS=${humanValue}\n`);
        lifetime = {
            version: 1,
            runID,
            project: PROJECT,
            status: 'planned',
            accounts: [],
            creationAttempted: [],
            oneLifetimeOnly: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            recovery:
                'Reconcile this exact plan. Never reset accounts, create replacement devices or reuse spent actors.',
        };
        newPrivateFile(lifetimePath, JSON.stringify(lifetime, null, 2) + '\n');
        journal = {
            version: 1,
            runID,
            project: PROJECT,
            organization: ORGANIZATION,
            stage: 'pending',
            restoreObligation: true,
            restorePath,
            restoreSha256: hash(`E2EE_PILOT_PARTICIPANTS=${humanValue}\n`),
            originalSecretMetadata: originalSecrets,
            temporarySelectionAttempted: false,
            restoreAttempted: false,
            restoredAndVerified: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        newPrivateFile(journalPath, JSON.stringify(journal, null, 2) + '\n');
        const credentials = { version: 1, runID, project: PROJECT, fixtureAccountsOnly: true, accounts: [] };
        newPrivateFile(credentialsPath, JSON.stringify(credentials, null, 2) + '\n');
        for (const plan of planned) {
            lifetime.creationAttempted.push(plan.email);
            lifetime.status = 'creating';
            lifetime.updatedAt = new Date().toISOString();
            progressFile(lifetimePath, lifetime);
            const created = await auth('admin/users', admin, {
                email: plan.email,
                password: plan.password,
                email_confirm: true,
            });
            need(
                match(created.id, UUID) &&
                    !oldIDs.includes(created.id) &&
                    created.email === plan.email &&
                    !credentials.accounts.some((account) => account.userId === created.id),
            );
            credentials.accounts.push({ userId: created.id, email: plan.email, password: plan.password });
            progressFile(credentialsPath, credentials);
            lifetime.accounts.push({ userId: created.id, email: plan.email });
            progressFile(lifetimePath, lifetime);
        }
        const inventory = await users(admin);
        allInventory(inventory, originals, credentials.accounts);
        need(equal(authDiagnostics(inventory, oldIDs), oldAuth) && equal(oldRows(), originalRows));
        const accounts = [];
        for (const account of credentials.accounts) {
            const session = await auth('token?grant_type=password', publicApiKey, {
                email: account.email,
                password: account.password,
            });
            need(
                match(session.access_token, BEARER) &&
                    session.access_token.length <= 8192 &&
                    session.user?.id === account.userId,
            );
            // Use the actual bearer for /user, never the public API key's role.
            const verified = await boundedJson(`${ORIGIN}/auth/v1/user`, {
                method: 'GET',
                headers: {
                    apikey: publicApiKey,
                    authorization: `Bearer ${session.access_token}`,
                    accept: 'application/json',
                },
            });
            need(verified.id === account.userId && verified.email === account.email);
            accounts.push({ userId: account.userId, email: account.email, accessToken: session.access_token });
        }
        const newIDs = accounts.map((account) => account.userId);
        const fixtureValue = newIDs.join(','),
            fixturePath = join(scratch, 'native-fixture-allowlist.local');
        newPrivateFile(fixturePath, `E2EE_PILOT_PARTICIPANTS=${fixtureValue}\n`);
        lifetime.status = 'prepared';
        lifetime.updatedAt = new Date().toISOString();
        progressFile(lifetimePath, lifetime);
        let begun = false,
            inputWritten = false,
            verifiedResult = false,
            restored = false,
            generation = 0,
            selectedRevision = null;
        const publicState = {
            version: 1,
            runID,
            project: PROJECT,
            organization: ORGANIZATION,
            status: 'prepared',
            fixtureAccountsOnly: true,
            oneLifetimeOnly: true,
            freshNodeAuthVerified: true,
            oldActorCount: 6,
            newActorCount: 2,
            credentialsPath,
            creationPlanPath,
            lifetimePath,
            restorationJournalPath: journalPath,
            originalSecretMetadataSha256: hash(canonical(originalSecrets)),
            oldAuthDiagnosticsSha256: hash(canonical(oldAuth)),
            oldRelayDataDiagnostics: originalRows,
            oldInstalledCatalogSha256: initialCatalogHash,
            initialRevision: revision,
            temporarySelectionAttempted: false,
            restoredAndVerified: false,
            nativeResultVerified: false,
            productionTouched: false,
            humanAccountModeSelected: false,
            humanDeviceChanged: false,
            independentAuditPerformed: false,
        };
        const publicPath = join(scratch, 'native-fixture-public-receipt.json');
        newPrivateFile(publicPath, JSON.stringify(publicState, null, 2) + '\n');
        function publish() {
            publicState.status = lifetime.status;
            progressFile(publicPath, publicState);
        }
        const guarded =
            (operation) =>
            async (...args) => {
                try {
                    return await operation(...args);
                } catch {
                    rememberFailure();
                    return fail();
                }
            };
        return Object.freeze({
            beginAllowlist: guarded(async () => {
                need(!begun && !restored && lifetime.status === 'prepared');
                need(equal(metadata(), originalSecrets));
                const beforeSelection = currentRevision();
                sameDeployedArtifact(beforeSelection);
                publicState.preSelectionRevision = beforeSelection;
                journal.temporarySelectionAttempted = true;
                journal.stage = 'attempted';
                journal.updatedAt = new Date().toISOString();
                progressFile(journalPath, journal);
                begun = true;
                publicState.temporarySelectionAttempted = true;
                lifetime.status = 'allowlist-attempted';
                progressFile(lifetimePath, lifetime);
                publish();
                need(privateBytes(fixturePath).toString('utf8') === `E2EE_PILOT_PARTICIPANTS=${fixtureValue}\n`);
                cli(
                    [
                        'secrets',
                        'set',
                        '--project-ref',
                        PROJECT,
                        '--workdir',
                        HERE,
                        '--env-file',
                        fixturePath,
                        '--output',
                        'json',
                    ],
                    false,
                );
                need(equal(metadata(), replacingParticipants(originalSecrets, fixtureValue)));
                selectedRevision = currentRevision();
                sameDeployedArtifact(selectedRevision);
                need(selectedRevision.version >= beforeSelection.version);
                publicState.selectedRevision = selectedRevision;
                lifetime.status = 'allowlisted';
                progressFile(lifetimePath, lifetime);
                publish();
                return true;
            }),
            writeNativeInput: guarded(async (inputPath) => {
                need(begun && !restored && !inputWritten && lifetime.status === 'allowlisted');
                need(
                    typeof inputPath === 'string' &&
                        isAbsolute(inputPath) &&
                        basename(inputPath) === `native-hosted-input-${runID}.json` &&
                        !existsSync(inputPath),
                );
                privateDirectory(dirname(inputPath));
                const packet = validateNativePacket(
                    {
                        version: 1,
                        runID,
                        project: PROJECT,
                        projectOrigin: ORIGIN,
                        serviceBasePath: BASE_PATH,
                        publicApiKey,
                        conversationId: `native-pm-${runID}`,
                        accounts: accounts.map((account) => ({ ...account })),
                    },
                    runID,
                    oldIDs,
                );
                // Persist the possible handoff BEFORE its path becomes visible.
                // Native polls only the final filename, never the private temp.
                inputWritten = true;
                lifetime.status = 'native-input-publication-attempted';
                publicState.nativeInputPublicationAttempted = true;
                progressFile(lifetimePath, lifetime);
                publish();
                const temporary = join(dirname(inputPath), `.native-packet-${runID}-${randomUUID()}.tmp`);
                try {
                    newPrivateFile(temporary, JSON.stringify(packet) + '\n');
                    // Same-directory hard link is atomic and refuses an existing
                    // destination. Never overwrite a READY path or expose zeros.
                    linkSync(temporary, inputPath);
                } finally {
                    if (existsSync(temporary)) unlinkSync(temporary);
                    flushDirectory(dirname(inputPath));
                }
                lifetime.status = 'native-input-written';
                progressFile(lifetimePath, lifetime);
                publish();
                return true;
            }),
            verifyNativeResult: guarded(async (value) => {
                need(begun && inputWritten && !restored && !verifiedResult);
                const epoch = generation;
                const summary = validateNativeSummary(value, { runID, userIds: newIDs });
                const nativeAccounts = summary.accounts,
                    messages = summary.messages;
                const currentUsers = await users(admin);
                need(epoch === generation && !restored);
                allInventory(currentUsers, originals, credentials.accounts);
                need(equal(authDiagnostics(currentUsers, oldIDs), oldAuth) && equal(oldRows(), originalRows));
                const installed = installedState(),
                    catalog = Object.fromEntries(Object.entries(installed).filter(([name]) => name !== 'data'));
                need(hash(canonical(catalog)) === initialCatalogHash);
                const ids = newIDs.map(literal).join(',');
                const actual = query(
                    frame(`jsonb_build_object(
                  'devices',(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY user_id),'[]'::jsonb) FROM e2ee_research.devices d WHERE user_id IN (${ids})),
                  'protected',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY owner_id),'[]'::jsonb) FROM e2ee_research.protected_accounts p WHERE owner_id IN (${ids})),
                  'decisions',(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY server_id),'[]'::jsonb) FROM e2ee_research.decisions d WHERE owner_id IN (${ids}) OR recipient_user_id IN (${ids})),
                  'claims',(SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM e2ee_research.claims c WHERE owner_id IN (${ids}) OR target_user_id IN (${ids})),
                  'blocks',(SELECT count(*) FROM e2ee_research.blocks WHERE owner_id IN (${ids}) OR other_id IN (${ids})),
                  'requests',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM e2ee_research.requests r WHERE owner_id IN (${ids})),
                  'forbiddenColumns',(SELECT count(*) FROM information_schema.columns WHERE table_schema='e2ee_research' AND
                    table_name IN ('devices','blocks','claims','decisions','requests','protected_accounts') AND column_name IN ('message','body','plaintext','preview','password','access_token','pickle')))`),
                );
                need(
                    actual.devices.length === 2 &&
                        actual.protected.length === 2 &&
                        actual.decisions.length === messages.length &&
                        actual.blocks === 0 &&
                        actual.forbiddenColumns === 0 &&
                        actual.claims.length === 1 &&
                        actual.requests.length >= 5 &&
                        actual.requests.length <= 12,
                );
                for (const account of nativeAccounts) {
                    const device = actual.devices.find((item) => item.user_id === account.userId);
                    need(
                        device &&
                            device.device_id === account.deviceId &&
                            device.identity_key_id === account.identityKeyId &&
                            device.revoked === false &&
                            hash(device.signed_bundle) === account.bundleSha256,
                    );
                    const policy = actual.protected.find((item) => item.owner_id === account.userId);
                    need(
                        policy?.selecting_device_id === account.deviceId &&
                            actual.requests.some(
                                (request) =>
                                    request.owner_id === account.userId &&
                                    request.device_id === account.deviceId &&
                                    request.request_id === policy.selecting_request_id &&
                                    JSON.parse(request.request_wire).action === 'require-protected',
                            ),
                    );
                }
                need(
                    actual.claims.every(
                        (claim) =>
                            newIDs.includes(claim.owner_id) &&
                            newIDs.includes(claim.target_user_id) &&
                            claim.owner_id !== claim.target_user_id,
                    ),
                );
                for (const request of actual.requests) {
                    const account = nativeAccounts.find((item) => item.userId === request.owner_id);
                    const wire = JSON.parse(request.request_wire);
                    need(
                        account &&
                            request.device_id === account.deviceId &&
                            wire.userId === account.userId &&
                            wire.deviceId === account.deviceId &&
                            wire.requestId === request.request_id &&
                            ['require-protected', 'claim', 'send', 'list'].includes(wire.action),
                    );
                    if (wire.action === 'require-protected')
                        need(wire.payload === '[]' && request.outcome?.mode === 'protected-required');
                    if (wire.action === 'send') {
                        const record = JSON.parse(wire.payload),
                            envelope = JSON.parse(record.serializedEnvelope);
                        need(
                            record.ownerUserId === account.userId &&
                                newIDs.includes(record.recipientUserId) &&
                                record.recipientUserId !== account.userId &&
                                MESSAGE_IDS.slice(0, messages.length).includes(envelope.clientMessageId) &&
                                request.outcome?.accepted === true,
                        );
                    }
                    for (const canary of CANARIES)
                        need(
                            !request.request_wire.includes(canary) && !JSON.stringify(request.outcome).includes(canary),
                        );
                }
                need(new Set(actual.decisions.map((decision) => decision.server_id)).size === messages.length);
                for (const message of messages) {
                    const rows = actual.decisions.filter(
                        (decision) =>
                            decision.client_message_id === message.clientMessageId &&
                            decision.owner_id === message.senderUserId &&
                            decision.recipient_user_id === message.recipientUserId,
                    );
                    need(
                        rows.length === 1 &&
                            rows[0].accepted === true &&
                            rows[0].reason === null &&
                            hash(rows[0].serialized_envelope) === message.envelopeSha256,
                    );
                    const envelope = JSON.parse(rows[0].serialized_envelope);
                    need(
                        envelope.version === 2 &&
                            envelope.protocol === 'olm-v1' &&
                            ['prekey', 'session'].includes(envelope.messageType) &&
                            envelope.clientMessageId === message.clientMessageId &&
                            envelope.senderDeviceId ===
                                nativeAccounts.find((account) => account.userId === message.senderUserId).deviceId &&
                            envelope.recipientDeviceId ===
                                nativeAccounts.find((account) => account.userId === message.recipientUserId).deviceId &&
                            typeof envelope.ciphertext === 'string',
                    );
                    const decoded = Buffer.from(envelope.ciphertext, 'base64');
                    need(decoded.length > 0 && decoded.toString('base64') === envelope.ciphertext);
                    for (const canary of CANARIES)
                        need(!rows[0].serialized_envelope.includes(canary) && !decoded.includes(Buffer.from(canary)));
                }
                need(
                    epoch === generation &&
                        !restored &&
                        equal(metadata(), replacingParticipants(originalSecrets, fixtureValue)),
                );
                need(selectedRevision && equal(currentRevision(), selectedRevision));
                verifiedResult = true;
                publicState.nativeResultVerified = true;
                publicState.nativeAssertions = summary.assertions;
                publicState.expectedMessages = messages.length;
                publicState.nativeAccountBindingsSha256 = hash(canonical(nativeAccounts));
                publicState.nativeMessageEnvelopeDiagnostics = messages;
                publicState.oldActorsAndAllSixRelayTablesPreserved = true;
                lifetime.status = 'native-verified';
                progressFile(lifetimePath, lifetime);
                publish();
                return true;
            }),
            restore: async () => {
                try {
                    generation += 1;
                    let journalFailure = false;
                    journal.restoreAttempted = true;
                    journal.stage = 'restore-attempted';
                    journal.updatedAt = new Date().toISOString();
                    try {
                        progressFile(journalPath, journal);
                    } catch {
                        journalFailure = true;
                    }
                    need(
                        hash(privateBytes(restorePath)) === journal.restoreSha256 &&
                            privateBytes(restorePath).toString('utf8') === `E2EE_PILOT_PARTICIPANTS=${humanValue}\n`,
                    );
                    const current = metadata(true);
                    need(
                        equal(current, originalSecrets) ||
                            equal(current, replacingParticipants(originalSecrets, fixtureValue)),
                    );
                    // Restore also after a failed/unknown temporary write. An
                    // unexpected third state is never overwritten blindly.
                    if (!equal(current, originalSecrets))
                        cli(
                            [
                                'secrets',
                                'set',
                                '--project-ref',
                                PROJECT,
                                '--workdir',
                                HERE,
                                '--env-file',
                                restorePath,
                                '--output',
                                'json',
                            ],
                            false,
                            true,
                        );
                    need(equal(metadata(true), originalSecrets));
                    restored = true;
                    journal.stage = 'verified';
                    journal.restoreObligation = false;
                    journal.restoredAndVerified = true;
                    journal.updatedAt = new Date().toISOString();
                    progressFile(journalPath, journal);
                    publicState.restoredAndVerified = true;
                    const restoredRevision = currentRevision(true);
                    publicState.restoredRevision = restoredRevision;
                    sameDeployedArtifact(restoredRevision);
                    if (selectedRevision) need(restoredRevision.version >= selectedRevision.version);
                    lifetime.status = verifiedResult ? 'consumed-complete' : 'consumed-incomplete';
                    lifetime.updatedAt = new Date().toISOString();
                    progressFile(lifetimePath, lifetime);
                    publish();
                    need(!journalFailure);
                    return true;
                } catch {
                    rememberFailure();
                    return fail();
                }
            },
            publicReceipt() {
                // Explicit publicState contains only refs, flags and bounded
                // diagnostic hashes/counts; never credentials or token digests.
                return JSON.parse(JSON.stringify(publicState));
            },
        });
    } catch {
        rememberFailure();
        return fail();
    } finally {
        if (activePreparation === preparation) activePreparation = null;
    }
}

// Explicit disposable hosted actors: never register fixtures against pilot phones.
// Always restore the approved human allowlist, including on failed live checks.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    fsyncSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = 'kmtupdvwdgbhtssqqova';
const organization = 'tideqlkywysyczrqreiz';
const origin = `https://${project}.supabase.co`;
const cli = '/opt/homebrew/bin/supabase';
const humans = ['f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73', '8fb85554-2385-49e9-8928-80d9407c05b1'];
const baselineEmails = ['e2ee-fixture-a@thalassa.invalid', 'e2ee-fixture-b@thalassa.invalid'];
const cutoverEmails = ['e2ee-cutover-fixture-a@thalassa.invalid', 'e2ee-cutover-fixture-b@thalassa.invalid'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let stage = 'fixture setup';

function privateFile(path) {
    assert(isAbsolute(path));
    const file = lstatSync(path),
        parent = lstatSync(dirname(path));
    assert(file.isFile() && !file.isSymbolicLink() && file.size < 65536 && file.uid === process.getuid());
    assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
    assert((file.mode & 0o777) === 0o600 && (parent.mode & 0o777) === 0o700);
    return readFileSync(path, 'utf8');
}

function run(args) {
    const result = spawnSync(cli, args, {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    });
    assert(!result.error && result.status === 0, 'Isolated command failed; private output suppressed');
    return result.stdout;
}

async function adminRequest(path, key, body) {
    const response = await fetch(`${origin}/auth/v1/admin/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(15000),
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.status === 200);
    return response.json();
}

function allowlist(path) {
    run(['secrets', 'set', '--project-ref', project, '--workdir', here, '--env-file', path, '--output', 'json']);
}

function secretMetadata() {
    const values = JSON.parse(
        run(['secrets', 'list', '--project-ref', project, '--workdir', here, '--output', 'json']),
    );
    assert(Array.isArray(values));
    const metadata = values.map(({ name, value }) => {
        assert(typeof name === 'string' && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
        return { name, value };
    });
    return metadata.sort((left, right) => left.name.localeCompare(right.name));
}

function fixtureCredentials(value, emails) {
    assert(
        value?.project === project &&
            value.fixtureAccountsOnly === true &&
            Array.isArray(value.accounts) &&
            value.accounts.length === 2,
    );
    assert(
        value.accounts.every(
            (account, index) =>
                account.email === emails[index] &&
                typeof account.userId === 'string' &&
                uuid.exec(account.userId)?.[0] === account.userId &&
                !humans.includes(account.userId) &&
                typeof account.password === 'string' &&
                account.password.length >= 24 &&
                account.password.length <= 256,
        ),
    );
    assert(new Set(value.accounts.map((account) => account.userId)).size === 2);
}

// Owner-only persistent recovery marker. Fsync each new file before atomically
// replacing the journal; no password, bearer or private signing key is recorded.
// Hard termination cannot run finally. A pending/attempted journal deliberately
// retains the restore obligation for explicit inspection/recovery on restart.
// This is not an independently tested power-loss durability guarantee.
function saveJournal(path, value, initial = false) {
    const target = initial ? path : `${path}.next-${randomUUID()}`;
    const descriptor = openSync(target, 'wx', 0o600);
    try {
        writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    if (!initial) renameSync(target, path);
}

async function main() {
    const args = process.argv.slice(2),
        cutover = args.at(-1) === '--cutover';
    if (cutover) args.pop();
    const [humanPath, reusePath, ...extra] = args;
    assert(extra.length === 0 && here.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert(!reusePath || isAbsolute(reusePath));
    const emails = cutover ? cutoverEmails : baselineEmails;
    let credentials, privatePath;
    // A reused artifact is classified before any management/Auth request, not
    // merely before enrollment. Reserved human IDs never enter fixture scope.
    if (reusePath) {
        credentials = JSON.parse(privateFile(reusePath));
        fixtureCredentials(credentials, emails);
        privatePath = reusePath;
    }
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    assert(privateFile(humanPath) === `E2EE_PILOT_PARTICIPANTS=${humans.join(',')}\n`);
    stage = 'approved project lookup';
    const selected = JSON.parse(run(['projects', 'list', '--output', 'json'])).find((item) => item.id === project);
    assert(
        selected?.organization_id === organization &&
            selected.name === 'Thalassa E2EE Pilot' &&
            selected.status === 'ACTIVE_HEALTHY',
    );
    const originalSecrets = secretMetadata();
    assert(
        originalSecrets.find((item) => item.name === 'E2EE_PILOT_PARTICIPANTS')?.value ===
            createHash('sha256').update(humans.join(',')).digest('hex'),
        'Original human allowlist must match before temporary replacement',
    );
    stage = 'pilot API key lookup';
    const keys = JSON.parse(run(['projects', 'api-keys', '--project-ref', project, '--output', 'json']));
    const admin = keys.find((key) => key.name === 'service_role')?.api_key;
    assert(typeof admin === 'string');
    stage = 'pilot fixture account validation';
    const existing = (await adminRequest('users?page=1&per_page=100', admin)).users;
    assert(Array.isArray(existing));
    assert(humans.every((id) => existing.some((user) => user.id === id)));
    assert(existing.length <= 6 && new Set(existing.map((user) => user.id)).size === existing.length);
    assert(
        existing.every(
            (user) => humans.includes(user.id) || [...baselineEmails, ...cutoverEmails].includes(user.email),
        ),
        'Unexpected actors; never reset or replace',
    );
    for (const pair of [baselineEmails, cutoverEmails]) {
        const count = existing.filter((user) => pair.includes(user.email)).length;
        assert(count === 0 || count === 2, 'Partial fixture setup requires deliberate reconciliation');
        if (count === 2) assert(pair.every((email) => existing.filter((user) => user.email === email).length === 1));
    }
    if (reusePath) {
        assert(
            credentials.accounts.every(
                (account, index) =>
                    account.email === emails[index] &&
                    existing.some((user) => user.id === account.userId && user.email === account.email),
            ),
        );
    } else {
        assert(!existing.some((user) => emails.includes(user.email)), 'Unexpected accounts; never reset or replace');
        const scratch = mkdtempSync(
            join(tmpdir(), cutover ? 'thalassa-hosted-cutover-fixtures-' : 'thalassa-hosted-fixtures-'),
        );
        chmodSync(scratch, 0o700);
        privatePath = join(scratch, 'account-credentials.local');
        credentials = {
            project,
            fixtureAccountsOnly: true,
            accounts: [],
            pendingAccounts: emails.map((email) => ({ email, password: randomBytes(24).toString('hex') })),
        };
        // Preserve planned passwords BEFORE irreversible fixture Auth creation.
        // Partial creation still refuses fresh replay; this is recovery evidence,
        // never authorization to reset an existing actor or claim a fresh pass.
        writeFileSync(privatePath, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx' });
        for (const { email, password } of [...credentials.pendingAccounts]) {
            const created = await adminRequest('users', admin, { email, password, email_confirm: true });
            assert(
                typeof created.id === 'string' &&
                    uuid.exec(created.id)?.[0] === created.id &&
                    !humans.includes(created.id) &&
                    created.email === email,
            );
            credentials.accounts.push({ userId: created.id, email, password });
            credentials.pendingAccounts = credentials.pendingAccounts.filter((account) => account.email !== email);
            writeFileSync(privatePath, JSON.stringify(credentials) + '\n', { mode: 0o600 });
        }
    }
    fixtureCredentials(credentials, emails);
    console.info(`Disposable relay credentials retained privately: ${privatePath}`);
    const fixturePath = join(dirname(privatePath), 'fixture-allowlist.local');
    writeFileSync(
        fixturePath,
        `E2EE_PILOT_PARTICIPANTS=${credentials.accounts.map((account) => account.userId).join(',')}\n`,
        { mode: 0o600 },
    );
    const journalPath = join(dirname(privatePath), `fixture-restore-journal-${randomUUID()}.json`);
    const journal = {
        version: 1,
        project,
        organization,
        proofRunner: cutover ? 'cutoverLiveProof.mjs' : 'liveProof.mjs',
        stage: 'pending',
        restoreObligation: true,
        restorePath: humanPath,
        originalSecretMetadata: originalSecrets,
        temporarySelectionAttempted: false,
        restoreAttempted: false,
        restoredAndVerified: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        recovery:
            'Inspect before proceeding. Restore only the pinned human allowlist path and verify all original secret digests. Never reset fixture accounts or policy rows.',
    };
    saveJournal(journalPath, journal, true);
    console.info(`Owner-only allowlist restoration journal: ${journalPath}`);
    try {
        stage = 'temporary fixture allowlist';
        journal.temporarySelectionAttempted = true;
        journal.updatedAt = new Date().toISOString();
        saveJournal(journalPath, journal);
        allowlist(fixturePath);
        stage = 'live relay assertions';
        const proof = spawnSync(
            process.execPath,
            [
                '--experimental-strip-types',
                join(here, cutover ? 'cutoverLiveProof.mjs' : 'liveProof.mjs'),
                privatePath,
                '--check-acl',
            ],
            { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 },
        );
        // The proof's output contract permits only fixed PASS/FAIL labels and a receipt path.
        for (const line of (proof.stdout + proof.stderr).split('\n')) {
            if (/^(PASS |FAIL )/.test(line)) console.info(line);
        }
        assert(!proof.error && proof.status === 0, 'Hosted live proof failed');
    } finally {
        // Deliberately synchronous and mandatory: restore even if the smoke test fails.
        const previousStage = stage;
        stage = 'human participant allowlist restoration';
        // A journal-write failure must not prevent the actual restore attempt;
        // the previous pending marker already retains the obligation.
        let journalFailed = false;
        journal.stage = 'attempted';
        journal.restoreAttempted = true;
        journal.updatedAt = new Date().toISOString();
        try {
            saveJournal(journalPath, journal);
        } catch {
            journalFailed = true;
            console.error('FAIL restoration journal update; prior restore obligation retained');
        }
        allowlist(humanPath);
        assert(
            JSON.stringify(secretMetadata()) === JSON.stringify(originalSecrets),
            'Original secret digests restored exactly',
        );
        journal.stage = 'verified';
        journal.restoreObligation = false;
        journal.restoredAndVerified = true;
        journal.updatedAt = new Date().toISOString();
        saveJournal(journalPath, journal);
        stage = previousStage;
        console.info('Human iPhone/iPad participant allowlist restored; device slots untouched.');
        assert(!journalFailed, 'Restoration succeeded but journal update was incomplete');
    }
}

await main().catch(() => {
    console.error(`FAIL ${stage}; private diagnostics suppressed`);
    process.exitCode = 1;
});

// Explicit disposable hosted actors: never register fixtures against pilot phones.
// Always restore the approved human allowlist, including on failed live checks.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = 'kmtupdvwdgbhtssqqova';
const organization = 'tideqlkywysyczrqreiz';
const origin = `https://${project}.supabase.co`;
const cli = '/opt/homebrew/bin/supabase';
const humans = ['f79ace09-0bcd-4ce5-a24d-1fb89a9e1c73', '8fb85554-2385-49e9-8928-80d9407c05b1'];
const emails = ['e2ee-fixture-a@thalassa.invalid', 'e2ee-fixture-b@thalassa.invalid'];
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
        signal: AbortSignal.timeout(15000),
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.status === 200);
    return response.json();
}

function allowlist(path) {
    run(['secrets', 'set', '--project-ref', project, '--workdir', here, '--env-file', path, '--output', 'json']);
}

async function main() {
    const [humanPath, reusePath, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && here.includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    assert(privateFile(humanPath) === `E2EE_PILOT_PARTICIPANTS=${humans.join(',')}\n`);
    stage = 'approved project lookup';
    const selected = JSON.parse(run(['projects', 'list', '--output', 'json'])).find((item) => item.id === project);
    assert(
        selected?.organization_id === organization &&
            selected.name === 'Thalassa E2EE Pilot' &&
            selected.status === 'ACTIVE_HEALTHY',
    );
    stage = 'pilot API key lookup';
    const keys = JSON.parse(run(['projects', 'api-keys', '--project-ref', project, '--output', 'json']));
    const admin = keys.find((key) => key.name === 'service_role')?.api_key;
    assert(typeof admin === 'string');
    stage = 'pilot fixture account validation';
    const existing = (await adminRequest('users?page=1&per_page=100', admin)).users;
    assert(Array.isArray(existing));
    let credentials, privatePath;
    if (reusePath) {
        credentials = JSON.parse(privateFile(reusePath));
        assert(
            credentials.project === project &&
                credentials.fixtureAccountsOnly === true &&
                credentials.accounts.length === 2,
        );
        assert(existing.length === 4 && humans.every((id) => existing.some((user) => user.id === id)));
        assert(
            credentials.accounts.every(
                (account, index) =>
                    account.email === emails[index] &&
                    existing.some((user) => user.id === account.userId && user.email === account.email),
            ),
        );
        privatePath = reusePath;
    } else {
        assert(
            existing.length === 2 && humans.every((id) => existing.some((user) => user.id === id)),
            'Unexpected accounts; never reset or replace',
        );
        const scratch = mkdtempSync(join(tmpdir(), 'thalassa-hosted-fixtures-'));
        chmodSync(scratch, 0o700);
        privatePath = join(scratch, 'account-credentials.local');
        credentials = { project, fixtureAccountsOnly: true, accounts: [] };
        for (const email of emails) {
            const password = randomBytes(24).toString('hex');
            const created = await adminRequest('users', admin, { email, password, email_confirm: true });
            assert(typeof created.id === 'string' && created.email === email);
            credentials.accounts.push({ userId: created.id, email, password });
            writeFileSync(privatePath, JSON.stringify(credentials) + '\n', { mode: 0o600 });
        }
    }
    console.info(`Disposable relay credentials retained privately: ${privatePath}`);
    const fixturePath = join(dirname(privatePath), 'fixture-allowlist.local');
    writeFileSync(
        fixturePath,
        `E2EE_PILOT_PARTICIPANTS=${credentials.accounts.map((account) => account.userId).join(',')}\n`,
        { mode: 0o600 },
    );
    try {
        stage = 'temporary fixture allowlist';
        allowlist(fixturePath);
        stage = 'live relay assertions';
        const proof = spawnSync(
            process.execPath,
            ['--experimental-strip-types', join(here, 'liveProof.mjs'), privatePath, '--check-acl'],
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
        allowlist(humanPath);
        stage = previousStage;
        console.info('Human iPhone/iPad participant allowlist restored; device slots untouched.');
    }
}

await main().catch(() => {
    console.error(`FAIL ${stage}; private diagnostics suppressed`);
    process.exitCode = 1;
});

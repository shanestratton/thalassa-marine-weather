// Explicit isolated Auth-fixture setup; does not email users or alter live logins.
// Initial fixture credentials are owner-only local artifacts, never console output.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = 'kmtupdvwdgbhtssqqova',
    organization = 'tideqlkywysyczrqreiz';
const here = dirname(fileURLToPath(import.meta.url));
const origin = `https://${project}.supabase.co`;
async function main() {
    assert(fileURLToPath(new URL('../../../', import.meta.url)).includes('/.codex/worktrees/scuttlebutt-e2ee/'));
    assert(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
    const emails = process.argv.slice(2);
    assert(
        emails.length === 2 &&
            new Set(emails).size === 2 &&
            emails.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
    );
    function cli(args) {
        const result = spawnSync('/opt/homebrew/bin/supabase', args, {
            encoding: 'utf8',
            timeout: 30000,
            env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
        });
        assert(!result.error && result.status === 0, 'Test project management unavailable');
        return JSON.parse(result.stdout);
    }
    const selected = cli(['projects', 'list', '--output', 'json']).find((item) => item.id === project);
    assert(selected?.organization_id === organization && selected?.status === 'ACTIVE_HEALTHY');
    const keys = cli(['projects', 'api-keys', '--project-ref', project, '--output', 'json']);
    const admin = keys.find((key) => key.name === 'service_role')?.api_key;
    const anon = keys.find((key) => key.name === 'anon')?.api_key;
    assert(typeof admin === 'string' && typeof anon === 'string');
    async function auth(path, key, body) {
        const response = await fetch(`${origin}/auth/v1/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
            headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.equal(response.status, 200, 'Isolated Auth operation failed; credential-bearing diagnostics suppressed');
        return response.json();
    }
    const existing = await auth('admin/users?page=1&per_page=100', admin);
    assert(
        Array.isArray(existing.users) && existing.users.length === 0,
        'Existing test accounts require deliberate reuse, never reset',
    );
    const scratch = mkdtempSync(join(tmpdir(), 'thalassa-e2ee-accounts-'));
    chmodSync(scratch, 0o700);
    const privatePath = join(scratch, 'account-credentials.local');
    const accounts = [];
    for (const email of emails) {
        const password = randomBytes(24).toString('hex');
        // Account identity supplied by Shane; confirmation bypass is test scaffolding,
        // NOT evidence that the email address/hardware ownership was verified.
        const created = await auth('admin/users', admin, { email, password, email_confirm: true });
        assert(/^[0-9a-f-]{36}$/.test(created.id) && created.email === email);
        accounts.push({ userId: created.id, email, password });
        writeFileSync(privatePath, JSON.stringify({ project, accounts }, null, 2) + '\n', { mode: 0o600 });
        const session = await auth('token?grant_type=password', anon, { email, password });
        const verified = await fetch(`${origin}/auth/v1/user`, {
            headers: { apikey: anon, authorization: `Bearer ${session.access_token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
        });
        assert.equal(verified.status, 200);
        assert.equal((await verified.json()).id, created.id);
    }
    const allowlistPath = join(scratch, 'participant-allowlist.local');
    writeFileSync(allowlistPath, `E2EE_PILOT_PARTICIPANTS=${accounts.map((account) => account.userId).join(',')}\n`, {
        mode: 0o600,
        flag: 'wx',
    });
    const installed = spawnSync(
        '/opt/homebrew/bin/supabase',
        [
            'secrets',
            'set',
            '--project-ref',
            project,
            '--workdir',
            here,
            '--env-file',
            allowlistPath,
            '--output',
            'json',
        ],
        { encoding: 'utf8', timeout: 30000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } },
    );
    assert(!installed.error && installed.status === 0, 'Participant allowlist update failed');
    console.log(
        JSON.stringify({
            project,
            participantUserIds: accounts.map((account) => account.userId),
            freshAuthVerified: true,
            fixtureCredentialsPath: privatePath,
            emailed: false,
            productionTouched: false,
        }),
    );
}
await main().catch(() => {
    console.error('FAIL isolated account setup; private diagnostics suppressed');
    process.exitCode = 1;
});

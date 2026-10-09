import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Four drift policies closed (20261009170000).
 *
 * On 2026-10-09 the live database carried four policies no migration ever
 * wrote: `channel_members_all`, `channel_join_requests_all` and `audit_log_all`
 * (FOR ALL TO public USING true WITH CHECK true) and guardian_alerts
 * "Authenticated users create alerts" (INSERT TO public WITH CHECK
 * auth.role() = 'authenticated'). Between them any signed-in account could
 * join any private crew chat, anyone with the public key could list and delete
 * every membership and read, forge and erase the admin audit log, and any
 * signed-in account could insert Guardian alerts under someone else's name.
 *
 * Nothing behavioural catches this regressing: with an open policy every app
 * path keeps working and only the boundary moves. So these checks are static.
 * They replay every migration's CREATE/DROP POLICY in filename order and pin
 * the resulting policy set, the grants, and the app paths the grants serve.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const LOCKDOWN = '20261009170000_drift_policy_lockdown.sql';
const TABLES = ['channel_members', 'channel_join_requests', 'admin_audit_log', 'guardian_alerts'] as const;
const DRIFT: Record<(typeof TABLES)[number], string> = {
    channel_members: 'channel_members_all',
    channel_join_requests: 'channel_join_requests_all',
    admin_audit_log: 'audit_log_all',
    guardian_alerts: 'Authenticated users create alerts',
};
const EXPECTED_POLICIES: Record<(typeof TABLES)[number], string[]> = {
    channel_members: ['channel_members_add', 'channel_members_read', 'channel_members_remove'],
    channel_join_requests: [
        'join_requests_create',
        'join_requests_delete',
        'join_requests_read',
        'join_requests_review',
    ],
    admin_audit_log: ['admin_audit_insert', 'admin_audit_read'],
    guardian_alerts: ['Users read related guardian alerts'],
};
/** Client code: everything that ships in the app, the edge functions, the workers and the Pi. */
const CLIENT_DIRS = [
    'services',
    'components',
    'hooks',
    'context',
    'utils',
    'pages',
    'src',
    'workers',
    'supabase/functions',
    'pi-cache/src',
];

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const sqlOf = (relative: string): string => read(relative).replace(/--.*$/gm, '');
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const lockdown = squash(sqlOf(`${MIGRATIONS_DIR}/${LOCKDOWN}`));

/** Policy name → its CREATE POLICY statement, for one table, after every migration in order. */
function finalPolicies(table: string): Map<string, string> {
    const policies = new Map<string, string>();
    const statement = new RegExp(
        String.raw`(create|drop)\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_ ]+?)"?\s+on\s+(?:public\.)?"?${table}"?\b[^;]*;`,
        'gi',
    );
    for (const file of migrationFiles) {
        const sql = sqlOf(`${MIGRATIONS_DIR}/${file}`);
        for (const match of sql.matchAll(statement)) {
            const [whole, verb, name] = match;
            if (verb.toLowerCase() === 'drop') policies.delete(name);
            else policies.set(name, squash(whole));
        }
    }
    return policies;
}

function expectNoOpenPolicy(table: string, policies: Map<string, string>): void {
    for (const [name, body] of policies) {
        expect(body, `${table}.${name} must not be FOR ALL`).not.toMatch(/\bfor all\b/);
        expect(body, `${table}.${name} must be scoped to authenticated`).toContain('to authenticated');
        expect(body, `${table}.${name} must not reach public/anon`).not.toMatch(/\bto (public|anon)\b/);
        expect(body, `${table}.${name} must not be USING (true)`).not.toMatch(/using \(\s*true\s*\)/);
        expect(body, `${table}.${name} must not be WITH CHECK (true)`).not.toMatch(/with check \(\s*true\s*\)/);
    }
}

function clientFiles(): string[] {
    const files: string[] = [];
    const walk = (relative: string): void => {
        const absolute = path.join(process.cwd(), relative);
        if (!fs.existsSync(absolute)) return;
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const child = `${relative}/${entry.name}`;
            if (entry.isDirectory()) walk(child);
            else if (/\.(ts|tsx|js|mjs|mts)$/.test(entry.name) && !/\.test\.|_test\./.test(entry.name))
                files.push(child);
        }
    };
    CLIENT_DIRS.forEach(walk);
    return files;
}

/** The newest migration's definition of a function: its header (before AS) and its body. */
function latestDefinition(fn: string): { header: string; body: string } {
    const create = new RegExp(String.raw`create (?:or replace )?function public\.${fn}\(`);
    for (const file of [...migrationFiles].reverse()) {
        if (file === LOCKDOWN) continue;
        const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
        const at = sql.search(create);
        if (at < 0) continue;
        const rest = sql.slice(at);
        // `AS $$` in hand-written files, `AS $function$` where pg_get_functiondef wrote it
        const open = rest.match(/ as (\$[a-z_]*\$)/) as RegExpMatchArray;
        const bodyStart = (open.index as number) + open[0].length;
        return { header: rest.slice(0, open.index), body: rest.slice(bodyStart, rest.indexOf(open[1], bodyStart)) };
    }
    throw new Error(`no migration defines public.${fn}`);
}

describe('drift policy lockdown (20261009170000)', () => {
    it('sorts after the policies it pins and after the last migration live when it was written', () => {
        // 20260723090000 and 20260730120000 wrote the scoped policies;
        // 20261009150000 was the newest migration applied to production when
        // this was drafted. A file that sorted earlier would be refused or
        // skipped by `db push`.
        expect(migrationFiles).toContain(LOCKDOWN);
        expect(migrationFiles).not.toContain('20261009170000_channel_members_lockdown.sql');
        expect(LOCKDOWN > '20260730120000').toBe(true);
        expect(LOCKDOWN > '20261009150000_vessel_quiet_watch.sql').toBe(true);
    });

    it('drops all four drift policies, and no migration ever creates them', () => {
        for (const table of TABLES) {
            expect(lockdown).toContain(`drop policy if exists "${DRIFT[table].toLowerCase()}" on public.${table};`);
        }
        for (const file of migrationFiles) {
            const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
            for (const table of TABLES) {
                expect(sql, file).not.toContain(`create policy "${DRIFT[table].toLowerCase()}"`);
                expect(sql, file).not.toContain(`create policy ${DRIFT[table].toLowerCase()} `);
            }
        }
    });

    it('leaves each of the four tables with exactly its scoped policies, none of them open', () => {
        for (const table of TABLES) {
            const policies = finalPolicies(table);
            expect([...policies.keys()].sort(), table).toEqual([...EXPECTED_POLICIES[table]].sort());
            expectNoOpenPolicy(table, policies);
        }
    });

    it('keeps the crew-chat membership policies owner- or moderator-only', () => {
        const policies = finalPolicies('channel_members');
        const readPolicy = policies.get('channel_members_read') as string;
        expect(readPolicy).toContain('for select');
        expect(readPolicy).toContain('public.can_access_chat_channel(channel_id, auth.uid())');

        // Only the channel's owner or a moderator adds a row. A self-join branch
        // (user_id = auth.uid()) here would reopen the hole: anyone could add
        // themselves to any private channel.
        const add = policies.get('channel_members_add') as string;
        expect(add).toContain('for insert');
        expect(add).toContain('c.id = channel_id and c.owner_id = auth.uid()');
        expect(add).toContain('public.is_chat_moderator(auth.uid())');
        expect(add).not.toMatch(/\buser_id = auth\.uid\(\)/);

        // Leaving (self), the owner removing someone, or a moderator.
        const remove = policies.get('channel_members_remove') as string;
        expect(remove).toContain('for delete');
        expect(remove).toContain('user_id = auth.uid()');
        expect(remove).toContain('c.owner_id = auth.uid()');
        expect(remove).toContain('public.is_chat_moderator(auth.uid())');

        // A join request is born pending and only by its own requester.
        const create = finalPolicies('channel_join_requests').get('join_requests_create') as string;
        expect(create).toContain("user_id = auth.uid() and status = 'pending'");
    });

    it('lets only a moderator write the audit log, as themselves, and only an admin read it', () => {
        const policies = finalPolicies('admin_audit_log');
        const insert = policies.get('admin_audit_insert') as string;
        expect(insert).toContain('for insert to authenticated');
        expect(insert).toContain('actor_id = auth.uid() and public.is_chat_moderator(auth.uid())');
        const readPolicy = policies.get('admin_audit_read') as string;
        expect(readPolicy).toContain('for select to authenticated');
        expect(readPolicy).toContain('public.is_chat_admin(auth.uid())');

        // The app's two paths: a plain insert stamped with the caller (no
        // .select(), so a moderator who is not an admin is never asked to read
        // the row back) and the admin panel's read.
        const service = codeOf('services/ChatService.ts');
        const at = service.indexOf(".from('admin_audit_log').insert(");
        expect(at).toBeGreaterThanOrEqual(0);
        const write = service.slice(at);
        expect(write.slice(0, 300)).toContain('actor_id: operation.userId');
        expect(write.slice(0, 300)).not.toContain('.select(');
        expect(service).toMatch(/\.from\('admin_audit_log'\)\s*\.select\('\*'\)/);
        const references = clientFiles().flatMap((file) =>
            [...codeOf(file).matchAll(/['"]admin_audit_log['"]/g)].map(() => file),
        );
        expect(references).toEqual(['services/ChatService.ts', 'services/ChatService.ts']);
    });

    it('leaves guardian_alerts readable by source or target and writable only through definer RPCs', () => {
        const readPolicy = finalPolicies('guardian_alerts').get('Users read related guardian alerts') as string;
        expect(readPolicy).toContain('for select to authenticated');
        expect(readPolicy).toContain('using (source_user_id = auth.uid() or target_user_id = auth.uid())');

        // No client code touches the table; it broadcasts and reads through RPCs.
        for (const file of clientFiles()) {
            expect(codeOf(file), file).not.toMatch(/\.from\(\s*['"]guardian_alerts['"]\s*\)/);
        }
        const guardian = codeOf('services/GuardianService.ts');
        expect(guardian).toContain(".rpc('broadcast_guardian_alert_with_receipt'");
        expect(guardian).toContain(".rpc('guardian_alerts_nearby'");

        // Every function that writes or reads the table runs as its owner, so
        // revoking client INSERT/UPDATE/DELETE costs them nothing.
        for (const fn of [
            'broadcast_guardian_alert_with_receipt',
            'broadcast_guardian_alert',
            'guardian_alerts_nearby',
            'queue_guardian_watchdog_alert',
            'scrub_account_deletion_survivors',
        ]) {
            expect(latestDefinition(fn).header, fn).toContain('security definer');
        }
        // builds 102-112 call the old name, which hands off to the receipt RPC
        expect(latestDefinition('broadcast_guardian_alert').body).toContain(
            'public.broadcast_guardian_alert_with_receipt(',
        );
    });

    it('takes every privilege from anon and PUBLIC, and from authenticated all it does not use', () => {
        for (const table of TABLES) {
            expect(lockdown).toContain(`revoke all on table public.${table} from public, anon;`);
        }
        expect(lockdown).toContain(
            'revoke truncate, references, trigger on table public.channel_members from authenticated;',
        );
        expect(lockdown).toContain(
            'revoke truncate, references, trigger on table public.channel_join_requests from authenticated;',
        );
        expect(lockdown).toContain(
            'revoke update, delete, truncate, references, trigger on table public.admin_audit_log from authenticated;',
        );
        expect(lockdown).toContain(
            'revoke insert, update, delete, truncate, references, trigger on table public.guardian_alerts from authenticated;',
        );
        expect(lockdown).toContain(
            'grant select, insert, update, delete on table public.channel_join_requests to authenticated;',
        );
        expect(lockdown).toContain('grant select, insert on table public.admin_audit_log to authenticated;');
        expect(lockdown).toContain('grant select on table public.guardian_alerts to authenticated;');
        // MAINTAIN exists from PostgreSQL 17, so it is revoked behind a version check.
        expect(lockdown).toMatch(
            /if current_setting\('server_version_num'\)::int >= 170000 then execute 'revoke maintain on table public\.channel_members, public\.channel_join_requests, ' \|\| 'public\.admin_audit_log, public\.guardian_alerts from authenticated';/,
        );
        // Nothing hands anon or PUBLIC a privilege on any of the four again.
        const grantToAnon = new RegExp(
            String.raw`grant [^;]* on (?:table )?(?:public\.)?(?:${TABLES.join('|')})\b[^;]* to [^;]*\b(?:anon|public)\b`,
        );
        for (const file of migrationFiles) {
            expect(squash(sqlOf(`${MIGRATIONS_DIR}/${file}`)), file).not.toMatch(grantToAnon);
        }
    });

    it('keeps UPDATE on channel_members for authenticated, which the join-request upsert needs', () => {
        // approveJoinRequest (builds 102-124) upserts with onConflict, i.e.
        // INSERT ... ON CONFLICT DO UPDATE, and Postgres requires the UPDATE
        // privilege for that statement even when nothing conflicts. Revoking it
        // would make every approval mark the request approved, add nobody, and
        // still return true (the client ignores the upsert's error). There is no
        // UPDATE policy, so no row can actually be updated.
        expect(lockdown).toContain(
            'grant select, insert, update, delete on table public.channel_members to authenticated;',
        );
        expect(lockdown).not.toMatch(
            /revoke [^;]*\bupdate\b[^;]* on table public\.channel_members from [^;]*authenticated/,
        );
        expect(finalPolicies('channel_members').has('channel_members_update')).toBe(false);
        expect(codeOf('services/ChatService.ts')).toContain(".from('channel_members').upsert(");
    });

    it('joins crew only through the SECURITY DEFINER RPC', () => {
        // Crew are not owners, so channel_members_add refuses their own insert.
        // The accepted-crew join has to stay on the RPC, which checks the
        // vessel_crew relationship itself.
        expect(codeOf('services/ChatService.ts')).toContain(".rpc('join_accepted_crew_channels'");
        const rpc = latestDefinition('join_accepted_crew_channels');
        expect(rpc.header).toContain('security definer set search_path = public');
        expect(rpc.body).toContain("raise exception 'accepted crew relationship required'");
        const hardening = squash(sqlOf(`${MIGRATIONS_DIR}/20260723090000_security_hardening_core.sql`));
        expect(hardening).toContain(
            'revoke all on function public.join_accepted_crew_channels(uuid) from public, anon;',
        );
    });

    it('does not touch chat_channels: the owner branch ships separately with build 125', () => {
        expect(lockdown).not.toContain('chat_channels_visible');
        expect(lockdown).not.toMatch(/(create|drop|alter) policy [^;]* on public\.chat_channels\b/);
        // and the header says where it went, and why it waits
        const header = read(`${MIGRATIONS_DIR}/${LOCKDOWN}`);
        expect(header).toContain('20261009171000');
        expect(header).toContain("build 125's Crew Chat fix");
    });

    it('fails the push unless the four tables are exactly as stated, and can be re-run', () => {
        // The self-check expects the same policy sets the migration history produces.
        const expected = lockdown.slice(lockdown.indexOf('expected_policies constant jsonb'));
        for (const table of TABLES) {
            const list = expected.match(new RegExp(String.raw`'${table}', jsonb_build_array\(([^)]*)\)`));
            expect(list, table).not.toBeNull();
            const names = [...(list as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
            expect(names.sort(), table).toEqual(EXPECTED_POLICIES[table].map((name) => name.toLowerCase()).sort());
        }
        expect(lockdown).toContain(
            "'admin_audit_log', jsonb_build_array('select', 'insert'), 'guardian_alerts', jsonb_build_array('select')",
        );
        expect(lockdown).toContain("raise exception 'drift lockdown: rls is off on %'");
        expect(lockdown).toContain("raise exception 'drift lockdown: % has policies %, expected %'");
        expect(lockdown).toContain("raise exception 'drift lockdown: authenticated must keep % on %'");
        expect(lockdown).toContain("raise exception 'drift lockdown: % still holds % on %'");
        expect(lockdown).toContain("raise exception 'drift lockdown: open policies remain: %'");
        expect(lockdown).toContain("foreach grantee in array array['anon', 'public', 'authenticated'] loop");
        expect(lockdown).toContain('has_any_column_privilege(grantee, relation, privilege)');
        // Every CREATE POLICY is preceded by its own DROP POLICY IF EXISTS.
        for (const match of lockdown.matchAll(/create policy "([^"]+)" on (public\.[a-z_]+)/g)) {
            expect(lockdown).toContain(`drop policy if exists "${match[1]}" on ${match[2]};`);
        }
        // No BEGIN/COMMIT, so the pre-push replay can run the file inside a
        // rolled-back transaction; no SET LOCAL, which is a no-op outside one.
        expect(lockdown).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(lockdown).not.toContain('set local');
        expect(lockdown).toContain("set lock_timeout = '5s';");
        expect(lockdown).toContain('reset lock_timeout;');
    });
});

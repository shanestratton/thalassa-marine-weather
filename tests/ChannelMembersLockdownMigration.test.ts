import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Crew chats are members-only (20261009170000).
 *
 * On 2026-10-09 the live database carried `channel_members_all` (FOR ALL TO
 * public USING true WITH CHECK true), a policy no migration ever wrote. It let
 * any signed-in account add itself to any private crew chat and read and post
 * there, and let anyone with the public key list and delete every membership.
 * `channel_join_requests_all` was the same policy on the join requests.
 *
 * Nothing behavioural catches this regressing: with an open policy every app
 * path keeps working and only the boundary moves. So these checks are static.
 * They replay every migration's CREATE/DROP POLICY in filename order and pin
 * the resulting policy set, plus the grants.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const LOCKDOWN = '20261009170000_channel_members_lockdown.sql';

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

describe('channel_members lockdown (20261009170000)', () => {
    it('sorts after the policies it pins and after the last migration live when it was written', () => {
        // 20260723090000 wrote the scoped policies; 20261009150000 was the
        // newest migration applied to production when this was drafted. A file
        // that sorted earlier would be refused or skipped by `db push`.
        expect(migrationFiles).toContain(LOCKDOWN);
        expect(LOCKDOWN > '20260723090000').toBe(true);
        expect(LOCKDOWN > '20261009150000_vessel_quiet_watch.sql').toBe(true);
    });

    it('drops both drift policies, and no migration ever recreates them', () => {
        expect(lockdown).toContain('drop policy if exists "channel_members_all" on public.channel_members;');
        expect(lockdown).toContain(
            'drop policy if exists "channel_join_requests_all" on public.channel_join_requests;',
        );
        for (const file of migrationFiles) {
            const sql = squash(sqlOf(`${MIGRATIONS_DIR}/${file}`));
            expect(sql, file).not.toMatch(/create policy "?channel_members_all"?/);
            expect(sql, file).not.toMatch(/create policy "?channel_join_requests_all"?/);
        }
    });

    it('leaves channel_members with exactly the three scoped policies', () => {
        const policies = finalPolicies('channel_members');
        expect([...policies.keys()].sort()).toEqual([
            'channel_members_add',
            'channel_members_read',
            'channel_members_remove',
        ]);
        expectNoOpenPolicy('channel_members', policies);

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
    });

    it('leaves channel_join_requests with exactly its four scoped policies', () => {
        const policies = finalPolicies('channel_join_requests');
        expect([...policies.keys()].sort()).toEqual([
            'join_requests_create',
            'join_requests_delete',
            'join_requests_read',
            'join_requests_review',
        ]);
        expectNoOpenPolicy('channel_join_requests', policies);
        // A request is born pending and only by its own requester.
        const create = policies.get('join_requests_create') as string;
        expect(create).toContain("user_id = auth.uid() and status = 'pending'");
    });

    it('takes every privilege from anon and the dangerous ones from authenticated', () => {
        for (const table of ['channel_members', 'channel_join_requests']) {
            expect(lockdown).toContain(`revoke all on table public.${table} from public, anon;`);
            expect(lockdown).toContain(
                `revoke truncate, references, trigger on table public.${table} from authenticated;`,
            );
        }
        // Nothing hands anon a privilege on either table again.
        const grantToAnon =
            /grant [^;]* on (?:table )?(?:public\.)?(?:channel_members|channel_join_requests)\b[^;]* to [^;]*\b(?:anon|public)\b/;
        for (const file of migrationFiles) {
            expect(squash(sqlOf(`${MIGRATIONS_DIR}/${file}`)), file).not.toMatch(grantToAnon);
        }
    });

    it('keeps UPDATE for authenticated, which the join-request upsert needs', () => {
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
        const service = codeOf('services/ChatService.ts');
        expect(service).toContain(".from('channel_members').upsert(");
    });

    it('lets an owner see the active channel they just created (createVoyageChannel)', () => {
        // createVoyageChannel inserts with .select(); Postgres checks the SELECT
        // policy against the new row, and can_access_chat_channel() looks that
        // row up by id and cannot see it yet. Without the owner branch every
        // skipper who is not a moderator got 42501 and no Crew Chat existed.
        const visible = finalPolicies('chat_channels').get('chat_channels_visible') as string;
        expect(visible).toContain('for select to authenticated');
        expect(visible).toContain("(status = 'active' and public.can_access_chat_channel(id, auth.uid()))");
        expect(visible).toContain("(status = 'active' and owner_id = auth.uid())");
        expect(visible).toContain('proposed_by = auth.uid()');
        expect(visible).toContain('public.is_chat_moderator(auth.uid())');
        // Only that one branch is new: the owner branch is limited to active rows.
        expect(visible).not.toMatch(/or owner_id = auth\.uid\(\)/);
        const service = codeOf('services/ChatService.ts');
        const create = service.slice(service.indexOf('async createVoyageChannel('));
        expect(create.slice(0, 3000)).toMatch(
            /\.insert\(\{[\s\S]*?owner_id: operation\.userId[\s\S]*?\}\)\s*\.select\(\)/,
        );
    });

    it('joins crew only through the SECURITY DEFINER RPC', () => {
        // Crew are not owners, so channel_members_add refuses their own insert.
        // The accepted-crew join has to stay on the RPC, which checks the
        // vessel_crew relationship itself.
        const service = codeOf('services/ChatService.ts');
        expect(service).toContain(".rpc('join_accepted_crew_channels'");
        const hardening = squash(sqlOf(`${MIGRATIONS_DIR}/20260723090000_security_hardening_core.sql`));
        const rpc = hardening.slice(hardening.indexOf('create or replace function public.join_accepted_crew_channels'));
        expect(rpc.slice(0, 400)).toContain('security definer set search_path = public');
        expect(rpc).toContain("raise exception 'accepted crew relationship required'");
        expect(hardening).toContain(
            'revoke all on function public.join_accepted_crew_channels(uuid) from public, anon;',
        );
    });

    it('fails the push if anything open is left, and can be re-run', () => {
        expect(lockdown).toContain("raise exception 'channel lockdown: open policies remain: %'");
        expect(lockdown).toContain("raise exception 'channel lockdown: anon still holds % on a membership table'");
        expect(lockdown).toContain(
            "raise exception 'channel lockdown: authenticated must keep update on channel_members'",
        );
        // Every CREATE POLICY is preceded by its own DROP POLICY IF EXISTS.
        for (const match of lockdown.matchAll(/create policy "([a-z_]+)" on (public\.[a-z_]+)/g)) {
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

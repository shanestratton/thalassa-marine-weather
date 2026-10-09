import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A skipper sees the Crew Chat they just created (20261009171000).
 *
 * createVoyageChannel inserts with .select(); Postgres checks the SELECT policy
 * against the new row, and can_access_chat_channel() looks that row up by id
 * and cannot see it yet. Without an owner branch every skipper who is not a
 * chat moderator got 42501 and no Crew Chat existed.
 *
 * The file must ship with build 125's Crew Chat fix (one room per skipper,
 * found by owner): builds 102-124 look the room up by name, and that lookup
 * breaks on commas and parentheses, so with this live they would make a
 * duplicate room per tap. These checks pin the policy and that warning.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const OWNER_VISIBLE = '20261009171000_crew_channel_owner_visible.sql';
const LOCKDOWN = '20261009170000_drift_policy_lockdown.sql';

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

const header = read(`${MIGRATIONS_DIR}/${OWNER_VISIBLE}`);
const ownerVisible = squash(sqlOf(`${MIGRATIONS_DIR}/${OWNER_VISIBLE}`));

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

describe('crew channel owner visible (20261009171000)', () => {
    it('sorts after the drift lockdown it depends on', () => {
        expect(migrationFiles).toContain(OWNER_VISIBLE);
        expect(migrationFiles).toContain(LOCKDOWN);
        expect(OWNER_VISIBLE > LOCKDOWN).toBe(true);
    });

    it('says in its header that it ships with build 125, and why', () => {
        expect(header).toContain("SHIPS TOGETHER WITH BUILD 125's CREW CHAT FIX");
        expect(header).toContain('found\n-- by owner, not by name');
        expect(header).toContain('duplicate room per tap');
        expect(header).toContain('a voyage name with a comma or a\n-- parenthesis breaks it');
        expect(header).toContain('rename this file to a fresh timestamp');
    });

    it('lets an owner see the active channel they just created, and changes nothing else', () => {
        const policies = finalPolicies('chat_channels');
        expect([...policies.keys()].sort()).toEqual([
            'chat_channels_create',
            'chat_channels_delete',
            'chat_channels_manage',
            'chat_channels_visible',
        ]);
        const visible = policies.get('chat_channels_visible') as string;
        expect(visible).toContain('for select to authenticated');
        expect(visible).toContain("(status = 'active' and public.can_access_chat_channel(id, auth.uid()))");
        expect(visible).toContain("(status = 'active' and owner_id = auth.uid())");
        expect(visible).toContain('proposed_by = auth.uid()');
        expect(visible).toContain('public.is_chat_moderator(auth.uid())');
        // Only that one branch is new: the owner branch is limited to active rows.
        expect(visible).not.toMatch(/or owner_id = auth\.uid\(\)/);
        expect(visible).not.toMatch(/using \(\s*true\s*\)/);
        // This file touches chat_channels_visible and nothing else.
        expect([...ownerVisible.matchAll(/create policy "([^"]+)" on ([a-z_.]+)/g)].map((m) => m.slice(1))).toEqual([
            ['chat_channels_visible', 'public.chat_channels'],
        ]);
        expect(ownerVisible).not.toMatch(/\b(grant|revoke)\b/);
    });

    it('is the path createVoyageChannel needs: insert(...).select() by the owner', () => {
        const service = codeOf('services/ChatService.ts');
        const create = service.slice(service.indexOf('async createVoyageChannel('));
        expect(create.slice(0, 3000)).toMatch(
            /\.insert\(\{[\s\S]*?owner_id: operation\.userId[\s\S]*?\}\)\s*\.select\(\)/,
        );
    });

    it('fails the push unless the policy set is exact, and can be re-run', () => {
        expect(ownerVisible).toContain(
            `'["chat_channels_create", "chat_channels_delete", "chat_channels_manage", "chat_channels_visible"]'::jsonb`,
        );
        expect(ownerVisible).toContain(
            "raise exception 'crew channel owner visible: owner branch missing from chat_channels_visible'",
        );
        expect(ownerVisible).toContain(
            "raise exception 'crew channel owner visible: open policies on chat_channels: %'",
        );
        expect(ownerVisible).toContain('drop policy if exists "chat_channels_visible" on public.chat_channels;');
        expect(ownerVisible).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(ownerVisible).not.toContain('set local');
        expect(ownerVisible).toContain("set lock_timeout = '5s';");
        expect(ownerVisible).toContain('reset lock_timeout;');
    });
});

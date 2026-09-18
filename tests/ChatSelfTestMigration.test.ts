import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260911141000_chat_self_test.sql', 'utf8');
const functionBodies = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([^]*?\$\$;/g)].map(
    (match) => match[0],
);
const status = functionBodies.find((body) => body.includes('get_chat_dm_block_status('))!;
const mutation = functionBodies.find((body) => body.includes('set_chat_user_block('))!;
const policy = sql.slice(
    sql.indexOf('CREATE POLICY chat_direct_messages_self_test'),
    sql.indexOf('-- No data cleanup'),
);

describe('chat self-test migration security contract', () => {
    it('adds exactly one authenticated INSERT permission without replacing existing policies or visibility', () => {
        expect(sql.match(/CREATE POLICY /g)).toHaveLength(1);
        expect(policy).toContain('ON public.chat_direct_messages FOR INSERT TO authenticated');
        expect(sql).not.toMatch(/DROP POLICY|ALTER POLICY|FOR SELECT|DISABLE ROW LEVEL SECURITY|GRANT SELECT/);
        expect(sql).toMatch(/BEGIN;/);
        expect(sql).toMatch(/COMMIT;/);
    });

    it('limits the new permission to the authenticated sender and recipient being exactly the same user', () => {
        expect(policy).toContain('sender_id = (SELECT auth.uid())');
        expect(policy).toContain('AND recipient_id = (SELECT auth.uid())');
        expect(policy).not.toMatch(/\bOR\b(?! chat_role\.muted_until)/);
    });

    it('independently preserves payload limits, moderation, and fail-closed block status', () => {
        expect(policy).toContain('AND char_length(message) BETWEEN 1 AND 4000');
        expect(policy).toContain('AND char_length(sender_name) BETWEEN 1 AND 120');
        expect(policy).toContain(
            "AND NOT COALESCE((public.get_chat_dm_block_status(recipient_id)->>'blockedEitherDirection')::BOOLEAN, TRUE)",
        );
        expect(policy).toContain('AND NOT EXISTS (');
        expect(policy).toContain('WHERE chat_role.user_id = (SELECT auth.uid())');
        expect(policy).toContain('COALESCE(chat_role.is_blocked, false) OR chat_role.muted_until > now()');
    });

    it('requires authenticated non-null caller identity for both fixed-path definer RPCs', () => {
        expect(functionBodies).toHaveLength(2);
        for (const body of functionBodies) {
            expect(body).toContain('owner_id UUID := auth.uid();');
            expect(body).toContain("IF auth.role() IS DISTINCT FROM 'authenticated' OR owner_id IS NULL THEN");
            expect(body).toContain("RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';");
            expect(body).toContain('SECURITY DEFINER\nSET search_path = pg_catalog, public');
            expect(body).not.toMatch(/EXECUTE\s/);
        }
    });

    it('allows a self target while still rejecting missing targets and block decisions', () => {
        expect(status).toContain('IF p_other_user_id IS NULL THEN');
        expect(mutation).toContain('IF p_other_user_id IS NULL OR p_blocked IS NULL THEN');
        expect(status).not.toContain('p_other_user_id = owner_id');
        expect(mutation).not.toContain('p_other_user_id = owner_id');
    });

    it('returns only caller-relative booleans while checking both directions in both block stores', () => {
        expect(status).toContain('blocker_id = owner_id AND blocked_id = p_other_user_id');
        expect(status).toContain('blocker_id = p_other_user_id AND blocked_id = owner_id');
        expect(status).toContain('blocker_id = owner_id::TEXT AND blocked_id = p_other_user_id::TEXT');
        expect(status).toContain('blocker_id = p_other_user_id::TEXT AND blocked_id = owner_id::TEXT');
        expect(status).toMatch(
            /RETURN jsonb_build_object\('blockedByMe', own_block,\s*'blockedEitherDirection', own_block OR reverse_block\);/,
        );
        expect(status).not.toMatch(/SELECT \*/);
    });

    it('writes self blocks only to private DMs and preserves idempotent peer mirroring', () => {
        expect(mutation).toContain('INSERT INTO public.dm_blocks (blocker_id, blocked_id)');
        expect(mutation).toMatch(
            /IF p_other_user_id <> owner_id THEN\s*INSERT INTO public.sailor_blocks \(blocker_id, blocked_id\)\s*VALUES \(owner_id::TEXT, p_other_user_id::TEXT\) ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING;\s*END IF;/,
        );
        expect(mutation.match(/ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING/g)).toHaveLength(2);
        expect(mutation).toContain('pg_advisory_xact_lock(hashtextextended(');
        expect(mutation).toContain('LEAST(owner_id::TEXT, p_other_user_id::TEXT)');
        expect(mutation).toContain('GREATEST(owner_id::TEXT, p_other_user_id::TEXT)');
    });

    it('can unblock only the caller-owned direction of either store', () => {
        expect(mutation).toContain(
            'DELETE FROM public.dm_blocks WHERE blocker_id = owner_id AND blocked_id = p_other_user_id;',
        );
        expect(mutation).toMatch(
            /DELETE FROM public.sailor_blocks\s*WHERE blocker_id = owner_id::TEXT AND blocked_id = p_other_user_id::TEXT;/,
        );
        expect(mutation).toContain('RETURN public.get_chat_dm_block_status(p_other_user_id);');
        expect(sql).not.toMatch(/UPDATE public\.|TRUNCATE |DELETE FROM auth\./);
    });

    it('grants authenticated RPC execution but neither anonymous access nor new table privileges', () => {
        for (const signature of ['get_chat_dm_block_status(UUID)', 'set_chat_user_block(UUID, BOOLEAN)']) {
            expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
            expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated;`);
        }
        expect(sql.match(/^GRANT /gm)).toHaveLength(2);
        expect(sql).not.toMatch(/GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE)/);
    });
});

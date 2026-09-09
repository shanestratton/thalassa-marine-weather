import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260910090000_chat_bilateral_block_enforcement.sql', 'utf8');
describe('chat bilateral block enforcement migration', () => {
    it('adds a restrictive gate without replacing payload, consent, or existing visibility policies', () => {
        expect(sql).toMatch(/AS RESTRICTIVE FOR INSERT TO authenticated/);
        expect(sql).toMatch(/sender_id = \(SELECT auth.uid\(\)\)/);
        expect(sql).toMatch(/NOT COALESCE\(\(public.get_chat_dm_block_status\(recipient_id\)/);
        expect(sql).not.toMatch(/DROP POLICY[^;]+Users can send unblocked DMs/);
        expect(sql).not.toMatch(/FOR SELECT|DISABLE ROW LEVEL SECURITY/);
    });
    it('reads both directions of both private block stores under a fixed definer path', () => {
        expect(sql).toContain('SECURITY DEFINER');
        expect(sql).toContain('SET search_path = pg_catalog, public');
        expect(sql).toContain('blocker_id = owner_id AND blocked_id = p_other_user_id');
        expect(sql).toContain('blocker_id = p_other_user_id AND blocked_id = owner_id');
        expect(sql).toContain('blocker_id = owner_id::TEXT AND blocked_id = p_other_user_id::TEXT');
        expect(sql).toContain('blocker_id = p_other_user_id::TEXT AND blocked_id = owner_id::TEXT');
        expect(sql).toContain("auth.role() IS DISTINCT FROM 'authenticated'");
    });
    it('authorizes only caller-scoped idempotent mutation, never an arbitrary blocker', () => {
        expect(sql).toMatch(/set_chat_user_block\(p_other_user_id UUID, p_blocked BOOLEAN\)/);
        expect(sql.match(/ON CONFLICT \(blocker_id, blocked_id\) DO NOTHING/g)).toHaveLength(2);
        expect(sql).toContain('DELETE FROM public.dm_blocks WHERE blocker_id = owner_id');
        expect(sql).toMatch(/DELETE FROM public.sailor_blocks\s+WHERE blocker_id = owner_id::TEXT/);
        expect(sql).toContain('pg_advisory_xact_lock');
        expect(sql).not.toMatch(/UPDATE public\.|GRANT (?:ALL|SELECT).*authenticated/);
    });
    it('revokes public/anonymous RPC access without exposing block rows', () => {
        for (const signature of ['get_chat_dm_block_status(UUID)', 'set_chat_user_block(UUID, BOOLEAN)']) {
            expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
            expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated;`);
        }
        expect(sql).not.toContain('GRANT SELECT');
    });
    it('keeps legacy direct unblocks owner-scoped and compatible without historical cleanup', () => {
        expect(sql).toContain('AFTER DELETE ON public.dm_blocks');
        expect(sql).toContain('AFTER DELETE ON public.sailor_blocks');
        expect(sql).toContain('OLD.blocker_id::TEXT <> auth.uid()::TEXT');
        expect(sql).toContain('blocker_id = OLD.blocker_id::TEXT AND blocked_id = OLD.blocked_id::TEXT');
        expect(sql).toContain('blocker_id::TEXT = OLD.blocker_id AND blocked_id::TEXT = OLD.blocked_id');
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.sync_chat_block_delete() FROM PUBLIC, anon, authenticated',
        );
    });
});

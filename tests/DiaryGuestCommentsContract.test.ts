import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateGuestComment, validCommentTarget } from '../supabase/functions/diary-comments/validation';
import { allowedDiaryCommentOrigin } from '../supabase/functions/diary-comments/origins';

const ENTRY = '00000000-0000-4000-8000-000000000001';
const base = {
    handle: 'serene-summer',
    entry_id: ENTRY,
    submission_id: '00000000-0000-4000-8000-000000000002',
    guest_name: 'Marta',
    body: 'Lovely anchorage!',
    website: '',
};
const sql = readFileSync('supabase/migrations/20260920120000_moderated_diary_guest_comments.sql', 'utf8');
const edge = readFileSync('supabase/functions/diary-comments/index.ts', 'utf8');
describe('guest comments production boat origins', () => {
    it.each([
        'https://serene-summer.thalassawx.app',
        'https://serene-summer.thalassawx.com',
        'https://www.thalassawx.app',
        'https://thalassawx.app',
        'http://127.0.0.1:4173',
    ])('allows the public page at %s', (origin) => expect(allowedDiaryCommentOrigin(origin)).toBe(true));
    it.each([
        'https://serene-summer.thalassawx.app.attacker.com',
        'https://attacker.com/serene-summer.thalassawx.app',
        'https://serene-summer.thalassawx.app@attacker.com',
        'https://attacker.com@serene-summer.thalassawx.app',
        'https://nested.serene-summer.thalassawx.app',
        'http://serene-summer.thalassawx.app',
        'https://serene-summer.thalassawx.app:444',
        'https://serene-summer.thalassawx.app/',
        'https://bad_handle.thalassawx.app',
        'null',
    ])('rejects untrusted/non-origin value %s', (origin) => expect(allowedDiaryCommentOrigin(origin)).toBe(false));
});
describe('guest comment validation', () => {
    it('accepts bounded plain text and line breaks without collecting an email', () => {
        expect(validateGuestComment({ ...base, body: '  Hello\r\ncrew!  ' })).toMatchObject({
            body: 'Hello\ncrew!',
            guestName: 'Marta',
            honeypot: false,
        });
        expect(validateGuestComment({ ...base, body: '🌊'.repeat(2000) })).not.toBeNull();
    });
    it.each([
        'https://example.com',
        'www.example.com',
        '<img src=x>',
        'javascript:alert(1)',
        'data:text/html,test',
        '\u0000secret',
    ])('rejects unsafe payload %s', (body) => {
        expect(validateGuestComment({ ...base, body })).toBeNull();
    });
    it('rejects overlong text, invalid ids, multiline names, and malformed targets', () => {
        expect(validateGuestComment({ ...base, body: 'x'.repeat(2001) })).toBeNull();
        expect(validateGuestComment({ ...base, guest_name: 'x'.repeat(61) })).toBeNull();
        expect(validateGuestComment({ ...base, guest_name: 'John\nSmith' })).toBeNull();
        expect(validateGuestComment({ ...base, submission_id: 'injected' })).toBeNull();
        expect(validCommentTarget('../admin', ENTRY)).toBe(false);
        expect(validCommentTarget('serene-summer', 'not-a-uuid')).toBe(false);
    });
    it('marks honeypots without needing to retain their payload', () => {
        expect(validateGuestComment({ ...base, website: 'bot-filled' })?.honeypot).toBe(true);
        expect(edge.indexOf('if (input.honeypot)')).toBeLessThan(
            edge.indexOf("admin.rpc('submit_diary_guest_comment'"),
        );
    });
});
describe('moderated guest comment database contract', () => {
    it('cascades diary/log deletion and gives guests no direct table or function access', () => {
        expect(sql).toContain('REFERENCES public.diary_entries(id) ON DELETE CASCADE');
        expect(sql).toContain('REFERENCES public.voyage_log_configs(id) ON DELETE CASCADE');
        expect(sql).toContain('ALTER TABLE public.diary_guest_comments ENABLE ROW LEVEL SECURITY');
        expect(sql).toContain('REVOKE ALL ON TABLE public.diary_guest_comments FROM PUBLIC, anon, authenticated');
        expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.submit_diary_guest_comment(TEXT, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated',
        );
    });
    it('rechecks publication, log enablement, boat match and combined crew authority', () => {
        expect(sql).toContain('config.enabled IS TRUE AND entry.is_public IS TRUE');
        expect(sql).toContain('(config.boat_id IS NULL OR entry.boat_id = config.boat_id)');
        expect(sql).toContain('entry.user_id = config.owner_id');
        expect(sql).toContain("config.scope = 'combined'");
        expect(sql).toContain('member.boat_id = config.boat_id AND member.user_id = entry.user_id');
        expect(
            sql.match(/public\.public_diary_comment_config\(p_handle, p_entry_id\)/g)?.length,
        ).toBeGreaterThanOrEqual(3);
        expect(edge).toContain("'Cache-Control': 'no-store'");
    });
    it('never publishes pending/rejected comments or stale approvals after owner transfer', () => {
        expect(sql).toContain("comment.entry_id = p_entry_id AND comment.status = 'approved'");
        expect(sql).toContain('comment.reviewed_by = (SELECT config.owner_id');
        expect(sql).toContain(
            "VALUES (p_entry_id, config_id, p_submission_id, btrim(p_guest_name), btrim(p_body), 'pending')",
        );
        expect(sql).toContain('config.owner_id = auth.uid()');
        expect(sql).toContain('reviewed_at = now(), reviewed_by = auth.uid()');
    });
    it('serializes inventory limits and binds retry IDs to unchanged content', () => {
        expect(sql).toContain('UNIQUE (log_config_id, entry_id, submission_id)');
        expect(sql).toContain('pg_catalog.pg_advisory_xact_lock');
        expect(sql).toContain('existing.guest_name <> btrim(p_guest_name) OR existing.body <> btrim(p_body)');
        expect(sql).toContain("comment.status = 'pending') >= 100");
        expect(sql).toContain("interval '24 hours') >= 200");
        expect(edge).toMatch(/post \? 5 : 180,\s*post \? 5 : 120,\s*3600,\s*true/);
        expect(edge).toContain('readJsonObject(req, 16_384)');
    });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260909110000_diary_deletion_media_cleanup.sql', 'utf8');
const edge = readFileSync('supabase/functions/diary-relay/index.ts', 'utf8');

function body(name: string): string {
    return sql.split(`CREATE OR REPLACE FUNCTION public.${name}(`)[1].split('$$;')[0];
}

describe('diary cancellation retains and drains its media manifest', () => {
    it('captures all three media kinds before deletion under the existing owner-operation lock', () => {
        const cancel = body('diary_relay_cancel_entry');
        expect(cancel).toContain("'diary-relay:' || p_owner_id::TEXT || ':' || p_client_operation_id");
        expect(cancel.indexOf('pg_advisory_xact_lock')).toBeLessThan(cancel.indexOf('INTO captured'));
        expect(cancel.indexOf('INTO captured')).toBeLessThan(
            cancel.indexOf('INSERT INTO public.diary_relay_tombstones'),
        );
        expect(cancel.indexOf('RETURNING media_cleanup_refs INTO pending')).toBeLessThan(
            cancel.indexOf('DELETE FROM public.diary_entries'),
        );
        for (const bucket of ['diary-photos', 'diary-audio', 'diary-video']) expect(cancel).toContain(`'${bucket}'`);
        expect(cancel).toContain('entry.user_id = p_owner_id');
        expect(cancel).toContain('entry.client_operation_id = p_client_operation_id');
    });

    it('retries merge pending paths instead of discarding them when the original row no longer exists', () => {
        expect(sql).toContain("ADD COLUMN IF NOT EXISTS media_cleanup_refs JSONB NOT NULL DEFAULT '[]'::jsonb");
        expect(body('diary_relay_cancel_entry')).toContain(
            'tombstone.media_cleanup_refs || EXCLUDED.media_cleanup_refs',
        );
        expect(body('diary_relay_cancel_entry')).toContain("'media_cleanup_refs', pending");
    });

    it('shared media checks cover owned surviving rows and normalize canonical and URL references', () => {
        const shared = body('diary_relay_media_is_referenced');
        expect(shared).toContain('entry.user_id = p_owner_id');
        expect(shared).toContain('public.diary_relay_media_reference_path(p_bucket, media.reference) = p_path');
        expect(body('diary_relay_media_reference_path')).toContain('public|sign|authenticated');
        expect(body('diary_relay_media_reference_path')).toContain(
            "decode(substr(candidate, cursor_at + 1, 2), 'hex')",
        );
    });

    it('acknowledges one exact owner-scoped manifest reference only after actual Storage absence', () => {
        const ack = body('diary_relay_ack_media_cleanup');
        expect(ack).toContain("left(p_path, length(p_owner_id::TEXT) + 1) <> p_owner_id::TEXT || '/'");
        expect(ack).toContain("FROM storage.objects WHERE bucket_id = p_reference ->> 'bucket' AND name = p_path");
        expect(ack.indexOf('FROM storage.objects')).toBeLessThan(ack.indexOf('UPDATE public.diary_relay_tombstones'));
        expect(ack).toContain('WHERE item IS DISTINCT FROM p_reference');
        expect(ack).toContain('WHERE owner_id = p_owner_id AND client_operation_id = p_client_operation_id');
        expect(sql).not.toMatch(/DELETE\s+FROM\s+storage\.objects/i);
    });

    it('keeps every helper service-only and returns a retryable failure before cancellation success', () => {
        for (const fn of [
            'diary_relay_cancel_entry',
            'diary_relay_media_reference_path',
            'diary_relay_media_is_referenced',
            'diary_relay_ack_media_cleanup',
        ]) {
            expect(sql).toMatch(
                new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^;]+FROM PUBLIC, anon, authenticated;`),
            );
            expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^;]+TO service_role;`));
        }
        const handler = edge.split('async function persistCancellation(')[1].split('async function cancelDiary(')[0];
        expect(handler).toContain('await cleanupCancelledDiaryMedia(');
        expect(handler).toContain('admin.storage.from(bucket).remove([path])');
        expect(handler).toContain("return json({ error: 'Diary media cleanup is pending; retry cancellation' }, 503)");
        expect(handler.indexOf('await cleanupCancelledDiaryMedia(')).toBeLessThan(
            handler.indexOf('return json({ ok: true'),
        );
    });
});

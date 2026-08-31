// @vitest-environment node
/**
 * The measuring half of the media quota (2026-09-01): 5 GB of video per
 * PAYING punter once the paywall exists; photos free and limited. Usage is
 * computed from storage's own catalog — no ledger table to drift — and
 * enforcement stays OFF until the paywall ships (never block a beta skipper
 * mid-passage).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260901100000_diary_media_usage.sql'),
    'utf8',
);
const service = readFileSync(resolve(process.cwd(), 'services/DiaryService.ts'), 'utf8');
const tab = readFileSync(resolve(process.cwd(), 'components/settings/VoyageLogTab.tsx'), 'utf8');

describe('diary media usage RPC', () => {
    it('is definer-safe and owner-scoped by the path prefix', () => {
        expect(migration).toContain('security definer');
        expect(migration).toContain("set search_path = ''");
        // The name prefix is the ownership truth — the owner column is not
        // (relay uploads arrive via service-minted signed URLs).
        expect(migration).toContain("o.name like auth.uid()::text || '/%'");
        for (const bucket of ['diary-photos', 'diary-audio', 'diary-video']) {
            expect(migration).toContain(`'${bucket}'`);
        }
    });

    it('keeps its permission tail intact — anon revoked, authenticated granted', () => {
        // A migration once shipped with its REVOKE tail truncated by a
        // line-range slice; never again.
        expect(migration).toContain('revoke all on function public.diary_media_usage() from public;');
        expect(migration).toContain('revoke all on function public.diary_media_usage() from anon;');
        expect(migration).toContain('grant execute on function public.diary_media_usage() to authenticated;');
    });

    it('the app reads it through the identity-scoped service and shows it in Settings', () => {
        expect(service).toContain("supabase.rpc('diary_media_usage')");
        const fn = service.slice(service.indexOf('async getMediaUsage'), service.indexOf('async getMediaUsage') + 900);
        expect(fn).toContain('isAuthIdentityScopeCurrent(scope)');
        expect(tab).toContain('<CloudStorageSection />');
        expect(tab).toContain('Section title="Cloud storage"');
        // Readout only — no enforcement anywhere until the paywall exists.
        expect(service).not.toContain('QUOTA');
    });
});

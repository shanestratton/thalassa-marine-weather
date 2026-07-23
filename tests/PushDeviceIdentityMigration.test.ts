import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260723104500_push_device_identity.sql'),
    'utf8',
);

describe('push device identity migration', () => {
    it('enforces one account owner per physical device token', () => {
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX IF NOT EXISTS push_device_tokens_one_owner_per_device[\s\S]*device_token/,
        );
        expect(migration).toMatch(/pg_advisory_xact_lock[\s\S]*hashtextextended\(p_device_token/);
    });

    it('claims only the exact bearer token for the authenticated expected owner', () => {
        expect(migration).toMatch(/caller_id <> p_expected_user_id/);
        expect(migration).toMatch(/DELETE FROM public\.push_device_tokens\s+WHERE device_token = p_device_token/);
        expect(migration).toMatch(
            /INSERT INTO public\.push_device_tokens[\s\S]*VALUES \(\s*caller_id,\s*p_device_token/,
        );
        expect(migration).not.toMatch(/DELETE FROM public\.push_device_tokens\s*;/);
    });

    it('keeps every SECURITY DEFINER API off public and anon roles', () => {
        for (const signature of [
            'claim_push_device_token\\(UUID, TEXT, TEXT\\)',
            'release_push_device_token\\(UUID, TEXT\\)',
            'clear_push_badge_for_identity\\(UUID\\)',
        ]) {
            expect(migration).toMatch(
                new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature}[\\s\\S]*?FROM PUBLIC, anon, authenticated`),
            );
            expect(migration).toMatch(
                new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}[\\s\\S]*?TO authenticated`),
            );
        }
    });
});

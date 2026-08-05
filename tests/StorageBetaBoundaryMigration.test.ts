import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260804195000_verify_storage_beta_boundaries.sql'),
    'utf8',
);

describe('public-beta Storage policy verification migration', () => {
    it('fails deployment on unbounded writes, a malformed vault boundary, or a legacy Crew path', () => {
        expect(migration).toContain("cmd = 'INSERT' AND with_check IS NULL");
        expect(migration).toContain("cmd IN ('UPDATE', 'DELETE', 'ALL') AND qual IS NULL");
        expect(migration).toContain("policyname = 'Users can update own vault files'");
        expect(migration).toContain("qual ILIKE '%vessel_vault%'");
        expect(migration).toContain("with_check ILIKE '%vessel_vault%'");
        expect(migration).toContain("'authenticated' = ANY(roles)");
        expect(migration).toContain("'public' <> ALL(roles)");
        expect(migration).toContain("COALESCE(qual, '') ILIKE '%crew%'");
        expect(migration).toContain('A legacy public chat-avatars/crew write path remains');
    });

    it('requires the complete four-policy recipe-photo boundary', () => {
        expect(migration).toContain('Recipe photos public read');
        expect(migration).toContain('Recipe photos owner upload');
        expect(migration).toContain('Recipe photos owner update');
        expect(migration).toContain('Recipe photos owner delete');
        expect(migration).toContain('IF recipe_policy_count <> 4');
    });
});

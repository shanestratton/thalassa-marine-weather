import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('public-beta recipe photo contract', () => {
    it('keeps public media community-only in the UI and never claims a failed save succeeded locally', () => {
        const form = read('components/chat/CustomRecipeForm.tsx');

        expect(form).toContain('privatePhotoBlocked');
        expect(form).toContain('Private photos are not available in beta');
        expect(form).toContain('Remove photo and keep private');
        expect(form).toContain('disabled={saving || !canAdvance() || privatePhotoBlocked}');
        expect(form).toContain('Recipe was not saved. Sign in or reconnect, then try again.');
        expect(form).not.toContain('Saved locally — will sync when you reconnect');
    });

    it('replaces permissive policies with owner-prefixed writes and owned legacy cleanup', () => {
        const migration = read('supabase/migrations/20260804193000_recipe_photo_ownership.sql');

        expect(migration).toContain("'recipe-photos'");
        expect(migration).toContain('FOR INSERT TO authenticated');
        expect(migration).toContain('FOR UPDATE TO authenticated');
        expect(migration).toContain('FOR DELETE TO authenticated');
        expect(migration).toMatch(/split_part\(name, '\/', 1\) = auth\.uid\(\)::TEXT/);
        expect(migration).toMatch(/community_recipe\.user_id = auth\.uid\(\)/);
        expect(migration).toMatch(/recipe\.user_id = auth\.uid\(\)/);
        expect(migration).toMatch(/community_recipe\.id::TEXT \|\| '\.jpg' = name/);
        expect(migration).toMatch(/COALESCE\(qual, ''\) ILIKE '%recipe-photos%'/);
        expect(migration).toContain('END;\n$policy_cleanup$;');
        expect(migration).toMatch(
            /DROP POLICY IF EXISTS "Users can update own vault files"[\s\S]*bucket_id = 'vessel_vault'[\s\S]*WITH CHECK/,
        );
        expect(migration).toMatch(/Unbounded storage write policies must be repaired first/);
    });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// One recipe store for your own and shared recipes (132-B18, binder audit
// GAL-06, GAL-08, GAL-16; Shane 15 Oct). The push needs Shane's own Supabase
// sign-in, so it is written HELD: supabase db push applies every file in
// supabase/migrations. Until it runs the app keeps two stores, and finds it by
// a column probe of recipes.rating_avg (tests/RecipesOneStore132.test.tsx).
// It is released by moving it into supabase/migrations under a stamp newer
// than the newest applied one; this test is rewritten in that same commit to
// read the released file and assert the held copy is gone (the b85cd258d
// vault-limits release), and 'recipes' joins the signed-out tables
// tests/AnonPrivilegesLockdownMigration.test.ts recomputes.
const FILE = '20261015170000_recipes_one_store.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');

describe('the one recipe store migration', () => {
    it('is held out of supabase/migrations, so a release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('recipes_one_store'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261015170000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
        // Newer than the newest applied migration when it was written: a fixed
        // stamp, so releasing a sibling held file first cannot fail this one.
        expect(FILE > '20261013091000_vessel_vault_limits.sql').toBe(true);
    });

    it("adds the author's name and the ratings to recipes, defaulted, and tells PostgREST", () => {
        expect(sql).toContain(
            'ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS author_name TEXT, ADD COLUMN IF NOT EXISTS rating_avg DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;',
        );
        expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    });

    it('copies each Captain’s Table row the store lacks, keeps a private photo off it, and skips fenced accounts', () => {
        const copy = sql.slice(sql.indexOf('INSERT INTO public.recipes'), sql.indexOf('UPDATE public.recipes'));
        expect(copy).toContain('FROM public.community_recipes AS community');
        expect(copy).toContain(
            'WHERE NOT EXISTS (SELECT 1 FROM public.recipes AS recipe WHERE recipe.id = community.id)',
        );
        expect(copy).toContain(
            'NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id = community.user_id)',
        );
        expect(copy).toContain("CASE WHEN community.visibility = 'community' THEN 'shared' ELSE 'personal' END");
        // A personal recipe keeps no photo in this beta.
        expect(copy).toContain("CASE WHEN community.visibility = 'community' THEN community.image_url END");
        // Steps as the twins hold them: JSON text.
        expect(copy).toContain("COALESCE(community.instructions, '[]'::jsonb)::text");
        expect(copy).toMatch(/, true, false, community\.author_name,/);
    });

    it('gives a twin its author, and never touches its visibility', () => {
        const twin = sql.slice(sql.indexOf('UPDATE public.recipes AS recipe SET author_name'));
        const statement = twin.slice(0, twin.indexOf(';'));
        expect(statement).toContain('SET author_name = community.author_name, updated_at = now()');
        expect(statement).not.toMatch(/visibility/);
        expect(statement).toContain('account_deletion_jobs');
    });

    it('points ratings at the one store, found by what the key is, checked when every recipe is there', () => {
        expect(sql).toContain("constraint_row.conrelid = 'public.recipe_ratings'::regclass");
        expect(sql).toContain('constraint_row.conkey = ARRAY[recipe_column]');
        expect(sql).toContain("constraint_row.confrelid <> 'public.recipes'::regclass");
        expect(sql).toContain("EXECUTE format('ALTER TABLE public.recipe_ratings DROP CONSTRAINT %I', fk.conname);");
        expect(sql).toContain(
            'ADD CONSTRAINT recipe_ratings_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE NOT VALID;',
        );
        expect(sql).toContain('AND NOT constraint_row.convalidated');
        expect(sql).toContain(
            "EXECUTE format('ALTER TABLE public.recipe_ratings VALIDATE CONSTRAINT %I', fk.conname);",
        );
        expect(sql).not.toMatch(/DROP CONSTRAINT (?:IF EXISTS )?recipe_ratings_recipe_id_fkey/i);
    });

    it('counts the ratings again, from a definer that writes both stores and nobody may call', () => {
        expect(sql).toMatch(/SET rating_avg = tally\.average, rating_count = tally\.total, updated_at = now\(\)/);
        expect(sql).toContain(
            'CREATE OR REPLACE FUNCTION public.update_recipe_rating_avg() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public',
        );
        expect(sql).toContain('UPDATE public.recipes SET rating_avg = average, rating_count = total WHERE id = target');
        expect(sql).toContain(
            'UPDATE public.community_recipes SET rating_avg = average, rating_count = total WHERE id = target',
        );
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.update_recipe_rating_avg() FROM PUBLIC, anon, authenticated;',
        );
    });

    it('guards the ratings and the owner, dropped first and made again last', () => {
        expect(sql).toContain('IF pg_trigger_depth() < 2 THEN');
        expect(sql).toContain('NEW.rating_avg := 0; NEW.rating_count := 0;');
        expect(sql).toContain('NEW.rating_avg := OLD.rating_avg; NEW.rating_count := OLD.rating_count;');
        expect(sql).toContain(
            "RAISE EXCEPTION 'Only the owner can move a recipe to another owner' USING ERRCODE = '42501';",
        );
        expect(sql).toContain('REVOKE ALL ON FUNCTION public.guard_recipe_row() FROM PUBLIC, anon, authenticated;');
        const drop = sql.indexOf('DROP TRIGGER IF EXISTS trg_zz_guard_recipe_row ON public.recipes;');
        const create = sql.indexOf(
            'CREATE TRIGGER trg_zz_guard_recipe_row BEFORE INSERT OR UPDATE ON public.recipes FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_row();',
        );
        expect(drop).toBeGreaterThan(-1);
        expect(create).toBeGreaterThan(-1);
        // Nothing this file writes passes through the guard.
        for (const write of [
            'INSERT INTO public.recipes',
            'UPDATE public.recipes AS recipe SET author_name',
            'SET rating_avg = tally.average',
        ]) {
            expect(sql.indexOf(write)).toBeGreaterThan(drop);
            expect(sql.indexOf(write)).toBeLessThan(create);
        }
    });

    it('lets crew with Galley write change a personal recipe of the skipper’s, and signed-out readers read shared ones', () => {
        expect(sql).toContain(
            "CREATE POLICY \"Galley crew change recipes\" ON public.recipes FOR UPDATE TO authenticated USING ( user_id <> auth.uid() AND visibility = 'personal' AND public.can_access_vessel_register(user_id, 'galley', true) ) WITH CHECK ( user_id <> auth.uid() AND visibility = 'personal' AND public.can_access_vessel_register(user_id, 'galley', true) );",
        );
        expect(sql).toContain('GRANT SELECT ON public.recipes TO anon;');
        expect(sql).toContain(
            'CREATE POLICY "Anyone reads shared recipes" ON public.recipes FOR SELECT TO anon USING (visibility = \'shared\');',
        );
        // No delete for crew, and the Captain's Table store stays for older builds.
        expect(sql).not.toMatch(/FOR DELETE/i);
        expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|ALTER TABLE public\.community_recipes/i);
    });

    it('is safe to re-run, bounded on its lock, has no transaction of its own, and says how to find and undo it', () => {
        expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
        expect(sql).toContain('DROP POLICY IF EXISTS "Galley crew change recipes" ON public.recipes;');
        expect(sql).toContain('DROP POLICY IF EXISTS "Anyone reads shared recipes" ON public.recipes;');
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(migration).toContain('services/galley/recipeStoreColumn.ts');
        expect(migration).toContain('tests/AnonPrivilegesLockdownMigration.test.ts');
        expect(migration).toMatch(/-- Undo\n/);
        expect(migration).toMatch(/-- Older builds\n/);
    });
});

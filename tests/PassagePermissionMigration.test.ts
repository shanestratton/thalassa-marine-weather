import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723104000_passage_permission_rls.sql', 'utf8');

describe('passage permission RLS migration', () => {
    it('replaces the globally broad voyage policy with accepted, scoped permission checks', () => {
        expect(migration).toMatch(/DROP POLICY IF EXISTS "Crew read active voyages"/i);
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.can_access_passage/i);
        expect(migration).toMatch(/membership\.status = 'accepted'/i);
        expect(migration).toMatch(/membership\.owner_id = p_owner_id/i);
        expect(migration).toMatch(/membership\.voyage_id = p_voyage_id::TEXT/i);
        expect(migration).toMatch(/coalesce\(membership\.permissions->>p_permission, 'false'\) = 'true'/i);
    });

    it('binds shared offline rows to the verified voyage owner before RLS checks', () => {
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.rewrite_passage_row_owner/i);
        expect(migration).toMatch(/NEW\.user_id := voyage_owner/i);
        expect(migration).toMatch(/CREATE TRIGGER trg_rewrite_meal_plan_owner/i);
        expect(migration).toMatch(/CREATE TRIGGER trg_rewrite_provision_owner/i);
        expect(migration).toMatch(/CREATE TRIGGER trg_rewrite_shopping_owner/i);
    });

    it('enforces child grants on meals, provisions, shopping, and watches', () => {
        expect(migration).toMatch(/ON public\.meal_plans FOR ALL[\s\S]+can_view_passage_meals/i);
        expect(migration).toMatch(/ON public\.passage_provisions FOR ALL[\s\S]+can_view_passage_meals/i);
        expect(migration).toMatch(/ON public\.shopping_list FOR ALL[\s\S]+can_view_passage_meals/i);
        expect(migration).toMatch(/ON public\.watch_assignments FOR SELECT[\s\S]+can_view_passage_checklist/i);
    });
});

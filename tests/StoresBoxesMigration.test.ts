/**
 * stores_boxes (126-11a, 2026-10-10): named boxes in Ship's Stores, shared
 * through the 'stores' register exactly as inventory_items is, and the soft
 * inventory_items.box_id link an item carries. Migration text only: it is
 * written, never applied, until Shane says yes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILE = 'supabase/migrations/20261010153000_stores_boxes.sql';
const sql = readFileSync(FILE, 'utf8');
const squash = (text: string) => text.replace(/\s+/g, ' ');
const body = squash(sql.replace(/--[^\n]*\n/g, '\n'));

describe('stores_boxes migration', () => {
    it('is stamped after the expiry_date migration (126-B9c) and before 126-13', () => {
        expect(FILE).toMatch(/20261010153000_/);
    });

    it('holds a named box per Stores owner, removed with the account', () => {
        expect(body).toContain('CREATE TABLE IF NOT EXISTS public.stores_boxes (');
        expect(body).toMatch(/id UUID PRIMARY KEY/);
        expect(body).toContain('user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
        expect(body).toContain('name TEXT NOT NULL');
        expect(body).toContain('location_zone TEXT');
        expect(body).toContain('notes TEXT');
        expect(body).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT now()');
        expect(body).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    });

    it('checks the lengths: a name of 1-80 after trim, a zone up to 80, notes up to 500', () => {
        expect(body).toMatch(/CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 80\)/);
        expect(body).toMatch(/CHECK \(location_zone IS NULL OR char_length\(location_zone\) <= 80\)/);
        expect(body).toMatch(/CHECK \(notes IS NULL OR char_length\(notes\) <= 500\)/);
    });

    it('indexes the owner and the item link', () => {
        expect(body).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON public\.stores_boxes ?\(user_id\)/);
        expect(body).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON public\.inventory_items ?\(box_id\)/);
    });

    it('gives inventory_items a nullable box_id with no foreign key (offline pushes do not order across tables)', () => {
        expect(body).toContain('ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS box_id UUID;');
        expect(body).not.toMatch(/box_id UUID[^;,]*(NOT NULL|REFERENCES)/);
        expect(body).not.toMatch(/FOREIGN KEY \(box_id\)/);
    });

    it("uses the 'stores' register for all four policies; only the owner deletes", () => {
        expect(body).toContain('ALTER TABLE public.stores_boxes ENABLE ROW LEVEL SECURITY');
        expect(body).toMatch(
            /ON public\.stores_boxes FOR SELECT TO authenticated USING \(public\.can_access_vessel_register\(user_id, 'stores', false\)\)/,
        );
        expect(body).toMatch(
            /ON public\.stores_boxes FOR INSERT TO authenticated WITH CHECK \(public\.can_access_vessel_register\(user_id, 'stores', true\)\)/,
        );
        expect(body).toMatch(
            /ON public\.stores_boxes FOR UPDATE TO authenticated USING \(public\.can_access_vessel_register\(user_id, 'stores', true\)\) WITH CHECK \(public\.can_access_vessel_register\(user_id, 'stores', true\)\)/,
        );
        expect(body).toMatch(/ON public\.stores_boxes FOR DELETE TO authenticated USING \(user_id = auth\.uid\(\)\)/);
        expect((body.match(/CREATE POLICY/g) ?? []).length).toBe(4);
        expect(body).not.toMatch(/TO anon|TO PUBLIC/i);
    });

    it('has the crew rewrite, updated_at and account-deletion fence triggers inventory_items has', () => {
        expect(body).toContain(
            "BEFORE INSERT ON public.stores_boxes FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('stores')",
        );
        expect(body).toContain(
            'BEFORE UPDATE ON public.stores_boxes FOR EACH ROW EXECUTE FUNCTION public.update_inventory_updated_at()',
        );
        expect(body).toContain(
            "BEFORE INSERT OR UPDATE ON public.stores_boxes FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id')",
        );
        expect(body).not.toMatch(/SECURITY DEFINER/);
    });

    it('revokes anon and PUBLIC, and grants the four DML verbs to authenticated', () => {
        expect(body).toContain('REVOKE ALL ON TABLE public.stores_boxes FROM PUBLIC, anon, authenticated;');
        expect(body).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stores_boxes TO authenticated;');
    });

    it('joins supabase_realtime only when it is not already there', () => {
        expect(body).toMatch(/IF EXISTS \(SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'\)/);
        expect(body).toMatch(/tablename = 'stores_boxes'/);
        expect(body).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.stores_boxes;');
    });

    it('checks itself: the table, the column, the policies, the triggers, the grants and the publication', () => {
        const check = body.slice(body.lastIndexOf('DO $check$'));
        expect(check).toContain("has_table_privilege('anon', 'public.stores_boxes'");
        expect(check).toContain("has_table_privilege('authenticated', 'public.stores_boxes'");
        expect(check).toMatch(/column_name = 'box_id'/);
        expect(check).toMatch(/pg_policies/);
        expect(check).toMatch(/pg_trigger/);
        expect(check).toMatch(/pg_publication_tables/);
        expect(check).toMatch(/RAISE EXCEPTION 'stores_boxes: /);
    });

    it('makes PostgREST reload, and holds its locks briefly', () => {
        expect(body).toContain("NOTIFY pgrst, 'reload schema';");
        expect(body).toContain("SET lock_timeout = '5s';");
        expect(body).toContain('RESET lock_timeout;');
        expect(body).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
    });
});

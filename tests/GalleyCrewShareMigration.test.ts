/**
 * 20261003100000_galley_crew_share (Shane 2026-10-03: "can we share the galley
 * as well with invitees (as an option)"). Accepted crew the skipper shares the
 * Galley with read and write the skipper's galley rows with no passage, add
 * personal recipes to his library, and tick grocery items bought without the
 * Stores share (no Stores receipt then). Passage rows keep their rules.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261003100000_galley_crew_share.sql', 'utf8');
const original = readFileSync('supabase/migrations/20260723104300_atomic_grocery_purchase.sql', 'utf8');
const crewManifest = readFileSync('supabase/migrations/20260723100000_crew_manifest_hardening.sql', 'utf8');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const stripComments = (text: string) => text.replace(/--[^\n]*\n/g, '\n');
const body = squash(stripComments(sql));

/** One CREATE OR REPLACE FUNCTION ... $$; block, by name. */
function functionBlock(text: string, name: string): string {
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n$$;', start);
    return text.slice(start, end + 4);
}

/** The redeem RPC's CREATE OR REPLACE ... $$; block (it takes arguments). */
function redeemBlock(text: string): string {
    const start = text.indexOf('CREATE OR REPLACE FUNCTION public.redeem_manifest_invite(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n$$;', start);
    return text.slice(start, end + 4);
}

const GALLEY_READ = "public.can_access_vessel_register(user_id, 'galley', false)";
const GALLEY_WRITE = "public.can_access_vessel_register(user_id, 'galley', true)";

describe('the galley crew share migration', () => {
    it('lets galley crew read the skipper’s recipes and add personal ones, never edit or delete them', () => {
        expect(body).toContain(
            `CREATE POLICY "Galley crew read recipes" ON public.recipes FOR SELECT TO authenticated USING (${GALLEY_READ});`,
        );
        expect(body).toContain(
            `CREATE POLICY "Galley crew add recipes" ON public.recipes FOR INSERT TO authenticated WITH CHECK ( user_id <> auth.uid() AND visibility = 'personal' AND ${GALLEY_WRITE} );`,
        );
        expect(body).not.toMatch(/ON public\.recipes FOR (UPDATE|DELETE|ALL)/);
    });

    it('shares meal plans and the grocery list with no passage only, read and write', () => {
        for (const [table, noun] of [
            ['meal_plans', 'meal plans'],
            ['shopping_list', 'shopping'],
        ]) {
            expect(body).toContain(
                `CREATE POLICY "Galley crew read ${noun}" ON public.${table} FOR SELECT TO authenticated USING (voyage_id IS NULL AND ${GALLEY_READ});`,
            );
            expect(body).toContain(
                `CREATE POLICY "Galley crew add ${noun}" ON public.${table} FOR INSERT TO authenticated WITH CHECK (voyage_id IS NULL AND ${GALLEY_WRITE});`,
            );
            expect(body).toContain(
                `CREATE POLICY "Galley crew update ${noun}" ON public.${table} FOR UPDATE TO authenticated USING (voyage_id IS NULL AND ${GALLEY_WRITE}) WITH CHECK (voyage_id IS NULL AND ${GALLEY_WRITE});`,
            );
            expect(body).toContain(
                `CREATE POLICY "Galley crew delete ${noun}" ON public.${table} FOR DELETE TO authenticated USING (voyage_id IS NULL AND ${GALLEY_WRITE});`,
            );
            expect(body).toContain(`DROP POLICY IF EXISTS "Galley crew read ${noun}" ON public.${table};`);
        }
        // Passage provisions and the public Captain's Table are not the galley's.
        expect(body).not.toMatch(/public\.passage_provisions|public\.community_recipes/);
        expect(body).not.toMatch(/\bTO (anon|PUBLIC)\b/i);
        expect(body).not.toContain('crew_rewrite_user_id');
    });

    it('keeps a skipper’s galley rows his: only the owner may hand one to someone else', () => {
        expect(body).toMatch(
            /CREATE OR REPLACE FUNCTION public\.guard_galley_row_owner\(\) RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS \$\$/,
        );
        // No signed-in caller (an operator's repair) is not crew: let it through.
        expect(body).toContain(
            'IF auth.uid() IS NOT NULL AND OLD.voyage_id IS NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id AND OLD.user_id IS DISTINCT FROM auth.uid() THEN',
        );
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.guard_galley_row_owner() FROM PUBLIC, anon, authenticated;',
        );
        // BEFORE triggers fire in name order. The guard must run AFTER the
        // passage owner rewrite (20260723104000), or crew could move a
        // skipper's row into their own passage: the rewrite would hand it to
        // them after the guard had already looked.
        for (const [table, guard, rewrite] of [
            ['meal_plans', 'trg_zz_guard_galley_meal_plan_owner', 'trg_rewrite_meal_plan_owner'],
            ['shopping_list', 'trg_zz_guard_galley_shopping_owner', 'trg_rewrite_shopping_owner'],
        ]) {
            expect(body).toContain(
                `CREATE TRIGGER ${guard} BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.guard_galley_row_owner();`,
            );
            expect(body).toContain(`DROP TRIGGER IF EXISTS ${guard} ON public.${table};`);
            expect([rewrite, guard].sort()).toEqual([rewrite, guard]);
            // And after every other BEFORE trigger on the table.
            for (const other of ['trg_atomic_grocery_purchase', 'trg_mealplan_updated', 'trg_shopping_list_updated']) {
                expect(guard > other).toBe(true);
            }
        }
        expect(body).not.toContain('trg_guard_galley_meal_plan_owner');
    });

    it('a galley tick without the Stores share records the purchase and skips the receipt; nothing else changes', () => {
        const next = functionBlock(sql, 'sync_grocery_purchase_inventory');
        const before = functionBlock(original, 'sync_grocery_purchase_inventory');

        // Only the galley's own list (no passage), only for galley crew, and
        // a tick or untick only through the revisioned protocol: a legacy
        // client with no operation key keeps the 42501 it always had.
        expect(squash(next)).toContain(
            "IF OLD.voyage_id IS NULL AND NEW.voyage_id IS NULL AND (NEW.purchase_operation_id IS NOT NULL OR NEW.purchased IS NOT DISTINCT FROM OLD.purchased) AND public.can_access_vessel_register(shopping_owner, 'galley', true) THEN galley_only := true; ELSE RAISE EXCEPTION 'Ship''s Stores edit permission is required' USING ERRCODE = '42501'; END IF;",
        );
        // No receipt is added or reversed on that path; a purchase is still validated.
        expect(squash(next)).toMatch(
            /IF galley_only THEN .*RAISE EXCEPTION 'A purchased item requires an exact quantity, unit, and purchase time' USING ERRCODE = '23514'; END IF; ELSIF NEW\.purchased THEN/,
        );

        // The rest is the live body unchanged: undo the additions and it is
        // 20260723104300's function, word for word.
        const restored = squash(stripComments(next))
            .replace(' galley_only BOOLEAN := false;', '')
            .replace(
                / IF OLD\.voyage_id IS NULL AND NEW\.voyage_id IS NULL AND \(NEW\.purchase_operation_id IS NOT NULL OR NEW\.purchased IS NOT DISTINCT FROM OLD\.purchased\) AND public\.can_access_vessel_register\(shopping_owner, 'galley', true\) THEN galley_only := true; ELSE (RAISE EXCEPTION 'Ship''s Stores edit permission is required' USING ERRCODE = '42501';) END IF;/,
                ' $1',
            )
            .replace(/ IF galley_only THEN .*? END IF; ELSIF NEW\.purchased THEN/, ' IF NEW.purchased THEN');
        expect(restored).toBe(squash(stripComments(before)));
        expect(body).toContain(
            'REVOKE ALL ON FUNCTION public.sync_grocery_purchase_inventory() FROM PUBLIC, anon, authenticated;',
        );
    });

    it('a galley-only untick cannot leave a Stores receipt behind', () => {
        // The skipper ticked it and the stock went into Ship's Stores: only
        // someone who may take it back out may put it back on the list.
        // Otherwise the receipt stays, and the next tick adopts it (or fails
        // for good once some of it has been eaten).
        const galleyOnly = squash(stripComments(functionBlock(sql, 'sync_grocery_purchase_inventory'))).match(
            /IF galley_only THEN (.*?) ELSIF NEW\.purchased THEN/,
        )?.[1];
        expect(galleyOnly).toContain(
            "IF OLD.purchased AND NOT NEW.purchased AND EXISTS ( SELECT 1 FROM public.inventory_items WHERE id = OLD.id AND description = receipt_provenance ) THEN RAISE EXCEPTION 'Only someone who can edit Ship''s Stores can undo this purchase' USING ERRCODE = '42501'; END IF;",
        );
        // After the operation ledger and the revision fence: a lost-response
        // retry or a stale untick is still the quiet no-op it always was.
        const whole = squash(stripComments(functionBlock(sql, 'sync_grocery_purchase_inventory')));
        expect(whole.indexOf('RETURN OLD; END IF; IF galley_only THEN')).toBeGreaterThan(
            whole.indexOf('WHERE operation_id = NEW.purchase_operation_id'),
        );
    });

    it('nobody shares a galley they did not tick: codes from the role preset are reset before the policies', () => {
        const reset = body.indexOf('UPDATE public.vessel_crew AS membership');
        expect(reset).toBeGreaterThanOrEqual(0);
        expect(reset).toBeLessThan(body.indexOf('CREATE POLICY'));

        expect(body).toContain(
            "UPDATE public.vessel_crew AS membership SET shared_registers = array_remove(coalesce(membership.shared_registers, '{}'::text[]), 'galley'), permissions = coalesce(membership.permissions, '{}'::jsonb) || '{\"can_view_galley\": false, \"share_galley\": false}'::jsonb WHERE ( 'galley' = ANY(coalesce(membership.shared_registers, '{}'::text[])) OR (membership.permissions->>'can_view_galley') = 'true' OR (membership.permissions->>'share_galley') = 'true' )",
        );
        // A tick this build made (share_galley, only ever written from the
        // Galley tick) is kept: it is the one deliberate share there can be.
        expect(body).toContain(
            "AND NOT ( 'galley' = ANY(coalesce(membership.shared_registers, '{}'::text[])) AND (membership.permissions->>'share_galley') = 'true' )",
        );
        // Codes not yet redeemed lose the preset's flag too.
        expect(body).toContain(
            "UPDATE public.manifest_invites AS invite SET permissions = coalesce(invite.permissions, '{}'::jsonb) || '{\"can_view_galley\": false}'::jsonb WHERE invite.status = 'pending' AND (invite.permissions->>'can_view_galley') = 'true' AND (invite.permissions->>'share_galley') IS DISTINCT FROM 'true'",
        );
        // An account being deleted is write-fenced (block_tombstoned_account_write):
        // one such row must not fail the whole migration.
        expect(body).toContain(
            'AND NOT EXISTS ( SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id IN (membership.owner_id, membership.crew_user_id) );',
        );
        expect(body).toContain(
            'AND NOT EXISTS ( SELECT 1 FROM public.account_deletion_jobs AS job WHERE job.user_id IN (invite.owner_id, invite.accepted_by) );',
        );
    });

    it('a crew code shares the galley only on share_galley; the rest of the redeem is unchanged', () => {
        const next = redeemBlock(sql);
        const before = redeemBlock(crewManifest);
        expect(body.indexOf('FUNCTION public.redeem_manifest_invite(')).toBeLessThan(body.indexOf('CREATE POLICY'));

        const galleyCase =
            "CASE WHEN coalesce((invite.permissions->>'share_galley')::boolean, false) THEN 'galley' END";
        expect(squash(next)).toContain(galleyCase);
        expect(squash(next)).not.toContain("invite.permissions->>'can_view_galley'");
        // The new crew row's flags say what its registers say.
        const normalised =
            "invite.permissions || jsonb_build_object( 'can_view_galley', 'galley' = ANY(register_values), 'share_galley', 'galley' = ANY(register_values) ),";
        expect(squash(next)).toContain(normalised);

        const restored = squash(stripComments(next))
            .replace(
                galleyCase,
                "CASE WHEN coalesce((invite.permissions->>'can_view_galley')::boolean, false) THEN 'galley' END",
            )
            .replace(normalised, 'invite.permissions,');
        expect(restored).toBe(squash(stripComments(before)));
        expect(body).toContain('REVOKE ALL ON FUNCTION public.redeem_manifest_invite(TEXT, TEXT) FROM PUBLIC, anon;');
        expect(body).toContain('GRANT EXECUTE ON FUNCTION public.redeem_manifest_invite(TEXT, TEXT) TO authenticated;');
    });

    it('says when it may be pushed: once crew run the build that carries the galley share', () => {
        expect(sql).toMatch(/PUSH ORDER/);
        expect(sql).toMatch(/app before database/i);
    });

    it('publishes recipes and meal plans (and the grocery list) for realtime, guarded for a replay', () => {
        expect(body).toMatch(
            /IF NOT EXISTS \( SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' \) THEN RETURN;/,
        );
        expect(body).toContain("FOREACH galley_table IN ARRAY ARRAY[ 'recipes', 'meal_plans', 'shopping_list' ]");
        expect(body).toMatch(
            /AND NOT EXISTS \( SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = galley_table \)/,
        );
        expect(body).toContain(
            "EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', galley_table);",
        );
    });

    it('ends with the signal the app waits for, callable by signed-in users only', () => {
        expect(body).toMatch(
            /CREATE OR REPLACE FUNCTION public\.galley_share_ready\(\) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog AS \$\$ SELECT true; \$\$;/,
        );
        expect(body).not.toMatch(/galley_share_ready\(\)[^;]*SECURITY DEFINER/);
        expect(body).toContain('REVOKE ALL ON FUNCTION public.galley_share_ready() FROM PUBLIC, anon;');
        expect(body).toContain('GRANT EXECUTE ON FUNCTION public.galley_share_ready() TO authenticated;');
        // Last: it can only answer once everything above is in place.
        expect(body.lastIndexOf('CREATE POLICY')).toBeLessThan(body.indexOf('FUNCTION public.galley_share_ready'));
        expect(body.indexOf('ALTER PUBLICATION')).toBeLessThan(body.indexOf('FUNCTION public.galley_share_ready'));
    });
});

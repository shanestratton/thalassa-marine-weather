import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723104300_atomic_grocery_purchase.sql', 'utf8');
const shoppingService = readFileSync('services/ShoppingListService.ts', 'utf8');

describe('atomic grocery purchase migration', () => {
    it('creates and reverses the exact stores receipt in the shopping transaction', () => {
        expect(migration).toMatch(
            /CREATE TRIGGER trg_atomic_grocery_purchase\s+BEFORE UPDATE\s+ON public\.shopping_list/i,
        );
        expect(migration).toMatch(/INSERT INTO public\.inventory_items/i);
        expect(migration).toMatch(/DELETE FROM public\.inventory_items/i);
        expect(migration).toMatch(/receipt\.quantity - receipt_quantity/i);
        expect(migration).toMatch(/NEW\.purchased_quantity/i);
        expect(migration).toMatch(/NEW\.purchased_unit/i);
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.grocery_purchase_operations/i);
        expect(migration).toMatch(/NEW\.purchase_revision IS DISTINCT FROM OLD\.purchase_revision \+ 1/i);
        expect(migration).toMatch(/WHERE operation_id = NEW\.purchase_operation_id/i);
        expect(migration).toMatch(/RETURN OLD/i);
        expect(migration).toMatch(/BEFORE INSERT ON public\.shopping_list/i);
        expect(migration).toMatch(/Shopping items must be inserted before they are purchased/i);
    });

    it('checks edit permission inside its definer-rights boundary and is not directly callable', () => {
        expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/i);
        expect(migration).toMatch(/can_access_vessel_register\(shopping_owner, 'stores', true\)/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.sync_grocery_purchase_inventory\(\)[\s\S]+FROM PUBLIC, anon, authenticated/i,
        );
    });

    it('protects purchased receipt fields and identity from meal-only writers', () => {
        expect(migration).toMatch(/purchase_sensitive_changed :=[\s\S]+NEW\.purchased_quantity/i);
        expect(migration).toMatch(/NEW\.purchase_revision IS DISTINCT FROM OLD\.purchase_revision/i);
        expect(migration).toMatch(
            /IF purchase_sensitive_changed[\s\S]+can_access_vessel_register\(shopping_owner, 'stores', true\)/i,
        );
        expect(migration).toMatch(
            /OLD\.purchased OR NEW\.purchased[\s\S]+NEW\.voyage_id IS DISTINCT FROM OLD\.voyage_id[\s\S]+NEW\.ingredient_name IS DISTINCT FROM OLD\.ingredient_name/i,
        );
        expect(migration).toMatch(/Purchase receipt fields require a revisioned transition/i);
    });

    it('refuses to delete a purchased row and orphan its Stores receipt', () => {
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.guard_grocery_purchase_delete\(\)/i);
        expect(migration).toMatch(/can_access_vessel_register\(OLD\.user_id, 'stores', true\)/i);
        expect(migration).toMatch(/Undo the grocery purchase before deleting the item/i);
        expect(migration).toMatch(
            /CREATE TRIGGER trg_guard_grocery_purchase_delete\s+BEFORE DELETE ON public\.shopping_list/i,
        );
    });

    it('uses local-only inventory mirroring so the shopping update is the sole remote outbox transition', () => {
        expect(shoppingService).toMatch(/bulkUpsert\(INVENTORY_TABLE/i);
        expect(shoppingService).toMatch(/bulkDelete\(INVENTORY_TABLE/i);
        expect(shoppingService).not.toMatch(/insertLocal\(INVENTORY_TABLE/i);
        expect(shoppingService).not.toMatch(/deleteLocal\(INVENTORY_TABLE/i);
    });
});

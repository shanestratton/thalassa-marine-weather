import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723102000_inventory_delta_outbox.sql', 'utf8');

describe('inventory delta migration', () => {
    it('supports fractional stores quantities without reintroducing a definer-rights view', () => {
        expect(migration).toMatch(/ALTER COLUMN quantity TYPE NUMERIC/i);
        expect(migration).toMatch(/CREATE VIEW public\.ships_stores\s+WITH \(security_invoker = true\)/i);
    });

    it('records an idempotency receipt in the same atomic function as the locked update', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.inventory_delta_receipts/i);
        expect(migration).toMatch(/WHERE id = p_inventory_item_id\s+FOR UPDATE/i);
        expect(migration).toMatch(/UPDATE public\.inventory_items[\s\S]+INSERT INTO public\.inventory_delta_receipts/i);
        expect(migration.match(/WHERE operation_id = p_operation_id/gi)).toHaveLength(2);
    });

    it('checks register edit authorization and exposes the RPC only to authenticated users', () => {
        expect(migration).toMatch(/public\.can_access_vessel_register\(inventory_owner, 'stores', true\)/i);
        expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.apply_inventory_quantity_delta\(UUID, UUID, NUMERIC\)[\s\S]+FROM PUBLIC, anon, service_role/i,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.apply_inventory_quantity_delta\(UUID, UUID, NUMERIC\)[\s\S]+TO authenticated/i,
        );
    });
});

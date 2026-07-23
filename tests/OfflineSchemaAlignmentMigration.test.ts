import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723103000_offline_schema_alignment.sql', 'utf8');

describe('offline schema alignment migration', () => {
    it('creates the shopping table with every synced purchase field and owner RLS', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.shopping_list/i);
        for (const column of [
            'ingredient_name',
            'required_qty',
            'market_zone',
            'purchase_retailer',
            'purchased_quantity',
            'purchased_unit',
            'purchase_revision',
            'purchase_operation_id',
            'voyage_id',
            'updated_at',
        ]) {
            expect(migration).toMatch(new RegExp(`\\b${column}\\b`, 'i'));
        }
        expect(migration).toMatch(/ALTER TABLE public\.shopping_list ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(/user_id = auth\.uid\(\)/i);
    });

    it('repairs recipe and provision row shapes used by the offline client', () => {
        expect(migration).toMatch(/ALTER TABLE public\.recipes[\s\S]+is_custom BOOLEAN/i);
        expect(migration).toMatch(
            /ALTER TABLE public\.passage_provisions[\s\S]+recipe_title TEXT[\s\S]+store_item_name TEXT[\s\S]+updated_at TIMESTAMPTZ/i,
        );
        expect(migration).toMatch(/CREATE TRIGGER trg_passage_provisions_updated/i);
    });

    it('publishes shopping changes and exposes an authenticated server-time watermark', () => {
        expect(migration).toMatch(/ALTER PUBLICATION supabase_realtime[\s\S]+ADD TABLE public\.shopping_list/i);
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.get_sync_watermark\(\)/i);
        expect(migration).toMatch(/SELECT statement_timestamp\(\)/i);
        expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_sync_watermark\(\)[\s\S]+TO authenticated/i);
    });
});

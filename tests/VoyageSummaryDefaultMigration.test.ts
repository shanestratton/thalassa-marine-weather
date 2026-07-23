import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260724093000_voyage_summary_default_bucket.sql', 'utf8');

describe('voyage summary default-bucket migration', () => {
    it('coalesces NULL and empty voyage ids into the default bucket for selection and grouping', () => {
        const normalization =
            /coalesce\s*\(\s*nullif\s*\(\s*logs\.voyage_id\s*,\s*''\s*\)\s*,\s*'default_voyage'\s*\)/i;
        expect(migration.match(new RegExp(normalization.source, 'gi'))).toHaveLength(2);
        expect(migration).not.toMatch(/logs\.voyage_id\s+IS\s+NOT\s+NULL/i);
    });

    it('keeps the RPC owner-scoped, invoker-rights, and unavailable to anonymous callers', () => {
        expect(migration).toMatch(/WHERE\s+logs\.user_id\s*=\s*auth\.uid\(\)/i);
        expect(migration).toMatch(/SECURITY\s+INVOKER/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.get_voyage_summaries\(boolean\)[\s\S]+FROM PUBLIC, anon/i,
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.get_voyage_summaries\(boolean\)[\s\S]+TO authenticated/i,
        );
    });

    it('preserves archived filtering and the complete summary return contract', () => {
        expect(migration).toMatch(/p_include_archived[\s\S]+logs\.archived IS NULL[\s\S]+logs\.archived = false/i);
        for (const field of [
            'entry_count',
            'started_at',
            'ended_at',
            'total_distance_nm',
            'avg_speed_kts',
            'has_manual',
            'is_planned_route',
            'is_imported',
            'first_lat',
            'first_lon',
            'last_lat',
            'last_lon',
            'first_is_on_water',
            'land_fraction',
        ]) {
            expect(migration).toMatch(new RegExp(`\\b${field}\\b`, 'i'));
        }
    });
});

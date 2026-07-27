import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260727115000_live_track_retirement_fence.sql', 'utf8');

describe('live-track retirement migration', () => {
    it('preserves capture-time water verification and indexes active voyage tails', () => {
        expect(migration).toMatch(/ALTER TABLE public\.live_track[\s\S]+ADD COLUMN IF NOT EXISTS is_on_water BOOLEAN/i);
        expect(migration).toMatch(
            /CREATE INDEX IF NOT EXISTS live_track_user_voyage_timestamp_idx[\s\S]+ON public\.live_track \(user_id, voyage_id, timestamp DESC\)/i,
        );
    });

    it('creates an owner-scoped, non-removable retirement fence', () => {
        expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.live_track_retirements/i);
        expect(migration).toMatch(/PRIMARY KEY \(user_id, voyage_id\)/i);
        expect(migration).toMatch(/ALTER TABLE public\.live_track_retirements ENABLE ROW LEVEL SECURITY/i);
        expect(migration).toMatch(/live_track_retirements_insert_own/i);
        expect(migration).toMatch(/live_track_retirements_update_own/i);
        expect(migration).not.toMatch(/live_track_retirements_delete_own/i);
    });

    it('blocks delayed live upserts and retires archive replay tails at the database boundary', () => {
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.suppress_retired_live_track/i);
        expect(migration).toMatch(/BEFORE INSERT OR UPDATE OF user_id, voyage_id ON public\.live_track/i);
        expect(migration).toMatch(/RETURN NULL/i);
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.retire_live_tracks_on_ship_log_archive/i);
        expect(migration).toMatch(/REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
        expect(migration).toMatch(/FOR EACH STATEMENT/i);
        expect(migration).toMatch(/prior\.archived IS DISTINCT FROM TRUE/i);
        expect(migration).toMatch(/PERFORM public\.retire_live_track_voyage/i);
    });

    it('does not expose the security-definer trigger helpers as public RPCs', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.retire_live_track_voyage\(UUID, TEXT, TEXT\)[\s\S]+FROM PUBLIC, anon, authenticated/i,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.suppress_retired_live_track\(\)[\s\S]+FROM PUBLIC, anon, authenticated/i,
        );
    });
});

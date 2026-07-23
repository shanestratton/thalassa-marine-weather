import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20260723104100_crew_profile_privacy.sql', 'utf8');

describe('crew profile privacy migration', () => {
    it('limits sensitive profile reads to the subject or their accepted skipper', () => {
        expect(migration).toMatch(/DROP POLICY IF EXISTS "Crew readable by vessel members"/i);
        expect(migration).toMatch(/membership\.owner_id = auth\.uid\(\)/i);
        expect(migration).toMatch(/membership\.crew_user_id = crew_profiles\.user_id/i);
        expect(migration).toMatch(/membership\.status = 'accepted'/i);
    });
});

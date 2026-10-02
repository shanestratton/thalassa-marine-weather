import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The privacy fix Shane approved 2026-10-03 ("yes fix the privacy leak too"):
// boat_profiles_member_read let every boat member, so every accepted crew
// member, read the skipper's WHOLE profile JSON over REST (EPIRB hex, shore
// contacts, phones, roster ages). After this only the boat's owner reads the
// profile; crew get the allow-list through get_crew_vessel_view. Written, not
// pushed: Shane says 'yes, push it' first.
const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261003130000_boat_profiles_owner_read.sql'),
    'utf8',
);
const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('boat_profiles owner-only read migration', () => {
    it('drops the member read policy', () => {
        expect(sql).toMatch(/DROP POLICY IF EXISTS boat_profiles_member_read ON public\.boat_profiles;/);
        expect(sql).not.toMatch(/CREATE POLICY boat_profiles_member_read/);
        expect(sql).not.toMatch(/is_boat_member/);
    });

    it('keeps the skipper reading his own profile, created BEFORE the member read goes', () => {
        const create = sql.search(
            /CREATE POLICY boat_profiles_owner_read\s+ON public\.boat_profiles FOR SELECT TO authenticated\s+USING \(public\.is_boat_owner\(boat_id\)\);/,
        );
        const drop = sql.search(/DROP POLICY IF EXISTS boat_profiles_member_read/);
        expect(create).toBeGreaterThan(-1);
        expect(create).toBeLessThan(drop);
        // Re-runnable: the owner policy is replaced, never duplicated.
        expect(sql).toMatch(/DROP POLICY IF EXISTS boat_profiles_owner_read ON public\.boat_profiles;/);
        // The owner's manage policy and the table grant are untouched.
        expect(sql).not.toMatch(/boat_profiles_owner_manage/);
        expect(sql).not.toMatch(/REVOKE[^;]*ON TABLE public\.boat_profiles/i);
        expect(sql).not.toMatch(/GRANT[^;]*\b(anon|PUBLIC)\b/i);
        expect(sql).not.toMatch(/WITH CHECK/i);
        expect(sql).not.toMatch(/FOR (ALL|INSERT|UPDATE|DELETE)\b/i);
    });

    it('refuses to finish unless an owner read remains and no other read does', () => {
        const guard = sql.match(/DO \$\$([\s\S]+?)\$\$;/)?.[1] ?? '';
        expect(guard).toContain("to_regprocedure('public.is_boat_owner(uuid)') IS NULL");
        expect(guard).toMatch(/tablename = 'boat_profiles'/);
        expect(guard).toMatch(/cmd IN \('SELECT', 'ALL'\)/);
        // Present: an owner read. Absent: any read that is not the owner's.
        expect(guard).toContain("AND policy.qual ~ '^(public\\.)?is_boat_owner\\(boat_id\\)$'");
        expect(guard).toContain("AND COALESCE(policy.qual, '') !~ '^(public\\.)?is_boat_owner\\(boat_id\\)$'");
        expect(guard.match(/RAISE EXCEPTION/g)?.length).toBeGreaterThanOrEqual(3);
    });
});

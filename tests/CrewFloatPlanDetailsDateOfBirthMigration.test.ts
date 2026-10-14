import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// An invitee's date of birth beside their age (129-14, Shane 2026-10-14: "can
// we change punters age for date of birth"). Written with 129, NOT pushed:
// supabase db push applies every file in supabase/migrations, and Shane pushes
// this one himself. Until then the app works without the column (it falls
// back to the age-only row: tests/CrewFloatPlanDetailsDateOfBirth.test.ts and
// tests/FloatPlanCrewDateOfBirth.test.ts). It is released by moving it into
// supabase/migrations under a stamp newer than the newest applied one, and
// this test is rewritten in that same commit to read the released file and
// assert the held copy is gone (the b85cd258d vault-limits release).
const FILE = '20261014181400_crew_float_plan_details_date_of_birth.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');

describe('crew_float_plan_details date of birth migration', () => {
    it('is held out of supabase/migrations, so the 129 release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('date_of_birth'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261014181400_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
        // Newer than the newest applied migration when it was written. A fixed
        // stamp, not the folder's newest: releasing a sibling held migration
        // (cyclone_watch, official_alerts) under a later stamp must not fail
        // this one while it is still rightly held.
        expect(FILE > '20261013091000_vessel_vault_limits.sql').toBe(true);
    });

    it('adds a nullable calendar date, and keeps age for old rows and 128 phones', () => {
        expect(sql).toContain(
            "ALTER TABLE public.crew_float_plan_details ADD COLUMN IF NOT EXISTS date_of_birth DATE CONSTRAINT crew_float_plan_details_date_of_birth_bounded CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2100-12-31');",
        );
        // A date, no time and no zone: it never shifts with the reader's clock.
        expect(sql).not.toMatch(/date_of_birth (?:TIMESTAMP|TIMESTAMPTZ|TEXT)/i);
        expect(sql).not.toMatch(/date_of_birth DATE NOT NULL/i);
        expect(sql).not.toMatch(/DROP COLUMN|ALTER COLUMN/i);
    });

    it('lets a row hold a date of birth alone, as it may hold an age alone', () => {
        expect(sql).toContain(
            'ALTER TABLE public.crew_float_plan_details DROP CONSTRAINT IF EXISTS crew_float_plan_details_not_empty;',
        );
        expect(sql).toContain(
            'ALTER TABLE public.crew_float_plan_details ADD CONSTRAINT crew_float_plan_details_not_empty CHECK (full_name IS NOT NULL OR phone IS NOT NULL OR age IS NOT NULL OR date_of_birth IS NOT NULL);',
        );
    });

    it('keeps the same readers as age: no new policy, no grant, RLS untouched', () => {
        // The table's four policies are row-level and its grant is table-wide,
        // so the new column has exactly age's readers: the person, and the
        // skippers they are accepted crew for.
        expect(sql).not.toMatch(/\bPOLICY\b/i);
        expect(sql).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
        expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
        expect(sql).not.toMatch(/SECURITY DEFINER|CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW)/i);
        // Nothing the crew's own view of the boat (get_crew_vessel_view) or the
        // public page reads changes.
        expect(sql).not.toMatch(/get_crew_vessel_view|boat_profiles|voyage/i);
    });

    it('is safe to re-run, bounded on its lock, and has no transaction of its own', () => {
        expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(sql).toMatch(/COMMENT ON COLUMN public\.crew_float_plan_details\.date_of_birth IS/);
    });
});

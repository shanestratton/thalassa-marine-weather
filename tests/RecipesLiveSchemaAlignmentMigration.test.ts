/**
 * Live's recipes table gets the two columns its migration declared (126-B2b
 * review).
 *
 * A read-only probe of live on 2026-10-10 found public.recipes without
 * spoonacular_id and source_url: 20260322090000 is recorded as applied, but
 * its CREATE TABLE IF NOT EXISTS never ran on a table that already existed.
 * Every queued recipes payload carries both keys, so PostgREST refused every
 * recipes write from the outbox (PGRST204). This additive migration adds the
 * columns exactly as 20260322090000 declares them; on a database built from
 * the migrations it changes nothing. Its effect was measured in a rolled-back
 * replay on live; these checks pin its text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { galleyColumns } from './helpers/galleyLiveSchema';

const DIR = 'supabase/migrations';
const migrations = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
const FILE = migrations.find((name) => name.endsWith('_recipes_live_schema_alignment.sql')) ?? '';
const sql = FILE ? readFileSync(`${DIR}/${FILE}`, 'utf8') : '';
const header = sql.slice(0, sql.search(/^\s*(?!--)\S/m));
const code = sql.replace(/--[^\n]*/g, '');
const body = code.replace(/\s+/g, ' ').trim();

/** `name TYPE` as 20260322090000_recipes.sql declares the column. */
function declared(column: string): string {
    const original = readFileSync(`${DIR}/20260322090000_recipes.sql`, 'utf8');
    const match = original.match(new RegExp(`^\\s*${column}\\s+([A-Z]+)`, 'm'));
    return match ? match[1] : '';
}

describe('recipes live schema alignment migration (126-B2b review)', () => {
    it('exists, sorts after the 126 files queued before it, and before the is_custom repair it pairs with', () => {
        expect(FILE).toMatch(/^\d{14}_recipes_live_schema_alignment\.sql$/);
        for (const earlier of [
            '20261009172000_saved_routes_verification.sql',
            '20261010110000_crew_ids_skipper_only.sql',
            '20261010120000_pi_alarm_events.sql',
            '20261010130000_anchor_watch_keeper_heartbeat.sql',
        ]) {
            expect(migrations).toContain(earlier);
            expect(FILE > earlier).toBe(true);
        }
        const repair = migrations.find((name) => name.endsWith('_recipes_is_custom_repair.sql')) ?? '';
        expect(repair).not.toBe('');
        expect(FILE < repair).toBe(true);
        // A stamp of its own.
        expect(migrations.filter((name) => name.slice(0, 14) === FILE.slice(0, 14))).toEqual([FILE]);
    });

    it('adds exactly spoonacular_id and source_url to public.recipes, as 20260322090000 declares them', () => {
        expect(body).toBe(
            'ALTER TABLE public.recipes ADD COLUMN IF NOT EXISTS spoonacular_id INTEGER, ' +
                "ADD COLUMN IF NOT EXISTS source_url TEXT; NOTIFY pgrst, 'reload schema';",
        );
        expect(declared('spoonacular_id')).toBe('INTEGER');
        expect(declared('source_url')).toBe('TEXT');
    });

    it('is the difference between live today and the shape the Galley fakes push to', () => {
        const live = galleyColumns('recipes', 'live') ?? [];
        const aligned = galleyColumns('recipes', 'aligned') ?? [];
        expect(aligned.filter((column) => !live.includes(column))).toEqual(['spoonacular_id', 'source_url']);
        expect(live).not.toContain('spoonacular_id');
        expect(live).not.toContain('source_url');
    });

    it('is additive only: no default, constraint, drop, data change, policy, grant or function', () => {
        expect(code).not.toMatch(
            /\b(DROP|UPDATE|INSERT|DELETE|TRUNCATE|GRANT|REVOKE|POLICY|TRIGGER|FUNCTION|DEFAULT|NOT NULL|UNIQUE|CHECK|REFERENCES|INDEX)\b/i,
        );
        expect(code).not.toMatch(/pg_notify|net\.http|SECURITY\s+DEFINER/i);
    });

    it('says in its header why, what, the order, and that it is not pushed until Shane says yes', () => {
        expect(header).toContain('Not pushed');
        expect(header).toContain('20260322090000');
        expect(header).toContain('PGRST204');
        expect(header).toMatch(/20261010150000_recipes_is_custom_repair/);
        expect(header).toMatch(/BEFORE, or\s+-- with, build 126/);
        expect(header).toMatch(/harmless/i);
    });
});

/**
 * Galley recipes get their Edit button back on the server (126-B2b, binder
 * audit GAL-03).
 *
 * Before 126 a recipe written in the Galley was saved first by a direct
 * upsert that left is_custom out, so the column default (false) won, and the
 * outbox INSERT (ON CONFLICT DO NOTHING) never corrected it. The next pull
 * took the Edit button away on every device. This one-off, data-only
 * migration sets is_custom = true on exactly those rows: no Spoonacular id,
 * is_custom false, not a build 126 library copy (a version 8 id), and not the
 * recipe of an account being deleted (the fail-closed write fence would abort
 * the whole migration).
 *
 * Live is not the migrations' shape (read-only probe, 2026-10-10): its recipes
 * table has no spoonacular_id column and no updated_at trigger. So the file
 * reads spoonacular_id through to_jsonb (NULL where the column is missing)
 * and sets updated_at itself; a bare `r.spoonacular_id` would abort the push.
 * Its effect was measured in a rolled-back replay on live; these checks pin
 * its text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const migrations = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
const FILE = migrations.find((name) => name.endsWith('_recipes_is_custom_repair.sql')) ?? '';
const sql = FILE ? readFileSync(`${DIR}/${FILE}`, 'utf8') : '';
const header = sql.slice(0, sql.search(/^\s*(?!--)\S/m));
const code = sql.replace(/--[^\n]*/g, '');
const body = code.replace(/\s+/g, ' ').trim();

describe('recipes is_custom repair migration (126-B2b, GAL-03)', () => {
    it('exists, and sorts after every migration live or queued before it', () => {
        expect(FILE).toMatch(/^\d{14}_recipes_is_custom_repair\.sql$/);
        // The newest migration live on 2026-10-09, and the 126 files queued before this one.
        for (const earlier of [
            '20261009172000_saved_routes_verification.sql',
            '20261010110000_crew_ids_skipper_only.sql',
            '20261010120000_pi_alarm_events.sql',
            '20261010130000_anchor_watch_keeper_heartbeat.sql',
            // Its pair: live's recipes gets the columns first, in the same push.
            '20261010145000_recipes_live_schema_alignment.sql',
        ]) {
            expect(migrations).toContain(earlier);
            expect(FILE > earlier).toBe(true);
        }
    });

    it('is one UPDATE of public.recipes that sets is_custom and touches only the GAL-03 rows', () => {
        expect(body.match(/\bUPDATE\b/gi)).toHaveLength(1);
        const update = body.match(
            /UPDATE public\.recipes AS r SET is_custom = true, updated_at = now\(\) WHERE ([^;]+);/i,
        );
        expect(update, 'the UPDATE statement').not.toBeNull();
        const where = (update as RegExpMatchArray)[1];
        expect(where).toContain('r.is_custom = false');
        // Live has no spoonacular_id column: read through to_jsonb, never by name.
        expect(where).toContain("(to_jsonb(r) ->> 'spoonacular_id') IS NULL");
        expect(code).not.toMatch(/\br\.spoonacular_id\b/);
        // Build 126 library copies (126-B2a) are version 8 uuids: legitimately not custom.
        expect(where).toContain("substr(r.id::text, 15, 1) <> '8'");
        // The account-deletion write fence fails closed: a tombstoned owner's row would abort it.
        expect(where).toMatch(
            /NOT EXISTS \( SELECT 1 FROM public\.account_deletion_jobs AS j WHERE j\.user_id = r\.user_id \)/,
        );
        // Nothing else in the row changes but updated_at (live has no trigger to stamp it).
        expect(body).not.toMatch(/updated_at = now\(\),/i);
    });

    it('checks itself in the same statement, with writes held off for that moment', () => {
        expect(body).toMatch(/^DO \$recipes_is_custom_repair\$/);
        expect(body).toContain('LOCK TABLE public.recipes IN SHARE ROW EXCLUSIVE MODE;');
        expect(body.indexOf('LOCK TABLE')).toBeLessThan(body.indexOf('UPDATE public.recipes'));
        const check = body.slice(body.indexOf('IF EXISTS'));
        expect(check).toContain('r.is_custom = false');
        expect(check).toContain("(to_jsonb(r) ->> 'spoonacular_id') IS NULL");
        expect(check).toContain("substr(r.id::text, 15, 1) <> '8'");
        expect(check).toContain('public.account_deletion_jobs');
        expect(check).toMatch(/RAISE EXCEPTION/);
        // Counts only, never ids or titles.
        expect(body).toMatch(/RAISE NOTICE '[^']*%[^']*', repaired;/);
    });

    it('changes data only: no schema, policy, grant or other table', () => {
        expect(code).not.toMatch(/\b(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|DELETE|INSERT)\b/i);
        expect(code).not.toMatch(/\bSECURITY\s+DEFINER\b/i);
        expect(code).not.toMatch(/pg_notify|net\.http/i);
        expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('says in its header why, which rows, and that it is not pushed until Shane says yes', () => {
        expect(header).toContain('GAL-03');
        expect(header).toContain('Not pushed');
        expect(header).toMatch(/version 8/);
        expect(header).toMatch(/account_deletion_write_fence/);
        expect(header).toMatch(/updated_at/);
        expect(header).toMatch(/no spoonacular_id/);
        expect(header).toMatch(/no trg_recipes_updated/);
        expect(header).toMatch(/harmless/i);
    });

    it('passes the migration audit', () => {
        const out = execFileSync(process.execPath, ['scripts/audit-supabase-migrations.mjs'], { encoding: 'utf8' });
        expect(out).toContain('Supabase migration audit passed');
    });
});

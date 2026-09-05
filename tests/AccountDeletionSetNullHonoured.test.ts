/**
 * Account deletion deleted OTHER people's rows.
 *
 * scrub_account_deletion_survivors() ends with a loop over every public column
 * holding a foreign key to auth.users and ran DELETE ... WHERE column = user for
 * each, "mirroring the eventual auth cascade". It mirrored one kind. Twelve of
 * those columns on production are ON DELETE SET NULL — the departing user as
 * reviewer, approver, assignee or weather master of a record that belongs to
 * someone else — and the real cascade would null the column and keep the row.
 *
 * The cross-account case, concretely: skipper A's voyage names B as
 * weather_master_id. B deletes their account. The loop ran
 * DELETE FROM voyages WHERE weather_master_id = B — and A's voyage was gone.
 * Same for A's watch bill (assigned_by / assigned_crew_user_id), A's founding
 * skipper application (status_updated_by), A's port (public_approved_by).
 *
 * The loop now reads confdeltype and does what the constraint says.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260905101000_deletion_honour_set_null.sql', 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

const loop = code.slice(code.indexOf('FOR direct_target IN'), code.indexOf('END LOOP;'));

describe('the survivor loop honours each constraint’s own delete rule', () => {
    it('selects the delete rule alongside the column', () => {
        expect(loop).toContain('constraint_row.confdeltype AS delete_rule');
        // DISTINCT + ORDER BY: the ordered columns must stay in the select list.
        expect(loop).toContain('ORDER BY namespace.nspname, relation.relname, attribute.attname');
    });

    it('NULLS a SET NULL column instead of deleting the row', () => {
        expect(loop).toMatch(
            /IF direct_target\.delete_rule = 'n' THEN\s*EXECUTE format\(\s*'UPDATE %I\.%I SET %I = NULL WHERE %I = \$1'/,
        );
    });

    it('restores the default for a SET DEFAULT column', () => {
        expect(loop).toMatch(
            /ELSIF direct_target\.delete_rule = 'd' THEN\s*EXECUTE format\(\s*'UPDATE %I\.%I SET %I = DEFAULT WHERE %I = \$1'/,
        );
    });

    it('still deletes for CASCADE / NO ACTION / RESTRICT — the cases it was right about', () => {
        expect(loop).toMatch(/ELSE\s*EXECUTE format\(\s*'DELETE FROM %I\.%I WHERE %I = \$1'/);
    });

    it('never deletes unconditionally any more', () => {
        // The old body ran DELETE straight after LOOP. Now every DELETE sits
        // inside the ELSE branch of the rule check.
        const deletes = [...loop.matchAll(/'DELETE FROM %I\.%I WHERE %I = \$1'/g)];
        expect(deletes.length).toBe(1);
        const before = loop.slice(0, deletes[0].index);
        expect(before).toContain("IF direct_target.delete_rule = 'n' THEN");
    });

    it('keeps the survivor check that fails the deletion loudly', () => {
        expect(loop).toContain("RAISE EXCEPTION 'Direct account identity survivor remains'");
        expect(loop).toContain('GET DIAGNOSTICS direct_rows = ROW_COUNT;');
    });

    it('names the production columns it exists for, so the next reader can re-verify', () => {
        for (const col of [
            'voyages.weather_master_id',
            'watch_assignments.assigned_by',
            'founding_skipper_applications.status_updated_by',
            'personal_ports.public_approved_by',
        ]) {
            expect(sql, col).toContain(col);
        }
    });

    it('is the live body with only the loop changed — the rest is untouched', () => {
        // Sanity anchors from the surrounding function that must still be there.
        expect(code).toContain('CREATE OR REPLACE FUNCTION public.scrub_account_deletion_survivors(');
        expect(code).toContain('direct_target RECORD');
        expect(code).toContain('SET reviewed_by = NULL');
    });
});

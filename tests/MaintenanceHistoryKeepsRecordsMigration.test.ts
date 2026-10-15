import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// R&M keeps a task's service history when the task is deleted (131-B7, binder
// audit MAINT-02). Shane said yes to the change, but the push needs his own
// Supabase sign-in, so it is written HELD: supabase db push applies every file
// in supabase/migrations. Until it runs the app asks as 126-B7a did (the
// records go with the task: tests/MaintenanceDeleteConfirm.test.tsx), and
// finds it by a column probe of task_title (tests/MaintenanceKeepsHistory131.test.tsx).
// It is released by moving it into supabase/migrations under a stamp newer
// than the newest applied one, and this test is rewritten in that same commit
// to read the released file and assert the held copy is gone (the b85cd258d
// vault-limits release).
const FILE = '20261015120000_maintenance_history_keeps_records.sql';
const held = join(process.cwd(), 'supabase/held-migrations');
const release = join(process.cwd(), 'supabase/migrations');
const migration = readFileSync(join(held, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');

describe('maintenance_history keeps its records migration', () => {
    it('is held out of supabase/migrations, so a release push cannot apply it', () => {
        expect(readdirSync(release).filter((name) => name.includes('maintenance_history_keeps'))).toEqual([]);
        expect(readdirSync(release).filter((name) => name.startsWith('20261015120000_'))).toEqual([]);
        expect(existsSync(join(held, FILE))).toBe(true);
        // Newer than the newest applied migration when it was written: a fixed
        // stamp, so releasing a sibling held file first cannot fail this one.
        expect(FILE > '20261013091000_vessel_vault_limits.sql').toBe(true);
    });

    it('adds the nullable snapshot column and lets a record outlive its task', () => {
        expect(sql).toContain('ALTER TABLE public.maintenance_history ADD COLUMN IF NOT EXISTS task_title TEXT;');
        expect(sql).not.toMatch(/task_title TEXT NOT NULL/i);
        expect(sql).toContain('ALTER TABLE public.maintenance_history ALTER COLUMN task_id DROP NOT NULL;');
        // The records' key to their task nulls the task instead of deleting the record.
        expect(sql).toContain(
            'ADD CONSTRAINT maintenance_history_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.maintenance_tasks(id) ON DELETE SET NULL;',
        );
        expect(sql).not.toMatch(/ON DELETE CASCADE/i);
        expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM/i);
    });

    it('finds the old cascading key by what it is, not by a name, and replaces only a key that does not SET NULL', () => {
        expect(sql).toContain("constraint_row.conrelid = 'public.maintenance_history'::regclass");
        expect(sql).toContain("constraint_row.confrelid = 'public.maintenance_tasks'::regclass");
        expect(sql).toContain('constraint_row.conkey = ARRAY[task_column]');
        expect(sql).toContain("constraint_row.confdeltype <> 'n'");
        expect(sql).toContain(
            "EXECUTE format('ALTER TABLE public.maintenance_history DROP CONSTRAINT %I', fk.conname);",
        );
        expect(sql).not.toMatch(/DROP CONSTRAINT (?:IF EXISTS )?maintenance_history_task_id_fkey/i);
    });

    it("writes the task's name onto its records before the key clears them, from a definer nobody may call", () => {
        expect(sql).toContain(
            'CREATE OR REPLACE FUNCTION public.maintenance_history_keep_task_title() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public',
        );
        expect(sql).toContain(
            'UPDATE public.maintenance_history SET task_title = OLD.title WHERE task_id = OLD.id AND task_title IS DISTINCT FROM OLD.title; RETURN OLD;',
        );
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.maintenance_history_keep_task_title() FROM PUBLIC, anon, authenticated;',
        );
        expect(sql).toContain(
            'CREATE TRIGGER maintenance_tasks_keep_history_title BEFORE DELETE ON public.maintenance_tasks FOR EACH ROW EXECUTE FUNCTION public.maintenance_history_keep_task_title();',
        );
        expect(sql).not.toMatch(/\bGRANT\b/i);
    });

    it('keeps the same readers: no policy, RLS or publication change', () => {
        expect(sql).not.toMatch(/\bPOLICY\b/i);
        expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
        expect(sql).not.toMatch(/PUBLICATION/i);
    });

    it('is safe to re-run, bounded on its lock, and has no transaction of its own', () => {
        expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
        expect(sql).toContain(
            'DROP TRIGGER IF EXISTS maintenance_tasks_keep_history_title ON public.maintenance_tasks;',
        );
        expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/);
        expect(sql).toMatch(/COMMENT ON COLUMN public\.maintenance_history\.task_title IS/);
        // The header says how the app finds it, and how to undo it.
        expect(migration).toContain('services/vessel/maintenanceHistoryColumn.ts');
        expect(migration).toMatch(/-- Undo\n/);
    });
});

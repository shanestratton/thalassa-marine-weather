-- R&M keeps a task's service history when the task is deleted (2026-10-15,
-- build 132, package 131-B7; binder audit MAINT-02, the lasting half of
-- 126-B7a).
--
-- HELD. Shane said yes to the change, but the push needs his own Supabase
-- sign-in: supabase db push applies every pending file in supabase/migrations,
-- and Shane pushes this one himself. Release it by moving it into
-- supabase/migrations under a stamp newer than the newest applied migration
-- and, in the same commit, rewriting
-- tests/MaintenanceHistoryKeepsRecordsMigration.test.ts to read the released
-- file and assert the held copy is gone (the b85cd258d vault-limits release),
-- then push.
--
-- Until it runs the app works as 126-B7a left it: maintenance_history.task_id
-- is ON DELETE CASCADE, so a deleted task takes its records with it on every
-- device, and R&M says so before the delete ("Its 3 service records go with
-- it, on every device"), offering Pause first. The app looks for this
-- migration with a column probe of task_title
-- (services/vessel/maintenanceHistoryColumn.ts). Once the probe answers, a
-- delete keeps the records, R&M says "Its 3 service records stay in your
-- service history", and the service history PDF lists them under the task's
-- name, marked "(task removed)".
--
-- What
-- ────
-- * task_title TEXT, nullable: the task's name, written onto its records as
--   the task is deleted. Null on every record whose task is still there (R&M
--   reads the name from the task), and on every record written before this.
-- * task_id loses NOT NULL, and its foreign key to maintenance_tasks becomes
--   ON DELETE SET NULL (it was CASCADE): the task goes, its records stay, with
--   no task. Found by what it is, not by its name: the base migration
--   (20260219000000) and the legacy script both declared it inline, unnamed.
-- * maintenance_history_keep_task_title(): BEFORE DELETE on maintenance_tasks,
--   it writes OLD.title onto the task's own records before the foreign key
--   clears their task_id. Every delete gets it, a 131 phone's included, so no
--   phone has to send the name. SECURITY DEFINER with a pinned search_path, so
--   a column grant the deleting skipper lacks cannot refuse it; it writes only
--   the deleted task's records, and only a delete RLS already allowed fires it
--   (task deletes are the owner's, 20260723100000). Nobody may call it:
--   EXECUTE is revoked from PUBLIC, anon and authenticated.
--
-- Account deletion is unchanged. scrub_account_deletion_survivors
-- (20260905101000) deletes the leaver's maintenance_history before their
-- maintenance_tasks (it walks the tables by name), in scrub mode, so neither
-- the trigger nor the SET NULL finds a record of theirs to write, and the
-- write fence on maintenance_history (BEFORE INSERT OR UPDATE) is not asked.
--
-- Who reads it: exactly the records' readers. The table's policies are
-- row-level (can_access_vessel_register, 20260723100000), so the skipper, and
-- crew he shares R&M with, read a record's task_title as they read its notes.
-- No policy, grant or publication change: maintenance_history is already in
-- supabase_realtime (20261002150000), and the SET NULL is an UPDATE, which
-- bumps updated_at (trg_maintenance_history_updated_at), so every phone pulls
-- the kept records on its next sync.
--
-- Undo
-- ────
--     DROP TRIGGER IF EXISTS maintenance_tasks_keep_history_title ON public.maintenance_tasks;
--     DROP FUNCTION IF EXISTS public.maintenance_history_keep_task_title();
-- then, ONLY with Shane's yes, because it deletes the records kept since:
--     DELETE FROM public.maintenance_history WHERE task_id IS NULL;
--     ALTER TABLE public.maintenance_history DROP CONSTRAINT maintenance_history_task_id_fkey;
--     ALTER TABLE public.maintenance_history ADD CONSTRAINT maintenance_history_task_id_fkey
--         FOREIGN KEY (task_id) REFERENCES public.maintenance_tasks(id) ON DELETE CASCADE;
--     ALTER TABLE public.maintenance_history ALTER COLUMN task_id SET NOT NULL;
--     ALTER TABLE public.maintenance_history DROP COLUMN task_title;
-- (the app then asks as 126-B7a did: its probe no longer finds task_title,
-- after the hour a session remembers it for, or on the next launch).
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS, DROP NOT NULL is a no-op on a
-- nullable column, the foreign key is replaced only while it does not already
-- SET NULL, and CREATE OR REPLACE / DROP TRIGGER IF EXISTS. ALTER TABLE locks
-- two small tables (a row per task, a row per service); the lock wait is
-- bounded, so a busy table fails the push (retry it) instead of queueing the
-- app behind it. No BEGIN or COMMIT here: the pre-push replay runs this file
-- inside a rolled-back transaction.
--
-- Check it after the push, as the skipper in a rolled-back transaction,
-- printing counts only: delete a task with records, and its records are still
-- there with task_id null and task_title the task's name.

SET LOCAL lock_timeout = '5s';

DO $precheck$
BEGIN
    IF to_regclass('public.maintenance_tasks') IS NULL OR to_regclass('public.maintenance_history') IS NULL THEN
        RAISE EXCEPTION 'maintenance_history_keeps_records: maintenance_tasks or maintenance_history is missing';
    END IF;
END;
$precheck$;

ALTER TABLE public.maintenance_history ADD COLUMN IF NOT EXISTS task_title TEXT;

ALTER TABLE public.maintenance_history ALTER COLUMN task_id DROP NOT NULL;

DO $keep_records$
DECLARE
    task_column SMALLINT;
    fk RECORD;
BEGIN
    SELECT attribute.attnum
    INTO task_column
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.maintenance_history'::regclass
      AND attribute.attname = 'task_id'
      AND NOT attribute.attisdropped;

    -- Every key from task_id to maintenance_tasks that does not already SET NULL.
    FOR fk IN
        SELECT constraint_row.conname
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.maintenance_history'::regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'public.maintenance_tasks'::regclass
          AND constraint_row.conkey = ARRAY[task_column]
          AND constraint_row.confdeltype <> 'n'
    LOOP
        EXECUTE format('ALTER TABLE public.maintenance_history DROP CONSTRAINT %I', fk.conname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.maintenance_history'::regclass
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'public.maintenance_tasks'::regclass
          AND constraint_row.conkey = ARRAY[task_column]
    ) THEN
        ALTER TABLE public.maintenance_history
            ADD CONSTRAINT maintenance_history_task_id_fkey
            FOREIGN KEY (task_id) REFERENCES public.maintenance_tasks(id) ON DELETE SET NULL;
    END IF;
END;
$keep_records$;

CREATE OR REPLACE FUNCTION public.maintenance_history_keep_task_title()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE public.maintenance_history
    SET task_title = OLD.title
    WHERE task_id = OLD.id
      AND task_title IS DISTINCT FROM OLD.title;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.maintenance_history_keep_task_title() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS maintenance_tasks_keep_history_title ON public.maintenance_tasks;
CREATE TRIGGER maintenance_tasks_keep_history_title
    BEFORE DELETE ON public.maintenance_tasks
    FOR EACH ROW EXECUTE FUNCTION public.maintenance_history_keep_task_title();

COMMENT ON COLUMN public.maintenance_history.task_title IS
    'The task''s name, written onto its records as the task is deleted (2026-10-15, 131-B7); null while the task is there. task_id is ON DELETE SET NULL, so the records stay in the service history.';

-- Watch-schedule edits reach open screens before Publish (2026-10-10, build
-- 126, package 126-19, live drift finding A10).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- WatchAssignmentService.subscribe listens for postgres_changes on
-- watch_assignments (filtered to the voyage), so a schedule screen updates as
-- the skipper assigns watches one at a time. But no migration ever added the
-- table to the supabase_realtime publication, and the read-only drift scan of
-- 2026-10-10 confirmed live does not publish it, so those events never fire.
-- The Publish broadcast still works; what is lost is the edits made before
-- Publish, mostly as seen on the skipper's other devices (crew only see their
-- own rows under RLS anyway).
--
-- What
-- ────
-- The 20261002150000_binder_realtime_publication.sql pattern: when the
-- publication exists and does not already list watch_assignments, the table
-- is added. Nothing else about the publication changes. Realtime applies RLS
-- to INSERT and UPDATE per subscriber. A DELETE carries only the primary key
-- (a random UUID) under the default replica identity; the screen's answer to
-- any event is to re-read its own voyage's schedule, so no row data leaks.
--
-- Undo
-- ────
--     ALTER PUBLICATION supabase_realtime DROP TABLE public.watch_assignments;
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $publish$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'watch_assignments') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.watch_assignments;
    END IF;
END;
$publish$;

DO $check$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        RAISE NOTICE 'watch_assignments_realtime: no supabase_realtime publication in this database; nothing to publish';
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'watch_assignments'
    ) THEN
        RAISE EXCEPTION 'watch_assignments_realtime: watch_assignments is not published';
    END IF;
END;
$check$;

RESET lock_timeout;

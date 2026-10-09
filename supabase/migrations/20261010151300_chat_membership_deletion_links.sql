-- Deleting an account removes that sailor's crew-room memberships and join
-- requests (2026-10-10, build 126, package 126-19, live drift finding B-06).
--
-- Not pushed with this commit: it goes in the 126 release push, before
-- 20261010151400.
--
-- Why
-- ───
-- 20260723090000_security_hardening_core.sql declared channel_members and
-- channel_join_requests with foreign keys to auth.users, a status check, and
-- chat_channels.owner_id / parent_id with ON DELETE SET NULL. Live records it
-- as applied, but the chat tables were built by hand first, so its CREATE
-- TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS were skipped, and none of
-- those keys exist on live (read-only drift scan, 2026-10-10):
-- * no channel_members_user_id_fkey, no channel_join_requests_user_id_fkey or
--   _reviewed_by_fkey, no status check, no chat_channels_owner_id_fkey;
-- * chat_channels_parent_id_fkey is NO ACTION, so deleting a channel that has
--   sub-channels (2 live channels have a parent) fails with 23503 instead of
--   detaching them.
-- Account deletion finds a sailor's rows through the foreign keys to
-- auth.users (scrub_account_deletion_survivors, 20260905101000, and the auth
-- cascade). With no keys here, a deleted sailor's crew-room memberships and
-- join requests, free-text message included, survive the deletion, and it
-- still reports clean. Neither table had a deletion fence either.
--
-- Live facts it depends on (2026-10-10 scan; re-check before the push): 2
-- memberships, 0 join requests, 0 orphans (no row naming a user or channel
-- that does not exist) and 0 bad statuses. An orphan or a bad status would
-- make an ADD CONSTRAINT fail, and the push would stop, changing nothing.
--
-- What
-- ────
-- Each key and ON DELETE rule exactly as 20260723090000 declared it, each
-- added only when missing (by name):
--   channel_members.user_id           → auth.users  ON DELETE CASCADE
--   channel_join_requests.user_id     → auth.users  ON DELETE CASCADE
--   channel_join_requests.reviewed_by → auth.users  ON DELETE SET NULL
--   chat_channels.owner_id            → auth.users  ON DELETE SET NULL
--   chat_channels.parent_id           → chat_channels ON DELETE SET NULL
--     (replaced only when it is not already SET NULL)
-- the status check (pending, approved, rejected), and
-- account_deletion_write_fence on channel_members and channel_join_requests
-- (user_id), as on every other user-owned table (20260806120000). Not on
-- chat_channels: a fence on owner_id would refuse other sailors' writes to a
-- room whose owner is mid-deletion; the scrub already nulls owner_id.
-- The NOT NULL tightenings 20260723090000 also declared are left out: no
-- NULLs exist and they protect nothing today.
--
-- Adding a foreign key briefly takes a SHARE ROW EXCLUSIVE lock on the table
-- and on auth.users while it validates (milliseconds at this size);
-- lock_timeout bounds the wait so sign-ins never queue behind it.
--
-- Known limit, not changed here: protect_channel_join_request_update
-- (20260723090000, live) refuses any UPDATE of a request that is no longer
-- pending. Two UPDATEs null reviewed_by when a reviewer's account goes:
-- * the scrub's own UPDATE, so the in-app deletion of a sailor who has
--   approved or rejected a join request stops there, with or without this
--   file;
-- * from this file on, the auth cascade too: the reviewed_by key's
--   ON DELETE SET NULL runs an UPDATE that fires the trigger, so deleting
--   that sailor's auth user directly (Dashboard, or auth.admin.deleteUser
--   without the scrub) also fails ('Only a pending request decision may be
--   updated'), where before this file it went through and left reviewed_by
--   pointing at no one.
-- Live holds 0 join requests, so neither can happen yet. Follow-up: let the
-- trigger allow a change that only sets reviewed_by to NULL when it is not
-- a signed-in client making it (the scrub or the key's cascade).
--
-- Undo
-- ────
-- Drop the five constraints and the two triggers by name; parent_id goes back
-- to NO ACTION with DROP + ADD ... REFERENCES public.chat_channels(id).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $repair$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.channel_members'::regclass AND conname = 'channel_members_user_id_fkey') THEN
        ALTER TABLE public.channel_members ADD CONSTRAINT channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.channel_join_requests'::regclass AND conname = 'channel_join_requests_user_id_fkey') THEN
        ALTER TABLE public.channel_join_requests ADD CONSTRAINT channel_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.channel_join_requests'::regclass AND conname = 'channel_join_requests_reviewed_by_fkey') THEN
        ALTER TABLE public.channel_join_requests ADD CONSTRAINT channel_join_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.channel_join_requests'::regclass AND conname = 'channel_join_requests_status_check') THEN
        ALTER TABLE public.channel_join_requests ADD CONSTRAINT channel_join_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_channels'::regclass AND conname = 'chat_channels_owner_id_fkey') THEN
        ALTER TABLE public.chat_channels ADD CONSTRAINT chat_channels_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_channels'::regclass AND conname = 'chat_channels_parent_id_fkey' AND confdeltype = 'n') THEN
        ALTER TABLE public.chat_channels DROP CONSTRAINT IF EXISTS chat_channels_parent_id_fkey;
        ALTER TABLE public.chat_channels ADD CONSTRAINT chat_channels_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.chat_channels(id) ON DELETE SET NULL;
    END IF;
END;
$repair$;

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.channel_members;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.channel_members
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.channel_join_requests;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.channel_join_requests
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DO $check$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(w.conname, ', ')
      INTO missing
      FROM (VALUES
          ('public.channel_members', 'channel_members_user_id_fkey', 'c'),
          ('public.channel_join_requests', 'channel_join_requests_user_id_fkey', 'c'),
          ('public.channel_join_requests', 'channel_join_requests_reviewed_by_fkey', 'n'),
          ('public.chat_channels', 'chat_channels_owner_id_fkey', 'n'),
          ('public.chat_channels', 'chat_channels_parent_id_fkey', 'n')
      ) AS w(tbl, conname, deltype)
     WHERE NOT EXISTS (
         SELECT 1
           FROM pg_constraint AS c
          WHERE c.conrelid = w.tbl::regclass
            AND c.conname = w.conname
            AND c.contype = 'f'
            AND c.confdeltype = w.deltype::"char"
            AND c.convalidated
     );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'chat_membership_deletion_links: missing or wrong ON DELETE: %', missing;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.channel_join_requests'::regclass
           AND conname = 'channel_join_requests_status_check'
           AND contype = 'c'
    ) THEN
        RAISE EXCEPTION 'chat_membership_deletion_links: channel_join_requests_status_check is missing';
    END IF;

    IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'account_deletion_write_fence' AND NOT tgisinternal AND tgenabled <> 'D' AND tgrelid IN ('public.channel_members'::regclass, 'public.channel_join_requests'::regclass)) <> 2 THEN
        RAISE EXCEPTION 'chat_membership_deletion_links: a deletion fence is missing';
    END IF;
END;
$check$;

RESET lock_timeout;

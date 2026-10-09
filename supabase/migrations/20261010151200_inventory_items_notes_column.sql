-- Cooking Mode leftovers reach Ship's Stores on every device (2026-10-10,
-- build 126, package 126-19, live drift finding A3).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- When a meal is cooked with leftovers, Cooking Mode saves a "(Leftovers)"
-- Stores item (MealPlanService.saveLeftovers). Its outbox INSERT carries a
-- notes key, but inventory_items has never had a notes column, live or in any
-- migration (the read-only drift scan of 2026-10-10 found 17 columns, none of
-- them notes). PostgREST refuses a payload naming a column the table lacks
-- (PGRST204), so the item never leaves the phone, and every later edit to it
-- is fenced too. Other devices see "leftovers saved" on the meal but get no
-- Stores item. Live held 0 leftovers rows.
--
-- Adding the column, rather than changing the app to stop sending notes, is
-- the recommendation: items already stuck in phone outboxes push on their
-- next sync cycle with no app release.
--
-- notes is the only column the insert sends that live lacks. It also sends
-- expiry_date, and live already has that (a nullable date, column 13, added
-- by hand and never declared in a migration; package 126-B9c only records
-- it in the migrations). A Postgres date column takes the date part of the
-- ISO timestamp string the app sends, so leftovers sync as soon as this file
-- is in, with or without 126-B9c.
--
-- What
-- ────
-- A nullable notes text column: no default, constraint, index or backfill,
-- so it changes the catalogue only (no table rewrite, a lock for
-- milliseconds). Table grants cover new columns, so the app can write it at
-- once; the self-check proves that. The NOTIFY makes PostgREST reload its
-- schema cache so the next push finds the column.
--
-- Undo
-- ────
--     ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS notes;
-- (leftovers would stop syncing again).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS notes TEXT;

NOTIFY pgrst, 'reload schema';

DO $check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'inventory_items'
           AND column_name = 'notes'
           AND data_type = 'text'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'inventory_items_notes_column: inventory_items.notes (nullable text) is missing';
    END IF;
    IF NOT has_column_privilege('authenticated', 'public.inventory_items', 'notes', 'INSERT')
       OR NOT has_column_privilege('authenticated', 'public.inventory_items', 'notes', 'UPDATE') THEN
        RAISE EXCEPTION 'inventory_items_notes_column: the app cannot write inventory_items.notes';
    END IF;
END;
$check$;

RESET lock_timeout;

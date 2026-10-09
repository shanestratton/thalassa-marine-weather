-- Ship's Stores expiry dates, recorded in the migrations (2026-10-10, build
-- 126, package 126-B9c, binder audit finding STORES-02).
--
-- Not pushed with this commit: it goes in the 126 release push, on Shane's yes.
--
-- A no-op on live
-- ───────────────
-- Live's inventory_items already has expiry_date, a nullable DATE (verified
-- read-only on 2026-10-10), so on live ADD COLUMN IF NOT EXISTS does nothing
-- and the self-check passes. Stores items with an expiry date sync on live
-- today, with or without this file.
--
-- Why it exists
-- ─────────────
-- The column was added by hand, never by a migration. The base table
-- (20260219000000) and the later ALTERs (unit 20260322080300, currency,
-- unit_value and unit_system 20260322100100, NUMERIC quantity 20260723102000,
-- notes 20261010151200) leave it out, yet the app sends expiry_date with every
-- Stores insert (StoresItem in types/vessel.ts, InventoryScanner, the edit
-- sheet) and the sync engine upserts the whole payload. A database built from
-- the migrations alone (a branch, a restore, a new project) would refuse that
-- payload (PGRST204) and fence the item in the outbox. This file makes the
-- migrations match live, so no such database is ever short of the column.
--
-- What
-- ────
-- A nullable expiry_date DATE: no default, constraint, index or backfill; no
-- RLS, grant or publication change. DATE, because the app sends 'YYYY-MM-DD'
-- from a date input and a DATE comes back the same way (not the
-- '…T00:00:00+00:00' a TIMESTAMPTZ returns). Where the column is new it
-- changes the catalogue only (no table rewrite, a lock for milliseconds).
-- Table grants cover new columns; the self-check proves the app can write it.
-- The NOTIFY makes PostgREST reload its schema cache, harmless where nothing
-- changed.
--
-- Undo
-- ────
-- None on live: the column predates this file. Where this file created it:
--     ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS expiry_date;
--
-- No BEGIN/COMMIT: the CLI applies the file, and a rolled-back rehearsal can
-- run it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE;

NOTIFY pgrst, 'reload schema';

DO $check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'inventory_items'
           AND column_name = 'expiry_date'
           AND data_type = 'date'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'inventory_items_expiry_date: inventory_items.expiry_date (nullable date) is missing';
    END IF;
    IF NOT has_column_privilege('authenticated', 'public.inventory_items', 'expiry_date', 'INSERT')
       OR NOT has_column_privilege('authenticated', 'public.inventory_items', 'expiry_date', 'UPDATE') THEN
        RAISE EXCEPTION 'inventory_items_expiry_date: the app cannot write inventory_items.expiry_date';
    END IF;
END;
$check$;

RESET lock_timeout;

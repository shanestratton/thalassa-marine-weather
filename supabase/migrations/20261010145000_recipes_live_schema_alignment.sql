-- Galley recipes can reach the server again (2026-10-10, build 126, plan
-- 126-B2b review): live's recipes table gets the two columns its migration
-- declared.
--
-- Not pushed with this commit: it waits for Shane's yes. Push it BEFORE, or
-- with, build 126 (see "Order"). Re-running it is harmless.
--
-- Why
-- ───
-- 20260322090000_recipes.sql declares recipes.spoonacular_id INTEGER and
-- recipes.source_url TEXT, and live records it as applied. But live's recipes
-- table predates it, so its CREATE TABLE IF NOT EXISTS never ran there: a
-- read-only probe of information_schema.columns on 2026-10-10 found neither
-- column. Every recipes row the app queues carries both keys, the outbox
-- sends a payload's keys as they are, and PostgREST refuses a write that
-- names a column the table does not have (PGRST204). So no recipe has ever
-- reached live through the outbox. The one live row came from the old direct
-- upsert in createCustomRecipe, which sent neither key. 126-B2a removed that
-- upsert (it lost is_custom, GAL-03), so from 126 a recipe written in the
-- Galley, and every stuck copy the 126 outbox repair frees, waits on the phone
-- that made it until this lands. It is kept, not lost: the next sync cycle
-- after the push sends it.
--
-- What
-- ────
-- The two nullable columns, exactly as 20260322090000 declares them. No
-- default, backfill, constraint, index, policy, grant or trigger: adding a
-- nullable column without a default changes the catalogue only (no table
-- rewrite, a lock for milliseconds). Existing rows read NULL for both, which
-- is what a Galley-made recipe has. A database built from the migrations has
-- both columns already, and this changes nothing there. The NOTIFY makes
-- PostgREST reload its schema cache, so the next push finds the columns.
--
-- Order
-- ─────
-- It sorts before 20261010150000_recipes_is_custom_repair.sql, so one push
-- runs both, this first. That repair reads spoonacular_id through to_jsonb,
-- so it is right with or without these columns.
--
-- Older builds: a recipes item PostgREST has refused until now (a recipe
-- saved from the Captain's Table, an edit queued behind a Galley recipe's
-- outbox INSERT) pushes on that phone's next cycle, as the outbox always
-- meant it to. One carrying a search result's fake id is still refused (it
-- does not fit an INTEGER) until that phone runs 126's outbox repair.

ALTER TABLE public.recipes
    ADD COLUMN IF NOT EXISTS spoonacular_id INTEGER,
    ADD COLUMN IF NOT EXISTS source_url TEXT;

NOTIFY pgrst, 'reload schema';

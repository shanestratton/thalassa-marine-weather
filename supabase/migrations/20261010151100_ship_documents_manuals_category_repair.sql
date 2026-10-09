-- Documents filed under Manuals reach the server (2026-10-10, build 126,
-- package 126-19, live drift finding A1 = B-01).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- 20260301090000_ship_documents_add_manuals_category.sql re-created
-- ship_documents_category_check with 'User Manuals' as a sixth category, and
-- live records it as applied. But the read-only drift scan of 2026-10-10
-- found live's check still allowing only the original five. The app offers
-- User Manuals in the document form (DocumentCategory, types/vessel.ts), so
-- every outbox push of such a document is refused with 23514 (a CHECK is
-- tested before ON CONFLICT, so ignoreDuplicates does not help). The record,
-- and every later edit to it, stays fenced on the phone that made it: it never
-- reaches the crew or the sailor's other devices, and each retry uploads the
-- attachment again. Live held 0 ship_documents rows, so no server data is
-- affected; items already stuck push on each phone's next sync cycle.
--
-- What
-- ────
-- When the check does not name 'User Manuals', it is dropped and added again
-- with the six values 20260301090000 declared (and DocumentCategory lists),
-- in the same order. When it already does (a database built from the
-- migrations, or a re-run), nothing changes. Adding the check validates the
-- existing rows; any row the five-value check allowed passes the six-value
-- one, so this cannot fail on data.
--
-- Undo
-- ────
-- Not wanted: it would refuse Manuals again. If ever needed, re-add the check
-- with the five values, after moving any Manuals rows to another category.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $repair$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint AS c
         WHERE c.conrelid = 'public.ship_documents'::regclass
           AND c.conname = 'ship_documents_category_check'
           AND c.contype = 'c'
           AND position('''User Manuals''' IN pg_get_constraintdef(c.oid)) > 0
    ) THEN
        ALTER TABLE public.ship_documents DROP CONSTRAINT IF EXISTS ship_documents_category_check;
        ALTER TABLE public.ship_documents ADD CONSTRAINT ship_documents_category_check CHECK (category IN ('Registration', 'Insurance', 'Crew Visas/IDs', 'Radio/MMSI', 'Customs Clearances', 'User Manuals'));
    END IF;
END;
$repair$;

DO $check$
DECLARE
    def TEXT;
    wanted TEXT;
BEGIN
    SELECT pg_get_constraintdef(c.oid)
      INTO def
      FROM pg_constraint AS c
     WHERE c.conrelid = 'public.ship_documents'::regclass
       AND c.conname = 'ship_documents_category_check'
       AND c.contype = 'c';
    IF def IS NULL THEN
        RAISE EXCEPTION 'ship_documents_manuals_category_repair: the category check is missing';
    END IF;
    FOREACH wanted IN ARRAY ARRAY['Registration', 'Insurance', 'Crew Visas/IDs', 'Radio/MMSI', 'Customs Clearances', 'User Manuals'] LOOP
        IF position(quote_literal(wanted) IN def) = 0 THEN
            RAISE EXCEPTION 'ship_documents_manuals_category_repair: % is not allowed by the category check', wanted;
        END IF;
    END LOOP;
END;
$check$;

RESET lock_timeout;

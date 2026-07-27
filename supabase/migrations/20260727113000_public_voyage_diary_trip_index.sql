-- Public Voyage Log trip selector (2026-07-27).
--
-- A selected recorded trip reads only the owner's published diary rows for
-- one voyage, newest-first. The existing public-feed index is keyed only by
-- user and timestamp; this narrower partial index avoids scanning unrelated
-- public entries as a skipper's diary grows, while keeping unassigned rows
-- in the separate "All diary entries" view.

CREATE INDEX IF NOT EXISTS diary_entries_public_user_voyage_created_idx
    ON public.diary_entries (user_id, voyage_id, created_at DESC)
    WHERE is_public = true AND voyage_id IS NOT NULL;

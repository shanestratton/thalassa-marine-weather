-- ═══════════════════════════════════════════════════════════════
-- Voyage Log — split byline into name parts
-- Run AFTER 20260516130000_crew_to_boat_bridge.sql.
--
-- boat_members.display_name was a single freeform string. Two crew
-- with the same first name (e.g. two Shanes) collided silently — both
-- rendered as "by Shane" on the combined log.
--
-- This migration splits the byline into four parts (prefix, first_name,
-- nickname, last_name) and makes display_name a GENERATED column that
-- composes them as: [Prefix] First ["Nick"] Last
--
-- Examples:
--   Shane Stratton
--   Capt. Shane Stratton
--   Shane "Skipper" Stratton
--   Capt. Shane "Skipper" Stratton
--   Dr. Emma Hayes
--
-- A UNIQUE constraint on (boat_id, lower(display_name)) prevents two
-- identical rendered bylines on the same boat — the iOS crew-invite UI
-- (separate session) will surface the conflict at acceptance time.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Add the four parts ──────────────────────────────────────
ALTER TABLE public.boat_members
    ADD COLUMN IF NOT EXISTS prefix     TEXT,
    ADD COLUMN IF NOT EXISTS first_name TEXT,
    ADD COLUMN IF NOT EXISTS nickname   TEXT,
    ADD COLUMN IF NOT EXISTS last_name  TEXT;

-- ── 2. Backfill from existing display_name (best-effort) ───────
-- Splits on first space: 'Shane Stratton' → ('Shane', 'Stratton'),
-- 'Shane' → ('Shane', NULL). Anything fancier is the user's to edit.
UPDATE public.boat_members
   SET first_name = COALESCE(NULLIF(split_part(display_name, ' ', 1), ''), 'Crew'),
       last_name  = NULLIF(substr(display_name, length(split_part(display_name, ' ', 1)) + 2), '')
 WHERE first_name IS NULL;

-- ── 3. first_name is required from here on ─────────────────────
ALTER TABLE public.boat_members ALTER COLUMN first_name SET NOT NULL;

-- ── 4. Replace display_name with a generated column ────────────
-- Postgres won't ALTER an existing column to GENERATED — drop + readd.
-- Old data is preserved by the backfill above; the generated value
-- recomputes on every INSERT/UPDATE.
ALTER TABLE public.boat_members DROP COLUMN display_name;

ALTER TABLE public.boat_members
    ADD COLUMN display_name TEXT GENERATED ALWAYS AS (
        trim(both ' ' from
            COALESCE(prefix || ' ', '') ||
            first_name ||
            COALESCE(' "' || nickname || '"', '') ||
            COALESCE(' ' || last_name, '')
        )
    ) STORED;

-- ── 5. Per-boat byline uniqueness (case-insensitive) ───────────
-- Two crew can't render to the same byline on the same boat. The iOS
-- invite-accept UI is expected to catch the conflict and prompt the
-- owner to disambiguate (e.g. "Shane B" or "Shane the Younger").
CREATE UNIQUE INDEX IF NOT EXISTS uq_boat_members_byline_per_boat
    ON public.boat_members (boat_id, lower(display_name));

-- ── 6. Bridge trigger: write to first_name, not display_name ───
-- display_name is generated now and can't be set directly. The crew
-- invite still derives a sensible default first_name from auth data;
-- the owner can edit afterwards.
CREATE OR REPLACE FUNCTION public.sync_vessel_crew_to_boat_members()
RETURNS TRIGGER AS $$
DECLARE
    captain_boat_id UUID;
    target_owner_id UUID;
    target_crew_id  UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_owner_id := OLD.owner_id;
        target_crew_id  := OLD.crew_user_id;
    ELSE
        target_owner_id := NEW.owner_id;
        target_crew_id  := NEW.crew_user_id;
    END IF;

    IF target_crew_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT id INTO captain_boat_id
      FROM public.boats
     WHERE owner_id = target_owner_id
     LIMIT 1;

    IF captain_boat_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'accepted' THEN
        INSERT INTO public.boat_members (boat_id, user_id, first_name, role)
        VALUES (captain_boat_id, target_crew_id,
                public.user_display_name(target_crew_id), 'crew')
        ON CONFLICT (boat_id, user_id) DO NOTHING;
    ELSIF TG_OP = 'DELETE'
       OR (TG_OP = 'UPDATE' AND NEW.status = 'declined') THEN
        DELETE FROM public.boat_members
         WHERE boat_id = captain_boat_id
           AND user_id = target_crew_id
           AND role = 'crew';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════
-- Inspect with:
--   SELECT b.name, prefix, first_name, nickname, last_name,
--          display_name AS rendered_byline, role
--     FROM public.boats b
--     JOIN public.boat_members m ON m.boat_id = b.id;
-- ═══════════════════════════════════════════════════════════════

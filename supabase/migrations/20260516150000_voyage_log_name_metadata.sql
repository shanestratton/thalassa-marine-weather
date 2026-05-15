-- ═══════════════════════════════════════════════════════════════
-- Voyage Log — read byline parts from auth.users.raw_user_meta_data
-- Run AFTER 20260516140000_voyage_log_byline_parts.sql.
--
-- Onboarding now writes four keys into auth.users.raw_user_meta_data:
--   prefix      (optional)  'Capt.', 'Dr.', …
--   first_name  (required)
--   last_name   (required)
--   nickname    (optional)
-- This migration teaches the crew-invite bridge to read those parts
-- and populate boat_members with the full structure (not just a
-- single-string first_name like before).
--
-- Collision handling: if the rendered display_name (prefix + first +
-- "nickname" + last) clashes with another crew member on the same
-- boat, the trigger appends a numeric suffix to first_name and retries
-- (Shane → 'Shane 2'). Ugly but acceptance never fails silently; the
-- owner can clean it up via SQL or the eventual byline-edit UI.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. New helper: read the four parts from auth metadata ──────
-- Falls back to email local-part for first_name if metadata is empty,
-- so legacy users (signed up before the four-box onboarding) still
-- get something sensible.
CREATE OR REPLACE FUNCTION public.user_name_parts(p_user_id UUID)
RETURNS TABLE(prefix TEXT, first_name TEXT, last_name TEXT, nickname TEXT) AS $$
DECLARE
    meta JSONB;
    email_local TEXT;
BEGIN
    SELECT raw_user_meta_data, split_part(email, '@', 1)
      INTO meta, email_local
      FROM auth.users
     WHERE id = p_user_id;

    prefix     := NULLIF(meta->>'prefix', '');
    first_name := NULLIF(meta->>'first_name', '');
    last_name  := NULLIF(meta->>'last_name', '');
    nickname   := NULLIF(meta->>'nickname', '');

    -- Fallback for legacy / no-metadata users.
    IF first_name IS NULL THEN
        first_name := COALESCE(NULLIF(initcap(email_local), ''), 'Crew');
    END IF;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ── 2. Bridge trigger: populate all four parts, auto-suffix on collision ──
CREATE OR REPLACE FUNCTION public.sync_vessel_crew_to_boat_members()
RETURNS TRIGGER AS $$
DECLARE
    captain_boat_id UUID;
    target_owner_id UUID;
    target_crew_id  UUID;
    parts RECORD;
    candidate_first TEXT;
    suffix INT := 1;
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
        SELECT * INTO parts FROM public.user_name_parts(target_crew_id);
        candidate_first := parts.first_name;

        -- Retry loop: on byline-collision, suffix first_name and try again.
        -- The (boat_id, user_id) primary key collision is a no-op (idempotent
        -- re-accept); the display_name unique index is the one we suffix for.
        LOOP
            BEGIN
                INSERT INTO public.boat_members
                    (boat_id, user_id, prefix, first_name, last_name, nickname, role)
                VALUES
                    (captain_boat_id, target_crew_id,
                     parts.prefix, candidate_first, parts.last_name, parts.nickname,
                     'crew')
                ON CONFLICT (boat_id, user_id) DO NOTHING;
                EXIT;  -- success
            EXCEPTION WHEN unique_violation THEN
                suffix := suffix + 1;
                candidate_first := parts.first_name || ' ' || suffix;
                IF suffix > 99 THEN
                    -- Sanity bail-out — 99 same-named crew is a different problem.
                    EXIT;
                END IF;
            END;
        END LOOP;

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

-- ── 3. Mirror existing owners' parts from auth metadata if present ──
-- For boat owners who already filled in the new onboarding fields,
-- pull their parts in now. No-op for owners whose metadata is empty.
DO $$
DECLARE
    bm RECORD;
    parts RECORD;
BEGIN
    FOR bm IN SELECT user_id, boat_id FROM public.boat_members WHERE role = 'owner' LOOP
        SELECT * INTO parts FROM public.user_name_parts(bm.user_id);
        UPDATE public.boat_members
           SET prefix     = COALESCE(parts.prefix, prefix),
               first_name = COALESCE(parts.first_name, first_name),
               last_name  = COALESCE(parts.last_name, last_name),
               nickname   = COALESCE(parts.nickname, nickname)
         WHERE user_id = bm.user_id AND boat_id = bm.boat_id
           AND parts.first_name IS NOT NULL
           -- Only overwrite if metadata genuinely has data — don't blank out
           -- a manually-edited field with a NULL fallback.
           AND EXISTS (SELECT 1 FROM auth.users u
                        WHERE u.id = bm.user_id
                          AND (u.raw_user_meta_data ? 'first_name'
                            OR u.raw_user_meta_data ? 'last_name'));
    END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- Inspect with:
--   SELECT b.name, prefix, first_name, nickname, last_name,
--          display_name AS rendered_byline, role
--     FROM public.boats b
--     JOIN public.boat_members m ON m.boat_id = b.id;
-- ═══════════════════════════════════════════════════════════════

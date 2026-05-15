-- ═══════════════════════════════════════════════════════════════
-- Voyage Log — bridge existing vessel_crew invites → boat_members
-- Run AFTER 20260516120000_voyage_log_boats.sql.
--
-- The app already has a crew-invite flow on vessel_crew (Settings →
-- Crew Management → "+ Invite Crew"). When a crew member accepts, we
-- now also mirror them into boat_members so their published diary
-- entries appear on the boat's combined voyage log with a byline.
--
-- All of this is server-side. The iOS app doesn't need to know about
-- boats/boat_members — accepting a vessel_crew invite is the same
-- gesture it always was.
--
-- Also fixes a display-name bug from the previous migration where the
-- boat owner's byline was set to the FIRST WORD OF THE VESSEL NAME
-- ("Serene") instead of derived from the user ("Shane").
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Display-name helper ─────────────────────────────────────
-- Prefer a name the user has explicitly set in auth metadata; fall
-- back to the email local-part. Never returns NULL.
CREATE OR REPLACE FUNCTION public.user_display_name(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
    result TEXT;
BEGIN
    SELECT COALESCE(
               NULLIF(u.raw_user_meta_data->>'full_name', ''),
               NULLIF(u.raw_user_meta_data->>'name', ''),
               NULLIF(initcap(split_part(u.email, '@', 1)), ''),
               'Crew'
           )
      INTO result
      FROM auth.users u
     WHERE u.id = p_user_id;
    RETURN COALESCE(result, 'Crew');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ── 2. Fix the boat-owner display_name bug ─────────────────────
-- Prior migration used split_part(vessel_name, ' ', 1) — wrong axis.
UPDATE public.boat_members bm
   SET display_name = public.user_display_name(bm.user_id)
 WHERE bm.role = 'owner';

-- ── 3. Bridge trigger: vessel_crew ⇄ boat_members ──────────────
-- - INSERT/UPDATE to status='accepted' with crew_user_id    → add member
-- - INSERT/UPDATE to status='declined'                       → remove
-- - DELETE                                                   → remove
--
-- Assumes one boat per captain. Multi-boat captains are a future
-- problem; for now we pick the first row (the one created by the
-- prior migration's backfill).
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

    -- Can't bridge without a captain's boat or a known crew user.
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

    -- Accepted → ensure boat_members row exists.
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'accepted' THEN
        INSERT INTO public.boat_members (boat_id, user_id, display_name, role)
        VALUES (captain_boat_id, target_crew_id,
                public.user_display_name(target_crew_id), 'crew')
        ON CONFLICT (boat_id, user_id) DO NOTHING;

    -- Declined or deleted → remove crew row. (Never touches the owner row.)
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

DROP TRIGGER IF EXISTS trg_vessel_crew_to_boat_members ON public.vessel_crew;
CREATE TRIGGER trg_vessel_crew_to_boat_members
    AFTER INSERT OR UPDATE OR DELETE ON public.vessel_crew
    FOR EACH ROW EXECUTE FUNCTION public.sync_vessel_crew_to_boat_members();

-- ── 4. Backfill: replay existing accepted invites ──────────────
-- Any crew already accepted before this migration gets mirrored now.
INSERT INTO public.boat_members (boat_id, user_id, display_name, role)
SELECT b.id, vc.crew_user_id, public.user_display_name(vc.crew_user_id), 'crew'
  FROM public.vessel_crew vc
  JOIN public.boats b ON b.owner_id = vc.owner_id
 WHERE vc.status = 'accepted'
   AND vc.crew_user_id IS NOT NULL
ON CONFLICT (boat_id, user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════
-- After running, verify with:
--   SELECT b.name, m.display_name, m.role
--     FROM public.boats b
--     JOIN public.boat_members m ON m.boat_id = b.id
--    ORDER BY b.name, m.role DESC, m.joined_at;
--
-- To grant a crew member their own personal voyage-log page (e.g.
-- emma-on-serene-summer), insert a personal config — the trigger
-- doesn't auto-publish (public URLs are an explicit opt-in):
--   INSERT INTO public.voyage_log_configs
--       (owner_id, boat_id, handle, scope, enabled)
--   VALUES (
--       (SELECT user_id FROM public.boat_members
--         WHERE boat_id = <boat_id> AND display_name = 'Emma'),
--       <boat_id>, 'emma-on-serene-summer', 'personal', true);
-- ═══════════════════════════════════════════════════════════════

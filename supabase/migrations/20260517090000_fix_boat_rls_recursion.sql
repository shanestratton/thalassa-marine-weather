-- ═══════════════════════════════════════════════════════════════
-- Fix infinite recursion in boats/boat_members RLS policies
--
-- The original policies (20260516120000_voyage_log_boats.sql) had
-- a cross-reference cycle:
--
--   boats SELECT policy (Members see their boat rows)
--       → queries boat_members
--   boat_members ALL policy (Owners manage their boat members)
--       → queries boats
--
-- An INSERT into boats with `.select('id').single()` does
-- `INSERT … RETURNING id`. The RETURNING triggers the boats SELECT
-- policy → reads boat_members → triggers boat_members policy →
-- reads boats → infinite recursion. Postgres detects this and
-- raises:
--
--   "infinite recursion detected in policy for relation 'boats'"
--
-- Fix: extract the cross-table membership/ownership checks into
-- SECURITY DEFINER functions. Those run with the function owner's
-- privileges and **bypass RLS internally**, so the policy can call
-- them without re-entering the policy engine.
--
-- Symptom that triggered this fix: fresh-install users couldn't
-- complete Voyage Log Setup — the boat-row insert failed silently
-- and Shane's diagnostic surfaced the recursion message.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Helper functions ────────────────────────────────────────
-- Both functions take a boat_id and answer a yes/no question about
-- the current auth.uid(). STABLE because they don't write, SECURITY
-- DEFINER so they read past RLS (no recursion), explicit search_path
-- so a malicious schema can't shadow `public`.

CREATE OR REPLACE FUNCTION public.is_boat_owner(p_boat_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS(
        SELECT 1
        FROM public.boats
        WHERE id = p_boat_id
          AND owner_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_boat_member(p_boat_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS(
        SELECT 1
        FROM public.boat_members
        WHERE boat_id = p_boat_id
          AND user_id = auth.uid()
    );
$$;

-- ── 2. Drop the recursive policies ─────────────────────────────
DROP POLICY IF EXISTS "Members see their boat rows" ON public.boats;
DROP POLICY IF EXISTS "Owners manage their boat members" ON public.boat_members;
DROP POLICY IF EXISTS "Members see their own membership" ON public.boat_members;

-- ── 3. Recreate them using the SECURITY DEFINER helpers ────────
-- Owners-of-the-boat policy on boats is unchanged (no cross-table
-- lookup), so we leave "Owners manage their boats" alone.

-- Non-owner crew members can SELECT the boats they're on. No more
-- direct EXISTS against boat_members — we call the helper, which
-- bypasses RLS internally.
CREATE POLICY "Members see their boat rows"
    ON public.boats FOR SELECT
    USING (public.is_boat_member(id));

-- The boat owner can manage every membership row on their boat.
-- Helper bypasses RLS, so this no longer recurses through boats.
CREATE POLICY "Owners manage their boat members"
    ON public.boat_members FOR ALL
    USING (public.is_boat_owner(boat_id))
    WITH CHECK (public.is_boat_owner(boat_id));

-- A user can see their own membership rows. Also lets crew see
-- *other* crew on the same boat (needed for the CrewManagement UI
-- and for byline rendering on the combined Voyage Log).
CREATE POLICY "Members see their own membership"
    ON public.boat_members FOR SELECT
    USING (
        user_id = auth.uid()
        OR public.is_boat_member(boat_id)
    );

-- ── 4. Grants ──────────────────────────────────────────────────
-- The helper functions need to be callable by the anon + authenticated
-- roles that PostgREST uses on behalf of clients. SECURITY DEFINER
-- doesn't grant EXECUTE — that's separate.
GRANT EXECUTE ON FUNCTION public.is_boat_owner(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_boat_member(uuid) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verify after running:
--   SELECT tablename, policyname, cmd
--     FROM pg_policies
--    WHERE schemaname='public'
--      AND tablename IN ('boats','boat_members')
--    ORDER BY tablename, cmd;
--
-- And from the app: hit Voyage Log → Set Up. Should now succeed
-- without the red "infinite recursion" card.
-- ═══════════════════════════════════════════════════════════════

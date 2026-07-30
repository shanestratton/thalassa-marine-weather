-- ═══════════════════════════════════════════════════════════════════════════
-- Actually take stripe_account_id out of the client-readable surface.
--
-- 20260730120000 tried this with:
--     REVOKE SELECT (stripe_account_id) ON public.chat_profiles FROM anon, authenticated;
--
-- IT SILENTLY DID NOTHING. In PostgreSQL a column-level REVOKE cannot subtract
-- from a table-level GRANT: `GRANT SELECT ON table` covers every column,
-- present and future, and a column REVOKE against it is a no-op. The migration
-- applied without error and I only caught it by querying
-- information_schema.column_privileges afterwards, which still listed SELECT on
-- that column for both anon and authenticated.
--
-- The working form is the inverse: revoke SELECT on the TABLE, then grant it
-- back on an explicit column list. That is what this does.
--
-- Why it matters even though 20260730120000 closed anon: chat_profiles' RLS
-- deliberately lets any authenticated user read every row, because the
-- Scuttlebutt UI needs other sailors' display names and avatars. So a
-- table-wide SELECT grant meant every signed-in user could read every other
-- user's stripe_account_id. Narrower than public, still wrong.
--
-- stripe_account_id has ZERO client readers (grep across services/ and
-- components/ finds none) and is a leftover from the retired Marketplace. It is
-- not dropped — no data is destroyed and service-role access is unaffected —
-- only removed from what anon and authenticated may select.
--
-- MAINTENANCE NOTE: because the grant is now an explicit column list, a NEW
-- column added to chat_profiles will NOT be readable by clients until it is
-- added here. That is the intended trade: opt-in exposure rather than opt-out.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE SELECT ON public.chat_profiles FROM anon, authenticated;

-- Every column except stripe_account_id.
GRANT SELECT (
    user_id,
    display_name,
    avatar_url,
    bio,
    vessel_name,
    vessel_type,
    home_port,
    looking_for_love,
    created_at,
    updated_at
) ON public.chat_profiles TO anon, authenticated;

-- Tidy: 20260730120000 replaced "Profiles are viewable by everyone" but an
-- older, differently-named authenticated-scoped duplicate survives alongside the
-- new policy. Same effect, two names — drop the stale one so the table has one
-- readable SELECT rule.
DROP POLICY IF EXISTS "Anyone can view chat profiles" ON public.chat_profiles;

-- ── Verify after applying ─────────────────────────────────────────────────
--   SELECT grantee, column_name FROM information_schema.column_privileges
--    WHERE table_name='chat_profiles' AND privilege_type='SELECT'
--      AND grantee IN ('anon','authenticated') AND column_name='stripe_account_id';
--   -- expect ZERO rows
--
--   Then as a signed-in user: selecting stripe_account_id must fail, while
--   display_name/avatar_url must still work (the Scuttlebutt list depends on it).
-- ═══════════════════════════════════════════════════════════════════════════

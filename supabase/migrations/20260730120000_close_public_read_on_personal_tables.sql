-- ═══════════════════════════════════════════════════════════════════════════
-- Close unconditional PUBLIC read on tables holding personal data.
--
-- Found by probing the LIVE database with the anon key that ships in the app
-- bundle. Nine tables carried `FOR SELECT TO public USING (true)` policies.
-- Three of those had no equivalent in any migration file — they were created by
-- hand and never captured, so the repo's migration history looked correct while
-- production was open. scripts/audit-supabase-migrations.mjs could never have
-- caught this: it is a text linter over the migration files, and the offending
-- policies were not in them.
--
-- WHAT WAS ACTUALLY EXPOSED (verified by live anon-key GET, not inferred):
--
--   guardian_profiles  → returned a REAL ROW containing home_coordinate,
--                        last_known_position, last_position_at, armed,
--                        armed_position, mmsi, vessel_name, user_id, bio.
--                        i.e. anyone holding the public key could enumerate
--                        every user's home berth, current vessel position, and
--                        whether their anchor guardian was armed. On a marine
--                        app that is a theft and stalking vector, not a privacy
--                        nicety.
--
--   chat_profiles      → returned REAL DATA including stripe_account_id, a
--                        financial identifier, plus display_name, bio,
--                        home_port, looking_for_love, user_id, vessel_name.
--
--   guardian_alerts        → empty today, but the policy leaks on first row.
--   sailor_dating_profiles → empty today. Its policy is even NAMED "viewable by
--                            opted-in users" while its qual is literally `true`.
--
-- DELIBERATELY LEFT PUBLIC — these are genuinely public registry/reference data
-- and dropping their policies would break real features:
--   vessels, vessel_metadata, amsa_register  (AIS + public ship registers)
--   community_tracks, recipe_ratings         (shared by design; both empty now,
--                                             but flagged for review — see below)
--
-- SAFETY OF EACH CHANGE WAS CHECKED AGAINST CONSUMERS BEFORE WRITING IT:
--   * guardian_profiles: the ONLY client read is GuardianService.fetchProfileFor,
--     which filters `.eq('user_id', ownerId)` and re-checks the row's user_id.
--     The own-row policy "Users read own guardian profile" (authenticated)
--     already covers it. Edge functions use the service role and bypass RLS.
--   * guardian_alerts: "Users read related guardian alerts" (authenticated)
--     already scopes to source/target user.
--   * chat_profiles: ChatService legitimately reads OTHER users' profiles for
--     the Scuttlebutt UI, so this restricts to `authenticated` rather than
--     dropping. Scuttlebutt is sign-in gated (ChatPage renders SignInScreen with
--     "Sign in to message other sailors"), so no signed-out path regresses.
--   * stripe_account_id has ZERO client-side readers (grep across services/ and
--     components/ returns nothing) and belonged to the retired Marketplace, so
--     it is revoked from the client roles rather than left selectable. REVOKE
--     rather than DROP COLUMN: reversible, and no data is destroyed.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── guardian_profiles: own row only ───────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can view guardian profiles" ON public.guardian_profiles;

-- Belt and braces: recreate the own-row policy if it is somehow absent, so this
-- migration cannot leave the table unreadable to its owner.
DROP POLICY IF EXISTS "Users read own guardian profile" ON public.guardian_profiles;
CREATE POLICY "Users read own guardian profile" ON public.guardian_profiles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- ── guardian_alerts: source or target only ────────────────────────────────
DROP POLICY IF EXISTS "Anyone can view guardian alerts" ON public.guardian_alerts;

DROP POLICY IF EXISTS "Users read related guardian alerts" ON public.guardian_alerts;
CREATE POLICY "Users read related guardian alerts" ON public.guardian_alerts
    FOR SELECT TO authenticated
    USING (source_user_id = auth.uid() OR target_user_id = auth.uid());

-- ── sailor_dating_profiles: signed-in only ────────────────────────────────
-- Preserves the intent its own name states, which its `true` qual did not.
DROP POLICY IF EXISTS "Dating profiles viewable by opted-in users" ON public.sailor_dating_profiles;
CREATE POLICY "Dating profiles viewable by signed-in sailors" ON public.sailor_dating_profiles
    FOR SELECT TO authenticated
    USING (true);

-- ── chat_profiles: signed-in only, and no financial identifier ────────────
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.chat_profiles;
CREATE POLICY "Chat profiles viewable by signed-in sailors" ON public.chat_profiles
    FOR SELECT TO authenticated
    USING (true);

-- Retired-Marketplace leftover with no client reader. Not dropped, just taken
-- out of the client-selectable surface.
REVOKE SELECT (stripe_account_id) ON public.chat_profiles FROM anon, authenticated;

-- ── Verify after applying ─────────────────────────────────────────────────
--   SELECT tablename, policyname, roles::text, cmd, qual
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND 'public' = ANY(roles) AND cmd = 'SELECT'
--      AND (qual IS NULL OR qual = 'true')
--    ORDER BY tablename;
--   -- expect ONLY: amsa_register, community_tracks, recipe_ratings,
--   --              vessel_metadata, vessels
--
-- Then re-probe with the anon key: guardian_profiles and chat_profiles must
-- return 401/permission denied, not 200.
--
-- STILL FOR REVIEW (not changed here, needs a product decision):
--   community_tracks — "Anyone can read community tracks". Empty today. If a
--   track is a recorded voyage it is position history, and public read on that
--   deserves the same scrutiny guardian_profiles just got.
-- ═══════════════════════════════════════════════════════════════════════════

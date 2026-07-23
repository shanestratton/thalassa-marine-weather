-- Crew profiles contain passport, medical, and emergency-contact data. The
-- original SELECT policy correlated only the profile subject to *any*
-- vessel_crew row, which let every authenticated user read every person who
-- happened to be crew somewhere. Restrict manifest access to the skipper who
-- owns that accepted membership.

DROP POLICY IF EXISTS "Crew readable by vessel members"
    ON public.crew_profiles;
DROP POLICY IF EXISTS "Skippers read accepted crew profiles"
    ON public.crew_profiles;

CREATE POLICY "Skippers read accepted crew profiles"
    ON public.crew_profiles FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1
            FROM public.vessel_crew AS membership
            WHERE membership.owner_id = auth.uid()
              AND membership.crew_user_id = crew_profiles.user_id
              AND membership.status = 'accepted'
        )
    );

-- Crew profiles contain passport, medical, and emergency-contact data. The
-- original SELECT policy correlated only the profile subject to *any*
-- vessel_crew row, which let every authenticated user read every person who
-- happened to be crew somewhere. Restrict manifest access to the skipper who
-- owns that accepted membership.

-- A small number of production projects recorded the original crew-profile
-- migration without retaining the table. Restore the canonical private
-- sea-bag schema here so the privacy policy can be applied consistently.
CREATE TABLE IF NOT EXISTS public.crew_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    nationality TEXT NOT NULL DEFAULT '',
    date_of_birth DATE,
    passport_number TEXT,
    passport_expiry DATE,
    passport_country TEXT,
    emergency_name TEXT,
    emergency_phone TEXT,
    emergency_relation TEXT,
    medical_notes TEXT,
    dietary_notes TEXT,
    sailing_experience TEXT DEFAULT 'novice'
        CHECK (sailing_experience IN ('novice', 'competent', 'experienced', 'professional')),
    profile_photo_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crewprofile_user
    ON public.crew_profiles(user_id);

CREATE OR REPLACE FUNCTION public.update_crewprofile_ts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crewprofile_updated ON public.crew_profiles;
CREATE TRIGGER trg_crewprofile_updated
    BEFORE UPDATE ON public.crew_profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_crewprofile_ts();

ALTER TABLE public.crew_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own profile" ON public.crew_profiles;
CREATE POLICY "Users manage own profile"
    ON public.crew_profiles FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

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

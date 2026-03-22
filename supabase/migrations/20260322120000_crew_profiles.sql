-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Crew Profiles (Digital Sea-Bag)                                ║
-- ║  Passport, emergency contacts, and customs data for global clearance.      ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.crew_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name           TEXT NOT NULL,
    nationality         TEXT NOT NULL DEFAULT '',
    date_of_birth       DATE,
    passport_number     TEXT,              -- Stored; consider app-level encryption
    passport_expiry     DATE,
    passport_country    TEXT,              -- Issuing country (ISO 3166-1 alpha-2)
    emergency_name      TEXT,
    emergency_phone     TEXT,
    emergency_relation  TEXT,
    medical_notes       TEXT,              -- Allergies, conditions
    dietary_notes       TEXT,              -- Vegetarian, gluten-free etc.
    sailing_experience  TEXT DEFAULT 'novice'
                        CHECK (sailing_experience IN (
                            'novice', 'competent', 'experienced', 'professional'
                        )),
    profile_photo_url   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crewprofile_user ON public.crew_profiles(user_id);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_crewprofile_ts()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_crewprofile_updated
    BEFORE UPDATE ON public.crew_profiles
    FOR EACH ROW EXECUTE FUNCTION update_crewprofile_ts();

-- RLS: users only see their own profile
ALTER TABLE public.crew_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own profile"
    ON public.crew_profiles FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Skipper can read crew profiles for customs manifests
CREATE POLICY "Crew readable by vessel members"
    ON public.crew_profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.crew_user_id = user_id
        )
    );

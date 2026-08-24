-- Founding Skippers applications contain contact details. Browsers never
-- receive table privileges: the public form crosses a bounded Edge function,
-- which calls one service-role-only RPC after server-side validation.

CREATE TABLE public.founding_skipper_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 80),
    email TEXT NOT NULL UNIQUE CHECK (
        email = lower(btrim(email))
        AND char_length(email) BETWEEN 3 AND 254
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
    boat_type TEXT NOT NULL CHECK (
        boat_type IN ('sail_monohull', 'sail_multihull', 'power', 'trailer_boat', 'other')
    ),
    home_waters TEXT NOT NULL CHECK (home_waters = btrim(home_waters) AND char_length(home_waters) BETWEEN 2 AND 120),
    apple_device TEXT NOT NULL CHECK (apple_device IN ('iphone', 'ipad', 'iphone_and_ipad')),
    boating_frequency TEXT NOT NULL CHECK (
        boating_frequency IN ('weekly_plus', 'fortnightly', 'monthly', 'less_often')
    ),
    interests TEXT[] NOT NULL CHECK (
        cardinality(interests) BETWEEN 1 AND 6
        AND interests <@ ARRAY[
            'marine_weather',
            'passage_planning',
            'float_plans',
            'anchor_watch',
            'voyage_logging',
            'onboard_data'
        ]::TEXT[]
    ),
    notes TEXT CHECK (notes IS NULL OR (notes = btrim(notes) AND char_length(notes) BETWEEN 1 AND 800)),
    source TEXT NOT NULL DEFAULT 'direct' CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    consent_version TEXT NOT NULL CHECK (consent_version = 'founding-skippers-v1'),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'accepted', 'declined', 'withdrawn')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp() + INTERVAL '180 days'
);

ALTER TABLE public.founding_skipper_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.founding_skipper_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.founding_skipper_applications TO service_role;

CREATE OR REPLACE FUNCTION public.submit_founding_skipper_application(
    p_name TEXT,
    p_email TEXT,
    p_boat_type TEXT,
    p_home_waters TEXT,
    p_apple_device TEXT,
    p_boating_frequency TEXT,
    p_interests TEXT[],
    p_notes TEXT,
    p_source TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required';
    END IF;

    INSERT INTO public.founding_skipper_applications (
        name,
        email,
        boat_type,
        home_waters,
        apple_device,
        boating_frequency,
        interests,
        notes,
        source,
        consent_version
    ) VALUES (
        p_name,
        p_email,
        p_boat_type,
        p_home_waters,
        p_apple_device,
        p_boating_frequency,
        p_interests,
        p_notes,
        p_source,
        'founding-skippers-v1'
    )
    ON CONFLICT (email) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_founding_skipper_application(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_founding_skipper_application(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.sweep_expired_founding_skipper_applications()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    DELETE FROM public.founding_skipper_applications
    WHERE expires_at <= statement_timestamp();
$$;
REVOKE ALL ON FUNCTION public.sweep_expired_founding_skipper_applications() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-expired-founding-skippers')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-expired-founding-skippers');
        PERFORM cron.schedule(
            'sweep-expired-founding-skippers',
            '23 3 * * *',
            'SELECT public.sweep_expired_founding_skipper_applications()'
        );
    END IF;
END;
$$;

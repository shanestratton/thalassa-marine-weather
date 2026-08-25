-- Return an identifier only when a Founding Skipper application is genuinely
-- inserted. The public Edge function uses this service-role-only result to
-- avoid emitting repeat alerts for duplicate email submissions.

CREATE OR REPLACE FUNCTION public.submit_founding_skipper_application_v2(
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
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    inserted_id UUID;
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
    ON CONFLICT (email) DO NOTHING
    RETURNING id INTO inserted_id;

    RETURN inserted_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_founding_skipper_application_v2(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT[],
    TEXT,
    TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_founding_skipper_application_v2(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT[],
    TEXT,
    TEXT
) TO service_role;

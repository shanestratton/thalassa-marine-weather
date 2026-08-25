-- Founding Skipper applications contain private contact details. Review access
-- is deliberately separate from Chat administration: exactly one verified
-- Supabase Auth UUID may be provisioned into the locked reviewer slot by the
-- service role. A mutable email address and a client-side role never authorize
-- this inbox.

CREATE TABLE public.founding_skipper_reviewers (
    reviewer_slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK (reviewer_slot = 1),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.founding_skipper_reviewers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.founding_skipper_reviewers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.founding_skipper_reviewers TO service_role;

-- Provision the reviewer out of band, after verifying Shane's immutable Auth
-- UUID in the Supabase dashboard. Do not derive this row from an email address.

ALTER TABLE public.founding_skipper_applications
    ADD COLUMN status_updated_at TIMESTAMPTZ,
    ADD COLUMN status_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Reassert the private-table boundary in the migration that introduces reads.
REVOKE ALL ON TABLE public.founding_skipper_applications FROM PUBLIC, anon, authenticated;

CREATE TABLE public.founding_skipper_application_status_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES public.founding_skipper_applications(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    previous_status TEXT NOT NULL CHECK (
        previous_status IN ('new', 'contacted', 'accepted', 'declined', 'withdrawn')
    ),
    status TEXT NOT NULL CHECK (status IN ('new', 'contacted', 'accepted', 'declined', 'withdrawn')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CHECK (status <> previous_status)
);

CREATE INDEX founding_skipper_application_status_audit_application_idx
    ON public.founding_skipper_application_status_audit (application_id, created_at DESC);
CREATE INDEX founding_skipper_applications_inbox_idx
    ON public.founding_skipper_applications (status, created_at DESC, id DESC);

ALTER TABLE public.founding_skipper_application_status_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.founding_skipper_application_status_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.founding_skipper_application_status_audit TO service_role;

CREATE OR REPLACE FUNCTION public.can_review_founding_skipper_applications()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.founding_skipper_reviewers reviewer
            WHERE reviewer.user_id = auth.uid()
       );
$$;

REVOKE ALL ON FUNCTION public.can_review_founding_skipper_applications() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_review_founding_skipper_applications() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_founding_skipper_applications(
    p_status TEXT DEFAULT NULL,
    p_before_created_at TIMESTAMPTZ DEFAULT NULL,
    p_before_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    email TEXT,
    boat_type TEXT,
    home_waters TEXT,
    apple_device TEXT,
    boating_frequency TEXT,
    interests TEXT[],
    notes TEXT,
    source TEXT,
    consent_version TEXT,
    consented_at TIMESTAMPTZ,
    status TEXT,
    created_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    status_updated_at TIMESTAMPTZ,
    status_updated_by UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS NULL
       OR NOT public.can_review_founding_skipper_applications() THEN
        RAISE EXCEPTION 'Founding Skipper reviewer role required'
            USING ERRCODE = '42501';
    END IF;

    IF p_status IS NOT NULL
       AND p_status NOT IN ('new', 'contacted', 'accepted', 'declined', 'withdrawn') THEN
        RAISE EXCEPTION 'Invalid Founding Skipper application status'
            USING ERRCODE = '22023';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
        RAISE EXCEPTION 'Founding Skipper application limit must be between 1 and 50'
            USING ERRCODE = '22023';
    END IF;

    IF (p_before_created_at IS NULL) IS DISTINCT FROM (p_before_id IS NULL) THEN
        RAISE EXCEPTION 'Founding Skipper application cursor is incomplete'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT application.id,
           application.name,
           application.email,
           application.boat_type,
           application.home_waters,
           application.apple_device,
           application.boating_frequency,
           application.interests,
           application.notes,
           application.source,
           application.consent_version,
           application.consented_at,
           application.status,
           application.created_at,
           application.expires_at,
           application.status_updated_at,
           application.status_updated_by
      FROM public.founding_skipper_applications application
     WHERE (p_status IS NULL OR application.status = p_status)
       AND (
            p_before_created_at IS NULL
            OR (application.created_at, application.id) < (p_before_created_at, p_before_id)
       )
     ORDER BY application.created_at DESC, application.id DESC
     LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_founding_skipper_applications(TEXT, TIMESTAMPTZ, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_founding_skipper_applications(TEXT, TIMESTAMPTZ, UUID, INTEGER)
    TO authenticated;

CREATE OR REPLACE FUNCTION public.review_founding_skipper_application(
    p_application_id UUID,
    p_expected_status TEXT,
    p_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    changed_application_id UUID;
    changed_at TIMESTAMPTZ := statement_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS NULL
       OR NOT public.can_review_founding_skipper_applications() THEN
        RAISE EXCEPTION 'Founding Skipper reviewer role required'
            USING ERRCODE = '42501';
    END IF;

    IF p_application_id IS NULL
       OR NOT (
            (p_expected_status = 'new' AND p_status IN ('contacted', 'accepted', 'declined', 'withdrawn'))
            OR (p_expected_status = 'contacted' AND p_status IN ('new', 'accepted', 'declined', 'withdrawn'))
            OR (p_expected_status = 'accepted' AND p_status IN ('new', 'contacted', 'declined', 'withdrawn'))
            OR (p_expected_status = 'declined' AND p_status = 'new')
       ) THEN
        RAISE EXCEPTION 'Invalid Founding Skipper application transition'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.founding_skipper_applications application
       SET status = p_status,
           status_updated_at = changed_at,
           status_updated_by = auth.uid()
     WHERE application.id = p_application_id
       AND application.status = p_expected_status
    RETURNING application.id INTO changed_application_id;

    IF changed_application_id IS NULL THEN
        RETURN false;
    END IF;

    INSERT INTO public.founding_skipper_application_status_audit (
        application_id,
        actor_id,
        previous_status,
        status,
        created_at
    ) VALUES (
        changed_application_id,
        auth.uid(),
        p_expected_status,
        p_status,
        changed_at
    );

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.review_founding_skipper_application(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_founding_skipper_application(UUID, TEXT, TEXT)
    TO authenticated;

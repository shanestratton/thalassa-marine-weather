-- Durable Founding Skipper email delivery.
--
-- The outbox deliberately stores only an application UUID and delivery
-- bookkeeping. Names, email addresses and the rest of the application remain
-- in founding_skipper_applications and are read only while a service worker
-- holds a lease. This keeps PII out of retry/dead-letter rows.

-- The refreshed application wording is a new consent contract. Keep the
-- already-recorded v1 evidence valid while allowing v3 to record the explicit
-- validated contract supplied by the Edge boundary. The compatibility v2 RPC
-- passes v1, keeping a database-first rolling deploy truthful for the still-
-- live v1 form.
ALTER TABLE public.founding_skipper_applications
    DROP CONSTRAINT founding_skipper_applications_consent_version_check;
ALTER TABLE public.founding_skipper_applications
    ADD CONSTRAINT founding_skipper_applications_consent_version_check
    CHECK (consent_version IN ('founding-skippers-v1', 'founding-skippers-v2'));

CREATE TABLE public.founding_skipper_email_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL
        REFERENCES public.founding_skipper_applications(id) ON DELETE CASCADE,
    message_kind TEXT NOT NULL CHECK (message_kind IN (
        'operator_new_v1',
        'applicant_received_v1',
        'applicant_accepted_v1'
    )),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
        'queued',
        'processing',
        'sent',
        'retry',
        'dead',
        'cancelled'
    )),
    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 20),
    available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    provider_message_id TEXT CHECK (
        provider_message_id IS NULL
        OR provider_message_id ~ '^[A-Za-z0-9_-]{1,200}$'
    ),
    -- Store a bounded machine code, never a provider response/body that may
    -- echo the recipient or message content.
    last_error_code TEXT CHECK (
        last_error_code IS NULL
        OR last_error_code ~ '^[a-z0-9][a-z0-9_:-]{0,79}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    sent_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    dead_at TIMESTAMPTZ,
    UNIQUE (application_id, message_kind),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'processing') = (lease_token IS NOT NULL)),
    CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
    CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
    CHECK ((state = 'dead') = (dead_at IS NOT NULL)),
    CHECK (provider_message_id IS NULL OR state = 'sent')
);

COMMENT ON TABLE public.founding_skipper_email_outbox IS
    'Service-only, PII-minimal durable email jobs for Founding Skipper applications.';
COMMENT ON COLUMN public.founding_skipper_email_outbox.application_id IS
    'Reference used to fetch current application fields at claim time; no recipient snapshot is stored here.';
COMMENT ON COLUMN public.founding_skipper_email_outbox.lease_token IS
    'Worker-generated fencing token; completion mutations must present the current token.';
COMMENT ON COLUMN public.founding_skipper_email_outbox.last_error_code IS
    'Bounded non-PII machine code only; never persist provider response text.';

ALTER TABLE public.founding_skipper_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.founding_skipper_email_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.founding_skipper_email_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.founding_skipper_email_outbox TO service_role;

-- Claim scans have separate indexes for scheduled retries and expired leases.
-- The uniqueness index above also serves application/message-kind lookups.
CREATE INDEX founding_skipper_email_outbox_ready_idx
    ON public.founding_skipper_email_outbox (available_at, created_at, id)
    WHERE state IN ('queued', 'retry');
CREATE INDEX founding_skipper_email_outbox_expired_lease_idx
    ON public.founding_skipper_email_outbox (lease_expires_at, created_at, id)
    WHERE state = 'processing';

-- Deliberately do not backfill pre-migration applications. Those submissions
-- belonged to the legacy direct-alert flow, and replaying them could duplicate
-- an operator alert or send stale receipt language after a review decision.
-- The outbox begins with applications inserted through v2/v3 below.

-- Version 3 preserves v2's UUID/null contract. A real insert always queues the
-- operator notification; explicit v2 consent also queues the applicant receipt.
CREATE OR REPLACE FUNCTION public.submit_founding_skipper_application_v3(
    p_name TEXT,
    p_email TEXT,
    p_boat_type TEXT,
    p_home_waters TEXT,
    p_apple_device TEXT,
    p_boating_frequency TEXT,
    p_interests TEXT[],
    p_notes TEXT,
    p_source TEXT,
    p_consent_version TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    inserted_id UUID;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_consent_version IS NULL
       OR p_consent_version NOT IN ('founding-skippers-v1', 'founding-skippers-v2') THEN
        RAISE EXCEPTION 'Invalid Founding Skipper consent version'
            USING ERRCODE = '22023';
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
        p_consent_version
    )
    ON CONFLICT (email) DO NOTHING
    RETURNING id INTO inserted_id;

    IF inserted_id IS NOT NULL THEN
        INSERT INTO public.founding_skipper_email_outbox (application_id, message_kind)
        VALUES (inserted_id, 'operator_new_v1');

        IF p_consent_version = 'founding-skippers-v2' THEN
            INSERT INTO public.founding_skipper_email_outbox (application_id, message_kind)
            VALUES (inserted_id, 'applicant_received_v1');
        END IF;
    END IF;

    RETURN inserted_id;
END;
$$;

COMMENT ON FUNCTION public.submit_founding_skipper_application_v3(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT
) IS
    'Service-only explicit-consent insert; all new rows queue an operator job and v2 consent also queues a receipt.';
REVOKE ALL ON FUNCTION public.submit_founding_skipper_application_v3(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_founding_skipper_application_v3(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT
) TO service_role;

-- Close the rolling-deploy window: until the Edge function switches to v3,
-- its existing v2 call records the v1 consent contract shown by that deployed
-- form and queues only the operator notification covered by that contract.
-- Signature, UUID/null result and privileges remain unchanged.
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
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;

    RETURN public.submit_founding_skipper_application_v3(
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
    );
END;
$$;

COMMENT ON FUNCTION public.submit_founding_skipper_application_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT
) IS
    'Compatibility delegate that passes v1 consent to the explicit v3 contract.';
REVOKE ALL ON FUNCTION public.submit_founding_skipper_application_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_founding_skipper_application_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT
) TO service_role;

-- Claim a bounded batch with row locks so concurrent cron/manual workers never
-- receive the same live lease. An expired processing lease may be reclaimed.
-- Current application values are joined only into the RPC result; they are not
-- copied into the durable outbox.
CREATE OR REPLACE FUNCTION public.claim_founding_skipper_email_jobs(
    p_lease_token UUID,
    p_limit INTEGER DEFAULT 10,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
    job_id UUID,
    application_id UUID,
    message_kind TEXT,
    attempts INTEGER,
    lease_token UUID,
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
    application_status TEXT,
    application_created_at TIMESTAMPTZ,
    application_expires_at TIMESTAMPTZ,
    status_updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_lease_token IS NULL
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
        RAISE EXCEPTION 'Invalid Founding Skipper email claim'
            USING ERRCODE = '22023';
    END IF;

    -- A worker that dies on the final permitted attempt cannot leave the row
    -- in processing forever. No other state can legitimately reach 20 without
    -- retry_founding_skipper_email_job dead-lettering it first.
    UPDATE public.founding_skipper_email_outbox AS outbox
       SET state = 'dead',
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'attempts_exhausted',
           dead_at = now_at,
           updated_at = now_at
     WHERE outbox.state = 'processing'
       AND outbox.lease_expires_at <= now_at
       AND outbox.attempt_count >= 20;

    RETURN QUERY
    WITH candidates AS MATERIALIZED (
        SELECT outbox.id
        FROM public.founding_skipper_email_outbox AS outbox
        WHERE outbox.attempt_count < 20
          AND (
                (outbox.state IN ('queued', 'retry') AND outbox.available_at <= now_at)
                OR (outbox.state = 'processing' AND outbox.lease_expires_at <= now_at)
          )
        ORDER BY
            CASE
                WHEN outbox.state = 'processing' THEN outbox.lease_expires_at
                ELSE outbox.available_at
            END,
            outbox.created_at,
            outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT p_limit
    ),
    claimed AS (
        UPDATE public.founding_skipper_email_outbox AS outbox
           SET state = 'processing',
               attempt_count = outbox.attempt_count + 1,
               lease_token = p_lease_token,
               lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
               last_error_code = NULL,
               dead_at = NULL,
               cancelled_at = NULL,
               updated_at = now_at
          FROM candidates
         WHERE outbox.id = candidates.id
        RETURNING outbox.id,
                  outbox.application_id,
                  outbox.message_kind,
                  outbox.attempt_count,
                  outbox.lease_token,
                  outbox.created_at
    )
    SELECT claimed.id,
           application.id,
           claimed.message_kind,
           claimed.attempt_count::INTEGER,
           claimed.lease_token,
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
           application.status_updated_at
    FROM claimed
    JOIN public.founding_skipper_applications AS application
      ON application.id = claimed.application_id
    ORDER BY claimed.created_at, claimed.id;
END;
$$;

COMMENT ON FUNCTION public.claim_founding_skipper_email_jobs(UUID, INTEGER, INTEGER) IS
    'Service-only SKIP LOCKED claim returning live application fields under a worker-generated fencing lease.';
REVOKE ALL ON FUNCTION public.claim_founding_skipper_email_jobs(UUID, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_founding_skipper_email_jobs(UUID, INTEGER, INTEGER)
    TO service_role;

-- A matching token is the fence. Expiry alone does not reject a late finish:
-- if another worker has reclaimed the row, its token has already changed.
CREATE OR REPLACE FUNCTION public.finish_founding_skipper_email_job(
    p_job_id UUID,
    p_lease_token UUID,
    p_provider_message_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected_rows INTEGER;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_job_id IS NULL OR p_lease_token IS NULL
       OR (
            p_provider_message_id IS NOT NULL
            AND (
                p_provider_message_id !~ '^[A-Za-z0-9_-]{1,200}$'
            )
       ) THEN
        RAISE EXCEPTION 'Invalid Founding Skipper email finish'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.founding_skipper_email_outbox AS outbox
       SET state = 'sent',
           provider_message_id = p_provider_message_id,
           last_error_code = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           sent_at = now_at,
           cancelled_at = NULL,
           dead_at = NULL,
           updated_at = now_at
     WHERE outbox.id = p_job_id
       AND outbox.state = 'processing'
       AND outbox.lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

COMMENT ON FUNCTION public.finish_founding_skipper_email_job(UUID, UUID, TEXT) IS
    'Marks one leased job sent; a stale or invalidated lease returns false.';
REVOKE ALL ON FUNCTION public.finish_founding_skipper_email_job(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_founding_skipper_email_job(UUID, UUID, TEXT)
    TO service_role;

-- Retry delays are capped to one day and errors are machine codes only. The
-- twentieth attempt, or an explicitly terminal result, is dead-lettered.
CREATE OR REPLACE FUNCTION public.retry_founding_skipper_email_job(
    p_job_id UUID,
    p_lease_token UUID,
    p_error_code TEXT,
    p_retry_after_seconds INTEGER DEFAULT 60,
    p_terminal BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected_rows INTEGER;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_job_id IS NULL OR p_lease_token IS NULL
       OR p_error_code IS NULL
       OR p_error_code !~ '^[a-z0-9][a-z0-9_:-]{0,79}$'
       OR p_retry_after_seconds IS NULL
       OR p_retry_after_seconds NOT BETWEEN 0 AND 86400
       OR (NOT p_terminal AND p_retry_after_seconds = 0)
       OR p_terminal IS NULL THEN
        RAISE EXCEPTION 'Invalid Founding Skipper email retry'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.founding_skipper_email_outbox AS outbox
       SET state = CASE
                WHEN p_terminal OR outbox.attempt_count >= 20 THEN 'dead'
                ELSE 'retry'
           END,
           available_at = now_at + make_interval(secs => p_retry_after_seconds),
           last_error_code = p_error_code,
           lease_token = NULL,
           lease_expires_at = NULL,
           dead_at = CASE
                WHEN p_terminal OR outbox.attempt_count >= 20 THEN now_at
                ELSE NULL
           END,
           cancelled_at = NULL,
           updated_at = now_at
     WHERE outbox.id = p_job_id
       AND outbox.state = 'processing'
       AND outbox.lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

COMMENT ON FUNCTION public.retry_founding_skipper_email_job(UUID, UUID, TEXT, INTEGER, BOOLEAN) IS
    'Releases one leased job for bounded retry, or dead-letters a terminal/exhausted delivery.';
REVOKE ALL ON FUNCTION public.retry_founding_skipper_email_job(UUID, UUID, TEXT, INTEGER, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_founding_skipper_email_job(UUID, UUID, TEXT, INTEGER, BOOLEAN)
    TO service_role;

CREATE OR REPLACE FUNCTION public.cancel_founding_skipper_email_job(
    p_job_id UUID,
    p_lease_token UUID,
    p_reason_code TEXT DEFAULT 'application_ineligible'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    affected_rows INTEGER;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_job_id IS NULL OR p_lease_token IS NULL
       OR p_reason_code IS NULL
       OR p_reason_code !~ '^[a-z0-9][a-z0-9_:-]{0,79}$' THEN
        RAISE EXCEPTION 'Invalid Founding Skipper email cancellation'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.founding_skipper_email_outbox AS outbox
       SET state = 'cancelled',
           last_error_code = p_reason_code,
           lease_token = NULL,
           lease_expires_at = NULL,
           cancelled_at = now_at,
           dead_at = NULL,
           updated_at = now_at
     WHERE outbox.id = p_job_id
       AND outbox.state = 'processing'
       AND outbox.lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

COMMENT ON FUNCTION public.cancel_founding_skipper_email_job(UUID, UUID, TEXT) IS
    'Cancels one leased job after a final live eligibility check; a stale lease returns false.';
REVOKE ALL ON FUNCTION public.cancel_founding_skipper_email_job(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_founding_skipper_email_job(UUID, UUID, TEXT)
    TO service_role;

-- Keep the existing immutable-reviewer authorization, transition matrix,
-- compare-and-set update and audit write. The only addition is an atomic
-- acceptance email intent for the v2 contract that disclosed applicant mail.
-- Leaving accepted invalidates even an active lease; a re-acceptance requeues
-- that same job only when it has never been sent.
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
    changed_consent_version TEXT;
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

    UPDATE public.founding_skipper_applications AS application
       SET status = p_status,
           status_updated_at = changed_at,
           status_updated_by = auth.uid()
     WHERE application.id = p_application_id
       AND application.status = p_expected_status
    RETURNING application.id, application.consent_version
         INTO changed_application_id, changed_consent_version;

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

    IF p_status = 'accepted'
       AND changed_consent_version = 'founding-skippers-v2' THEN
        INSERT INTO public.founding_skipper_email_outbox (
            application_id,
            message_kind,
            state,
            available_at,
            created_at,
            updated_at
        ) VALUES (
            changed_application_id,
            'applicant_accepted_v1',
            'queued',
            changed_at,
            changed_at,
            changed_at
        )
        ON CONFLICT (application_id, message_kind) DO UPDATE
           SET state = 'queued',
               attempt_count = 0,
               available_at = changed_at,
               lease_token = NULL,
               lease_expires_at = NULL,
               provider_message_id = NULL,
               last_error_code = NULL,
               sent_at = NULL,
               cancelled_at = NULL,
               dead_at = NULL,
               updated_at = changed_at
         WHERE founding_skipper_email_outbox.sent_at IS NULL;
    ELSIF p_status = 'accepted' THEN
        -- Legacy v1 consent covered only the operator notification. Keep an
        -- unexpected unsent acceptance job fenced off rather than contacting
        -- that applicant under a newer contract they did not accept.
        UPDATE public.founding_skipper_email_outbox AS outbox
           SET state = 'cancelled',
               lease_token = NULL,
               lease_expires_at = NULL,
               provider_message_id = NULL,
               last_error_code = 'applicant_email_not_consented',
               sent_at = NULL,
               cancelled_at = changed_at,
               dead_at = NULL,
               updated_at = changed_at
         WHERE outbox.application_id = changed_application_id
           AND outbox.message_kind = 'applicant_accepted_v1'
           AND outbox.sent_at IS NULL;
    ELSIF p_expected_status = 'accepted' THEN
        -- This is the race fence for a worker that claimed immediately before
        -- the review change. Clearing the token makes its finish/retry/cancel
        -- call fail, and the worker also rechecks current status before POST.
        UPDATE public.founding_skipper_email_outbox AS outbox
           SET state = 'cancelled',
               lease_token = NULL,
               lease_expires_at = NULL,
               provider_message_id = NULL,
               last_error_code = 'application_no_longer_accepted',
               sent_at = NULL,
               cancelled_at = changed_at,
               dead_at = NULL,
               updated_at = changed_at
         WHERE outbox.application_id = changed_application_id
           AND outbox.message_kind = 'applicant_accepted_v1'
           AND outbox.sent_at IS NULL;
    END IF;

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.review_founding_skipper_application(UUID, TEXT, TEXT) IS
    'Reviewer-only CAS transition with audit; v2 acceptance queues one welcome and all ineligible transitions fence unsent delivery.';
REVOKE ALL ON FUNCTION public.review_founding_skipper_application(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_founding_skipper_application(UUID, TEXT, TEXT)
    TO authenticated;

-- A one-minute tick drains queued mail promptly. The shared helper obtains its
-- service credential from Vault and fails loudly when infrastructure is not
-- configured. Guard extension-less local/test databases.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('process-founding-skipper-email-outbox');
        EXCEPTION
            WHEN OTHERS THEN NULL;
        END;

        PERFORM cron.schedule(
            'process-founding-skipper-email-outbox',
            '* * * * *',
            'SELECT public.invoke_edge_function(''founding-skipper-email-worker'', 30000)'
        );
    END IF;
END;
$$;

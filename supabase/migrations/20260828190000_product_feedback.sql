-- Private product feedback intake and durable email delivery.
--
-- Browsers never receive table privileges. The public form crosses a bounded
-- Edge function which normalizes and validates the payload, consumes a keyed
-- per-network quota, and calls one service-role-only RPC. The transaction that
-- stores a submission also creates its two email intents, so a successful form
-- response can never lose the operator alert or submitter receipt.

CREATE TABLE public.product_feedback_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_submission_id UUID NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature')),
    name TEXT NOT NULL CHECK (
        name = btrim(name)
        AND char_length(name) BETWEEN 2 AND 80
        AND name !~ '[[:cntrl:]]'
    ),
    email TEXT NOT NULL CHECK (
        email = lower(btrim(email))
        AND char_length(email) BETWEEN 3 AND 254
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
    area TEXT NOT NULL CHECK (area IN (
        'weather',
        'charts_obs',
        'passage_planning',
        'anchor_watch',
        'voyage_log',
        'crew_list',
        'vessel_nmea',
        'account',
        'website',
        'other'
    )),
    title TEXT NOT NULL CHECK (
        title = btrim(title)
        AND char_length(title) BETWEEN 5 AND 120
        AND title !~ '[[:cntrl:]]'
    ),
    details TEXT NOT NULL CHECK (
        details = btrim(details)
        AND char_length(details) BETWEEN 20 AND 4000
    ),
    impact TEXT NOT NULL,
    steps_to_reproduce TEXT CHECK (
        steps_to_reproduce IS NULL
        OR (steps_to_reproduce = btrim(steps_to_reproduce) AND char_length(steps_to_reproduce) BETWEEN 1 AND 2000)
    ),
    expected_result TEXT CHECK (
        expected_result IS NULL
        OR (expected_result = btrim(expected_result) AND char_length(expected_result) BETWEEN 1 AND 2000)
    ),
    actual_result TEXT CHECK (
        actual_result IS NULL
        OR (actual_result = btrim(actual_result) AND char_length(actual_result) BETWEEN 1 AND 2000)
    ),
    problem_to_solve TEXT CHECK (
        problem_to_solve IS NULL
        OR (problem_to_solve = btrim(problem_to_solve) AND char_length(problem_to_solve) BETWEEN 1 AND 2000)
    ),
    ideal_outcome TEXT CHECK (
        ideal_outcome IS NULL
        OR (ideal_outcome = btrim(ideal_outcome) AND char_length(ideal_outcome) BETWEEN 1 AND 2000)
    ),
    device TEXT CHECK (
        device IS NULL
        OR (
            device = btrim(device)
            AND char_length(device) BETWEEN 1 AND 120
            AND device !~ '[[:cntrl:]]'
        )
    ),
    app_version TEXT CHECK (
        app_version IS NULL
        OR (
            app_version = btrim(app_version)
            AND char_length(app_version) BETWEEN 1 AND 40
            AND app_version !~ '[[:cntrl:]]'
        )
    ),
    app_build TEXT CHECK (
        app_build IS NULL
        OR (
            app_build = btrim(app_build)
            AND char_length(app_build) BETWEEN 1 AND 40
            AND app_build !~ '[[:cntrl:]]'
        )
    ),
    app_platform TEXT CHECK (
        app_platform IS NULL
        OR (
            app_platform = btrim(app_platform)
            AND char_length(app_platform) BETWEEN 1 AND 40
            AND app_platform !~ '[[:cntrl:]]'
        )
    ),
    diagnostics JSONB,
    source TEXT NOT NULL DEFAULT 'direct' CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    consent_version TEXT NOT NULL CHECK (consent_version = 'product-feedback-v1'),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
        'new',
        'reviewing',
        'planned',
        'in_progress',
        'resolved',
        'declined',
        'duplicate'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    -- One day of headroom lets the daily sweep uphold the disclosed
    -- deletion-within-365-days ceiling even at its worst scheduling offset.
    expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp() + INTERVAL '364 days',
    CONSTRAINT product_feedback_impact_matches_kind CHECK (
        (kind = 'bug' AND impact IN ('blocking', 'serious', 'annoying', 'cosmetic'))
        OR
        (kind = 'feature' AND impact IN ('game_changer', 'important', 'nice_to_have'))
    ),
    CONSTRAINT product_feedback_fields_match_kind CHECK (
        (
            kind = 'bug'
            AND problem_to_solve IS NULL
            AND ideal_outcome IS NULL
        )
        OR
        (
            kind = 'feature'
            AND steps_to_reproduce IS NULL
            AND expected_result IS NULL
            AND actual_result IS NULL
            AND diagnostics IS NULL
        )
    ),
    CONSTRAINT product_feedback_diagnostics_bounded CHECK (
        diagnostics IS NULL
        OR (
            kind = 'bug'
            AND jsonb_typeof(diagnostics) = 'object'
            AND diagnostics ?& ARRAY[
                'platform',
                'userAgent',
                'screen',
                'viewport',
                'language',
                'online',
                'currentPath'
            ]::TEXT[]
            AND diagnostics - ARRAY[
                'platform',
                'userAgent',
                'screen',
                'viewport',
                'language',
                'online',
                'currentPath'
            ]::TEXT[] = '{}'::JSONB
            AND jsonb_typeof(diagnostics->'platform') = 'string'
            AND jsonb_typeof(diagnostics->'userAgent') = 'string'
            AND jsonb_typeof(diagnostics->'screen') = 'string'
            AND jsonb_typeof(diagnostics->'viewport') = 'string'
            AND jsonb_typeof(diagnostics->'language') = 'string'
            AND jsonb_typeof(diagnostics->'online') = 'boolean'
            AND jsonb_typeof(diagnostics->'currentPath') = 'string'
            AND char_length(diagnostics->>'platform') <= 120
            AND char_length(diagnostics->>'userAgent') <= 512
            AND char_length(diagnostics->>'screen') <= 40
            AND char_length(diagnostics->>'viewport') <= 40
            AND char_length(diagnostics->>'language') <= 32
            AND char_length(diagnostics->>'currentPath') BETWEEN 1 AND 120
            AND diagnostics->>'currentPath' ~ '^/[^?#[[:cntrl:]]]{0,119}$'
            AND octet_length(diagnostics::TEXT) <= 1500
        )
    ),
    CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.product_feedback_submissions IS
    'Private bug reports and feature requests submitted through the bounded public feedback Edge function.';
COMMENT ON COLUMN public.product_feedback_submissions.client_submission_id IS
    'Untrusted client-generated UUID used only for exact-payload retry idempotency; it grants no read access.';
COMMENT ON COLUMN public.product_feedback_submissions.diagnostics IS
    'Explicitly opted-in, bug-only bounded browser diagnostics with pathname only; never query, coordinates, storage or identifiers.';

ALTER TABLE public.product_feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_feedback_submissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_feedback_submissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_feedback_submissions TO service_role;

CREATE INDEX product_feedback_submissions_status_created_idx
    ON public.product_feedback_submissions (status, created_at DESC, id DESC);
CREATE INDEX product_feedback_submissions_expiry_idx
    ON public.product_feedback_submissions (expires_at);

-- PII remains in the submission row. Retry/dead-letter rows retain only the
-- submission UUID and bounded delivery bookkeeping.
CREATE TABLE public.product_feedback_email_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL
        REFERENCES public.product_feedback_submissions(id) ON DELETE CASCADE,
    message_kind TEXT NOT NULL CHECK (message_kind IN ('operator_new_v1', 'submitter_received_v1')),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'sent', 'retry', 'dead')),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    provider_message_id TEXT CHECK (
        provider_message_id IS NULL
        OR provider_message_id ~ '^[A-Za-z0-9_-]{1,200}$'
    ),
    last_error_code TEXT CHECK (
        last_error_code IS NULL
        OR last_error_code ~ '^[a-z0-9][a-z0-9_:-]{0,79}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    sent_at TIMESTAMPTZ,
    dead_at TIMESTAMPTZ,
    UNIQUE (submission_id, message_kind),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'processing') = (lease_token IS NOT NULL)),
    CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
    CHECK ((state = 'dead') = (dead_at IS NOT NULL)),
    CHECK (provider_message_id IS NULL OR state = 'sent')
);

COMMENT ON TABLE public.product_feedback_email_outbox IS
    'Service-only, PII-minimal durable email jobs for product feedback.';
COMMENT ON COLUMN public.product_feedback_email_outbox.last_error_code IS
    'Bounded non-PII machine code only; never a provider response or recipient/message content.';

ALTER TABLE public.product_feedback_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_feedback_email_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_feedback_email_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_feedback_email_outbox TO service_role;

CREATE INDEX product_feedback_email_outbox_ready_idx
    ON public.product_feedback_email_outbox (available_at, created_at, id)
    WHERE state IN ('queued', 'retry');
CREATE INDEX product_feedback_email_outbox_expired_lease_idx
    ON public.product_feedback_email_outbox (lease_expires_at, created_at, id)
    WHERE state = 'processing';

CREATE OR REPLACE FUNCTION public.submit_product_feedback(
    p_client_submission_id UUID,
    p_kind TEXT,
    p_name TEXT,
    p_email TEXT,
    p_area TEXT,
    p_title TEXT,
    p_details TEXT,
    p_impact TEXT,
    p_steps_to_reproduce TEXT,
    p_expected_result TEXT,
    p_actual_result TEXT,
    p_problem_to_solve TEXT,
    p_ideal_outcome TEXT,
    p_device TEXT,
    p_app_version TEXT,
    p_app_build TEXT,
    p_app_platform TEXT,
    p_diagnostics JSONB,
    p_source TEXT,
    p_consent_version TEXT
)
RETURNS TABLE (submission_id UUID, reference TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    stored public.product_feedback_submissions%ROWTYPE;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_client_submission_id IS NULL
       OR p_consent_version IS DISTINCT FROM 'product-feedback-v1' THEN
        RAISE EXCEPTION 'Invalid product feedback submission' USING ERRCODE = '22023';
    END IF;

    -- INSERT-first idempotency closes the absent-row race: concurrent calls
    -- with the same client UUID serialize on its unique index. Exactly one can
    -- insert and queue mail; the loser observes and compares the committed row.
    INSERT INTO public.product_feedback_submissions (
        client_submission_id,
        kind,
        name,
        email,
        area,
        title,
        details,
        impact,
        steps_to_reproduce,
        expected_result,
        actual_result,
        problem_to_solve,
        ideal_outcome,
        device,
        app_version,
        app_build,
        app_platform,
        diagnostics,
        source,
        consent_version
    ) VALUES (
        p_client_submission_id,
        p_kind,
        p_name,
        p_email,
        p_area,
        p_title,
        p_details,
        p_impact,
        p_steps_to_reproduce,
        p_expected_result,
        p_actual_result,
        p_problem_to_solve,
        p_ideal_outcome,
        p_device,
        p_app_version,
        p_app_build,
        p_app_platform,
        p_diagnostics,
        p_source,
        p_consent_version
    )
    ON CONFLICT (client_submission_id) DO NOTHING
    RETURNING * INTO stored;

    IF FOUND THEN
        INSERT INTO public.product_feedback_email_outbox (submission_id, message_kind)
        VALUES
            (stored.id, 'operator_new_v1'),
            (stored.id, 'submitter_received_v1');
    ELSE
        SELECT submission.*
          INTO stored
          FROM public.product_feedback_submissions AS submission
         WHERE submission.client_submission_id = p_client_submission_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product feedback idempotency checkpoint unavailable'
                USING ERRCODE = '40001';
        END IF;

        -- A client UUID is retry idempotency, not permission to overwrite. A
        -- UUID reused with any different normalized value fails closed.
        IF stored.kind IS DISTINCT FROM p_kind
           OR stored.name IS DISTINCT FROM p_name
           OR stored.email IS DISTINCT FROM p_email
           OR stored.area IS DISTINCT FROM p_area
           OR stored.title IS DISTINCT FROM p_title
           OR stored.details IS DISTINCT FROM p_details
           OR stored.impact IS DISTINCT FROM p_impact
           OR stored.steps_to_reproduce IS DISTINCT FROM p_steps_to_reproduce
           OR stored.expected_result IS DISTINCT FROM p_expected_result
           OR stored.actual_result IS DISTINCT FROM p_actual_result
           OR stored.problem_to_solve IS DISTINCT FROM p_problem_to_solve
           OR stored.ideal_outcome IS DISTINCT FROM p_ideal_outcome
           OR stored.device IS DISTINCT FROM p_device
           OR stored.app_version IS DISTINCT FROM p_app_version
           OR stored.app_build IS DISTINCT FROM p_app_build
           OR stored.app_platform IS DISTINCT FROM p_app_platform
           OR stored.diagnostics IS DISTINCT FROM p_diagnostics
           OR stored.source IS DISTINCT FROM p_source
           OR stored.consent_version IS DISTINCT FROM p_consent_version THEN
            RAISE EXCEPTION 'Client submission UUID was reused with different content'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    RETURN QUERY
    SELECT stored.id,
           'FB-' || upper(left(replace(stored.id::TEXT, '-', ''), 8));
END;
$$;

COMMENT ON FUNCTION public.submit_product_feedback(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT
) IS
    'Service-only exact-idempotency feedback insert which atomically queues operator and submitter mail.';
REVOKE ALL ON FUNCTION public.submit_product_feedback(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_product_feedback(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_product_feedback_email_jobs(
    p_lease_token UUID,
    p_limit INTEGER DEFAULT 10,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
    job_id UUID,
    submission_id UUID,
    message_kind TEXT,
    attempts INTEGER,
    lease_token UUID,
    reference TEXT,
    kind TEXT,
    name TEXT,
    email TEXT,
    area TEXT,
    title TEXT,
    details TEXT,
    impact TEXT,
    steps_to_reproduce TEXT,
    expected_result TEXT,
    actual_result TEXT,
    problem_to_solve TEXT,
    ideal_outcome TEXT,
    device TEXT,
    app_version TEXT,
    app_build TEXT,
    app_platform TEXT,
    diagnostics JSONB,
    source TEXT,
    consent_version TEXT,
    submission_status TEXT
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
        RAISE EXCEPTION 'Invalid product feedback email claim' USING ERRCODE = '22023';
    END IF;

    UPDATE public.product_feedback_email_outbox AS outbox
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
          FROM public.product_feedback_email_outbox AS outbox
          JOIN public.product_feedback_submissions AS submission
            ON submission.id = outbox.submission_id
         WHERE outbox.attempt_count < 20
           AND submission.expires_at > now_at
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
        UPDATE public.product_feedback_email_outbox AS outbox
           SET state = 'processing',
               attempt_count = outbox.attempt_count + 1,
               lease_token = p_lease_token,
               lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
               last_error_code = NULL,
               dead_at = NULL,
               updated_at = now_at
          FROM candidates
         WHERE outbox.id = candidates.id
        RETURNING outbox.id,
                  outbox.submission_id,
                  outbox.message_kind,
                  outbox.attempt_count,
                  outbox.lease_token,
                  outbox.created_at
    )
    SELECT claimed.id,
           submission.id,
           claimed.message_kind,
           claimed.attempt_count::INTEGER,
           claimed.lease_token,
           'FB-' || upper(left(replace(submission.id::TEXT, '-', ''), 8)),
           submission.kind,
           submission.name,
           submission.email,
           submission.area,
           submission.title,
           submission.details,
           submission.impact,
           submission.steps_to_reproduce,
           submission.expected_result,
           submission.actual_result,
           submission.problem_to_solve,
           submission.ideal_outcome,
           submission.device,
           submission.app_version,
           submission.app_build,
           submission.app_platform,
           submission.diagnostics,
           submission.source,
           submission.consent_version,
           submission.status
      FROM claimed
      JOIN public.product_feedback_submissions AS submission
        ON submission.id = claimed.submission_id
     ORDER BY claimed.created_at, claimed.id;
END;
$$;

COMMENT ON FUNCTION public.claim_product_feedback_email_jobs(UUID, INTEGER, INTEGER) IS
    'Service-only SKIP LOCKED claim returning live feedback fields under a worker-generated fencing lease.';
REVOKE ALL ON FUNCTION public.claim_product_feedback_email_jobs(UUID, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_product_feedback_email_jobs(UUID, INTEGER, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.finish_product_feedback_email_job(
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
            AND p_provider_message_id !~ '^[A-Za-z0-9_-]{1,200}$'
       ) THEN
        RAISE EXCEPTION 'Invalid product feedback email finish' USING ERRCODE = '22023';
    END IF;

    UPDATE public.product_feedback_email_outbox AS outbox
       SET state = 'sent',
           provider_message_id = p_provider_message_id,
           last_error_code = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           sent_at = now_at,
           dead_at = NULL,
           updated_at = now_at
     WHERE outbox.id = p_job_id
       AND outbox.state = 'processing'
       AND outbox.lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_product_feedback_email_job(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_product_feedback_email_job(UUID, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.retry_product_feedback_email_job(
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
        RAISE EXCEPTION 'Invalid product feedback email retry' USING ERRCODE = '22023';
    END IF;

    UPDATE public.product_feedback_email_outbox AS outbox
       SET state = CASE
                WHEN p_terminal OR outbox.attempt_count >= 20 THEN 'dead'
                ELSE 'retry'
           END,
           available_at = now_at + make_interval(secs => p_retry_after_seconds),
           provider_message_id = NULL,
           last_error_code = p_error_code,
           lease_token = NULL,
           lease_expires_at = NULL,
           sent_at = NULL,
           dead_at = CASE
                WHEN p_terminal OR outbox.attempt_count >= 20 THEN now_at
                ELSE NULL
           END,
           updated_at = now_at
     WHERE outbox.id = p_job_id
       AND outbox.state = 'processing'
       AND outbox.lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.retry_product_feedback_email_job(UUID, UUID, TEXT, INTEGER, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_product_feedback_email_job(UUID, UUID, TEXT, INTEGER, BOOLEAN)
    TO service_role;

CREATE OR REPLACE FUNCTION public.sweep_expired_product_feedback()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    DELETE FROM public.product_feedback_submissions
    WHERE expires_at <= statement_timestamp();
$$;

COMMENT ON FUNCTION public.sweep_expired_product_feedback() IS
    'Daily cleanup of feedback scheduled at day 364, preserving deletion within 365 days; outbox rows cascade.';
REVOKE ALL ON FUNCTION public.sweep_expired_product_feedback() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-expired-product-feedback')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-expired-product-feedback');
        PERFORM cron.schedule(
            'sweep-expired-product-feedback',
            '41 3 * * *',
            'SELECT public.sweep_expired_product_feedback()'
        );

        PERFORM cron.unschedule('process-product-feedback-email-outbox')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-product-feedback-email-outbox');
        PERFORM cron.schedule(
            'process-product-feedback-email-outbox',
            '* * * * *',
            'SELECT public.invoke_edge_function(''feedback-email-worker'', 30000)'
        );
    END IF;
END;
$$;

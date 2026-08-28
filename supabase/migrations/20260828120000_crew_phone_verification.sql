-- Phone-possession verification for the Crew List.
--
-- Twilio receives the raw number and one-time code in the Edge Function only.
-- Postgres retains a keyed, versioned fingerprint, the last four digits, and
-- provider audit identifiers. Raw numbers and verification codes never enter
-- the database.

CREATE TABLE public.crew_phone_verification_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_hmac TEXT NOT NULL CHECK (phone_hmac ~ '^[0-9a-f]{64}$'),
    hmac_version SMALLINT NOT NULL DEFAULT 1 CHECK (hmac_version BETWEEN 1 AND 32767),
    phone_last4 TEXT NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
    twilio_verification_sid TEXT
        CHECK (twilio_verification_sid IS NULL OR twilio_verification_sid ~ '^VE[0-9A-Fa-f]{32}$'),
    status TEXT NOT NULL DEFAULT 'initiating'
        CHECK (status IN ('initiating', 'pending', 'approved', 'failed', 'expired', 'superseded', 'conflict')),
    request_count SMALLINT NOT NULL DEFAULT 1 CHECK (request_count BETWEEN 1 AND 10),
    check_count SMALLINT NOT NULL DEFAULT 0 CHECK (check_count BETWEEN 0 AND 5),
    failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,40}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp() + interval '10 minutes',
    checked_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    CONSTRAINT crew_phone_attempt_time_order CHECK (expires_at > created_at),
    CONSTRAINT crew_phone_attempt_provider_shape CHECK (
        status NOT IN ('pending', 'approved') OR twilio_verification_sid IS NOT NULL
    ),
    CONSTRAINT crew_phone_attempt_approval_shape CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
    )
);

ALTER TABLE public.crew_phone_verification_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_phone_verification_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_phone_verification_attempts TO service_role;

CREATE INDEX crew_phone_attempts_user_recent_idx
    ON public.crew_phone_verification_attempts (user_id, created_at DESC);
CREATE INDEX crew_phone_attempts_expiry_idx
    ON public.crew_phone_verification_attempts (expires_at)
    WHERE status IN ('initiating', 'pending');

CREATE TABLE public.crew_phone_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    phone_hmac TEXT NOT NULL CHECK (phone_hmac ~ '^[0-9a-f]{64}$'),
    hmac_version SMALLINT NOT NULL DEFAULT 1 CHECK (hmac_version BETWEEN 1 AND 32767),
    phone_last4 TEXT NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
    provider TEXT NOT NULL DEFAULT 'twilio_verify' CHECK (provider = 'twilio_verify'),
    provider_verification_sid TEXT NOT NULL CHECK (provider_verification_sid ~ '^VE[0-9A-Fa-f]{32}$'),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.crew_phone_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_phone_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_phone_identities TO service_role;

CREATE UNIQUE INDEX crew_phone_identities_one_current_per_user_idx
    ON public.crew_phone_identities (user_id);
CREATE UNIQUE INDEX crew_phone_identities_one_current_per_phone_idx
    ON public.crew_phone_identities (hmac_version, phone_hmac);

-- Detect accidental HMAC-secret replacement. The tag is an HMAC of a fixed,
-- domain-separated sentinel; it cannot recover the secret and is not derived
-- from a phone number. A mismatch fails closed while any phone row exists.
-- Deliberate rotation therefore requires first removing every identity and
-- attempt, then waiting for all short-lived phone quota buckets to be swept;
-- only then may the guard register a new version/tag pair without resetting
-- the same-number abuse limiter.
CREATE TABLE public.crew_phone_hmac_config (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    hmac_version SMALLINT NOT NULL CHECK (hmac_version BETWEEN 1 AND 32767),
    key_tag TEXT NOT NULL CHECK (key_tag ~ '^[0-9a-f]{64}$'),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.crew_phone_hmac_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_phone_hmac_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crew_phone_hmac_config TO service_role;

CREATE OR REPLACE FUNCTION public.assert_crew_phone_hmac_key(
    p_hmac_version SMALLINT,
    p_key_tag TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_config RECORD;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_hmac_version NOT BETWEEN 1 AND 32767
       OR p_key_tag !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid Crew phone HMAC key tag' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('crew-phone-hmac-config', 20260828));

    SELECT config.hmac_version, config.key_tag
      INTO current_config
      FROM public.crew_phone_hmac_config config
     WHERE config.singleton
     FOR UPDATE;

    IF current_config.key_tag IS NULL THEN
        IF EXISTS (SELECT 1 FROM public.crew_phone_identities)
           OR EXISTS (SELECT 1 FROM public.crew_phone_verification_attempts)
           OR EXISTS (
                SELECT 1
                FROM public.edge_public_rate_limits quota
                WHERE quota.bucket LIKE 'crew_phone_number_%'
           ) THEN
            RETURN false;
        END IF;
        INSERT INTO public.crew_phone_hmac_config(singleton, hmac_version, key_tag)
        VALUES (true, p_hmac_version, p_key_tag);
        RETURN true;
    END IF;

    IF current_config.hmac_version = p_hmac_version
       AND current_config.key_tag = p_key_tag THEN
        RETURN true;
    END IF;

    IF EXISTS (SELECT 1 FROM public.crew_phone_identities)
       OR EXISTS (SELECT 1 FROM public.crew_phone_verification_attempts)
       OR EXISTS (
            SELECT 1
            FROM public.edge_public_rate_limits quota
            WHERE quota.bucket LIKE 'crew_phone_number_%'
       ) THEN
        RETURN false;
    END IF;

    UPDATE public.crew_phone_hmac_config
       SET hmac_version = p_hmac_version,
           key_tag = p_key_tag,
           registered_at = statement_timestamp()
     WHERE singleton;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_crew_phone_hmac_key(SMALLINT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_crew_phone_hmac_key(SMALLINT, TEXT)
    TO service_role;

-- The deletion-durability migration installed fences only on tables that
-- existed at that point in time. New auth-owned tables must add them directly.
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_phone_verification_attempts;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_phone_verification_attempts
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_phone_identities;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_phone_identities
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

-- Crew-phone number and network quotas are shared abuse-prevention aggregates,
-- not user-owned profile rows. Removing them on profile/account deletion would
-- let an attacker reset the limiter. Keep only the current UTC day's opaque
-- hashes and sweep every older Crew-phone public bucket in bounded batches.
CREATE OR REPLACE FUNCTION public.sweep_crew_phone_public_quotas(p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    deleted_count INTEGER := 0;
BEGIN
    IF p_limit NOT BETWEEN 1 AND 10000 THEN
        RAISE EXCEPTION 'Invalid Crew phone quota sweep limit' USING ERRCODE = '22023';
    END IF;

    WITH stale AS MATERIALIZED (
        SELECT quota.client_hash, quota.bucket, quota.window_start
        FROM public.edge_public_rate_limits quota
        WHERE left(quota.bucket, 11) = 'crew_phone_'
          AND quota.window_start < (
                date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
        ORDER BY quota.window_start, quota.client_hash, quota.bucket
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.edge_public_rate_limits quota
    USING stale
    WHERE quota.client_hash = stale.client_hash
      AND quota.bucket = stale.bucket
      AND quota.window_start = stale.window_start;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_crew_phone_public_quotas(INTEGER)
    FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-crew-phone-public-quotas')
        WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-crew-phone-public-quotas');
        PERFORM cron.schedule(
            'sweep-crew-phone-public-quotas',
            '17 * * * *',
            'SELECT public.sweep_crew_phone_public_quotas()'
        );
    END IF;
END;
$$;

-- Internal eligibility predicate. Phone possession is deliberately distinct
-- from the existing manual headshot/profile review fields.
CREATE OR REPLACE FUNCTION public.crew_list_account_is_verified(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM auth.users account
            WHERE account.id = p_user_id
              AND account.email_confirmed_at IS NOT NULL
       )
       AND EXISTS (
            SELECT 1
            FROM public.crew_phone_identities identity_row
            WHERE identity_row.user_id = p_user_id
       );
$$;

REVOKE ALL ON FUNCTION public.crew_list_account_is_verified(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crew_list_account_is_verified(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.get_current_crew_phone_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    confirmed BOOLEAN := false;
    current_identity RECORD;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT account.email_confirmed_at IS NOT NULL
      INTO confirmed
      FROM auth.users account
     WHERE account.id = caller_id;

    SELECT identity_row.phone_last4, identity_row.verified_at
      INTO current_identity
     FROM public.crew_phone_identities identity_row
     WHERE identity_row.user_id = caller_id
     ORDER BY identity_row.verified_at DESC
     LIMIT 1;

    RETURN jsonb_build_object(
        'verified', current_identity.phone_last4 IS NOT NULL,
        'last4', current_identity.phone_last4,
        'verified_at', current_identity.verified_at,
        'email_verified', COALESCE(confirmed, false)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_current_crew_phone_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_crew_phone_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_current_crew_phone_identity()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    deleted_identity_count INTEGER := 0;
    deleted_attempt_count INTEGER := 0;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(caller_id::TEXT, 20260828));

    -- Explicit removal means removal: retain neither the keyed fingerprint nor
    -- the last four digits in identity or attempt history. Shared, opaque
    -- number-quota buckets intentionally survive until the bounded daily sweep
    -- so remove-and-retry cannot reset the abuse limiter.
    DELETE FROM public.crew_phone_verification_attempts WHERE user_id = caller_id;
    GET DIAGNOSTICS deleted_attempt_count = ROW_COUNT;
    DELETE FROM public.crew_phone_identities WHERE user_id = caller_id;
    GET DIAGNOSTICS deleted_identity_count = ROW_COUNT;

    -- The later phone gate turns an in-flight review back into a draft. An
    -- already manually approved profile retains that independent review but is
    -- private until a number is verified again.
    UPDATE public.sailor_crew_profiles
       SET crew_list_visibility = 'private',
           updated_at = statement_timestamp()
     WHERE user_id = caller_id;

    RETURN deleted_identity_count > 0 OR deleted_attempt_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_current_crew_phone_identity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_current_crew_phone_identity() TO authenticated;

-- Reserve a local attempt before contacting Twilio. A fresh attempt is kept
-- separate from the prior pending SID so a provider failure cannot invalidate
-- an otherwise usable code.
CREATE OR REPLACE FUNCTION public.reserve_crew_phone_verification_attempt(
    p_user_id UUID,
    p_phone_hmac TEXT,
    p_phone_last4 TEXT,
    p_hmac_version SMALLINT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    recent_at TIMESTAMPTZ;
    attempt_id UUID;
    retry_after INTEGER;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL
       OR p_phone_hmac !~ '^[0-9a-f]{64}$'
       OR p_phone_last4 !~ '^[0-9]{4}$'
       OR p_hmac_version NOT BETWEEN 1 AND 32767 THEN
        RAISE EXCEPTION 'Invalid phone verification reservation' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM auth.users account
        WHERE account.id = p_user_id AND account.email_confirmed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Confirmed email required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    IF EXISTS (
        SELECT 1
        FROM public.crew_phone_identities identity_row
        WHERE identity_row.user_id = p_user_id
          AND identity_row.phone_hmac = p_phone_hmac
          AND identity_row.hmac_version = p_hmac_version
    ) THEN
        RETURN jsonb_build_object('status', 'already_verified');
    END IF;

    SELECT attempt.created_at
      INTO recent_at
      FROM public.crew_phone_verification_attempts attempt
     WHERE attempt.user_id = p_user_id
       AND attempt.phone_hmac = p_phone_hmac
       AND attempt.hmac_version = p_hmac_version
       AND attempt.created_at > statement_timestamp() - interval '60 seconds'
     ORDER BY attempt.created_at DESC
     LIMIT 1;

    IF recent_at IS NOT NULL THEN
        retry_after := GREATEST(
            1,
            CEIL(EXTRACT(EPOCH FROM recent_at + interval '60 seconds' - statement_timestamp()))::INTEGER
        );
        RETURN jsonb_build_object('status', 'cooldown', 'retry_after_seconds', retry_after);
    END IF;

    INSERT INTO public.crew_phone_verification_attempts (
        user_id, phone_hmac, hmac_version, phone_last4
    ) VALUES (
        p_user_id, p_phone_hmac, p_hmac_version, p_phone_last4
    )
    RETURNING id INTO attempt_id;

    -- Bounded opportunistic retention. Authorization never depends on cleanup.
    WITH stale AS MATERIALIZED (
        SELECT attempt.id
        FROM public.crew_phone_verification_attempts attempt
        WHERE attempt.created_at < statement_timestamp() - interval '24 hours'
        ORDER BY attempt.created_at
        LIMIT 100
    )
    DELETE FROM public.crew_phone_verification_attempts attempt
    USING stale
    WHERE attempt.id = stale.id;

    RETURN jsonb_build_object(
        'status', 'reserved',
        'attempt_id', attempt_id,
        'expires_at', statement_timestamp() + interval '10 minutes'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_crew_phone_verification_attempt(UUID, TEXT, TEXT, SMALLINT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_crew_phone_verification_attempt(UUID, TEXT, TEXT, SMALLINT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.activate_crew_phone_verification_attempt(
    p_user_id UUID,
    p_attempt_id UUID,
    p_twilio_verification_sid TEXT,
    p_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    activated BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL
       OR p_attempt_id IS NULL
       OR p_twilio_verification_sid !~ '^VE[0-9A-Fa-f]{32}$'
       OR p_expires_at <= statement_timestamp()
       OR p_expires_at > statement_timestamp() + interval '11 minutes' THEN
        RAISE EXCEPTION 'Invalid phone verification activation' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    UPDATE public.crew_phone_verification_attempts
       SET status = 'superseded',
           updated_at = statement_timestamp(),
           failure_code = NULL
     WHERE user_id = p_user_id
       AND id <> p_attempt_id
       AND status IN ('initiating', 'pending');

    UPDATE public.crew_phone_verification_attempts
       SET twilio_verification_sid = p_twilio_verification_sid,
           status = 'pending',
           expires_at = p_expires_at,
           updated_at = statement_timestamp(),
           failure_code = NULL
     WHERE id = p_attempt_id
       AND user_id = p_user_id
       AND status = 'initiating'
    RETURNING true INTO activated;

    RETURN COALESCE(activated, false);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_crew_phone_verification_attempt(UUID, UUID, TEXT, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_crew_phone_verification_attempt(UUID, UUID, TEXT, TIMESTAMPTZ)
    TO service_role;

CREATE OR REPLACE FUNCTION public.fail_crew_phone_verification_attempt(
    p_user_id UUID,
    p_attempt_id UUID,
    p_failure_code TEXT,
    p_final_status TEXT DEFAULT 'failed'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    changed BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL
       OR p_attempt_id IS NULL
       OR p_failure_code !~ '^[A-Z0-9_]{1,40}$'
       OR p_final_status NOT IN ('failed', 'expired', 'conflict', 'superseded') THEN
        RAISE EXCEPTION 'Invalid phone verification failure' USING ERRCODE = '22023';
    END IF;

    UPDATE public.crew_phone_verification_attempts
       SET status = p_final_status,
           failure_code = p_failure_code,
           updated_at = statement_timestamp()
     WHERE id = p_attempt_id
       AND user_id = p_user_id
       AND status IN ('initiating', 'pending')
    RETURNING true INTO changed;

    RETURN COALESCE(changed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_crew_phone_verification_attempt(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_crew_phone_verification_attempt(UUID, UUID, TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.claim_crew_phone_verification_check(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    claimed RECORD;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Invalid phone verification check' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    UPDATE public.crew_phone_verification_attempts
       SET status = 'expired',
           failure_code = 'LOCAL_EXPIRY',
           updated_at = statement_timestamp()
     WHERE user_id = p_user_id
       AND status = 'pending'
       AND expires_at <= statement_timestamp();

    SELECT attempt.id, attempt.twilio_verification_sid, attempt.check_count,
           attempt.expires_at, attempt.phone_last4
      INTO claimed
      FROM public.crew_phone_verification_attempts attempt
     WHERE attempt.user_id = p_user_id
       AND attempt.status = 'pending'
       AND attempt.expires_at > statement_timestamp()
       AND attempt.twilio_verification_sid IS NOT NULL
     ORDER BY attempt.created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF claimed.id IS NULL THEN
        RETURN jsonb_build_object('status', 'missing');
    END IF;
    IF claimed.check_count >= 5 THEN
        UPDATE public.crew_phone_verification_attempts
           SET status = 'failed',
               failure_code = 'MAX_CHECKS',
               updated_at = statement_timestamp()
         WHERE id = claimed.id;
        RETURN jsonb_build_object('status', 'max_checks');
    END IF;

    UPDATE public.crew_phone_verification_attempts
       SET check_count = check_count + 1,
           checked_at = statement_timestamp(),
           updated_at = statement_timestamp()
     WHERE id = claimed.id;

    RETURN jsonb_build_object(
        'status', 'claimed',
        'attempt_id', claimed.id,
        'verification_sid', claimed.twilio_verification_sid,
        'expires_at', claimed.expires_at,
        'last4', claimed.phone_last4
    );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_crew_phone_verification_check(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_crew_phone_verification_check(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_crew_phone_verification(
    p_user_id UUID,
    p_attempt_id UUID,
    p_twilio_verification_sid TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    attempt RECORD;
    existing_identity RECORD;
    verified_time TIMESTAMPTZ := statement_timestamp();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL
       OR p_attempt_id IS NULL
       OR p_twilio_verification_sid !~ '^VE[0-9A-Fa-f]{32}$' THEN
        RAISE EXCEPTION 'Invalid phone verification completion' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    SELECT attempt_row.id, attempt_row.phone_hmac, attempt_row.hmac_version,
           attempt_row.phone_last4, attempt_row.twilio_verification_sid,
           attempt_row.status, attempt_row.expires_at, attempt_row.approved_at
      INTO attempt
      FROM public.crew_phone_verification_attempts attempt_row
     WHERE attempt_row.id = p_attempt_id
       AND attempt_row.user_id = p_user_id
     FOR UPDATE;

    IF attempt.id IS NULL
       OR attempt.twilio_verification_sid IS DISTINCT FROM p_twilio_verification_sid THEN
        RETURN jsonb_build_object('verified', false, 'status', 'invalid');
    END IF;

    IF attempt.status = 'approved' THEN
        SELECT identity_row.phone_last4, identity_row.verified_at
          INTO existing_identity
          FROM public.crew_phone_identities identity_row
         WHERE identity_row.user_id = p_user_id
           AND identity_row.phone_hmac = attempt.phone_hmac
           AND identity_row.hmac_version = attempt.hmac_version
         LIMIT 1;
        RETURN jsonb_build_object(
            'verified', existing_identity.phone_last4 IS NOT NULL,
            'status', CASE WHEN existing_identity.phone_last4 IS NOT NULL THEN 'approved' ELSE 'invalid' END,
            'last4', existing_identity.phone_last4,
            'verified_at', existing_identity.verified_at
        );
    END IF;

    IF attempt.status <> 'pending' OR attempt.expires_at <= statement_timestamp() THEN
        RETURN jsonb_build_object('verified', false, 'status', 'expired');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM auth.users account
        WHERE account.id = p_user_id AND account.email_confirmed_at IS NOT NULL
    ) THEN
        RETURN jsonb_build_object('verified', false, 'status', 'email_unverified');
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(attempt.hmac_version::TEXT || ':' || attempt.phone_hmac, 20260828)
    );

    -- A number can back only one current account. Deleted/replaced identities
    -- leave no fingerprint history, matching the explicit-removal promise.
    IF EXISTS (
        SELECT 1
        FROM public.crew_phone_identities identity_row
        WHERE identity_row.hmac_version = attempt.hmac_version
          AND identity_row.phone_hmac = attempt.phone_hmac
          AND identity_row.user_id <> p_user_id
    ) THEN
        UPDATE public.crew_phone_verification_attempts
           SET status = 'conflict',
               failure_code = 'PHONE_IN_USE',
               updated_at = statement_timestamp()
         WHERE id = p_attempt_id;
        RETURN jsonb_build_object('verified', false, 'status', 'conflict');
    END IF;

    SELECT identity_row.phone_last4, identity_row.verified_at
      INTO existing_identity
      FROM public.crew_phone_identities identity_row
     WHERE identity_row.user_id = p_user_id
       AND identity_row.phone_hmac = attempt.phone_hmac
       AND identity_row.hmac_version = attempt.hmac_version
     LIMIT 1;

    IF existing_identity.phone_last4 IS NULL THEN
        -- The old identity stays active while the replacement challenge is in
        -- flight. This nested block makes delete+insert atomic: a uniqueness
        -- race restores the old identity before the conflict is returned.
        BEGIN
            DELETE FROM public.crew_phone_identities WHERE user_id = p_user_id;
            INSERT INTO public.crew_phone_identities (
                user_id, phone_hmac, hmac_version, phone_last4,
                provider_verification_sid, verified_at
            ) VALUES (
                p_user_id, attempt.phone_hmac, attempt.hmac_version,
                attempt.phone_last4, p_twilio_verification_sid, verified_time
            );
        EXCEPTION WHEN unique_violation THEN
            UPDATE public.crew_phone_verification_attempts
               SET status = 'conflict',
                   failure_code = 'PHONE_IN_USE',
                   updated_at = statement_timestamp()
             WHERE id = p_attempt_id;
            RETURN jsonb_build_object('verified', false, 'status', 'conflict');
        END;
    ELSE
        verified_time := existing_identity.verified_at;
    END IF;

    UPDATE public.crew_phone_verification_attempts
       SET status = 'approved',
           approved_at = verified_time,
           updated_at = statement_timestamp(),
           failure_code = NULL
     WHERE id = p_attempt_id;

    DELETE FROM public.crew_phone_verification_attempts
     WHERE user_id = p_user_id
       AND id <> p_attempt_id;

    -- Preserve manual review. A previously approved profile may come back
    -- online after phone replacement; drafts and pending profiles stay private.
    UPDATE public.sailor_crew_profiles
       SET crew_list_visibility = 'visible',
           updated_at = statement_timestamp()
     WHERE user_id = p_user_id
       AND community_enabled
       AND approval_status = 'approved'
       AND verification_status = 'verified'
       AND NULLIF(BTRIM(COALESCE(crew_photo_path, '')), '') IS NOT NULL;

    RETURN jsonb_build_object(
        'verified', true,
        'status', 'approved',
        'last4', attempt.phone_last4,
        'verified_at', verified_time
    );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_crew_phone_verification(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_crew_phone_verification(UUID, UUID, TEXT)
    TO service_role;

-- Terminal attempt metadata is short-lived and contains only a keyed
-- fingerprint, last four digits, and provider SID. The no-grant inner sweep
-- lets the database owner's pg_cron job guarantee eventual removal even when
-- verification traffic stops; the service-role wrapper remains available to
-- operations workers. Reserve also performs the same bounded 24-hour reap.
CREATE OR REPLACE FUNCTION public.sweep_crew_phone_verification_attempts(
    p_limit INTEGER DEFAULT 1000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    deleted_count INTEGER := 0;
    stale_ids UUID[];
BEGIN
    IF p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(stale.id ORDER BY stale.created_at)
      INTO stale_ids
      FROM (
        SELECT attempt.id, attempt.created_at
        FROM public.crew_phone_verification_attempts attempt
        WHERE attempt.created_at < statement_timestamp() - interval '24 hours'
        ORDER BY attempt.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
      ) stale;

    DELETE FROM public.crew_phone_verification_attempts attempt
     WHERE attempt.id = ANY(COALESCE(stale_ids, ARRAY[]::UUID[]));
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_crew_phone_verification_attempts(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cleanup_crew_phone_verification_attempts(
    p_limit INTEGER DEFAULT 500
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    RETURN public.sweep_crew_phone_verification_attempts(p_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_crew_phone_verification_attempts(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_crew_phone_verification_attempts(INTEGER)
    TO service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-crew-phone-verification-attempts')
        WHERE EXISTS (
            SELECT 1
            FROM cron.job
            WHERE jobname = 'sweep-crew-phone-verification-attempts'
        );
        PERFORM cron.schedule(
            'sweep-crew-phone-verification-attempts',
            '23 * * * *',
            'SELECT public.sweep_crew_phone_verification_attempts(1000)'
        );
    END IF;
END;
$$;

-- Existing visible profiles predate phone verification. Fail closed without
-- destroying their drafts or manual review decisions; successful verification
-- can restore visibility for an otherwise still-approved profile.
-- The table lock taken by ALTER TABLE also prevents concurrent writes while
-- the tombstone fence is briefly bypassed for this one migration-owned update.
ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER account_deletion_write_fence;
ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER sailor_crew_profiles_beta_guard;
UPDATE public.sailor_crew_profiles
   SET crew_list_visibility = 'private',
       updated_at = statement_timestamp()
 WHERE crew_list_visibility = 'visible';
ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER sailor_crew_profiles_beta_guard;
ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER account_deletion_write_fence;

CREATE OR REPLACE FUNCTION public.guard_crew_phone_publication()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.approval_status = 'pending'
       AND NOT public.crew_list_account_is_verified(NEW.user_id) THEN
        IF TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM NEW.approval_status THEN
            RAISE EXCEPTION 'Confirmed email and phone verification are required before review'
                USING ERRCODE = '42501';
        END IF;

        -- If verification is explicitly removed while a review is in flight,
        -- withdraw the stale review without blocking the deletion transaction.
        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.crew_list_visibility := 'private';
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
    END IF;

    IF NEW.crew_list_visibility = 'visible'
       AND NOT public.crew_list_account_is_verified(NEW.user_id) THEN
        RAISE EXCEPTION 'Confirmed email and phone verification are required before publication'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_phone_publication()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sailor_crew_profiles_phone_gate ON public.sailor_crew_profiles;
CREATE TRIGGER sailor_crew_profiles_phone_gate
    BEFORE INSERT OR UPDATE ON public.sailor_crew_profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_crew_phone_publication();

CREATE OR REPLACE FUNCTION public.submit_crew_profile_for_review()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    submitted BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.crew_list_account_is_verified(caller_id) THEN
        RAISE EXCEPTION 'Confirmed email and phone verification are required before review'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = 'pending',
           verification_status = 'pending',
           crew_list_visibility = 'private',
           review_requested_at = statement_timestamp(),
           reviewed_at = NULL,
           reviewed_by = NULL,
           updated_at = statement_timestamp()
     WHERE user_id = caller_id
       AND community_enabled
       AND approval_status IN ('draft', 'rejected')
    RETURNING true INTO submitted;

    RETURN COALESCE(submitted, false);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_crew_profile_for_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_crew_profile_for_review() TO authenticated;

CREATE OR REPLACE FUNCTION public.review_crew_profile(
    p_profile_user_id UUID,
    p_decision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    updated_profile BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR NOT public.is_chat_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Crew List administrator role required'
            USING ERRCODE = '42501';
    END IF;

    IF p_profile_user_id IS NULL
       OR p_profile_user_id = auth.uid()
       OR p_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Invalid Crew List review request'
            USING ERRCODE = '22023';
    END IF;

    IF p_decision = 'approved'
       AND NOT public.crew_list_account_is_verified(p_profile_user_id) THEN
        RETURN false;
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = p_decision,
           verification_status = CASE WHEN p_decision = 'approved' THEN 'verified' ELSE 'rejected' END,
           is_verified = p_decision = 'approved',
           crew_list_visibility = CASE WHEN p_decision = 'approved' THEN 'visible' ELSE 'private' END,
           reviewed_at = statement_timestamp(),
           reviewed_by = auth.uid(),
           updated_at = statement_timestamp()
     WHERE user_id = p_profile_user_id
       AND community_enabled
       AND approval_status = 'pending'
    RETURNING true INTO updated_profile;

    RETURN COALESCE(updated_profile, false);
END;
$$;

REVOKE ALL ON FUNCTION public.review_crew_profile(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_crew_profile(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.crew_list_profile_is_discoverable(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NOT NULL
       AND public.crew_list_account_is_verified(p_user_id)
       AND EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = p_user_id
              AND profile.community_enabled
              AND profile.crew_list_visibility = 'visible'
              AND profile.approval_status = 'approved'
              AND profile.verification_status = 'verified'
              AND NULLIF(BTRIM(COALESCE(profile.crew_photo_path, '')), '') IS NOT NULL
       );
$$;

REVOKE ALL ON FUNCTION public.crew_list_profile_is_discoverable(UUID)
    FROM PUBLIC, anon, authenticated;

-- Close the direct-table RLS path as well as the browse RPC. Owners and admins
-- retain their existing access; ordinary authenticated reads keep their prior
-- semantics but the target must satisfy the complete phone-aware predicate.
CREATE OR REPLACE FUNCTION public.can_select_crew_list_profile(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_user_id IS NOT NULL
       AND (
            p_user_id = auth.uid()
            OR public.is_chat_admin(auth.uid())
            OR public.crew_list_profile_is_discoverable(p_user_id)
       );
$$;

REVOKE ALL ON FUNCTION public.can_select_crew_list_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_select_crew_list_profile(UUID) TO authenticated;

DROP POLICY IF EXISTS "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles;
CREATE POLICY "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles FOR SELECT TO authenticated
    USING (public.can_select_crew_list_profile(user_id));

CREATE OR REPLACE FUNCTION public.can_view_crew_list_photo(p_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_object_name IS NOT NULL
       AND (
            split_part(p_object_name, '/', 1) = auth.uid()::TEXT
            OR public.is_chat_admin(auth.uid())
            OR (
                EXISTS (
                    SELECT 1
                    FROM public.sailor_crew_profiles profile
                    WHERE profile.user_id::TEXT = split_part(p_object_name, '/', 1)
                      AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
                      AND (
                            profile.crew_photo_path = p_object_name
                         OR p_object_name = ANY(profile.crew_photo_paths)
                      )
                      AND (
                            (
                                public.can_browse_crew_list()
                                AND public.crew_list_account_is_verified(profile.user_id)
                                AND profile.community_enabled
                                AND profile.crew_list_visibility = 'visible'
                                AND profile.approval_status = 'approved'
                                AND profile.verification_status = 'verified'
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM public.crew_intro_requests request
                                WHERE request.status = 'accepted'
                                  AND (
                                        (request.sender_id = auth.uid() AND request.recipient_id = profile.user_id)
                                     OR (request.sender_id = profile.user_id AND request.recipient_id = auth.uid())
                                  )
                            )
                      )
                )
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_view_crew_list_photo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_crew_list_photo(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.browse_crew_list_profiles(
    p_target_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    user_id UUID,
    listing_type TEXT,
    first_name TEXT,
    gender TEXT,
    age_range TEXT,
    has_partner BOOLEAN,
    partner_details TEXT,
    skills TEXT[],
    sailing_experience TEXT,
    sailing_region TEXT,
    available_from TEXT,
    available_to TEXT,
    bio TEXT,
    vibe TEXT[],
    languages TEXT[],
    smoking TEXT,
    drinking TEXT,
    pets TEXT,
    interests TEXT[],
    last_active TIMESTAMPTZ,
    location_state TEXT,
    location_country TEXT,
    crew_photo_path TEXT,
    crew_photo_paths TEXT[],
    community_enabled BOOLEAN,
    crew_intents TEXT[],
    crew_list_visibility TEXT,
    approval_status TEXT,
    verification_status TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT
        profile.user_id,
        profile.listing_type,
        profile.first_name,
        profile.gender,
        profile.age_range,
        COALESCE(profile.has_partner, false),
        profile.partner_details,
        COALESCE(profile.skills, ARRAY[]::TEXT[]),
        profile.sailing_experience,
        profile.sailing_region,
        profile.available_from,
        profile.available_to,
        profile.bio,
        COALESCE(profile.vibe, ARRAY[]::TEXT[]),
        COALESCE(profile.languages, ARRAY[]::TEXT[]),
        profile.smoking,
        profile.drinking,
        profile.pets,
        COALESCE(profile.interests, ARRAY[]::TEXT[]),
        profile.last_active,
        profile.location_state,
        profile.location_country,
        profile.crew_photo_path,
        COALESCE(profile.crew_photo_paths, ARRAY[]::TEXT[]),
        profile.community_enabled,
        COALESCE(profile.crew_intents, ARRAY[]::TEXT[]),
        profile.crew_list_visibility,
        profile.approval_status,
        profile.verification_status,
        profile.created_at,
        profile.updated_at
    FROM public.sailor_crew_profiles profile
    WHERE auth.role() = 'authenticated'
      AND auth.uid() IS NOT NULL
      AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
      AND (p_target_id IS NULL OR profile.user_id = p_target_id)
      AND (
            (
                public.can_browse_crew_list()
                AND public.crew_list_account_is_verified(profile.user_id)
                AND profile.community_enabled
                AND profile.crew_list_visibility = 'visible'
                AND profile.approval_status = 'approved'
                AND profile.verification_status = 'verified'
            )
            OR (
                p_target_id IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM public.crew_intro_requests request
                    WHERE request.status = 'accepted'
                      AND (
                            (request.sender_id = auth.uid() AND request.recipient_id = profile.user_id)
                         OR (request.sender_id = profile.user_id AND request.recipient_id = auth.uid())
                      )
                )
            )
      )
    ORDER BY profile.updated_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 100));
$$;

REVOKE ALL ON FUNCTION public.browse_crew_list_profiles(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.browse_crew_list_profiles(UUID, INTEGER) TO authenticated;

-- Once an account has created a Crew List profile, cached copies of its UUID
-- must never become an ordinary generic-DM first-contact path merely because
-- the profile is later private, unverified, or deleted. This private fence
-- lasts until the auth account itself is deleted.
CREATE TABLE public.crew_list_contact_fences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.crew_list_contact_fences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_list_contact_fences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_list_contact_fences TO service_role;

INSERT INTO public.crew_list_contact_fences(user_id)
SELECT profile.user_id
FROM public.sailor_crew_profiles profile
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.remember_crew_list_contact_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.crew_list_contact_fences(user_id)
    VALUES (NEW.user_id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.remember_crew_list_contact_fence()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sailor_crew_profiles_remember_contact_fence
    ON public.sailor_crew_profiles;
CREATE TRIGGER sailor_crew_profiles_remember_contact_fence
    AFTER INSERT ON public.sailor_crew_profiles
    FOR EACH ROW EXECUTE FUNCTION public.remember_crew_list_contact_fence();

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_list_contact_fences;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_list_contact_fences
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

CREATE OR REPLACE FUNCTION public.can_send_generic_dm_to_recipient(p_recipient_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_recipient_id IS NOT NULL
       AND p_recipient_id <> auth.uid()
       AND (
            NOT EXISTS (
                SELECT 1
                FROM public.crew_list_contact_fences fence
                WHERE fence.user_id = p_recipient_id
            )
            OR EXISTS (
                SELECT 1
                FROM public.crew_intro_requests request
                WHERE request.status = 'accepted'
                  AND (
                        (request.sender_id = auth.uid() AND request.recipient_id = p_recipient_id)
                     OR (request.sender_id = p_recipient_id AND request.recipient_id = auth.uid())
                  )
            )
            OR EXISTS (
                SELECT 1
                FROM public.chat_direct_messages dm
                WHERE (dm.sender_id = auth.uid() AND dm.recipient_id = p_recipient_id)
                   OR (dm.sender_id = p_recipient_id AND dm.recipient_id = auth.uid())
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_send_generic_dm_to_recipient(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_generic_dm_to_recipient(UUID) TO authenticated;

-- Reporting remains available to a pair whose introduction was accepted,
-- even if either party later hides the listing or removes phone verification.
CREATE OR REPLACE FUNCTION public.can_report_crew_list_user(p_reported_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_reported_id IS NOT NULL
       AND p_reported_id <> auth.uid()
       AND (
            (
                public.crew_list_profile_is_discoverable(auth.uid())
                AND public.crew_list_profile_is_discoverable(p_reported_id)
            )
            OR EXISTS (
                SELECT 1
                FROM public.crew_intro_requests request
                WHERE request.status = 'accepted'
                  AND (
                        (request.sender_id = auth.uid() AND request.recipient_id = p_reported_id)
                     OR (request.sender_id = p_reported_id AND request.recipient_id = auth.uid())
                  )
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_report_crew_list_user(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_report_crew_list_user(UUID) TO authenticated;

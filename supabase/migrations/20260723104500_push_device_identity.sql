-- A native device token is an opaque bearer secret for one physical app
-- installation. It must never remain associated with two auth accounts after
-- an in-app account switch.

-- Repair any historic duplicate ownership before enforcing the invariant.
-- The most recently refreshed association is the best available indication of
-- which account last used this physical installation.
WITH ranked_tokens AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY device_token
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        ) AS ownership_rank
    FROM public.push_device_tokens
)
DELETE FROM public.push_device_tokens AS token
USING ranked_tokens AS ranked
WHERE token.id = ranked.id
  AND ranked.ownership_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS push_device_tokens_one_owner_per_device
    ON public.push_device_tokens(device_token);

CREATE OR REPLACE FUNCTION public.claim_push_device_token(
    p_expected_user_id UUID,
    p_device_token TEXT,
    p_platform TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_id UUID := auth.uid();
BEGIN
    IF caller_id IS NULL OR auth.role() <> 'authenticated' OR caller_id <> p_expected_user_id THEN
        RAISE EXCEPTION 'Authenticated identity does not match expected push owner';
    END IF;
    IF p_device_token IS NULL
       OR char_length(p_device_token) NOT BETWEEN 16 AND 4096
       OR p_device_token ~ '[[:space:][:cntrl:]]' THEN
        RAISE EXCEPTION 'Invalid device token';
    END IF;
    IF p_platform NOT IN ('ios', 'android') THEN
        RAISE EXCEPTION 'Invalid push platform';
    END IF;

    -- Serialize claims for this exact high-entropy bearer token. The lock and
    -- unique index prevent two concurrent account sessions from both winning.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_device_token, 20260723)
    );

    -- SECURITY DEFINER is deliberately limited to the exact opaque token the
    -- caller proves possession of by presenting. No user-id-selected deletion
    -- or broad token cleanup is exposed.
    DELETE FROM public.push_device_tokens
    WHERE device_token = p_device_token;

    INSERT INTO public.push_device_tokens (
        user_id,
        device_token,
        platform,
        updated_at
    )
    VALUES (
        caller_id,
        p_device_token,
        p_platform,
        now()
    );

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_push_device_token(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_push_device_token(UUID, TEXT, TEXT)
    TO authenticated;

CREATE OR REPLACE FUNCTION public.release_push_device_token(
    p_expected_user_id UUID,
    p_device_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_id UUID := auth.uid();
BEGIN
    IF caller_id IS NULL OR auth.role() <> 'authenticated' OR caller_id <> p_expected_user_id THEN
        RAISE EXCEPTION 'Authenticated identity does not match expected push owner';
    END IF;
    IF p_device_token IS NULL
       OR char_length(p_device_token) NOT BETWEEN 16 AND 4096
       OR p_device_token ~ '[[:space:][:cntrl:]]' THEN
        RAISE EXCEPTION 'Invalid device token';
    END IF;

    DELETE FROM public.push_device_tokens
    WHERE user_id = caller_id
      AND device_token = p_device_token;

    -- Idempotent success: the requested owner/token association is absent.
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.release_push_device_token(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_push_device_token(UUID, TEXT)
    TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_push_badge_for_identity(
    p_expected_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    caller_id UUID := auth.uid();
BEGIN
    IF caller_id IS NULL OR auth.role() <> 'authenticated' OR caller_id <> p_expected_user_id THEN
        RAISE EXCEPTION 'Authenticated identity does not match expected badge owner';
    END IF;

    UPDATE public.push_notification_queue
    SET read_at = now()
    WHERE recipient_user_id = caller_id
      AND sent_at IS NOT NULL
      AND read_at IS NULL;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_push_badge_for_identity(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_push_badge_for_identity(UUID)
    TO authenticated;

-- Server-side quota buckets for paid Edge relays and one-use WebSocket tickets.

CREATE TABLE IF NOT EXISTS public.edge_function_rate_limits (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, bucket, window_start)
);
ALTER TABLE public.edge_function_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_edge_quota(
    p_bucket TEXT,
    p_limit INTEGER,
    p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    bucket_start TIMESTAMPTZ;
    consumed INTEGER;
BEGIN
    IF auth.uid() IS NULL
       OR p_bucket !~ '^[a-z0-9_-]{1,40}$'
       OR p_limit NOT BETWEEN 1 AND 10000
       OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
        RETURN false;
    END IF;

    bucket_start := to_timestamp(
        floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
    );

    INSERT INTO public.edge_function_rate_limits(user_id, bucket, window_start, request_count)
    VALUES (auth.uid(), p_bucket, bucket_start, 1)
    ON CONFLICT (user_id, bucket, window_start) DO UPDATE
        SET request_count = public.edge_function_rate_limits.request_count + 1
        WHERE public.edge_function_rate_limits.request_count < p_limit
    RETURNING request_count INTO consumed;

    RETURN consumed IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_edge_quota(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_edge_quota(TEXT, INTEGER, INTEGER) TO authenticated;

CREATE TABLE IF NOT EXISTS public.deepgram_proxy_tickets (
    ticket_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.deepgram_proxy_tickets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_deepgram_proxy_ticket()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    raw_ticket TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    IF NOT public.consume_edge_quota('deepgram', 30, 3600) THEN
        RAISE EXCEPTION 'Voice session rate limit exceeded';
    END IF;

    raw_ticket := encode(gen_random_bytes(32), 'hex');
    INSERT INTO public.deepgram_proxy_tickets(ticket_hash, user_id, expires_at)
    VALUES (encode(digest(raw_ticket, 'sha256'), 'hex'), auth.uid(), now() + interval '60 seconds');
    RETURN raw_ticket;
END;
$$;

-- This function is intentionally callable with the public anon key: the
-- unguessable, one-use ticket is the credential. It reveals only success/fail.
CREATE OR REPLACE FUNCTION public.consume_deepgram_proxy_ticket(p_ticket TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    consumed_hash TEXT;
BEGIN
    IF p_ticket IS NULL OR p_ticket !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
    UPDATE public.deepgram_proxy_tickets
    SET used_at = now()
    WHERE ticket_hash = encode(digest(p_ticket, 'sha256'), 'hex')
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING ticket_hash INTO consumed_hash;
    RETURN consumed_hash IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.create_deepgram_proxy_ticket() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_deepgram_proxy_ticket() TO authenticated;
REVOKE ALL ON FUNCTION public.consume_deepgram_proxy_ticket(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_deepgram_proxy_ticket(TEXT) TO anon, authenticated, service_role;

-- Clean-up is opportunistic; every ticket is unusable after one minute even
-- if the scheduled job is not available in a local deployment.
CREATE INDEX IF NOT EXISTS deepgram_proxy_tickets_expiry_idx
    ON public.deepgram_proxy_tickets(expires_at);

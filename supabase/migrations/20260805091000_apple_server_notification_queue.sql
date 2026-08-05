-- Durable, service-role-only inbox for verified Sign in with Apple events.
--
-- The receiver never claims that a destructive account action completed. It
-- records verified consent-revoked/account-deleted events as pending so an
-- explicitly authorized processor can perform the same complete media/UGC/
-- auth deletion routine as the in-app flow. Raw JWS payloads and plaintext
-- Apple subjects are deliberately not retained.

CREATE TABLE IF NOT EXISTS public.apple_server_notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jti TEXT NOT NULL UNIQUE CHECK (length(jti) BETWEEN 1 AND 512),
    event_type TEXT NOT NULL CHECK (event_type IN ('consent-revoked', 'account-deleted')),
    apple_subject_sha256 TEXT NOT NULL CHECK (apple_subject_sha256 ~ '^[0-9a-f]{64}$'),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_time TIMESTAMPTZ NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS apple_server_notification_queue_pending_idx
    ON public.apple_server_notification_queue (received_at)
    WHERE status IN ('pending', 'failed');

ALTER TABLE public.apple_server_notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_server_notification_queue FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.apple_server_notification_queue FROM PUBLIC;
REVOKE ALL ON TABLE public.apple_server_notification_queue FROM anon;
REVOKE ALL ON TABLE public.apple_server_notification_queue FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apple_server_notification_queue TO service_role;

COMMENT ON TABLE public.apple_server_notification_queue IS
    'Verified Apple account events awaiting an explicitly authorized complete account-data processor.';

-- Sign in with Apple token retention for TN3194-compliant account deletion.
--
-- Only Edge Functions holding SUPABASE_SERVICE_ROLE_KEY can access this table.
-- The Apple refresh token is additionally encrypted with a dedicated 256-bit
-- application secret before it reaches Postgres. There are deliberately no
-- anon/authenticated RLS policies and no client grants.

CREATE TABLE IF NOT EXISTS public.apple_sign_in_tokens (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    refresh_token_ciphertext TEXT NOT NULL CHECK (length(refresh_token_ciphertext) BETWEEN 16 AND 16384),
    refresh_token_iv TEXT NOT NULL CHECK (length(refresh_token_iv) BETWEEN 16 AND 64),
    encryption_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_version = 1),
    apple_subject_sha256 TEXT NOT NULL UNIQUE CHECK (apple_subject_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.apple_sign_in_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apple_sign_in_tokens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM PUBLIC;
REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM anon;
REVOKE ALL ON TABLE public.apple_sign_in_tokens FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.apple_sign_in_tokens TO service_role;

COMMENT ON TABLE public.apple_sign_in_tokens IS
    'Service-role-only encrypted Apple refresh tokens retained solely for validation and account-deletion revocation.';
COMMENT ON COLUMN public.apple_sign_in_tokens.refresh_token_ciphertext IS
    'AES-256-GCM ciphertext; key is held only in APPLE_REFRESH_TOKEN_ENCRYPTION_KEY.';
COMMENT ON COLUMN public.apple_sign_in_tokens.refresh_token_iv IS
    'Unique 96-bit AES-GCM nonce encoded as standard base64.';
COMMENT ON COLUMN public.apple_sign_in_tokens.apple_subject_sha256 IS
    'SHA-256 digest of the verified Apple subject; plaintext provider identifier is not retained here.';

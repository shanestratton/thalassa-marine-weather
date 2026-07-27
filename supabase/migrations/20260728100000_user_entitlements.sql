-- User entitlements are deliberately separate from mutable preferences.
--
-- The historical `profiles` relation was never present in the production
-- schema, yet it was being used as both the settings store and the paid-tier
-- authority. A user must never be able to promote their own entitlement by
-- updating a JSON settings blob, so this table is service-owned apart from a
-- narrowly scoped, idempotent trial bootstrap RPC.

CREATE TABLE IF NOT EXISTS public.user_entitlements (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    subscription_status TEXT NOT NULL DEFAULT 'trial'
        CHECK (subscription_status IN ('active', 'trial', 'expired', 'free')),
    trial_start_date TIMESTAMPTZ,
    subscription_expiry TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_entitlements_active_expiry_idx
    ON public.user_entitlements (subscription_expiry)
    WHERE subscription_status = 'active' AND subscription_expiry IS NOT NULL;

CREATE OR REPLACE FUNCTION public.user_entitlements_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_entitlements_set_updated_at ON public.user_entitlements;
CREATE TRIGGER user_entitlements_set_updated_at
BEFORE UPDATE ON public.user_entitlements
FOR EACH ROW EXECUTE FUNCTION public.user_entitlements_set_updated_at();

ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_entitlements_read_own ON public.user_entitlements;
CREATE POLICY user_entitlements_read_own
    ON public.user_entitlements FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- There are intentionally no client INSERT/UPDATE/DELETE policies. Billing
-- webhooks and operations use the service role; a signed-in skipper may only
-- ensure that their own initial trial row exists through the RPC below.
REVOKE ALL ON TABLE public.user_entitlements FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_entitlements FROM authenticated;
GRANT SELECT ON TABLE public.user_entitlements TO authenticated;

CREATE OR REPLACE FUNCTION public.ensure_own_user_entitlement()
RETURNS TABLE (
    subscription_status TEXT,
    trial_start_date TIMESTAMPTZ,
    subscription_expiry TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_user_id UUID := auth.uid();
BEGIN
    IF current_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    -- Trial time begins on the account's first entitlement lookup, not at
    -- migration deployment or at an arbitrary anonymous device install.
    INSERT INTO public.user_entitlements (user_id, subscription_status, trial_start_date)
    VALUES (current_user_id, 'trial', statement_timestamp())
    ON CONFLICT (user_id) DO NOTHING;

    RETURN QUERY
    SELECT entitlement.subscription_status,
           entitlement.trial_start_date,
           entitlement.subscription_expiry
      FROM public.user_entitlements AS entitlement
     WHERE entitlement.user_id = current_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_own_user_entitlement() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_own_user_entitlement() TO authenticated, service_role;

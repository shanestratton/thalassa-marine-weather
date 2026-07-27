-- Account-scoped preferences contract.
--
-- `profiles` was never a source-controlled table in this project, yet the
-- mobile settings store and weather-alert worker treated `profiles.settings`
-- as their shared persistence layer.  Keep generic preferences in an
-- explicit, private table instead.  Vessel data and entitlement fields are
-- deliberately excluded: they have their own authoritative contracts.

CREATE TABLE IF NOT EXISTS public.user_settings (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    settings    JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_settings_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE OR REPLACE FUNCTION public.user_settings_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_settings_set_updated_at ON public.user_settings;
CREATE TRIGGER user_settings_set_updated_at
    BEFORE UPDATE ON public.user_settings
    FOR EACH ROW EXECUTE FUNCTION public.user_settings_set_updated_at();

-- Copy legacy preferences only in installations where the retired table is
-- genuinely present with the expected shape.  The fleet migration has already
-- promoted legacy vessel fields before this migration; do not recreate a
-- second vessel authority here.  Likewise, subscription state must not remain
-- client-mutable inside a generic settings blob.
DO $$
BEGIN
    IF to_regclass('public.profiles') IS NOT NULL
       AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name = 'id'
              AND data_type = 'uuid'
       )
       AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name = 'settings'
              AND data_type IN ('json', 'jsonb')
       ) THEN
        EXECUTE $legacy_backfill$
            INSERT INTO public.user_settings AS target (user_id, settings)
            SELECT
                profile.id,
                (
                    CASE
                        WHEN jsonb_typeof(profile.settings::jsonb) = 'object' THEN profile.settings::jsonb
                        ELSE '{}'::jsonb
                    END
                    - ARRAY[
                        'vessel',
                        'vesselUnits',
                        'comfortParams',
                        'polarData',
                        'polarBoatModel',
                        'polarSource_type',
                        'subscriptionTier',
                        'subscriptionExpiry',
                        'isPro'
                    ]::text[]
                )
            FROM public.profiles AS profile
            INNER JOIN auth.users AS account ON account.id = profile.id
            ON CONFLICT (user_id) DO NOTHING
        $legacy_backfill$;
    END IF;
END;
$$;

-- The client sends only the fields it changed.  Atomic server-side merging
-- avoids a stale whole-settings write from one device erasing an unrelated
-- setting saved by another.  `notifications` and `units` are compound
-- settings, so their direct children are merged too.
CREATE OR REPLACE FUNCTION public.merge_user_settings(p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    safe_patch JSONB;
    persisted_settings JSONB;
BEGIN
    IF caller_id IS NULL OR auth.role() <> 'authenticated' THEN
        RAISE EXCEPTION 'An authenticated user is required to update settings'
            USING ERRCODE = '42501';
    END IF;

    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'Settings patch must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF octet_length(p_patch::text) > 262144 THEN
        RAISE EXCEPTION 'Settings patch is too large'
            USING ERRCODE = '22001';
    END IF;

    IF p_patch ? 'notifications' AND jsonb_typeof(p_patch -> 'notifications') <> 'object' THEN
        RAISE EXCEPTION 'notifications must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF p_patch ? 'units' AND jsonb_typeof(p_patch -> 'units') <> 'object' THEN
        RAISE EXCEPTION 'units must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    safe_patch := p_patch - ARRAY[
        'vessel',
        'vesselUnits',
        'comfortParams',
        'polarData',
        'polarBoatModel',
        'polarSource_type',
        'subscriptionTier',
        'subscriptionExpiry',
        'isPro'
    ]::text[];

    INSERT INTO public.user_settings AS target (user_id, settings)
    VALUES (caller_id, safe_patch)
    ON CONFLICT (user_id) DO UPDATE
    SET settings = (
        (target.settings || EXCLUDED.settings)
        || CASE
            WHEN EXCLUDED.settings ? 'notifications' THEN
                jsonb_build_object(
                    'notifications',
                    CASE
                        WHEN jsonb_typeof(target.settings -> 'notifications') = 'object' THEN
                            (target.settings -> 'notifications') || (EXCLUDED.settings -> 'notifications')
                        ELSE EXCLUDED.settings -> 'notifications'
                    END
                )
            ELSE '{}'::jsonb
        END
        || CASE
            WHEN EXCLUDED.settings ? 'units' THEN
                jsonb_build_object(
                    'units',
                    CASE
                        WHEN jsonb_typeof(target.settings -> 'units') = 'object' THEN
                            (target.settings -> 'units') || (EXCLUDED.settings -> 'units')
                        ELSE EXCLUDED.settings -> 'units'
                    END
                )
            ELSE '{}'::jsonb
        END
    )
    RETURNING settings INTO persisted_settings;

    RETURN persisted_settings;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_user_settings(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_user_settings(JSONB) TO authenticated;

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_settings_select_own ON public.user_settings;
CREATE POLICY user_settings_select_own
    ON public.user_settings FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Writes are intentionally RPC-only.  This keeps the auth-derived owner,
-- field allow-list, size bound, and compound-object merge in one place.
REVOKE ALL ON TABLE public.user_settings FROM anon, authenticated;
GRANT SELECT ON TABLE public.user_settings TO authenticated;
GRANT SELECT ON TABLE public.user_settings TO service_role;

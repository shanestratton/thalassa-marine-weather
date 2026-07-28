-- Adding a second vessel failed with 42702 "column reference id is ambiguous".
--
-- Same defect class as 20260728130000, different column. This function also
-- declares RETURNS TABLE (id UUID, ...), so `id` is a PL/pgSQL variable
-- inside the body, and
--
--     INSERT INTO public.boats (...) VALUES (...) RETURNING id INTO new_boat_id;
--
-- cannot be resolved: `id` is both the OUT column and boats.id. The fleet is
-- advertised as "1/5 vessels", but no skipper could ever reach 2.
--
-- Scoped against the live catalogue rather than by eye — of every function
-- containing an unqualified `RETURNING id`, this is the only one that also
-- returns a TABLE with an `id` column, so it is the only one that can raise.
-- The rest return scalars and have no shadowing variable.
--
-- Aliasing the insert target is the narrow fix. The other statements in this
-- function were checked and are safe: `WHERE boat_id = new_boat_id` names a
-- column that is not in the RETURNS TABLE list, and the UPDATE's right-hand
-- sides are all parameters rather than column references.
CREATE OR REPLACE FUNCTION public.create_owned_vessel_profile(
    p_profile JSONB,
    p_vessel_units JSONB DEFAULT '{}'::JSONB,
    p_polar_data JSONB DEFAULT NULL,
    p_polar_boat_model TEXT DEFAULT NULL,
    p_polar_source_type TEXT DEFAULT NULL,
    p_comfort_params JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    new_boat_id UUID;
    vessel_name TEXT;
    vessel_type_value TEXT;
    vessel_model_value TEXT;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_polar_data IS NOT NULL AND jsonb_typeof(p_polar_data) <> 'object' AND jsonb_typeof(p_polar_data) <> 'array' THEN
        RAISE EXCEPTION 'Polar data must be an object or array when provided' USING ERRCODE = '22023';
    END IF;
    IF p_polar_source_type IS NOT NULL
       AND p_polar_source_type NOT IN ('database', 'file_import', 'manual') THEN
        RAISE EXCEPTION 'Unknown polar source type' USING ERRCODE = '22023';
    END IF;

    PERFORM public.assert_valid_vessel_profile_input(
        p_profile,
        COALESCE(p_vessel_units, '{}'::JSONB),
        COALESCE(p_comfort_params, '{}'::JSONB)
    );

    vessel_name := BTRIM(p_profile ->> 'name');
    vessel_type_value := BTRIM(p_profile ->> 'type');
    vessel_model_value := NULLIF(BTRIM(p_profile ->> 'model'), '');

    -- The trigger enforces this same limit for every insert path. Taking the
    -- advisory lock here makes the user-facing error deterministic before the
    -- insert and documents the atomic fleet-creation contract.
    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));
    IF (
        SELECT COUNT(*)
          FROM public.boats AS boat
         WHERE boat.owner_id = current_owner_id
           AND boat.archived_at IS NULL
    ) >= 5 THEN
        RAISE EXCEPTION 'A skipper may have at most five active vessels'
            USING ERRCODE = 'P0001',
                  DETAIL = 'Archive an existing vessel before creating another one.';
    END IF;

    INSERT INTO public.boats AS boat (owner_id, name, vessel_type, model)
    VALUES (current_owner_id, vessel_name, vessel_type_value, vessel_model_value)
    RETURNING boat.id INTO new_boat_id;

    -- `boats_create_default_profile` has created the shell already. Replace it
    -- rather than relying on the caller to make a second request.
    UPDATE public.boat_profiles
       SET profile = p_profile,
           vessel_units = COALESCE(p_vessel_units, '{}'::JSONB),
           polar_data = p_polar_data,
           polar_boat_model = NULLIF(BTRIM(p_polar_boat_model), ''),
           polar_source_type = p_polar_source_type,
           comfort_params = COALESCE(p_comfort_params, '{}'::JSONB)
     WHERE boat_id = new_boat_id;

    INSERT INTO public.user_active_vessels (user_id, boat_id)
    VALUES (current_owner_id, new_boat_id)
    ON CONFLICT (user_id) DO UPDATE
        SET boat_id = EXCLUDED.boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, new_boat_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    TO authenticated;

-- Every vessel profile edit failed with 42702 "column reference polar_data is
-- ambiguous", for every account, since the fleet contract shipped.
--
-- `patch_owned_vessel_profile` declares RETURNS TABLE (... polar_data,
-- polar_boat_model, polar_source_type ...).  Those output columns become
-- PL/pgSQL variables inside the body, so the unqualified `ELSE polar_data`
-- branches in the UPDATE could mean either the OUT variable or the
-- boat_profiles column.  PL/pgSQL refuses to guess and raises 42702, which
-- PostgREST surfaces as HTTP 400.
--
-- The failure was invisible from the client: VesselFleetService wraps the
-- PostgrestError in `new Error(...)`, whose `message` is non-enumerable, so
-- the queued-patch warning logged a bare `{}`.  The device then parked the
-- edit in its outbox and reported "Saved offline" while fully online, and
-- every later edit queued behind it without retrying.
--
-- Qualify the self-references with an alias rather than adding
-- `#variable_conflict use_column`: the pragma would silently change name
-- resolution for the whole body, including places where the PL/pgSQL variable
-- is the intended target.  SET targets stay unqualified — Postgres does not
-- accept a qualified column on the left of SET.
CREATE OR REPLACE FUNCTION public.patch_owned_vessel_profile(
    p_boat_id UUID,
    p_profile_patch JSONB DEFAULT '{}'::JSONB,
    p_vessel_units_patch JSONB DEFAULT '{}'::JSONB,
    p_polar_data JSONB DEFAULT NULL,
    p_set_polar_data BOOLEAN DEFAULT false,
    p_polar_boat_model TEXT DEFAULT NULL,
    p_set_polar_boat_model BOOLEAN DEFAULT false,
    p_polar_source_type TEXT DEFAULT NULL,
    p_set_polar_source_type BOOLEAN DEFAULT false,
    p_comfort_params_patch JSONB DEFAULT '{}'::JSONB,
    p_expected_revision BIGINT DEFAULT NULL
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
    current_profile JSONB;
    current_units JSONB;
    current_comfort JSONB;
    current_archived_at TIMESTAMPTZ;
    next_profile JSONB;
    next_units JSONB;
    next_comfort JSONB;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_boat_id IS NULL THEN
        RAISE EXCEPTION 'A vessel id is required' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(jsonb_typeof(p_profile_patch), 'null') <> 'object'
       OR COALESCE(jsonb_typeof(p_vessel_units_patch), 'null') <> 'object'
       OR COALESCE(jsonb_typeof(p_comfort_params_patch), 'null') <> 'object' THEN
        RAISE EXCEPTION 'Vessel patches must be objects' USING ERRCODE = '22023';
    END IF;
    IF p_set_polar_data
       AND p_polar_data IS NOT NULL
       AND jsonb_typeof(p_polar_data) <> 'object'
       AND jsonb_typeof(p_polar_data) <> 'array' THEN
        RAISE EXCEPTION 'Polar data must be an object or array when provided' USING ERRCODE = '22023';
    END IF;
    IF p_set_polar_source_type
       AND p_polar_source_type IS NOT NULL
       AND p_polar_source_type NOT IN ('database', 'file_import', 'manual') THEN
        RAISE EXCEPTION 'Unknown polar source type' USING ERRCODE = '22023';
    END IF;

    SELECT profile.profile,
           profile.vessel_units,
           profile.comfort_params,
           boat.archived_at
      INTO current_profile,
           current_units,
           current_comfort,
           current_archived_at
      FROM public.boats AS boat
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE boat.id = p_boat_id
       AND boat.owner_id = current_owner_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vessel not found or not owned by current user' USING ERRCODE = '42501';
    END IF;
    IF current_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'Archived vessels cannot be edited' USING ERRCODE = '22023';
    END IF;
    -- Revisions are returned for diagnostics and UX, not a hard lock. A
    -- queued patch from device B must still merge into device A's newer row:
    -- JSONB `||` makes independent top-level fields converge, while a true
    -- same-field collision is intentionally last-writer-wins.

    -- JSON null is the explicit sparse-patch delete token. It lets a device
    -- clear a comfort threshold or optional unit without replacing unrelated
    -- fields from another device; JavaScript callers must normalise an
    -- `undefined` clear to null before RPC serialisation.
    next_profile := jsonb_strip_nulls(current_profile || COALESCE(p_profile_patch, '{}'::JSONB));
    next_units := jsonb_strip_nulls(current_units || COALESCE(p_vessel_units_patch, '{}'::JSONB));
    next_comfort := jsonb_strip_nulls(current_comfort || COALESCE(p_comfort_params_patch, '{}'::JSONB));
    PERFORM public.assert_valid_vessel_profile_input(next_profile, next_units, next_comfort);

    UPDATE public.boat_profiles AS target
       SET profile = next_profile,
           vessel_units = next_units,
           polar_data = CASE WHEN p_set_polar_data THEN p_polar_data ELSE target.polar_data END,
           polar_boat_model = CASE
               WHEN p_set_polar_boat_model THEN NULLIF(BTRIM(p_polar_boat_model), '')
               ELSE target.polar_boat_model
           END,
           polar_source_type = CASE
               WHEN p_set_polar_source_type THEN p_polar_source_type
               ELSE target.polar_source_type
           END,
           comfort_params = next_comfort
     WHERE target.boat_id = p_boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, p_boat_id);
END;
$$;

REVOKE ALL ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) TO authenticated;

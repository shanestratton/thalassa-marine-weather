-- Route Tracer Cast Off verification (public-beta safety gate).
--
-- Client UI/service checks are useful explanations, not authority. An
-- authenticated caller can invoke cast_off_voyage directly, so the final
-- planning -> active transition must verify the versioned envelope while the
-- voyage row is locked by the RPC. Manual (non-tracer) voyages are unchanged.

CREATE OR REPLACE FUNCTION public.enforce_traced_route_cast_off_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    prefix CONSTANT TEXT := '__thalassa_trace_verification_v1__::';
    payload_text TEXT;
    proof JSONB;
    grades JSONB;
    acknowledgements JSONB;
    route_points JSONB;
    expected_geometry_key TEXT;
    checked_at TIMESTAMPTZ;
    proof_departure_ms DOUBLE PRECISION;
    danger_count INTEGER;
BEGIN
    IF NOT (OLD.status = 'planning' AND NEW.status = 'active') THEN
        RETURN NEW;
    END IF;

    -- Ordinary planner/manual voyages carry neither a canonical tracer link
    -- nor the namespaced trace envelope and keep their existing Cast Off path.
    IF NEW.saved_route_id IS NULL AND COALESCE(NEW.notes, '') NOT LIKE prefix || '%' THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.notes, '') NOT LIKE prefix || '%' THEN
        RAISE EXCEPTION 'Traced route verification is missing. Recheck the route before Cast Off.';
    END IF;

    payload_text := split_part(substr(NEW.notes, length(prefix) + 1), E'\n', 1);
    BEGIN
        proof := payload_text::JSONB;
        checked_at := (proof->>'checkedAt')::TIMESTAMPTZ;
        proof_departure_ms := (proof->>'departureMs')::DOUBLE PRECISION;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Traced route verification is malformed. Recheck the route before Cast Off.';
    END;

    IF jsonb_typeof(proof) IS DISTINCT FROM 'object' OR checked_at IS NULL OR proof_departure_ms IS NULL THEN
        RAISE EXCEPTION 'Traced route verification is malformed. Recheck the route before Cast Off.';
    END IF;

    grades := proof->'legGrades';
    acknowledgements := proof->'acknowledgedDangerLegs';
    IF proof->>'version' IS DISTINCT FROM '1'
        OR proof->>'graderVersion' IS DISTINCT FROM 'route-tracer-v1'
        OR COALESCE(proof->>'result', '') NOT IN ('verified', 'danger-acknowledged')
        OR jsonb_typeof(proof->'checkedAt') IS DISTINCT FROM 'string'
        OR jsonb_typeof(proof->'departureMs') IS DISTINCT FROM 'number'
        OR jsonb_typeof(grades) IS DISTINCT FROM 'array'
        OR jsonb_array_length(grades) < 1
        OR jsonb_typeof(acknowledgements) IS DISTINCT FROM 'array'
        OR jsonb_typeof(proof->'geometryKey') IS DISTINCT FROM 'string'
        OR COALESCE(proof->>'geometryKey', '') = ''
        OR jsonb_typeof(proof->'draftM') IS DISTINCT FROM 'number'
        OR (proof->>'draftM')::DOUBLE PRECISION <= 0
        OR jsonb_typeof(proof->'draftAssumed') IS DISTINCT FROM 'boolean'
        OR proof->>'draftAssumed' IS DISTINCT FROM 'false'
        OR jsonb_typeof(proof->'encRegistryVersion') IS DISTINCT FROM 'number'
        OR (proof->>'encRegistryVersion')::INTEGER < 0
        OR jsonb_typeof(proof->'encRegistryFingerprint') IS DISTINCT FROM 'string'
        OR COALESCE(proof->>'encRegistryFingerprint', '') = ''
        OR jsonb_typeof(proof->'tideWindowLabel') IS DISTINCT FROM 'string'
    THEN
        RAISE EXCEPTION 'Traced route verification is incomplete. Recheck the route before Cast Off.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(grades) AS grade(value)
        WHERE grade.value NOT IN ('clear', 'caution', 'danger')
    ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(acknowledgements) AS acknowledgement(value)
        WHERE acknowledgement.value !~ '^[0-9]+$'
    ) THEN
        RAISE EXCEPTION 'Traced route verification contains invalid leg states.';
    END IF;

    SELECT count(*)
    INTO danger_count
    FROM jsonb_array_elements_text(grades) AS grade(value)
    WHERE grade.value = 'danger';

    IF (danger_count = 0 AND proof->>'result' IS DISTINCT FROM 'verified')
        OR (danger_count > 0 AND proof->>'result' IS DISTINCT FROM 'danger-acknowledged')
        OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(grades) WITH ORDINALITY AS grade(value, ordinal)
            WHERE grade.value = 'danger'
              AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(acknowledgements) AS acknowledgement(value)
                  WHERE acknowledgement.value::INTEGER = grade.ordinal - 1
              )
        )
        OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(acknowledgements) AS acknowledgement(value)
            WHERE acknowledgement.value::INTEGER >= jsonb_array_length(grades)
               OR grades->>(acknowledgement.value::INTEGER) <> 'danger'
        )
    THEN
        RAISE EXCEPTION 'Every no-go leg must be acknowledged for this exact route before Cast Off.';
    END IF;

    IF NEW.saved_route_id IS NOT NULL THEN
        SELECT route.points
        INTO route_points
        FROM public.saved_routes AS route
        WHERE route.id = NEW.saved_route_id
          AND route.user_id = NEW.user_id
          AND route.deleted = false;

        IF route_points IS NULL OR jsonb_typeof(route_points) <> 'array' OR jsonb_array_length(route_points) < 2 THEN
            RAISE EXCEPTION 'The linked traced route is missing or deleted. Save and check it again.';
        END IF;

        SELECT
            'trace-geometry-v1|' || jsonb_array_length(route_points)::TEXT || '|' ||
            string_agg(
                to_char((point.value->>0)::NUMERIC, 'FM999990.000000') || ',' ||
                to_char((point.value->>1)::NUMERIC, 'FM999990.000000'),
                '|' ORDER BY point.ordinal
            )
        INTO expected_geometry_key
        FROM jsonb_array_elements(route_points) WITH ORDINALITY AS point(value, ordinal);

        IF proof->>'geometryKey' IS DISTINCT FROM expected_geometry_key
            OR jsonb_array_length(grades) <> jsonb_array_length(route_points) - 1
        THEN
            RAISE EXCEPTION 'The traced route changed after it was checked. Recheck it before Cast Off.';
        END IF;
    END IF;

    -- cast_off_voyage deliberately stamps NEW.departure_time = locked_at.
    -- The proof belongs to the planning value on OLD; current-time/tide
    -- freshness is enforced separately below.
    IF OLD.departure_time IS NULL
        OR abs(proof_departure_ms - extract(epoch FROM OLD.departure_time) * 1000) > 60000
    THEN
        RAISE EXCEPTION 'The planned departure changed after the route check. Recheck before Cast Off.';
    END IF;

    IF checked_at > clock_timestamp() + interval '5 minutes'
        OR (
            COALESCE(proof->>'tideWindowLabel', '') <> ''
            AND checked_at < clock_timestamp() - interval '48 hours'
        )
        OR (
            COALESCE(proof->>'tideWindowLabel', '') = ''
            AND checked_at < clock_timestamp() - interval '30 days'
        )
    THEN
        RAISE EXCEPTION 'The traced route check is stale. Recheck against current charts before Cast Off.';
    END IF;

    IF COALESCE(proof->>'tideWindowLabel', '') <> ''
        AND abs(extract(epoch FROM clock_timestamp()) * 1000 - proof_departure_ms) > 21600000
    THEN
        RAISE EXCEPTION 'Cast Off is outside the checked tide-departure window. Recheck the route.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_traced_route_cast_off_verification_trigger ON public.voyages;
CREATE TRIGGER enforce_traced_route_cast_off_verification_trigger
    BEFORE UPDATE OF status ON public.voyages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_traced_route_cast_off_verification();

REVOKE ALL ON FUNCTION public.enforce_traced_route_cast_off_verification() FROM PUBLIC;

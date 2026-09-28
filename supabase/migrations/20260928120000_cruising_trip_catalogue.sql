-- UNDEPLOYED foundation. No seeds, private-track imports, or planner wiring.
-- PostGIS is installed by existing migrations, sometimes in public and
-- sometimes in extensions. Do not relocate an existing extension.
BEGIN;
SET LOCAL search_path = pg_catalog, public, extensions;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'postgis' AND n.nspname IN ('public', 'extensions')
    ) THEN
        RAISE EXCEPTION 'Cruising catalogue requires existing PostGIS in public or extensions';
    END IF;
END;
$$;

CREATE TABLE public.cruising_catalogue_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('destination', 'trip', 'route_variant')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
    current_version integer CHECK (current_version > 0),
    withdrawal_reason text CHECK (length(withdrawal_reason) BETWEEN 1 AND 2000),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'published' OR current_version IS NOT NULL),
    CHECK ((status = 'withdrawn') = (withdrawal_reason IS NOT NULL))
);

CREATE TABLE public.cruising_catalogue_versions (
    entry_id uuid NOT NULL REFERENCES public.cruising_catalogue_entries(id),
    version integer NOT NULL CHECK (version > 0),
    kind text NOT NULL CHECK (kind IN ('destination', 'trip', 'route_variant')),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
    summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    location geography(Point, 4326) GENERATED ALWAYS AS
        (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED,
    -- A source retrieval is not a human review and never establishes safe access.
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 12),
    review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed')),
    reviewed_at timestamptz,
    review_due_at timestamptz,
    reviewer_label text CHECK (length(btrim(reviewer_label)) BETWEEN 1 AND 160),
    review_scope text CHECK (length(btrim(review_scope)) BETWEEN 1 AND 1000),
    limitations text[] NOT NULL CHECK (cardinality(limitations) BETWEEN 1 AND 20),
    activities text[] NOT NULL DEFAULT '{}' CHECK (cardinality(activities) <= 12),
    origin_destination_id uuid,
    origin_destination_version integer,
    destination_id uuid,
    destination_version integer,
    trip_id uuid,
    trip_version integer,
    direction text CHECK (direction IN ('outbound', 'return')),
    -- The order is authoritative. All points, including intermediate controls,
    -- are required; reversing a variant is never an implicit return route.
    checkpoints jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entry_id, version),
    FOREIGN KEY (origin_destination_id, origin_destination_version)
        REFERENCES public.cruising_catalogue_versions(entry_id, version) MATCH FULL,
    FOREIGN KEY (destination_id, destination_version)
        REFERENCES public.cruising_catalogue_versions(entry_id, version) MATCH FULL,
    FOREIGN KEY (trip_id, trip_version)
        REFERENCES public.cruising_catalogue_versions(entry_id, version) MATCH FULL,
    CHECK (
        (review_status = 'pending' AND reviewed_at IS NULL AND review_due_at IS NULL
            AND reviewer_label IS NULL AND review_scope IS NULL)
        OR (review_status = 'reviewed' AND reviewed_at IS NOT NULL AND review_due_at IS NOT NULL
            AND reviewer_label IS NOT NULL AND review_scope IS NOT NULL
            AND isfinite(reviewed_at) AND isfinite(review_due_at) AND review_due_at > reviewed_at)
    ),
    CHECK (
        (kind = 'destination' AND origin_destination_id IS NULL AND destination_id IS NULL
            AND trip_id IS NULL AND direction IS NULL AND checkpoints IS NULL)
        OR (kind = 'trip' AND origin_destination_id IS NOT NULL AND destination_id IS NOT NULL
            AND origin_destination_id <> destination_id AND trip_id IS NULL
            AND direction IS NULL AND checkpoints IS NULL)
        OR (kind = 'route_variant' AND origin_destination_id IS NULL AND destination_id IS NULL
            AND trip_id IS NOT NULL AND direction IS NOT NULL AND checkpoints IS NOT NULL
            AND jsonb_typeof(checkpoints) = 'array' AND jsonb_array_length(checkpoints) BETWEEN 2 AND 256)
    ),
    CHECK (pg_column_size(evidence) <= 32768),
    CHECK (checkpoints IS NULL OR pg_column_size(checkpoints) <= 131072)
);

ALTER TABLE public.cruising_catalogue_entries ADD CONSTRAINT cruising_catalogue_current_version_fk
    FOREIGN KEY (id, current_version) REFERENCES public.cruising_catalogue_versions(entry_id, version);
CREATE INDEX cruising_catalogue_location_gist ON public.cruising_catalogue_versions USING gist (location);
CREATE INDEX cruising_catalogue_trip_version ON public.cruising_catalogue_versions (trip_id, trip_version)
    WHERE kind = 'route_variant';

-- Content is append-only even for the service role. A correction/re-review
-- requires another version. Lifecycle/pointer changes belong to the identity.
CREATE FUNCTION public.cruising_catalogue_validate_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, extensions AS $$
DECLARE
    item jsonb;
    ordinal bigint;
    parent public.cruising_catalogue_versions;
    departure public.cruising_catalogue_versions;
    arrival public.cruising_catalogue_versions;
    previous_point jsonb;
    source_date timestamptz;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Catalogue versions are immutable; insert a new version';
    END IF;
    IF NEW.kind IS DISTINCT FROM (SELECT kind FROM public.cruising_catalogue_entries WHERE id = NEW.entry_id) THEN
        RAISE EXCEPTION 'Catalogue version kind must match its identity';
    END IF;
    IF NEW.reviewed_at > statement_timestamp() THEN
        RAISE EXCEPTION 'Catalogue review must not be in the future';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.limitations || NEW.activities) s
        WHERE s IS NULL OR length(btrim(s)) NOT BETWEEN 1 AND 1000) THEN
        RAISE EXCEPTION 'Catalogue text lists must contain bounded nonempty strings';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.evidence) LOOP
        IF jsonb_typeof(item) <> 'object' OR NOT item ?& ARRAY[
            'source_url', 'source_label', 'retrieved_at', 'licence', 'licence_url', 'attribution', 'scope'
        ] OR EXISTS (
            SELECT 1 FROM jsonb_each(item) p WHERE jsonb_typeof(p.value) <> 'string'
                OR length(btrim(p.value #>> '{}')) NOT BETWEEN 1 AND 2000
        ) OR item->>'source_url' !~ '^https://[^[:space:]]+$'
          OR item->>'licence_url' !~ '^https://[^[:space:]]+$' THEN
            RAISE EXCEPTION 'Catalogue evidence requires source, licensing, attribution and scope';
        END IF;
        IF item->>'retrieved_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
            RAISE EXCEPTION 'Evidence retrieval requires an ISO timestamp with timezone';
        END IF;
        source_date := (item->>'retrieved_at')::timestamptz;
        IF NOT isfinite(source_date) OR source_date > statement_timestamp()
            OR (NEW.reviewed_at IS NOT NULL AND source_date > NEW.reviewed_at) THEN
            RAISE EXCEPTION 'Evidence retrieval must precede the review and cannot be in the future';
        END IF;
    END LOOP;
    IF NEW.kind = 'trip' THEN
        SELECT * INTO departure FROM public.cruising_catalogue_versions
            WHERE entry_id = NEW.origin_destination_id AND version = NEW.origin_destination_version;
        SELECT * INTO arrival FROM public.cruising_catalogue_versions
            WHERE entry_id = NEW.destination_id AND version = NEW.destination_version;
        IF departure.kind IS DISTINCT FROM 'destination' OR arrival.kind IS DISTINCT FROM 'destination'
            OR NEW.latitude IS DISTINCT FROM departure.latitude OR NEW.longitude IS DISTINCT FROM departure.longitude THEN
            RAISE EXCEPTION 'Trip endpoints must reference exact destination versions; location is departure';
        END IF;
    ELSIF NEW.kind = 'route_variant' THEN
        SELECT * INTO parent FROM public.cruising_catalogue_versions
            WHERE entry_id = NEW.trip_id AND version = NEW.trip_version;
        IF parent.kind IS DISTINCT FROM 'trip' THEN
            RAISE EXCEPTION 'Route variant must reference an exact trip version';
        END IF;
        SELECT * INTO departure FROM public.cruising_catalogue_versions
            WHERE entry_id = CASE WHEN NEW.direction = 'outbound' THEN parent.origin_destination_id ELSE parent.destination_id END
                AND version = CASE WHEN NEW.direction = 'outbound' THEN parent.origin_destination_version ELSE parent.destination_version END;
        SELECT * INTO arrival FROM public.cruising_catalogue_versions
            WHERE entry_id = CASE WHEN NEW.direction = 'outbound' THEN parent.destination_id ELSE parent.origin_destination_id END
                AND version = CASE WHEN NEW.direction = 'outbound' THEN parent.destination_version ELSE parent.origin_destination_version END;
        IF NEW.latitude IS DISTINCT FROM departure.latitude OR NEW.longitude IS DISTINCT FROM departure.longitude THEN
            RAISE EXCEPTION 'Route variant location must match its directional departure';
        END IF;
        FOR item, ordinal IN SELECT value, ordinality FROM jsonb_array_elements(NEW.checkpoints) WITH ORDINALITY LOOP
            IF jsonb_typeof(item) <> 'object' OR NOT item ?& ARRAY[
                'sequence', 'name', 'latitude', 'longitude', 'required', 'evidence_note'
            ] OR item->'required' IS DISTINCT FROM 'true'::jsonb
                OR jsonb_typeof(item->'sequence') IS DISTINCT FROM 'number'
                OR (item->>'sequence')::numeric <> ordinal
                OR jsonb_typeof(item->'latitude') IS DISTINCT FROM 'number'
                OR jsonb_typeof(item->'longitude') IS DISTINCT FROM 'number'
                OR (item->>'latitude')::double precision NOT BETWEEN -90 AND 90
                OR (item->>'longitude')::double precision NOT BETWEEN -180 AND 180
                OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
                OR length(btrim(item->>'name')) NOT BETWEEN 1 AND 160
                OR jsonb_typeof(item->'evidence_note') IS DISTINCT FROM 'string'
                OR length(btrim(item->>'evidence_note')) NOT BETWEEN 1 AND 1000 THEN
                RAISE EXCEPTION 'Route checkpoints must be bounded, ordered, evidenced and required';
            END IF;
            IF previous_point IS NOT NULL AND item->'latitude' = previous_point->'latitude'
                AND item->'longitude' = previous_point->'longitude' THEN
                RAISE EXCEPTION 'Consecutive route checkpoints must differ';
            END IF;
            IF ordinal = 1 AND ((item->>'latitude')::double precision <> departure.latitude
                OR (item->>'longitude')::double precision <> departure.longitude) THEN
                RAISE EXCEPTION 'First checkpoint must match the directional departure';
            END IF;
            previous_point := item;
        END LOOP;
        IF (previous_point->>'latitude')::double precision <> arrival.latitude
            OR (previous_point->>'longitude')::double precision <> arrival.longitude THEN
            RAISE EXCEPTION 'Last checkpoint must match the directional arrival';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cruising_catalogue_validate_version() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER cruising_catalogue_immutable_versions BEFORE INSERT OR UPDATE OR DELETE
    ON public.cruising_catalogue_versions FOR EACH ROW EXECUTE FUNCTION public.cruising_catalogue_validate_version();

CREATE FUNCTION public.cruising_catalogue_guard_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Withdraw catalogue entries instead of deleting'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.kind <> OLD.kind
        OR (OLD.current_version IS NOT NULL AND (NEW.current_version IS NULL OR NEW.current_version < OLD.current_version))) THEN
        RAISE EXCEPTION 'Catalogue identity is immutable and versions cannot move backwards';
    END IF;
    -- Fence every exit, including withdrawn -> draft -> published. Reusing a
    -- withdrawn destination version would also resurrect its old dependants.
    -- An identity withdrawn before its first version must acquire version 1+
    -- before leaving withdrawal; a null pointer cannot bypass the fence.
    IF TG_OP = 'UPDATE' AND OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn'
        AND (NEW.current_version IS NULL OR NEW.current_version <= COALESCE(OLD.current_version, 0)) THEN
        RAISE EXCEPTION 'Leaving withdrawal requires a strictly newer catalogue version';
    END IF;
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cruising_catalogue_guard_entry() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER cruising_catalogue_entry_guard BEFORE INSERT OR UPDATE OR DELETE
    ON public.cruising_catalogue_entries FOR EACH ROW EXECUTE FUNCTION public.cruising_catalogue_guard_entry();

-- A bounded three-level graph: variant -> trip -> destinations. The definer
-- avoids self-recursive RLS; only a boolean about public eligibility is exposed.
CREATE FUNCTION public.cruising_catalogue_is_readable(p_id uuid, p_version integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v public.cruising_catalogue_versions;
BEGIN
    SELECT cv.* INTO v FROM public.cruising_catalogue_versions cv
    JOIN public.cruising_catalogue_entries ce ON ce.id = cv.entry_id AND ce.current_version = cv.version
    WHERE cv.entry_id = p_id AND cv.version = p_version AND ce.status = 'published'
        AND cv.review_status = 'reviewed' AND cv.reviewed_at <= statement_timestamp()
        AND cv.review_due_at > statement_timestamp();
    IF NOT FOUND THEN RETURN false; END IF;
    IF v.kind = 'trip' THEN
        RETURN public.cruising_catalogue_is_readable(v.origin_destination_id, v.origin_destination_version)
            AND public.cruising_catalogue_is_readable(v.destination_id, v.destination_version);
    ELSIF v.kind = 'route_variant' THEN
        RETURN public.cruising_catalogue_is_readable(v.trip_id, v.trip_version);
    END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.cruising_catalogue_is_readable(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cruising_catalogue_is_readable(uuid, integer) TO authenticated, service_role;

ALTER TABLE public.cruising_catalogue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cruising_catalogue_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cruising_catalogue_entries, public.cruising_catalogue_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cruising_catalogue_entries, public.cruising_catalogue_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cruising_catalogue_entries TO service_role;
GRANT SELECT, INSERT ON TABLE public.cruising_catalogue_versions TO service_role;
CREATE POLICY cruising_catalogue_entries_read ON public.cruising_catalogue_entries
    FOR SELECT TO authenticated USING (public.cruising_catalogue_is_readable(id, current_version));
CREATE POLICY cruising_catalogue_versions_read ON public.cruising_catalogue_versions
    FOR SELECT TO authenticated USING (public.cruising_catalogue_is_readable(entry_id, version));

CREATE FUNCTION public.nearby_cruising_catalogue(
    p_latitude double precision, p_longitude double precision,
    p_radius_nm double precision DEFAULT 30, p_limit integer DEFAULT 24
) RETURNS TABLE (
    entry_id uuid, version integer, kind text, name text, summary text,
    latitude double precision, longitude double precision, distance_nm double precision,
    reviewed_at timestamptz, review_due_at timestamptz, status text, review_status text
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, extensions AS $$
DECLARE query_location geography;
BEGIN
    IF p_latitude IS NULL OR NOT (p_latitude BETWEEN -90 AND 90)
        OR p_longitude IS NULL OR NOT (p_longitude BETWEEN -180 AND 180)
        OR p_radius_nm IS NULL OR NOT (p_radius_nm > 0 AND p_radius_nm <= 100)
        OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'Invalid catalogue search bounds' USING ERRCODE = '22023';
    END IF;
    query_location := ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography;
    RETURN QUERY SELECT v.entry_id, v.version, v.kind, v.name, v.summary, v.latitude, v.longitude,
        ST_Distance(v.location, query_location) / 1852.0, v.reviewed_at, v.review_due_at, 'published'::text, v.review_status
    FROM public.cruising_catalogue_versions v
    WHERE v.kind IN ('destination', 'trip')
        AND ST_DWithin(v.location, query_location, p_radius_nm * 1852.0)
        AND public.cruising_catalogue_is_readable(v.entry_id, v.version)
    ORDER BY ST_Distance(v.location, query_location), v.entry_id
    LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.nearby_cruising_catalogue(double precision, double precision, double precision, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nearby_cruising_catalogue(double precision, double precision, double precision, integer) TO authenticated, service_role;

CREATE FUNCTION public.cruising_catalogue_detail(p_id uuid, p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
    IF p_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
        RAISE EXCEPTION 'Exact catalogue identity and version required' USING ERRCODE = '22023';
    END IF;
    SELECT (to_jsonb(v) - 'location') || jsonb_build_object('status', 'published', 'variants_truncated',
        (SELECT count(*) > 32 FROM (SELECT 1 FROM public.cruising_catalogue_versions rv
            WHERE rv.trip_id = v.entry_id AND rv.trip_version = v.version
                AND public.cruising_catalogue_is_readable(rv.entry_id, rv.version) LIMIT 33) available), 'variants',
        COALESCE((SELECT jsonb_agg(jsonb_build_object('entry_id', r.entry_id, 'version', r.version,
            'direction', r.direction, 'name', r.name) ORDER BY r.direction, r.entry_id)
            FROM (SELECT rv.* FROM public.cruising_catalogue_versions rv
                WHERE rv.trip_id = v.entry_id AND rv.trip_version = v.version
                    AND public.cruising_catalogue_is_readable(rv.entry_id, rv.version)
                ORDER BY rv.direction, rv.entry_id LIMIT 32) r), '[]'::jsonb))
    INTO result FROM public.cruising_catalogue_versions v
    WHERE v.entry_id = p_id AND v.version = p_version
        AND public.cruising_catalogue_is_readable(v.entry_id, v.version);
    RETURN result; -- null includes superseded, withdrawn, stale and unknown versions.
END;
$$;
REVOKE ALL ON FUNCTION public.cruising_catalogue_detail(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cruising_catalogue_detail(uuid, integer) TO authenticated, service_role;

COMMENT ON TABLE public.cruising_catalogue_versions IS
    'Shared editorial references, never safe-route certification. Append-only. No private-voyage imports.';
COMMENT ON FUNCTION public.nearby_cruising_catalogue(double precision, double precision, double precision, integer) IS
    'Bounded nearby summaries only; exact route checkpoints are fetched lazily with cruising_catalogue_detail.';
COMMIT;

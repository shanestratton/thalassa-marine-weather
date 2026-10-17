-- Public phase is a new, independent owner decision. Legacy 2026-10-05
-- capture permission grants neither public-map publication nor DCDB/CC0.
-- No bucket, public view, timer, publication or DCDB submission is activated.
CREATE SCHEMA IF NOT EXISTS private_crowd;
REVOKE ALL ON SCHEMA private_crowd FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private_crowd.valid_calibration(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT CASE
        WHEN value IS NULL OR jsonb_typeof(value) <> 'object' THEN false
        WHEN pg_column_size(value) > 2048 THEN false
        WHEN (SELECT count(*) FROM jsonb_object_keys(value)) <> 10 THEN false
        WHEN NOT (value ?& ARRAY['schema','depthReference','depthSource','sounderProduct','measuredAt',
            'waterlineToTransducerM','offsetUncertaintyM','sounderUncertaintyM','checkedDepthLimitM','method']) THEN false
        WHEN value->'schema' <> '1'::jsonb OR jsonb_typeof(value->'depthReference') <> 'string'
            OR jsonb_typeof(value->'method') <> 'string' OR value->>'depthReference' NOT IN ('T','W')
            OR value->>'method' <> 'measured-offset-and-sounder-check' THEN false
        WHEN jsonb_typeof(value->'depthSource') <> 'string' OR jsonb_typeof(value->'sounderProduct') <> 'string'
            OR char_length(value->>'depthSource') NOT BETWEEN 1 AND 120
            OR char_length(value->>'sounderProduct') NOT BETWEEN 1 AND 120
            OR value->>'depthSource' <> btrim(value->>'depthSource') OR value->>'sounderProduct' <> btrim(value->>'sounderProduct')
            OR value->>'depthSource' ~ '[[:cntrl:]]' OR value->>'sounderProduct' ~ '[[:cntrl:]]' THEN false
        WHEN jsonb_typeof(value->'measuredAt') <> 'number' OR jsonb_typeof(value->'waterlineToTransducerM') <> 'number'
            OR jsonb_typeof(value->'offsetUncertaintyM') <> 'number' OR jsonb_typeof(value->'sounderUncertaintyM') <> 'number'
            OR jsonb_typeof(value->'checkedDepthLimitM') <> 'number' THEN false
        ELSE (value->>'measuredAt')::numeric BETWEEN 1577836800000 AND 4102444800000
            AND trunc((value->>'measuredAt')::numeric) = (value->>'measuredAt')::numeric
            AND (value->>'waterlineToTransducerM')::numeric BETWEEN 0 AND 10
            AND (value->>'offsetUncertaintyM')::numeric BETWEEN 0.01 AND 1
            AND (value->>'sounderUncertaintyM')::numeric BETWEEN 0.01 AND 1
            AND (value->>'checkedDepthLimitM')::numeric BETWEEN 0.5 AND 200
    END;
$$;
REVOKE ALL ON FUNCTION private_crowd.valid_calibration(jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private_crowd TO service_role;
GRANT EXECUTE ON FUNCTION private_crowd.valid_calibration(jsonb) TO service_role;

CREATE TABLE public.seabed_publication_consents (
    owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_id uuid NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    consent_version text NOT NULL DEFAULT '2026-10-17-public-1' CHECK (consent_version = '2026-10-17-public-1'),
    map_enabled boolean NOT NULL DEFAULT false,
    dcdb_enabled boolean NOT NULL DEFAULT false,
    map_effective_from timestamptz,
    dcdb_effective_from timestamptz,
    calibration jsonb CHECK (calibration IS NULL OR private_crowd.valid_calibration(calibration)),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id, boat_id),
    CHECK (map_enabled = (map_effective_from IS NOT NULL)),
    CHECK (dcdb_enabled = (dcdb_effective_from IS NOT NULL)),
    CHECK (NOT (map_enabled OR dcdb_enabled) OR calibration IS NOT NULL)
);
CREATE INDEX seabed_publication_boat ON public.seabed_publication_consents(boat_id);
ALTER TABLE public.seabed_publication_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.seabed_publication_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.seabed_publication_consents TO authenticated;
GRANT ALL ON TABLE public.seabed_publication_consents TO service_role;
CREATE POLICY "Owner reads separate sounding permission" ON public.seabed_publication_consents
    FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON public.seabed_publication_consents
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

-- Archive/transfer retires the permission itself. A/B/A cannot revive a UUID
-- revision from a deleted row, even if an old phone still has its former copy.
CREATE OR REPLACE FUNCTION private_crowd.retire_boat_permission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.archived_at IS NOT NULL THEN
        DELETE FROM public.seabed_publication_consents WHERE boat_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private_crowd.retire_boat_permission() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER retire_crowd_permission AFTER UPDATE OF owner_id, archived_at ON public.boats
    FOR EACH ROW EXECUTE FUNCTION private_crowd.retire_boat_permission();

CREATE OR REPLACE FUNCTION public.set_seabed_publication(
    p_boat_id uuid, p_expected_revision uuid, p_map_enabled boolean,
    p_dcdb_enabled boolean, p_terms_version text, p_calibration jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    caller uuid := auth.uid();
    current_row public.seabed_publication_consents%ROWTYPE;
    owned uuid;
    stamp timestamptz := clock_timestamp();
    stamp_ms numeric;
    measured numeric;
    next_calibration jsonb;
    next_map_time timestamptz;
    next_dcdb_time timestamptz;
BEGIN
    IF caller IS NULL OR p_boat_id IS NULL OR p_map_enabled IS NULL OR p_dcdb_enabled IS NULL THEN
        RAISE EXCEPTION 'Signed-in owner and explicit separate choices required' USING ERRCODE='42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE user_id=caller) THEN
        RAISE EXCEPTION 'Account is retired' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:crowd-permission:' || caller::text || ':' || p_boat_id::text,0));
    SELECT id INTO owned FROM public.boats
        WHERE id=p_boat_id AND owner_id=caller AND archived_at IS NULL FOR SHARE;
    SELECT * INTO current_row FROM public.seabed_publication_consents
        WHERE owner_id=caller AND boat_id=p_boat_id FOR UPDATE;
    -- An existing owner can always revoke their own row, including after a
    -- permission/selection change. Enabling requires current actual ownership.
    IF owned IS NULL AND (p_map_enabled OR p_dcdb_enabled OR current_row.owner_id IS NULL) THEN
        RAISE EXCEPTION 'Current vessel ownership required' USING ERRCODE='42501';
    END IF;
    IF p_map_enabled OR p_dcdb_enabled THEN
        IF p_expected_revision IS DISTINCT FROM current_row.revision OR p_terms_version IS DISTINCT FROM '2026-10-17-public-1'
            OR NOT private_crowd.valid_calibration(p_calibration) THEN
            RAISE EXCEPTION 'Fresh permission revision and measured sounder calibration required' USING ERRCODE='40001';
        END IF;
        stamp_ms := floor(extract(epoch FROM stamp)*1000);
        measured := (p_calibration->>'measuredAt')::numeric;
        IF measured>stamp_ms OR measured<stamp_ms-366::numeric*86400000 THEN
            RAISE EXCEPTION 'Calibration date is unavailable or expired' USING ERRCODE='22023';
        END IF;
        next_calibration := p_calibration;
    ELSE
        -- Revocation deliberately does not need old consent, a live calibration
        -- or a matching stale revision. It cannot grant either permission.
        next_calibration := current_row.calibration;
    END IF;
    IF current_row.owner_id IS NOT NULL AND current_row.map_enabled=p_map_enabled
        AND current_row.dcdb_enabled=p_dcdb_enabled AND current_row.calibration IS NOT DISTINCT FROM next_calibration THEN
        RETURN to_jsonb(current_row);
    END IF;
    IF p_map_enabled THEN
        next_map_time := CASE WHEN current_row.map_enabled AND current_row.calibration IS NOT DISTINCT FROM next_calibration
            THEN current_row.map_effective_from ELSE stamp END;
    END IF;
    IF p_dcdb_enabled THEN
        next_dcdb_time := CASE WHEN current_row.dcdb_enabled AND current_row.calibration IS NOT DISTINCT FROM next_calibration
            THEN current_row.dcdb_effective_from ELSE stamp END;
    END IF;
    INSERT INTO public.seabed_publication_consents(owner_id,boat_id,revision,map_enabled,dcdb_enabled,
        map_effective_from,dcdb_effective_from,calibration,updated_at)
    VALUES(caller,p_boat_id,gen_random_uuid(),p_map_enabled,p_dcdb_enabled,next_map_time,next_dcdb_time,next_calibration,stamp)
    ON CONFLICT(owner_id,boat_id) DO UPDATE SET revision=EXCLUDED.revision,
        map_enabled=EXCLUDED.map_enabled,dcdb_enabled=EXCLUDED.dcdb_enabled,
        map_effective_from=EXCLUDED.map_effective_from,dcdb_effective_from=EXCLUDED.dcdb_effective_from,
        calibration=EXCLUDED.calibration,updated_at=EXCLUDED.updated_at
    RETURNING * INTO current_row;
    RETURN to_jsonb(current_row);
END;
$$;
REVOKE ALL ON FUNCTION public.set_seabed_publication(uuid,uuid,boolean,boolean,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_seabed_publication(uuid,uuid,boolean,boolean,text,jsonb) TO authenticated;

-- Only the reviewed service exporter can read a private candidate. This is a
-- current-source snapshot, not a transaction lock across network publication.
CREATE OR REPLACE FUNCTION public.read_crowd_sounding_candidate(p_batch_id uuid,p_purpose text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT jsonb_build_object('schema',1,'purpose',p_purpose,'ownerId',b.owner_id,'boatId',b.boat_id,
        'batchId',b.id,'objectPath',b.object_path,'sentSha256',b.content_sha256,'storedBytes',b.bytes,
        'rowCount',b.row_count,'capturedStart',b.t_start,'capturedEnd',b.t_end,'eligibleAfter',b.eligible_after,
        'captureMeta',b.capture_meta,'privacyZones',p.privacy_zones,'platformRevision',p.updated_at,
        'csbUuid',p.csb_uuid,'consentRevision',c.revision,'consentVersion',c.consent_version,
        'mapEnabled',c.map_enabled,'dcdbEnabled',c.dcdb_enabled,'calibration',c.calibration,
        'effectiveFrom',CASE WHEN p_purpose='map' THEN c.map_effective_from ELSE c.dcdb_effective_from END)
    FROM public.seabed_batches b
    JOIN public.boats boat ON boat.id=b.boat_id AND boat.owner_id=b.owner_id AND boat.archived_at IS NULL
    JOIN public.seabed_platforms p ON p.id=b.platform_id AND p.owner_id=b.owner_id AND p.boat_id=b.boat_id
    JOIN public.seabed_publication_consents c ON c.owner_id=b.owner_id AND c.boat_id=b.boat_id
    WHERE b.id=p_batch_id AND p_purpose IN ('map','dcdb')
        AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=b.owner_id)
        AND c.consent_version='2026-10-17-public-1'
        AND CASE WHEN p_purpose='map' THEN c.map_enabled ELSE c.dcdb_enabled END
        AND b.t_start >= CASE WHEN p_purpose='map' THEN c.map_effective_from ELSE c.dcdb_effective_from END
        AND b.eligible_after >= b.t_end+interval '30 days' AND b.eligible_after<=now()
        AND b.bytes BETWEEN 1 AND 2097152 AND b.row_count BETWEEN 1 AND 7200
        AND private_crowd.valid_calibration(c.calibration) AND public.seabed_zones_valid(p.privacy_zones);
$$;
REVOKE ALL ON FUNCTION public.read_crowd_sounding_candidate(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_crowd_sounding_candidate(uuid,text) TO service_role;

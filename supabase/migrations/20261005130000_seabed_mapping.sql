-- Seabed mapping, phase 1: capture done right (Shane 2026-10-05, after the
-- crowdsourced-bathymetry pitch: "also you should do the bottom mapping as a
-- parallel add in").
--
-- With the skipper's opt-in, the boat's own sounder is logged about once a
-- second while under way (time, position, depth BELOW THE TRANSDUCER), shaped
-- for the IHO crowdsourced bathymetry programme (IHO B-12 Ed. 3.0.0; NCEI
-- "Sample CSB File Formats" 3.0). Phase 1 keeps everything PRIVATE: no public
-- view, no export job, a private bucket. Phase 3 (sharing with the IHO DCDB
-- under CC0) asks again, with a new consent version.
--
--   seabed_platforms  one row per (owner, boat): the switch, the consent
--                     version, which device logs (NULL = the boat's Pi) and
--                     since when, the privacy zones and the anonymous CSB id.
--                     Owner-only.
--   seabed_batches    the index of uploaded batches: counts, bounding box,
--                     time span, quality summary. Written ONLY by the
--                     seabed-relay Edge Function (service role), which
--                     recomputes every figure from the file itself, so the
--                     index cannot disagree with what is stored.
--   seabed-soundings  private bucket of gzipped CSV batches, no storage
--                     policies at all: only the service role reads or writes.
--
-- csb_uuid is minted here and never derived from the boat, its name or MMSI:
-- the phase-3 DCDB id is '<prefix>-<csb_uuid>', and a new owner of the same
-- hull gets a new row, so owners' trips stay unlinkable. Clients cannot write
-- it (column grants below).
--
-- Deletion: both tables reference auth.users ON DELETE CASCADE (the scrub's
-- foreign-key loop, 20260905101000, deletes them), both carry the tombstone
-- write fence like every user table (20260806120000), and the bucket joins
-- the path-based deletion reach below. The Pi uploads through the service
-- role, so an object has owner_id NULL and the uid at path segment 1: exactly
-- the shape the path list exists for.
--
-- ORDER WITH SIGHTINGS. The Sightings workflow's 20261005120000_sightings.sql
-- redefines the same two deletion-reach functions to add 'sighting-photos'.
-- Each is a full CREATE OR REPLACE, so whichever runs LAST decides the list.
-- This migration is numbered after it and lists BOTH buckets, so pushing the
-- two in version order (or this one alone) loses neither. A name in the list
-- whose bucket does not exist yet matches no object and costs nothing.
-- tests/seabedMigration.test.ts holds the newest definition to a superset of
-- every earlier one.
--
-- WRITTEN, NOT PUSHED: Shane says "yes, push it" separately. Until it is
-- pushed the app keeps the setting on the device and stays quiet.

-- ── 1. Zones: the shape the app, the Pi and the ingest function all check ──

-- MUST match parseSeabedZones in services/seabed/seabedCore.ts: an array of
-- at most 20 {id, kind, lat, lon, radius_m, jitter_m}, kind home|marked (one
-- home at most), radius 250..5000 m. jitter_m is the most the centre was
-- moved when the zone was made (a quarter of its radius then, so 0..1250),
-- and the radius may never shrink below 4/3 of it: the true spot then still
-- sits a quarter of the radius inside the edge. Written as CASE ladders,
-- because SQL does not promise to evaluate AND/OR left to right:
-- jsonb_array_length or jsonb_object_keys on the wrong shape would raise
-- instead of answering false.
CREATE OR REPLACE FUNCTION public.seabed_zones_valid(p_zones JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT CASE
        WHEN p_zones IS NULL OR jsonb_typeof(p_zones) <> 'array' THEN false
        WHEN jsonb_array_length(p_zones) > 20 THEN false
        ELSE NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(p_zones) AS zone(v)
                 WHERE NOT CASE
                     WHEN jsonb_typeof(zone.v) <> 'object' THEN false
                     WHEN NOT (zone.v ?& ARRAY['id', 'kind', 'lat', 'lon', 'radius_m', 'jitter_m']) THEN false
                     WHEN (SELECT count(*) FROM jsonb_object_keys(zone.v)) <> 6 THEN false
                     WHEN jsonb_typeof(zone.v -> 'id') <> 'string' THEN false
                     WHEN char_length(zone.v ->> 'id') NOT BETWEEN 1 AND 40 THEN false
                     WHEN zone.v ->> 'kind' NOT IN ('home', 'marked') THEN false
                     WHEN jsonb_typeof(zone.v -> 'lat') <> 'number' THEN false
                     WHEN jsonb_typeof(zone.v -> 'lon') <> 'number' THEN false
                     WHEN jsonb_typeof(zone.v -> 'radius_m') <> 'number' THEN false
                     WHEN jsonb_typeof(zone.v -> 'jitter_m') <> 'number' THEN false
                     ELSE (zone.v ->> 'lat')::DOUBLE PRECISION BETWEEN -90 AND 90
                      AND (zone.v ->> 'lon')::DOUBLE PRECISION BETWEEN -180 AND 180
                      AND (zone.v ->> 'radius_m')::DOUBLE PRECISION BETWEEN 250 AND 5000
                      AND (zone.v ->> 'jitter_m')::DOUBLE PRECISION BETWEEN 0 AND 1250
                      AND 3 * (zone.v ->> 'radius_m')::DOUBLE PRECISION >= 4 * (zone.v ->> 'jitter_m')::DOUBLE PRECISION
                 END
             )
             AND (
                SELECT count(*)
                  FROM jsonb_array_elements(p_zones) AS zone(v)
                 WHERE zone.v ->> 'kind' = 'home'
             ) <= 1
    END;
$$;

-- Evaluated as the writer inside the CHECK below.
REVOKE ALL ON FUNCTION public.seabed_zones_valid(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seabed_zones_valid(JSONB) TO authenticated, service_role;

-- ── 2. One platform per (owner, boat) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.seabed_platforms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_id UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    csb_uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    enabled BOOLEAN NOT NULL DEFAULT false,
    consent_version TEXT CHECK (consent_version IS NULL OR consent_version ~ '^\d{4}-\d{2}-\d{2}$'),
    consented_at TIMESTAMPTZ,
    -- The phone that logs; NULL means the boat's Pi does.
    capture_device_id TEXT CHECK (capture_device_id IS NULL OR capture_device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
    -- When capture_device_id last changed (the trigger below; no client
    -- grant): seabed-relay refuses a batch from the other kind of device that
    -- ended after it (one logger per boat), and still takes what it held.
    capture_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    privacy_zones JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (public.seabed_zones_valid(privacy_zones)),
    sounder_note TEXT CHECK (sounder_note IS NULL OR char_length(sounder_note) <= 120),
    -- {type, length_m, draft_m, draft_confirmed}: a snapshot for phase 3, never names or MMSI.
    vessel JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(vessel) = 'object' AND pg_column_size(vessel) <= 1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT seabed_platforms_owner_boat UNIQUE (owner_id, boat_id)
);

ALTER TABLE public.seabed_platforms ENABLE ROW LEVEL SECURITY;

-- Column grants: the client may set the switch, the consent, the device, the
-- zones, the note and the vessel snapshot. It can never write id or
-- csb_uuid, and owner_id and boat_id are fixed once the row exists.
REVOKE ALL ON TABLE public.seabed_platforms FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.seabed_platforms TO authenticated;
GRANT INSERT (
    owner_id,
    boat_id,
    enabled,
    consent_version,
    consented_at,
    capture_device_id,
    privacy_zones,
    sounder_note,
    vessel
) ON public.seabed_platforms TO authenticated;
GRANT UPDATE (
    enabled,
    consent_version,
    consented_at,
    capture_device_id,
    privacy_zones,
    sounder_note,
    vessel
) ON public.seabed_platforms TO authenticated;
GRANT ALL ON TABLE public.seabed_platforms TO service_role;

DROP TRIGGER IF EXISTS trg_seabed_platforms_updated_at ON public.seabed_platforms;
CREATE TRIGGER trg_seabed_platforms_updated_at
    BEFORE UPDATE ON public.seabed_platforms
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The logger's change time is the server's, set here and nowhere else.
CREATE OR REPLACE FUNCTION public.seabed_platforms_capture_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.capture_device_id IS DISTINCT FROM OLD.capture_device_id THEN
        NEW.capture_changed_at := now();
    ELSE
        NEW.capture_changed_at := OLD.capture_changed_at;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.seabed_platforms_capture_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_seabed_platforms_capture_changed ON public.seabed_platforms;
CREATE TRIGGER trg_seabed_platforms_capture_changed
    BEFORE UPDATE ON public.seabed_platforms
    FOR EACH ROW EXECUTE FUNCTION public.seabed_platforms_capture_changed();

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.seabed_platforms;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.seabed_platforms
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

DROP POLICY IF EXISTS "Seabed platform owner reads" ON public.seabed_platforms;
CREATE POLICY "Seabed platform owner reads"
    ON public.seabed_platforms FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

-- Only the boat's OWNER: crew see "Your skipper decides this".
DROP POLICY IF EXISTS "Seabed platform owner creates" ON public.seabed_platforms;
CREATE POLICY "Seabed platform owner creates"
    ON public.seabed_platforms FOR INSERT TO authenticated
    WITH CHECK (owner_id = auth.uid() AND public.is_boat_owner(boat_id));

DROP POLICY IF EXISTS "Seabed platform owner updates" ON public.seabed_platforms;
CREATE POLICY "Seabed platform owner updates"
    ON public.seabed_platforms FOR UPDATE TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid() AND public.is_boat_owner(boat_id));

DROP POLICY IF EXISTS "Seabed platform owner deletes" ON public.seabed_platforms;
CREATE POLICY "Seabed platform owner deletes"
    ON public.seabed_platforms FOR DELETE TO authenticated
    USING (owner_id = auth.uid());

-- ── 3. The batch index ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.seabed_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    platform_id UUID NOT NULL REFERENCES public.seabed_platforms(id) ON DELETE CASCADE,
    boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL,
    device TEXT NOT NULL CHECK (device IN ('pi', 'phone')),
    object_path TEXT NOT NULL UNIQUE CHECK (char_length(object_path) BETWEEN 1 AND 200),
    -- The SHA-256 of the gzip bytes the device sent: the idempotency key.
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2097152),
    row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 7200),
    rows_flagged INTEGER NOT NULL DEFAULT 0 CHECK (rows_flagged BETWEEN 0 AND 7200),
    -- Rows the ingest function removed because they fell inside a zone.
    rows_privacy_dropped INTEGER NOT NULL DEFAULT 0 CHECK (rows_privacy_dropped BETWEEN 0 AND 7200),
    t_start TIMESTAMPTZ NOT NULL,
    t_end TIMESTAMPTZ NOT NULL,
    min_lat DOUBLE PRECISION NOT NULL CHECK (min_lat BETWEEN -90 AND 90),
    max_lat DOUBLE PRECISION NOT NULL CHECK (max_lat BETWEEN -90 AND 90),
    -- West and east edges; min_lon > max_lon when crosses_antimeridian.
    min_lon DOUBLE PRECISION NOT NULL CHECK (min_lon BETWEEN -180 AND 180),
    max_lon DOUBLE PRECISION NOT NULL CHECK (max_lon BETWEEN -180 AND 180),
    crosses_antimeridian BOOLEAN NOT NULL DEFAULT false,
    track_m DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (track_m >= 0),
    depth_min DOUBLE PRECISION,
    depth_max DOUBLE PRECISION,
    flag_counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(flag_counts) = 'object'),
    quality JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality) = 'object'),
    capture_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capture_meta) = 'object'),
    -- t_end + 30 days: nothing is eligible for a map or a DCDB submission before.
    eligible_after TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ,
    submission_ref TEXT CHECK (submission_ref IS NULL OR char_length(submission_ref) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT seabed_batches_time_order CHECK (t_end >= t_start),
    CONSTRAINT seabed_batches_lat_order CHECK (min_lat <= max_lat),
    CONSTRAINT seabed_batches_eligible_after_hold CHECK (eligible_after >= t_end + interval '30 days'),
    CONSTRAINT seabed_batches_owner_sha UNIQUE (owner_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS seabed_batches_platform_time ON public.seabed_batches (platform_id, t_start);
CREATE INDEX IF NOT EXISTS seabed_batches_unsubmitted
    ON public.seabed_batches (eligible_after)
    WHERE submitted_at IS NULL;

ALTER TABLE public.seabed_batches ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner. No client INSERT/UPDATE/DELETE grant or policy:
-- seabed-relay writes with the service role after recomputing every figure.
REVOKE ALL ON TABLE public.seabed_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.seabed_batches TO authenticated;
GRANT ALL ON TABLE public.seabed_batches TO service_role;

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.seabed_batches;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.seabed_batches
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');

DROP POLICY IF EXISTS "Seabed batch owner reads" ON public.seabed_batches;
CREATE POLICY "Seabed batch owner reads"
    ON public.seabed_batches FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

-- ── 4. The contribution line ────────────────────────────────────────────────

-- "Seabed mapping: 12,345 soundings logged, 87 km of track". INVOKER, so the
-- caller's own RLS decides what it sums.
CREATE OR REPLACE FUNCTION public.seabed_contribution_summary()
RETURNS TABLE (
    soundings BIGINT,
    track_m DOUBLE PRECISION,
    batches BIGINT,
    first_at TIMESTAMPTZ,
    last_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT coalesce(sum(b.row_count), 0)::BIGINT,
           coalesce(sum(b.track_m), 0)::DOUBLE PRECISION,
           count(*)::BIGINT,
           min(b.t_start),
           max(b.t_end)
      FROM public.seabed_batches AS b
     WHERE b.owner_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.seabed_contribution_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seabed_contribution_summary() TO authenticated;

-- ── 5. The private bucket ───────────────────────────────────────────────────

-- 2 MiB per object (an hour at 1 Hz gzips to ~68 KB), gzip only, and NO
-- storage.objects policy: clients can neither list, read nor write it.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('seabed-soundings', 'seabed-soundings', false, 2097152, ARRAY['application/gzip']::TEXT[])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 6. Account deletion reach: seabed-soundings ─────────────────────────────
-- The LIVE bodies, pulled with pg_get_functiondef on 2026-10-05 (identical to
-- 20260905100000), with 'seabed-soundings' added to each path-based list, and
-- 'sighting-photos' too (see ORDER WITH SIGHTINGS at the top).

CREATE OR REPLACE FUNCTION public.account_deletion_storage_inventory(p_user_id uuid)
 RETURNS TABLE(bucket_id text, object_name text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, public, storage
AS $function$
    SELECT DISTINCT
        object.bucket_id::TEXT,
        object.name::TEXT,
        CASE
            WHEN object.owner_id::TEXT = p_user_id::TEXT THEN 'storage-owner'
            WHEN object.bucket_id = 'recipe-photos'
             AND object.name IN (
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.recipes AS recipe
                 WHERE recipe.user_id = p_user_id
                 UNION
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.community_recipes AS recipe
                 WHERE recipe.user_id = p_user_id
             ) THEN 'legacy-recipe-row'
            ELSE 'owner-path'
        END AS source
    FROM storage.objects AS object
    WHERE object.owner_id::TEXT = p_user_id::TEXT
       OR (
            object.bucket_id = 'chat-avatars'
            AND (
                split_part(object.name, '/', 1) = p_user_id::TEXT
                OR (
                    split_part(object.name, '/', 1) IN ('dating', 'crew')
                    AND split_part(object.name, '/', 2) = p_user_id::TEXT
                )
            )
       )
       OR (
            -- The skipper's OWN imported chart cells. Personal cells live at
            -- u/<uid>/… so the uid is at segment 2, behind the literal 'u';
            -- the bucket-list branch above matches segment 1 and could never
            -- have found them even if 'enc-cells' were added to it.
            object.bucket_id = 'enc-cells'
            AND split_part(object.name, '/', 1) = 'u'
            AND split_part(object.name, '/', 2) = p_user_id::TEXT
       )
       OR (
            object.bucket_id IN (
                'crew-list-photos',
                'diary-photos',
                'diary-audio',
                'diary-video',
                'vessel_vault',
                'marketplace-images',
                'recipe-photos',
                'sighting-photos',
                'seabed-soundings'
            )
            AND split_part(object.name, '/', 1) = p_user_id::TEXT
       )
       OR (
            object.bucket_id = 'recipe-photos'
            AND object.name IN (
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.recipes AS recipe
                WHERE recipe.user_id = p_user_id
                UNION
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.community_recipes AS recipe
                WHERE recipe.user_id = p_user_id
            )
       );
$function$;

CREATE OR REPLACE FUNCTION public.block_tombstoned_storage_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public
AS $function$
DECLARE
    candidate UUID;
    candidates UUID[] := ARRAY[]::UUID[];
    owner_path TEXT;
BEGIN
    IF NEW.owner_id::TEXT ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, NEW.owner_id::TEXT::UUID);
    END IF;

    owner_path := CASE
        WHEN NEW.bucket_id = 'enc-cells'
         AND split_part(NEW.name, '/', 1) = 'u'
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id = 'chat-avatars'
         AND split_part(NEW.name, '/', 1) IN ('dating', 'crew')
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id IN (
            'chat-avatars',
            'crew-list-photos',
            'diary-photos',
            'diary-audio',
            'diary-video',
            'vessel_vault',
            'marketplace-images',
            'recipe-photos',
            'sighting-photos',
            'seabed-soundings'
        ) THEN split_part(NEW.name, '/', 1)
        ELSE NULL
    END;
    IF owner_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, owner_path::UUID);
    END IF;

    FOR candidate IN
        SELECT DISTINCT expanded.candidate_value
        FROM unnest(candidates) AS expanded(candidate_value)
        ORDER BY expanded.candidate_value
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate::TEXT, 20260806));
        IF EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate) THEN
            RAISE EXCEPTION 'Account Storage is permanently write-fenced' USING ERRCODE = '55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$function$;

-- Privileges restated (CREATE OR REPLACE keeps them; the audit and the next
-- reader should not have to know that). Verbatim from 20260905100000.
REVOKE ALL ON FUNCTION public.account_deletion_storage_inventory(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_tombstoned_storage_write() FROM PUBLIC, anon, authenticated;

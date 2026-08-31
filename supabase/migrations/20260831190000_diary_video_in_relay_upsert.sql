-- The relay upsert never learned the video column: the Edge Function sent
-- video_url faithfully, but this function's explicit column list dropped it on
-- the floor — and the NULL row it returned then OVERWROTE the phone's local
-- copy on sync completion, which is why a saved video "did not stick".
--
-- Full copy of the 20260727120000 (boat-hardened) definition with video_url
-- added in the three places audio_url appears. Copying the LATEST version
-- matters: replacing from the older 20260727100000 body would have silently
-- dropped the boat_id hardening.

CREATE OR REPLACE FUNCTION public.diary_relay_upsert_entry(
    p_owner_id UUID,
    p_entry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    operation_id TEXT;
    revision_text TEXT;
    submitted_revision INTEGER;
    supplied_boat_text TEXT;
    supplied_boat_id UUID;
    canonical public.diary_entries%ROWTYPE;
    was_applied BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Diary relay requires the service role' USING ERRCODE = '42501';
    END IF;
    IF p_owner_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RAISE EXCEPTION 'A diary relay owner and object envelope are required'
            USING ERRCODE = '22023';
    END IF;

    operation_id := NULLIF(p_entry ->> 'client_operation_id', '');
    IF operation_id IS NULL OR operation_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'Invalid diary client operation id'
            USING ERRCODE = '22023';
    END IF;

    revision_text := p_entry ->> 'client_revision';
    IF revision_text IS NULL THEN
        submitted_revision := 1;
    ELSIF revision_text !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'Invalid diary client revision'
            USING ERRCODE = '22023';
    ELSE
        submitted_revision := revision_text::INTEGER;
    END IF;

    -- Missing/null boat ids are valid legacy envelopes. On a brand-new row
    -- the operational trigger will use the active owned vessel when there is
    -- one; on an existing row we preserve the original binding below rather
    -- than moving an old diary entry when the skipper later changes vessel.
    supplied_boat_text := NULLIF(BTRIM(p_entry ->> 'boat_id'), '');
    IF supplied_boat_text IS NOT NULL THEN
        IF supplied_boat_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid diary boat id' USING ERRCODE = '22023';
        END IF;
        supplied_boat_id := supplied_boat_text::UUID;
        IF NOT EXISTS (
            SELECT 1
             FROM public.boats AS boat
             WHERE boat.id = supplied_boat_id
               AND boat.owner_id = p_owner_id
        ) THEN
            RAISE EXCEPTION 'Diary boat is not owned by this relay owner'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('diary-relay:' || p_owner_id::TEXT || ':' || operation_id, 0)
    );

    IF EXISTS (
        SELECT 1
        FROM public.diary_relay_tombstones AS tombstone
        WHERE tombstone.owner_id = p_owner_id
          AND tombstone.client_operation_id = operation_id
    ) THEN
        RETURN jsonb_build_object('status', 'cancelled');
    END IF;

    INSERT INTO public.diary_entries (
        user_id,
        boat_id,
        client_operation_id,
        client_revision,
        title,
        body,
        mood,
        photos,
        audio_url,
        video_url,
        latitude,
        longitude,
        location_name,
        weather_summary,
        weather_data,
        voyage_id,
        tags,
        is_public,
        created_at
    )
    VALUES (
        p_owner_id,
        supplied_boat_id,
        operation_id,
        submitted_revision,
        COALESCE(p_entry ->> 'title', ''),
        COALESCE(p_entry ->> 'body', ''),
        COALESCE(NULLIF(p_entry ->> 'mood', ''), 'neutral'),
        CASE
            WHEN jsonb_typeof(p_entry -> 'photos') = 'array' THEN p_entry -> 'photos'
            ELSE '[]'::JSONB
        END,
        NULLIF(p_entry ->> 'audio_url', ''),
        NULLIF(p_entry ->> 'video_url', ''),
        NULLIF(p_entry ->> 'latitude', '')::DOUBLE PRECISION,
        NULLIF(p_entry ->> 'longitude', '')::DOUBLE PRECISION,
        COALESCE(p_entry ->> 'location_name', ''),
        COALESCE(p_entry ->> 'weather_summary', ''),
        NULLIF(p_entry -> 'weather_data', 'null'::JSONB),
        NULLIF(p_entry ->> 'voyage_id', ''),
        CASE
            WHEN jsonb_typeof(p_entry -> 'tags') = 'array' THEN p_entry -> 'tags'
            ELSE '[]'::JSONB
        END,
        CASE WHEN p_entry -> 'is_public' = 'true'::JSONB THEN true ELSE false END,
        COALESCE(NULLIF(p_entry ->> 'created_at', '')::TIMESTAMPTZ, now())
    )
    ON CONFLICT (user_id, client_operation_id) DO UPDATE
    SET
        -- Only a newer envelope that explicitly names an owned vessel can
        -- alter a prior binding. Legacy null envelopes cannot make an entry
        -- drift onto whichever yacht happens to be active at retry time.
        boat_id = CASE
            WHEN supplied_boat_id IS NOT NULL THEN EXCLUDED.boat_id
            ELSE public.diary_entries.boat_id
        END,
        client_revision = EXCLUDED.client_revision,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        mood = EXCLUDED.mood,
        photos = EXCLUDED.photos,
        audio_url = EXCLUDED.audio_url,
        video_url = EXCLUDED.video_url,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        location_name = EXCLUDED.location_name,
        weather_summary = EXCLUDED.weather_summary,
        weather_data = EXCLUDED.weather_data,
        voyage_id = EXCLUDED.voyage_id,
        tags = EXCLUDED.tags,
        is_public = EXCLUDED.is_public
    WHERE EXCLUDED.client_revision > public.diary_entries.client_revision
    RETURNING * INTO canonical;

    was_applied := FOUND;
    IF NOT was_applied THEN
        SELECT *
          INTO canonical
          FROM public.diary_entries
         WHERE user_id = p_owner_id
           AND client_operation_id = operation_id;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'cancelled');
    END IF;

    RETURN jsonb_build_object(
        'status', CASE WHEN was_applied THEN 'accepted' ELSE 'stale' END,
        'entry', to_jsonb(canonical)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_upsert_entry(UUID, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_upsert_entry(UUID, JSONB) TO service_role;

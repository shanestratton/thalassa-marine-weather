-- Capture each deleted diary's media before the row disappears. The private
-- tombstone is also the retry ledger: Storage failures must not lose its paths.
-- Storage objects are removed through the Storage API, never by SQL DELETE.
ALTER TABLE public.diary_relay_tombstones
    ADD COLUMN IF NOT EXISTS media_cleanup_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.diary_relay_cancel_entry(
    p_owner_id UUID,
    p_client_operation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    captured JSONB;
    pending JSONB;
BEGIN
    IF p_owner_id IS NULL OR p_client_operation_id IS NULL
       OR p_client_operation_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'Invalid diary cancellation operation id' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('diary-relay:' || p_owner_id::TEXT || ':' || p_client_operation_id, 0)
    );

    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('bucket', media.bucket, 'reference', media.reference)), '[]'::jsonb)
    INTO captured
    FROM public.diary_entries AS entry
    CROSS JOIN LATERAL (
        SELECT 'diary-photos'::TEXT AS bucket, photo #>> '{}' AS reference
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(entry.photos) = 'array' THEN entry.photos ELSE '[]'::jsonb END) AS photo
        WHERE jsonb_typeof(photo) = 'string'
        UNION ALL SELECT 'diary-audio', entry.audio_url
        UNION ALL SELECT 'diary-video', entry.video_url
    ) AS media
    WHERE entry.user_id = p_owner_id
      AND entry.client_operation_id = p_client_operation_id
      AND media.reference IS NOT NULL AND media.reference <> '';

    INSERT INTO public.diary_relay_tombstones AS tombstone (owner_id, client_operation_id, media_cleanup_refs)
    VALUES (p_owner_id, p_client_operation_id, captured)
    ON CONFLICT (owner_id, client_operation_id) DO UPDATE
    SET media_cleanup_refs = (
        SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
        FROM jsonb_array_elements(tombstone.media_cleanup_refs || EXCLUDED.media_cleanup_refs) AS item
    )
    RETURNING media_cleanup_refs INTO pending;

    DELETE FROM public.diary_entries
    WHERE user_id = p_owner_id AND client_operation_id = p_client_operation_id;

    RETURN jsonb_build_object('status', 'cancelled', 'media_cleanup_refs', pending);
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_cancel_entry(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_cancel_entry(UUID, TEXT) TO service_role;

-- This parser is used only to PRESERVE shared objects. The Edge independently
-- requires this project's exact origin before it may DELETE a URL reference.
-- Ignoring the origin here is conservative: an ambiguous reference protects
-- an object rather than authorizing its deletion. URL paths are decoded once.
CREATE OR REPLACE FUNCTION public.diary_relay_media_reference_path(p_bucket TEXT, p_reference TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    candidate TEXT;
    encoded BYTEA := ''::bytea;
    cursor_at INTEGER := 1;
BEGIN
    IF p_reference IS NULL THEN RETURN NULL; END IF;
    IF left(p_reference, length('storage:' || p_bucket || ':')) = 'storage:' || p_bucket || ':' THEN
        RETURN substr(p_reference, length('storage:' || p_bucket || ':') + 1);
    END IF;
    candidate := substring(p_reference FROM '^https?://[^/?#]+/storage/v1/object/(?:public|sign|authenticated)/' || p_bucket || '/([^?#]+)');
    IF candidate IS NULL THEN RETURN NULL; END IF;
    WHILE cursor_at <= length(candidate) LOOP
        IF substr(candidate, cursor_at, 1) = '%' THEN
            encoded := encoded || decode(substr(candidate, cursor_at + 1, 2), 'hex');
            cursor_at := cursor_at + 3;
        ELSE
            encoded := encoded || convert_to(substr(candidate, cursor_at, 1), 'UTF8');
            cursor_at := cursor_at + 1;
        END IF;
    END LOOP;
    RETURN convert_from(encoded, 'UTF8');
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_media_reference_path(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_media_reference_path(TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.diary_relay_media_is_referenced(
    p_owner_id UUID,
    p_bucket TEXT,
    p_path TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.diary_entries AS entry
        CROSS JOIN LATERAL (
            SELECT photo #>> '{}' AS reference
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(entry.photos) = 'array' THEN entry.photos ELSE '[]'::jsonb END) AS photo
            WHERE p_bucket = 'diary-photos' AND jsonb_typeof(photo) = 'string'
            UNION ALL SELECT entry.audio_url WHERE p_bucket = 'diary-audio'
            UNION ALL SELECT entry.video_url WHERE p_bucket = 'diary-video'
        ) AS media
        WHERE entry.user_id = p_owner_id
          AND public.diary_relay_media_reference_path(p_bucket, media.reference) = p_path
    );
$$;

REVOKE ALL ON FUNCTION public.diary_relay_media_is_referenced(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_media_is_referenced(UUID, TEXT, TEXT) TO service_role;

-- Checkpoint only the exact captured reference. When the Edge removed an
-- object, verify its absence in Storage's catalog before discarding the retry
-- information. Shared, external and device-local references are preserved.
CREATE OR REPLACE FUNCTION public.diary_relay_ack_media_cleanup(
    p_owner_id UUID,
    p_client_operation_id TEXT,
    p_reference JSONB,
    p_path TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('diary-relay:' || p_owner_id::TEXT || ':' || p_client_operation_id, 0)
    );
    IF p_path IS NOT NULL THEN
        IF p_reference ->> 'bucket' NOT IN ('diary-photos', 'diary-audio', 'diary-video')
           OR left(p_path, length(p_owner_id::TEXT) + 1) <> p_owner_id::TEXT || '/'
           OR public.diary_relay_media_reference_path(p_reference ->> 'bucket', p_reference ->> 'reference') IS DISTINCT FROM p_path THEN
            RAISE EXCEPTION 'Invalid diary media cleanup path' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = p_reference ->> 'bucket' AND name = p_path) THEN
            RAISE EXCEPTION 'Diary media removal has not completed' USING ERRCODE = '55000';
        END IF;
    END IF;

    UPDATE public.diary_relay_tombstones AS tombstone
    SET media_cleanup_refs = (
        SELECT coalesce(jsonb_agg(item), '[]'::jsonb)
        FROM jsonb_array_elements(tombstone.media_cleanup_refs) AS item
        WHERE item IS DISTINCT FROM p_reference
    )
    WHERE owner_id = p_owner_id AND client_operation_id = p_client_operation_id;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_ack_media_cleanup(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_ack_media_cleanup(UUID, TEXT, JSONB, TEXT) TO service_role;

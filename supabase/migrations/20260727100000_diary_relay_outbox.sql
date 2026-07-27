-- Durable Diary relay support.
--
-- A diary entry can take two safe paths to the cloud:
--   device -> Supabase
--   device -> boat Pi outbox -> Supabase
--
-- `client_operation_id` makes those paths converge on one row. The relay
-- table holds only SHA-256 hashes of per-Pi bearer credentials; it is never
-- readable by regular clients and the Pi never receives a service-role key.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.diary_entries
    ADD COLUMN IF NOT EXISTS client_operation_id TEXT;

-- A stable operation id deduplicates delivery; the revision orders edits made
-- to that operation while one copy is still waiting in the device or Pi
-- outbox. Existing diary rows are revision 1.
ALTER TABLE public.diary_entries
    ADD COLUMN IF NOT EXISTS client_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.diary_entries
    DROP CONSTRAINT IF EXISTS diary_entries_client_revision_positive;
ALTER TABLE public.diary_entries
    ADD CONSTRAINT diary_entries_client_revision_positive
    CHECK (client_revision >= 1);

ALTER TABLE public.diary_entries
    DROP CONSTRAINT IF EXISTS diary_entries_client_operation_id_shape;
ALTER TABLE public.diary_entries
    ADD CONSTRAINT diary_entries_client_operation_id_shape
    CHECK (
        client_operation_id IS NULL
        OR client_operation_id ~ '^[A-Za-z0-9_-]{1,128}$'
    );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.diary_entries'::regclass
          AND conname = 'diary_entries_owner_operation_key'
    ) THEN
        ALTER TABLE public.diary_entries
            ADD CONSTRAINT diary_entries_owner_operation_key
            UNIQUE (user_id, client_operation_id);
    END IF;
END;
$$;

COMMENT ON COLUMN public.diary_entries.client_operation_id IS
    'Stable client-created id that deduplicates direct and Raspberry Pi outbox delivery.';

COMMENT ON COLUMN public.diary_entries.client_revision IS
    'Monotonic client revision used to reject an older device or Pi snapshot of the same operation.';

-- A cancellation must outlive every device/Pi retry. There are deliberately
-- no client policies: only the service-role-backed diary-relay edge function
-- can create or inspect these records.
CREATE TABLE IF NOT EXISTS public.diary_relay_tombstones (
    owner_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    client_operation_id TEXT NOT NULL
                            CHECK (client_operation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    cancelled_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, client_operation_id)
);

ALTER TABLE public.diary_relay_tombstones ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.diary_relay_tombstones FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pi_diary_relays (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relay_id        TEXT NOT NULL UNIQUE
                        CHECK (relay_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pi_diary_relays_owner_idx
    ON public.pi_diary_relays(owner_id);

ALTER TABLE public.pi_diary_relays ENABLE ROW LEVEL SECURITY;

-- Relay credentials are administered exclusively by the `diary-relay` edge
-- function using the service role. In particular, an authenticated browser
-- must never be able to read a bearer-token hash or enumerate boat Pis.
REVOKE ALL ON TABLE public.pi_diary_relays FROM anon, authenticated;

-- A raw PostgREST write can otherwise race a cancellation: the write checks
-- for a tombstone before the cancellation commits, then inserts after it. The
-- shared transaction-level advisory lock serializes that key across every
-- diary write and cancellation. This trigger is the database backstop; the
-- edge RPCs below use the same lock and give callers a canonical response.
CREATE OR REPLACE FUNCTION public.diary_relay_block_tombstoned_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Legacy rows have no replay operation and are outside this protocol.
    IF NEW.client_operation_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'diary-relay:' || NEW.user_id::TEXT || ':' || NEW.client_operation_id,
            0
        )
    );

    IF EXISTS (
        SELECT 1
        FROM public.diary_relay_tombstones AS tombstone
        WHERE tombstone.owner_id = NEW.user_id
          AND tombstone.client_operation_id = NEW.client_operation_id
    ) THEN
        RAISE EXCEPTION 'Diary operation has been cancelled'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS diary_entries_block_tombstoned_write ON public.diary_entries;
CREATE TRIGGER diary_entries_block_tombstoned_write
    BEFORE INSERT OR UPDATE ON public.diary_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.diary_relay_block_tombstoned_write();

REVOKE ALL ON FUNCTION public.diary_relay_block_tombstoned_write()
    FROM PUBLIC, anon, authenticated;

-- Apply a complete, normalized envelope at most once per revision. The
-- function returns either the accepted row, the newer canonical row already
-- present, or `cancelled`; callers never need a read-then-write race.
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
    canonical public.diary_entries%ROWTYPE;
    was_applied BOOLEAN := false;
BEGIN
    IF p_owner_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RAISE EXCEPTION 'A diary relay owner and object envelope are required'
            USING ERRCODE = '22023';
    END IF;

    operation_id := NULLIF(p_entry ->> 'client_operation_id', '');
    IF operation_id IS NULL OR operation_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'Invalid diary client operation id'
            USING ERRCODE = '22023';
    END IF;

    -- Old queued builds did not include a revision. They are safely treated
    -- as revision 1; malformed/overflowing supplied revisions are rejected.
    revision_text := p_entry ->> 'client_revision';
    IF revision_text IS NULL THEN
        submitted_revision := 1;
    ELSIF revision_text !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'Invalid diary client revision'
            USING ERRCODE = '22023';
    ELSE
        submitted_revision := revision_text::INTEGER;
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
        client_operation_id,
        client_revision,
        title,
        body,
        mood,
        photos,
        audio_url,
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
        client_revision = EXCLUDED.client_revision,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        mood = EXCLUDED.mood,
        photos = EXCLUDED.photos,
        audio_url = EXCLUDED.audio_url,
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
        -- The advisory lock means this is only possible if an authorised
        -- cancellation committed in a legacy/direct writer's transaction.
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

-- Cancellation is deliberately absolute: it writes the durable fence before
-- deleting the current row, under the same per-operation advisory lock used
-- by all writes. Any delayed device/Pi retry is then rejected by both this
-- protocol and the trigger above.
CREATE OR REPLACE FUNCTION public.diary_relay_cancel_entry(
    p_owner_id UUID,
    p_client_operation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_owner_id IS NULL
       OR p_client_operation_id IS NULL
       OR p_client_operation_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'Invalid diary cancellation operation id'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('diary-relay:' || p_owner_id::TEXT || ':' || p_client_operation_id, 0)
    );

    INSERT INTO public.diary_relay_tombstones (owner_id, client_operation_id)
    VALUES (p_owner_id, p_client_operation_id)
    ON CONFLICT (owner_id, client_operation_id) DO NOTHING;

    DELETE FROM public.diary_entries
    WHERE user_id = p_owner_id
      AND client_operation_id = p_client_operation_id;

    RETURN jsonb_build_object('status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_cancel_entry(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_cancel_entry(UUID, TEXT) TO service_role;

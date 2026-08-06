-- Durable public-beta account-deletion boundary.
--
-- This migration is deliberately deployed before the delete-account Edge
-- Function and while the client feature flag is still off. A deletion job is
-- a permanent, minimal anti-resurrection tombstone: it is not tied to
-- auth.users, so a stale JWT or delayed service writer cannot start writing
-- the deleted UUID again after auth.admin.deleteUser() commits.

CREATE TABLE public.account_deletion_jobs (
    user_id UUID PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'requested' CHECK (phase IN (
        'requested',
        'apple_revocation',
        'storage_capture',
        'storage_cleanup',
        'storage_verified',
        'survivor_scrub',
        'ready_for_auth_delete',
        'auth_deleting',
        'completed'
    )),
    apple_revocation_state TEXT NOT NULL DEFAULT 'pending' CHECK (apple_revocation_state IN (
        'pending',
        'revoking',
        'complete',
        'manual_required',
        'not_applicable'
    )),
    -- Needed only while the job is in progress so queued Apple lifecycle
    -- events can be deleted. Completion clears this pseudonymous identifier.
    apple_subject_sha256 TEXT CHECK (
        apple_subject_sha256 IS NULL
        OR apple_subject_sha256 ~ '^[0-9a-f]{64}$'
    ),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT CHECK (
        last_error_code IS NULL
        OR last_error_code ~ '^[a-z0-9][a-z0-9_:-]{0,79}$'
    ),
    last_error_at TIMESTAMPTZ,
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((phase = 'completed') = (completed_at IS NOT NULL)),
    CHECK (phase <> 'completed' OR apple_subject_sha256 IS NULL),
    CHECK (
        phase IN ('requested', 'apple_revocation')
        OR apple_revocation_state IN ('complete', 'manual_required', 'not_applicable')
    )
);

CREATE TABLE public.account_deletion_storage_items (
    user_id UUID NOT NULL REFERENCES public.account_deletion_jobs(user_id) ON DELETE CASCADE,
    bucket_id TEXT NOT NULL CHECK (length(bucket_id) BETWEEN 1 AND 100),
    object_name TEXT NOT NULL CHECK (length(object_name) BETWEEN 1 AND 1024),
    source TEXT NOT NULL CHECK (source IN ('storage-owner', 'owner-path', 'legacy-recipe-row')),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    remove_requested_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, bucket_id, object_name)
);

ALTER TABLE public.account_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_storage_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_storage_items FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.account_deletion_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.account_deletion_storage_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_deletion_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_deletion_storage_items TO service_role;

-- Watch assignments historically retained only an email/name snapshot. Link
-- new writes to the actual crew identity so deletion can fence a stale skipper
-- client, and backfill exact existing auth emails before the survivor scrub.
ALTER TABLE public.watch_assignments
    ADD COLUMN IF NOT EXISTS assigned_crew_user_id UUID;

UPDATE public.watch_assignments AS assignment
SET assigned_crew_user_id = auth_user.id
FROM auth.users AS auth_user
WHERE assignment.assigned_crew_user_id IS NULL
  AND assignment.assigned_crew_email IS NOT NULL
  AND lower(btrim(assignment.assigned_crew_email)) = lower(auth_user.email);

ALTER TABLE public.watch_assignments
    DROP CONSTRAINT IF EXISTS watch_assignments_assigned_crew_user_id_fkey;
ALTER TABLE public.watch_assignments
    ADD CONSTRAINT watch_assignments_assigned_crew_user_id_fkey
    FOREIGN KEY (assigned_crew_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS watch_assignments_assigned_crew_user_idx
    ON public.watch_assignments (assigned_crew_user_id)
    WHERE assigned_crew_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.account_deletion_phase_rank(p_phase TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT CASE p_phase
        WHEN 'requested' THEN 0
        WHEN 'apple_revocation' THEN 10
        WHEN 'storage_capture' THEN 20
        WHEN 'storage_cleanup' THEN 30
        WHEN 'storage_verified' THEN 40
        WHEN 'survivor_scrub' THEN 50
        WHEN 'ready_for_auth_delete' THEN 60
        WHEN 'auth_deleting' THEN 70
        WHEN 'completed' THEN 80
        ELSE NULL
    END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_phase_rank(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_phase_rank(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_account_deletion(
    p_user_id UUID,
    p_lease_token UUID,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE (
    acquired BOOLEAN,
    current_phase TEXT,
    current_apple_revocation_state TEXT,
    current_apple_subject_sha256 TEXT,
    is_completed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
    job public.account_deletion_jobs%ROWTYPE;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL OR p_lease_token IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION 'Invalid account-deletion claim' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));

    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
       AND NOT EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE user_id = p_user_id) THEN
        RAISE EXCEPTION 'Deletion subject does not exist' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.account_deletion_jobs (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO STRICT job
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF job.phase = 'completed' THEN
        RETURN QUERY SELECT false, job.phase, job.apple_revocation_state, NULL::TEXT, true;
        RETURN;
    END IF;

    IF job.lease_token IS NOT NULL
       AND job.lease_token <> p_lease_token
       AND job.lease_expires_at > now_at THEN
        RETURN QUERY
        SELECT false, job.phase, job.apple_revocation_state, job.apple_subject_sha256, false;
        RETURN;
    END IF;

    UPDATE public.account_deletion_jobs
    SET lease_token = p_lease_token,
        lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
        updated_at = now_at,
        last_error_code = NULL,
        last_error_at = NULL
    WHERE user_id = p_user_id
    RETURNING * INTO job;

    RETURN QUERY
    SELECT true, job.phase, job.apple_revocation_state, job.apple_subject_sha256, false;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_account_deletion(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion(UUID, UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_account_deletion_phase(
    p_user_id UUID,
    p_lease_token UUID,
    p_phase TEXT,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    old_phase TEXT;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL OR p_lease_token IS NULL
       OR public.account_deletion_phase_rank(p_phase) IS NULL
       OR p_phase = 'completed'
       OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION 'Invalid account-deletion phase update' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    SELECT phase INTO STRICT old_phase
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND lease_expires_at > now_at
    FOR UPDATE;

    IF p_phase <> old_phase
       AND NOT (
            (old_phase = 'storage_verified' AND p_phase = 'survivor_scrub')
            OR (old_phase = 'ready_for_auth_delete' AND p_phase = 'auth_deleting')
       ) THEN
        RAISE EXCEPTION 'Invalid account-deletion phase transition' USING ERRCODE = '22023';
    END IF;

    UPDATE public.account_deletion_jobs
    SET phase = p_phase,
        updated_at = now_at,
        lease_expires_at = now_at + make_interval(secs => p_lease_seconds)
    WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_account_deletion_phase(UUID, UUID, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_account_deletion_phase(UUID, UUID, TEXT, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.record_account_deletion_apple_state(
    p_user_id UUID,
    p_lease_token UUID,
    p_state TEXT,
    p_apple_subject_sha256 TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    old_state TEXT;
    old_phase TEXT;
    old_subject_sha256 TEXT;
    now_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_state NOT IN ('revoking', 'complete', 'manual_required', 'not_applicable')
       OR (p_apple_subject_sha256 IS NOT NULL AND p_apple_subject_sha256 !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'Invalid Apple revocation state' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    SELECT apple_revocation_state, phase, apple_subject_sha256
    INTO STRICT old_state, old_phase, old_subject_sha256
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND lease_expires_at > now_at
    FOR UPDATE;

    IF old_phase NOT IN ('requested', 'apple_revocation') THEN
        RAISE EXCEPTION 'Apple revocation state is already sealed' USING ERRCODE = '22023';
    END IF;
    IF old_subject_sha256 IS NOT NULL
       AND p_apple_subject_sha256 IS NOT NULL
       AND old_subject_sha256 <> p_apple_subject_sha256 THEN
        RAISE EXCEPTION 'Apple revocation subject cannot change' USING ERRCODE = '22023';
    END IF;

    IF old_state IN ('complete', 'manual_required', 'not_applicable') AND old_state <> p_state THEN
        RAISE EXCEPTION 'Apple revocation state is already terminal' USING ERRCODE = '22023';
    END IF;
    IF old_state = 'pending' AND p_state NOT IN ('revoking', 'manual_required', 'not_applicable') THEN
        RAISE EXCEPTION 'Apple revocation must be claimed before completion' USING ERRCODE = '22023';
    END IF;
    IF old_state = 'revoking' AND p_state NOT IN ('revoking', 'complete') THEN
        RAISE EXCEPTION 'Invalid Apple revocation transition' USING ERRCODE = '22023';
    END IF;

    UPDATE public.account_deletion_jobs
    SET phase = CASE
            WHEN public.account_deletion_phase_rank(phase) < 10 THEN 'apple_revocation'
            ELSE phase
        END,
        apple_revocation_state = p_state,
        apple_subject_sha256 = COALESCE(p_apple_subject_sha256, apple_subject_sha256),
        updated_at = now_at,
        lease_expires_at = now_at + interval '300 seconds'
    WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_account_deletion_apple_state(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_account_deletion_apple_state(UUID, UUID, TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.account_deletion_storage_inventory(p_user_id UUID)
RETURNS TABLE (bucket_id TEXT, object_name TEXT, source TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, storage
AS $$
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
            object.bucket_id IN (
                'crew-list-photos',
                'diary-photos',
                'diary-audio',
                'vessel_vault',
                'marketplace-images',
                'recipe-photos'
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
$$;

REVOKE ALL ON FUNCTION public.account_deletion_storage_inventory(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_storage_inventory(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.capture_account_deletion_storage(
    p_user_id UUID,
    p_lease_token UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
    item_count INTEGER;
    job_phase TEXT;
    apple_state TEXT;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    SELECT phase, apple_revocation_state INTO job_phase, apple_state
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND lease_expires_at > now_at
      AND phase <> 'completed'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion lease is not active' USING ERRCODE = '55000';
    END IF;
    IF job_phase NOT IN ('apple_revocation', 'storage_capture', 'storage_cleanup')
       OR apple_state NOT IN ('complete', 'manual_required', 'not_applicable') THEN
        RAISE EXCEPTION 'Apple revocation is not durably resolved' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.account_deletion_storage_items (user_id, bucket_id, object_name, source)
    SELECT p_user_id, inventory.bucket_id, inventory.object_name, inventory.source
    FROM public.account_deletion_storage_inventory(p_user_id) AS inventory
    ON CONFLICT (user_id, bucket_id, object_name)
    DO UPDATE SET source = EXCLUDED.source,
                  remove_requested_at = NULL;

    UPDATE public.account_deletion_jobs
    SET phase = CASE
            WHEN public.account_deletion_phase_rank(phase) < 30 THEN 'storage_cleanup'
            ELSE phase
        END,
        updated_at = now_at,
        lease_expires_at = now_at + interval '300 seconds'
    WHERE user_id = p_user_id;

    SELECT count(*)::INTEGER INTO item_count
    FROM public.account_deletion_storage_items
    WHERE user_id = p_user_id
      AND remove_requested_at IS NULL;
    RETURN item_count;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_account_deletion_storage(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_account_deletion_storage(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_account_deletion_storage_empty(
    p_user_id UUID,
    p_lease_token UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
    survivor_count INTEGER;
    job_phase TEXT;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    SELECT phase INTO job_phase
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND lease_expires_at > now_at
      AND phase <> 'completed'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion lease is not active' USING ERRCODE = '55000';
    END IF;
    IF job_phase <> 'storage_cleanup' THEN
        RAISE EXCEPTION 'Storage cleanup is not active' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.account_deletion_storage_items (user_id, bucket_id, object_name, source)
    SELECT p_user_id, inventory.bucket_id, inventory.object_name, inventory.source
    FROM public.account_deletion_storage_inventory(p_user_id) AS inventory
    ON CONFLICT (user_id, bucket_id, object_name)
    DO UPDATE SET source = EXCLUDED.source,
                  remove_requested_at = NULL;

    SELECT count(*)::INTEGER INTO survivor_count
    FROM public.account_deletion_storage_inventory(p_user_id);

    IF survivor_count = 0 THEN
        DELETE FROM public.account_deletion_storage_items WHERE user_id = p_user_id;
        UPDATE public.account_deletion_jobs
        SET phase = CASE
                WHEN public.account_deletion_phase_rank(phase) < 40 THEN 'storage_verified'
                ELSE phase
            END,
            updated_at = now_at,
            lease_expires_at = now_at + interval '300 seconds'
        WHERE user_id = p_user_id;
    END IF;

    RETURN survivor_count;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_account_deletion_storage_empty(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_account_deletion_storage_empty(UUID, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.scrub_account_deletion_survivors(
    p_user_id UUID,
    p_lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
    now_at TIMESTAMPTZ := clock_timestamp();
    normalized_email TEXT;
    apple_subject TEXT;
    affected_rows INTEGER := 0;
    changed_manifest INTEGER := 0;
    changed_watch INTEGER := 0;
    changed_channels INTEGER := 0;
    changed_audit INTEGER := 0;
    changed_direct_rows INTEGER := 0;
    direct_rows INTEGER := 0;
    direct_survivor BOOLEAN := false;
    direct_target RECORD;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    PERFORM 1
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND lease_expires_at > now_at
      AND phase = 'survivor_scrub'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion lease or storage verification is not active' USING ERRCODE = '55000';
    END IF;

    SELECT lower(btrim(email)) INTO normalized_email FROM auth.users WHERE id = p_user_id;
    SELECT apple_subject_sha256 INTO apple_subject
    FROM public.account_deletion_jobs
    WHERE user_id = p_user_id;

    -- This narrowly-scoped service-role transaction may clear survivor FKs
    -- even when a second account is simultaneously tombstoned. Ordinary
    -- service writers and every client remain fenced by the triggers below.
    PERFORM set_config('thalassa.account_deletion_scrub', 'true', true);

    DELETE FROM public.manifest_invites
    WHERE owner_id = p_user_id
       OR (
            status = 'pending'
            AND normalized_email IS NOT NULL
            AND lower(btrim(email)) = normalized_email
       );
    GET DIAGNOSTICS changed_manifest = ROW_COUNT;

    UPDATE public.manifest_invites
    SET email = NULL,
        accepted_by = CASE WHEN accepted_by = p_user_id THEN NULL ELSE accepted_by END,
        device_id = NULL
    WHERE accepted_by = p_user_id
       OR (
            normalized_email IS NOT NULL
            AND lower(btrim(email)) = normalized_email
       );
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    changed_manifest := changed_manifest + affected_rows;

    DELETE FROM public.watch_assignments AS assignment
    WHERE assignment.assigned_by = p_user_id
       OR assignment.assigned_crew_user_id = p_user_id
       OR (
            normalized_email IS NOT NULL
            AND lower(btrim(assignment.assigned_crew_email)) = normalized_email
       )
       OR EXISTS (
            SELECT 1
            FROM public.voyages AS voyage
            WHERE voyage.user_id = p_user_id
              AND voyage.id::TEXT = assignment.voyage_id
       );
    GET DIAGNOSTICS changed_watch = ROW_COUNT;

    DELETE FROM public.chat_channels
    WHERE status = 'pending'
      AND (proposed_by = p_user_id OR owner_id = p_user_id);

    UPDATE public.chat_channels
    SET proposed_by = NULL,
        owner_id = NULL,
        name = 'Archived community channel',
        description = '',
        region = NULL,
        icon = '🌊'
    WHERE proposed_by = p_user_id OR owner_id = p_user_id;
    GET DIAGNOSTICS changed_channels = ROW_COUNT;

    -- Clear every current retained SET NULL reviewer/approver relationship
    -- inside this scrub transaction. Leaving these to auth deletion would let
    -- a second tombstone on the same shared row trip the ordinary write fence.
    UPDATE public.voyages
    SET weather_master_id = NULL
    WHERE weather_master_id = p_user_id;

    UPDATE public.personal_ports
    SET public_approved_by = NULL
    WHERE public_approved_by = p_user_id;

    UPDATE public.sailor_crew_profiles
    SET reviewed_by = NULL
    WHERE reviewed_by = p_user_id;

    UPDATE public.channel_join_requests
    SET reviewed_by = NULL
    WHERE reviewed_by = p_user_id;

    UPDATE public.crew_list_reports
    SET status = 'pending',
        reviewed_at = NULL,
        reviewed_by = NULL
    WHERE reviewed_by = p_user_id;

    UPDATE public.admin_audit_log
    SET actor_id = CASE WHEN actor_id = p_user_id THEN NULL ELSE actor_id END,
        target_id = CASE
            WHEN target_id IS NOT NULL
             AND (
                strpos(lower(target_id), lower(p_user_id::TEXT)) > 0
                OR (normalized_email IS NOT NULL AND strpos(lower(target_id), normalized_email) > 0)
             ) THEN NULL
            ELSE target_id
        END,
        details = jsonb_build_object('account_deleted', true)
    WHERE actor_id = p_user_id
       OR (
            target_id IS NOT NULL
            AND (
                strpos(lower(target_id), lower(p_user_id::TEXT)) > 0
                OR (normalized_email IS NOT NULL AND strpos(lower(target_id), normalized_email) > 0)
            )
       )
       OR strpos(lower(details::TEXT), lower(p_user_id::TEXT)) > 0
       OR (normalized_email IS NOT NULL AND strpos(lower(details::TEXT), normalized_email) > 0);
    GET DIAGNOSTICS changed_audit = ROW_COUNT;

    DELETE FROM public.apple_server_notification_queue
    WHERE user_id = p_user_id
       OR (apple_subject IS NOT NULL AND apple_subject_sha256 = apple_subject);

    DELETE FROM public.community_tracks WHERE user_id = p_user_id;
    DELETE FROM public.guardian_alerts
    WHERE source_user_id = p_user_id OR target_user_id = p_user_id;

    -- Pre-delete every remaining direct public auth FK while scrub mode and
    -- the per-account advisory lock are active. This mirrors the eventual
    -- auth cascade without allowing table triggers to collide with the
    -- permanent fence. Retained shared rows were detached/redacted above;
    -- any unclassified direct identity row is deleted rather than guessed at.
    FOR direct_target IN
        SELECT DISTINCT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            attribute.attname AS column_name
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN unnest(constraint_row.conkey) AS constrained_column(attnum) ON true
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum = constrained_column.attnum
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
        ORDER BY namespace.nspname, relation.relname, attribute.attname
    LOOP
        EXECUTE format(
            'DELETE FROM %I.%I WHERE %I = $1',
            direct_target.schema_name,
            direct_target.table_name,
            direct_target.column_name
        ) USING p_user_id;
        GET DIAGNOSTICS direct_rows = ROW_COUNT;
        changed_direct_rows := changed_direct_rows + direct_rows;
        EXECUTE format(
            'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)',
            direct_target.schema_name,
            direct_target.table_name,
            direct_target.column_name
        ) INTO direct_survivor USING p_user_id;
        IF direct_survivor THEN
            RAISE EXCEPTION 'Direct account identity survivor remains' USING ERRCODE = '55000';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM public.manifest_invites
        WHERE accepted_by = p_user_id
           OR (
                normalized_email IS NOT NULL
                AND lower(btrim(email)) = normalized_email
           )
    ) OR EXISTS (
        SELECT 1 FROM public.watch_assignments
        WHERE assigned_by = p_user_id
           OR assigned_crew_user_id = p_user_id
           OR (
                normalized_email IS NOT NULL
                AND lower(btrim(assigned_crew_email)) = normalized_email
           )
    ) OR EXISTS (
        SELECT 1 FROM public.chat_channels
        WHERE proposed_by = p_user_id OR owner_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.voyages WHERE weather_master_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.personal_ports WHERE public_approved_by = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.sailor_crew_profiles WHERE reviewed_by = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.channel_join_requests WHERE reviewed_by = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.crew_list_reports WHERE reviewed_by = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.admin_audit_log
        WHERE actor_id = p_user_id
           OR strpos(lower(COALESCE(target_id, '')), lower(p_user_id::TEXT)) > 0
           OR strpos(lower(details::TEXT), lower(p_user_id::TEXT)) > 0
           OR (
                normalized_email IS NOT NULL
                AND (
                    strpos(lower(COALESCE(target_id, '')), normalized_email) > 0
                    OR strpos(lower(details::TEXT), normalized_email) > 0
                )
           )
    ) OR EXISTS (
        SELECT 1 FROM public.apple_server_notification_queue
        WHERE user_id = p_user_id
           OR (apple_subject IS NOT NULL AND apple_subject_sha256 = apple_subject)
    ) OR EXISTS (
        SELECT 1 FROM public.community_tracks WHERE user_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM public.guardian_alerts
        WHERE source_user_id = p_user_id OR target_user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'Account-deletion survivor verification failed' USING ERRCODE = '55000';
    END IF;

    UPDATE public.account_deletion_jobs
    SET phase = 'ready_for_auth_delete',
        updated_at = now_at,
        lease_expires_at = now_at + interval '300 seconds'
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'verified', true,
        'manifest_rows_changed', changed_manifest,
        'watch_rows_deleted', changed_watch,
        'channels_anonymized', changed_channels,
        'audit_rows_redacted', changed_audit,
        'direct_identity_rows_deleted', changed_direct_rows
    );
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_account_deletion_survivors(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_account_deletion_survivors(UUID, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.record_account_deletion_failure(
    p_user_id UUID,
    p_lease_token UUID,
    p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9][a-z0-9_:-]{0,79}$' THEN
        RAISE EXCEPTION 'Invalid account-deletion error code' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    UPDATE public.account_deletion_jobs
    SET last_error_code = p_error_code,
        last_error_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND phase <> 'completed';
END;
$$;

REVOKE ALL ON FUNCTION public.record_account_deletion_failure(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_account_deletion_failure(UUID, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.complete_account_deletion(
    p_user_id UUID,
    p_lease_token UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260806));
    IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
        RAISE EXCEPTION 'Auth account still exists' USING ERRCODE = '55000';
    END IF;
    UPDATE public.account_deletion_jobs
    SET phase = 'completed',
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        apple_subject_sha256 = NULL,
        last_error_code = NULL,
        last_error_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE user_id = p_user_id
      AND lease_token = p_lease_token
      AND phase = 'auth_deleting';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Deletion is not ready to complete' USING ERRCODE = '55000';
    END IF;
    DELETE FROM public.account_deletion_storage_items WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_account_deletion(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_account_deletion(UUID, UUID)
    TO service_role;

-- Every current public-table FK to auth.users is fenced automatically. The
-- generated trigger arguments are deterministic and include all identity
-- columns on a table, so service-role writers cannot bypass the tombstone.
CREATE OR REPLACE FUNCTION public.block_tombstoned_account_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    candidate UUID;
    candidates UUID[];
    scrub_mode BOOLEAN := auth.role() = 'service_role'
        AND current_setting('thalassa.account_deletion_scrub', true) = 'true';
BEGIN
    SELECT array_agg(DISTINCT value::UUID ORDER BY value::UUID)
    INTO candidates
    FROM jsonb_each_text(to_jsonb(NEW)) AS field(key, value)
    WHERE field.key = ANY(TG_ARGV)
      AND field.value IS NOT NULL
      AND field.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

    FOREACH candidate IN ARRAY COALESCE(candidates, ARRAY[]::UUID[]) LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate::TEXT, 20260806));
        IF NOT scrub_mode AND EXISTS (
            SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate
        ) THEN
            RAISE EXCEPTION 'Account is permanently write-fenced' USING ERRCODE = '55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.block_tombstoned_account_write() FROM PUBLIC, anon, authenticated;

DO $install_account_deletion_fences$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            string_agg(quote_literal(attribute.attname), ', ' ORDER BY attribute.attnum) AS trigger_arguments
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN unnest(constraint_row.conkey) AS constrained_column(attnum) ON true
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum = constrained_column.attnum
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
        GROUP BY namespace.nspname, relation.relname
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS account_deletion_write_fence ON %I.%I',
            target.schema_name,
            target.table_name
        );
        EXECUTE format(
            'CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON %I.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write(%s)',
            target.schema_name,
            target.table_name,
            target.trigger_arguments
        );
    END LOOP;
END;
$install_account_deletion_fences$;

CREATE OR REPLACE FUNCTION public.block_tombstoned_storage_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    candidate UUID;
    candidates UUID[] := ARRAY[]::UUID[];
    owner_path TEXT;
BEGIN
    IF NEW.owner_id::TEXT ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, NEW.owner_id::TEXT::UUID);
    END IF;

    owner_path := CASE
        WHEN NEW.bucket_id = 'chat-avatars'
         AND split_part(NEW.name, '/', 1) IN ('dating', 'crew')
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id IN (
            'chat-avatars',
            'crew-list-photos',
            'diary-photos',
            'diary-audio',
            'vessel_vault',
            'marketplace-images',
            'recipe-photos'
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
$$;

REVOKE ALL ON FUNCTION public.block_tombstoned_storage_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_deletion_storage_write_fence ON storage.objects;
CREATE TRIGGER account_deletion_storage_write_fence
    BEFORE INSERT OR UPDATE ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_storage_write();

COMMENT ON TABLE public.account_deletion_jobs IS
    'Minimal durable tombstone and resumable state for complete account deletion. No auth FK by design.';
COMMENT ON TABLE public.account_deletion_storage_items IS
    'Ephemeral exact Storage deletion manifest; rows are removed when the tombstone completes.';

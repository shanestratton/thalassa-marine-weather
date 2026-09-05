-- Account deletion deleted OTHER people's rows.
--
-- scrub_account_deletion_survivors() ends with a loop over every public column
-- holding a foreign key to auth.users and runs DELETE ... WHERE column = user
-- for each, "mirroring the eventual auth cascade". It mirrored only one kind of
-- cascade. Twelve of those columns on production are ON DELETE SET NULL — the
-- departing user as reviewer, approver, assignee or weather master of a record
-- that belongs to someone else — and the real cascade would null the column
-- and keep the row. The loop deleted the row.
--
-- Concretely, live on 2026-09-05: voyages.weather_master_id,
-- watch_assignments.assigned_by / assigned_crew_user_id,
-- founding_skipper_applications.status_updated_by, personal_ports.public_approved_by, manifest_invites.accepted_by, crew_profile_review_holds.cleared_by, crew_profile_publication_decisions.actor_id,
-- founding_skipper_application_status_audit.actor_id, guardian_alerts.sender_user_id, chat_channels.proposed_by, admin_audit_log.actor_id. The
-- explicit detach statements above the loop covered reviewed_by on three
-- tables and one actor_id; the rest fell through to DELETE.
--
-- The loop now reads pg_constraint.confdeltype and does what the constraint
-- says: 'n' nulls the column, 'd' sets its default, anything else deletes as
-- before. The survivor check after each step is unchanged and still fails the
-- deletion loudly if the column somehow still names the user.
--
-- Body below is the LIVE production definition pulled via pg_get_functiondef on
-- 2026-09-05 with only the loop changed, so this cannot regress anything a
-- later migration did to the rest of the function.

CREATE OR REPLACE FUNCTION public.scrub_account_deletion_survivors(p_user_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
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
            attribute.attname AS column_name,
            constraint_row.confdeltype AS delete_rule
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
        -- HONOUR THE COLUMN'S OWN DELETE RULE. This used to DELETE the row for
        -- every auth FK column equal to the departing user, whatever the
        -- constraint said. For an ON DELETE SET NULL column that is the wrong
        -- row to remove: voyages.weather_master_id, watch_assignments.assigned_by,
        -- founding_skipper_applications.status_updated_by, personal_ports.public_approved_by — all live SET NULL on production, all naming the
        -- departing user as a REVIEWER, ASSIGNEE or APPROVER of somebody else's
        -- record. Deleting the row deleted the other person's voyage, watch,
        -- application or port because the leaver had once touched it. The
        -- cascade this loop mirrors would have nulled the column and kept the
        -- row; now so does the loop.
        IF direct_target.delete_rule = 'n' THEN
            EXECUTE format(
                'UPDATE %I.%I SET %I = NULL WHERE %I = $1',
                direct_target.schema_name,
                direct_target.table_name,
                direct_target.column_name,
                direct_target.column_name
            ) USING p_user_id;
        ELSIF direct_target.delete_rule = 'd' THEN
            EXECUTE format(
                'UPDATE %I.%I SET %I = DEFAULT WHERE %I = $1',
                direct_target.schema_name,
                direct_target.table_name,
                direct_target.column_name,
                direct_target.column_name
            ) USING p_user_id;
        ELSE
            EXECUTE format(
                'DELETE FROM %I.%I WHERE %I = $1',
                direct_target.schema_name,
                direct_target.table_name,
                direct_target.column_name
            ) USING p_user_id;
        END IF;
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
$function$;

-- Privileges restated so this migration is self-evidently safe on its own — CREATE OR
-- REPLACE preserves existing grants, but the audit (scripts/audit-supabase-migrations.mjs)
-- and the next reader should not have to know that. Verbatim from 20260806120000; the
-- only caller is supabase/functions/delete-account, which runs as the service role.
REVOKE ALL ON FUNCTION public.scrub_account_deletion_survivors(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_account_deletion_survivors(UUID, UUID)
    TO service_role;

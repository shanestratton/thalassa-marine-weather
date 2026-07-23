-- Make Cast Off one atomic, retry-safe server operation.
--
-- A live vessel_crew row remains the editable invitation/authorization record.
-- voyage_manifest is a historical snapshot: changing or revoking a membership
-- after departure must not rewrite who was aboard when the voyage started.

ALTER TABLE public.voyages
    ADD COLUMN IF NOT EXISTS manifest_locked_at TIMESTAMPTZ;

-- Older clients could race two independent "is anything active?" checks.
-- Preserve the most recently touched active voyage and close any stale
-- duplicates before installing the database-level invariant.
WITH ranked_active AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY user_id
            ORDER BY
                coalesce(departure_time, updated_at, created_at) DESC,
                updated_at DESC,
                id DESC
        ) AS active_rank
    FROM public.voyages
    WHERE status = 'active'
)
UPDATE public.voyages AS voyage
SET status = 'aborted'
FROM ranked_active AS ranked
WHERE voyage.id = ranked.id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_voyages_one_active_per_owner
    ON public.voyages(user_id)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.voyage_manifest (
    voyage_id UUID NOT NULL
        REFERENCES public.voyages(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    member_user_id UUID NOT NULL,
    source_membership_id UUID,
    role TEXT NOT NULL,
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    shared_registers TEXT[] NOT NULL DEFAULT '{}',
    membership_scope TEXT NOT NULL
        CHECK (membership_scope IN ('owner', 'global', 'voyage')),
    snapshot_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (voyage_id, member_user_id)
);

CREATE INDEX IF NOT EXISTS idx_voyage_manifest_member
    ON public.voyage_manifest(member_user_id, voyage_id);

ALTER TABLE public.voyage_manifest ENABLE ROW LEVEL SECURITY;

-- Querying voyage_manifest directly inside its policy would recurse. This
-- narrowly-scoped definer helper lets the owner and snapshotted crew read the
-- complete manifest, without consulting the mutable vessel_crew table.
CREATE OR REPLACE FUNCTION public.can_read_voyage_manifest(
    p_voyage_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.uid() IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.voyage_manifest AS membership
            WHERE membership.voyage_id = p_voyage_id
              AND (
                  membership.owner_id = auth.uid()
                  OR membership.member_user_id = auth.uid()
              )
       );
$$;

REVOKE ALL ON FUNCTION public.can_read_voyage_manifest(UUID)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_voyage_manifest(UUID)
    TO authenticated;

DROP POLICY IF EXISTS "Manifest members read snapshot"
    ON public.voyage_manifest;
CREATE POLICY "Manifest members read snapshot"
    ON public.voyage_manifest FOR SELECT TO authenticated
    USING (public.can_read_voyage_manifest(voyage_id));

-- Authenticated clients may read an authorized snapshot, but only the
-- SECURITY DEFINER Cast Off RPC may create it. There are deliberately no
-- authenticated INSERT, UPDATE, or DELETE policies/grants.
REVOKE ALL ON TABLE public.voyage_manifest
    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.voyage_manifest
    TO authenticated;

-- Existing active voyages predate atomic Cast Off. Capture the best manifest
-- still available at migration time, then mark those snapshots as locked.
INSERT INTO public.voyage_manifest (
    voyage_id,
    owner_id,
    member_user_id,
    source_membership_id,
    role,
    permissions,
    shared_registers,
    membership_scope,
    snapshot_at
)
SELECT
    voyage.id,
    voyage.user_id,
    voyage.user_id,
    NULL,
    'skipper',
    '{"is_owner": true}'::jsonb,
    '{}'::text[],
    'owner',
    now()
FROM public.voyages AS voyage
WHERE voyage.status = 'active'
ON CONFLICT (voyage_id, member_user_id) DO NOTHING;

WITH applicable_memberships AS (
    SELECT
        voyage.id AS voyage_id,
        voyage.user_id AS owner_id,
        membership.id AS source_membership_id,
        membership.crew_user_id AS member_user_id,
        membership.role,
        coalesce(membership.permissions, '{}'::jsonb) AS permissions,
        coalesce(membership.shared_registers, '{}'::text[]) AS shared_registers,
        CASE
            WHEN membership.voyage_id IS NULL THEN 'global'
            ELSE 'voyage'
        END AS membership_scope,
        row_number() OVER (
            PARTITION BY voyage.id, membership.crew_user_id
            ORDER BY
                (membership.voyage_id = voyage.id::text) DESC,
                membership.updated_at DESC NULLS LAST,
                membership.id DESC
        ) AS membership_rank
    FROM public.voyages AS voyage
    JOIN public.vessel_crew AS membership
      ON membership.owner_id = voyage.user_id
     AND membership.status = 'accepted'
     AND (
         membership.voyage_id IS NULL
         OR membership.voyage_id = voyage.id::text
     )
    WHERE voyage.status = 'active'
)
INSERT INTO public.voyage_manifest (
    voyage_id,
    owner_id,
    member_user_id,
    source_membership_id,
    role,
    permissions,
    shared_registers,
    membership_scope,
    snapshot_at
)
SELECT
    applicable.voyage_id,
    applicable.owner_id,
    applicable.member_user_id,
    applicable.source_membership_id,
    applicable.role,
    applicable.permissions,
    applicable.shared_registers,
    applicable.membership_scope,
    now()
FROM applicable_memberships AS applicable
WHERE applicable.membership_rank = 1
ON CONFLICT (voyage_id, member_user_id) DO NOTHING;

UPDATE public.voyages
SET manifest_locked_at = now()
WHERE status = 'active'
  AND manifest_locked_at IS NULL;

ALTER TABLE public.voyages
    DROP CONSTRAINT IF EXISTS voyages_active_manifest_locked;
ALTER TABLE public.voyages
    ADD CONSTRAINT voyages_active_manifest_locked
    CHECK (status <> 'active' OR manifest_locked_at IS NOT NULL);

-- The owner policy historically allowed direct status updates. Require the
-- immutable owner snapshot to exist before a planning voyage may become
-- active, and make the lock timestamp write-once. The RPC inserts the snapshot
-- first; both it and the status transition still commit or roll back together.
CREATE OR REPLACE FUNCTION public.guard_voyage_manifest_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.manifest_locked_at IS DISTINCT FROM OLD.manifest_locked_at THEN
        IF OLD.manifest_locked_at IS NOT NULL
           OR OLD.status <> 'planning'
           OR NEW.status <> 'active' THEN
            RAISE EXCEPTION 'Voyage manifest locks are immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.status = 'active'
       AND OLD.status IS DISTINCT FROM 'active' THEN
        IF OLD.status <> 'planning'
           OR NEW.manifest_locked_at IS NULL
           OR NOT EXISTS (
                SELECT 1
                FROM public.voyage_manifest AS manifest
                WHERE manifest.voyage_id = NEW.id
                  AND manifest.owner_id = NEW.user_id
                  AND manifest.member_user_id = NEW.user_id
                  AND manifest.membership_scope = 'owner'
                  AND manifest.snapshot_at = NEW.manifest_locked_at
           ) THEN
            RAISE EXCEPTION 'Use cast_off_voyage to activate a voyage'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_voyage_manifest_transition()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_voyage_manifest_transition
    ON public.voyages;
CREATE TRIGGER trg_guard_voyage_manifest_transition
    BEFORE UPDATE OF status, manifest_locked_at ON public.voyages
    FOR EACH ROW EXECUTE FUNCTION public.guard_voyage_manifest_transition();

CREATE OR REPLACE FUNCTION public.cast_off_voyage(
    p_voyage_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    voyage_owner UUID;
    voyage_row public.voyages%ROWTYPE;
    competing_voyage_name TEXT;
    locked_at TIMESTAMPTZ := now();
BEGIN
    IF caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '28000';
    END IF;

    SELECT voyage.user_id
    INTO voyage_owner
    FROM public.voyages AS voyage
    WHERE voyage.id = p_voyage_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Voyage not found'
            USING ERRCODE = '22023';
    END IF;
    IF voyage_owner <> caller_id THEN
        RAISE EXCEPTION 'Only the voyage owner can cast off'
            USING ERRCODE = '42501';
    END IF;

    -- Serialize starts owned by the same skipper. The partial unique index is
    -- the final invariant; this lock also makes the conflict message stable.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(voyage_owner::text, 0)
    );

    SELECT voyage.*
    INTO voyage_row
    FROM public.voyages AS voyage
    WHERE voyage.id = p_voyage_id
    FOR UPDATE;

    IF voyage_row.user_id <> caller_id THEN
        RAISE EXCEPTION 'Only the voyage owner can cast off'
            USING ERRCODE = '42501';
    END IF;

    -- A retry after the original transaction committed returns the exact
    -- active voyage. It neither changes departure time nor re-snapshots crew.
    IF voyage_row.status = 'active'
       AND voyage_row.manifest_locked_at IS NOT NULL THEN
        RETURN to_jsonb(voyage_row);
    END IF;

    IF voyage_row.status NOT IN ('planning', 'active') THEN
        RAISE EXCEPTION 'Only a planning voyage can cast off'
            USING ERRCODE = '22023';
    END IF;

    SELECT voyage.voyage_name
    INTO competing_voyage_name
    FROM public.voyages AS voyage
    WHERE voyage.user_id = caller_id
      AND voyage.status = 'active'
      AND voyage.id <> p_voyage_id
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION '"%" is already active. End it first.',
            competing_voyage_name
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.voyage_manifest (
        voyage_id,
        owner_id,
        member_user_id,
        source_membership_id,
        role,
        permissions,
        shared_registers,
        membership_scope,
        snapshot_at
    )
    VALUES (
        voyage_row.id,
        voyage_row.user_id,
        voyage_row.user_id,
        NULL,
        'skipper',
        '{"is_owner": true}'::jsonb,
        '{}'::text[],
        'owner',
        locked_at
    )
    ON CONFLICT (voyage_id, member_user_id) DO NOTHING;

    WITH applicable_memberships AS (
        SELECT
            membership.id AS source_membership_id,
            membership.crew_user_id AS member_user_id,
            membership.role,
            coalesce(membership.permissions, '{}'::jsonb) AS permissions,
            coalesce(membership.shared_registers, '{}'::text[]) AS shared_registers,
            CASE
                WHEN membership.voyage_id IS NULL THEN 'global'
                ELSE 'voyage'
            END AS membership_scope,
            row_number() OVER (
                PARTITION BY membership.crew_user_id
                ORDER BY
                    (membership.voyage_id = voyage_row.id::text) DESC,
                    membership.updated_at DESC NULLS LAST,
                    membership.id DESC
            ) AS membership_rank
        FROM public.vessel_crew AS membership
        WHERE membership.owner_id = voyage_row.user_id
          AND membership.status = 'accepted'
          AND (
              membership.voyage_id IS NULL
              OR membership.voyage_id = voyage_row.id::text
          )
    )
    INSERT INTO public.voyage_manifest (
        voyage_id,
        owner_id,
        member_user_id,
        source_membership_id,
        role,
        permissions,
        shared_registers,
        membership_scope,
        snapshot_at
    )
    SELECT
        voyage_row.id,
        voyage_row.user_id,
        applicable.member_user_id,
        applicable.source_membership_id,
        applicable.role,
        applicable.permissions,
        applicable.shared_registers,
        applicable.membership_scope,
        locked_at
    FROM applicable_memberships AS applicable
    WHERE applicable.membership_rank = 1
    ON CONFLICT (voyage_id, member_user_id) DO NOTHING;

    UPDATE public.voyages
    SET
        status = 'active',
        departure_time = CASE
            WHEN voyage_row.status = 'planning' THEN locked_at
            ELSE coalesce(voyage_row.departure_time, locked_at)
        END,
        manifest_locked_at = locked_at
    WHERE id = p_voyage_id
    RETURNING * INTO voyage_row;

    RETURN to_jsonb(voyage_row);
END;
$$;

REVOKE ALL ON FUNCTION public.cast_off_voyage(UUID)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cast_off_voyage(UUID)
    TO authenticated;

-- Enforce the Passage Planning permission model at the database boundary.
-- Client visibility is not authorization: accepted memberships must match the
-- voyage owner and scope, and only the explicitly granted child register may
-- read or mutate its rows.

-- Backfill canonical passage flags for memberships created before the UI kept
-- shared_registers and permissions JSON in sync. Preserve any explicit true
-- grant already present.
UPDATE public.vessel_crew
SET permissions = coalesce(permissions, '{}'::jsonb) || jsonb_build_object(
    'can_view_passage_meals',
        coalesce((permissions->>'can_view_passage_meals')::boolean, false)
        OR 'passage_meals' = ANY(shared_registers),
    'can_view_passage_chat',
        coalesce((permissions->>'can_view_passage_chat')::boolean, false)
        OR 'passage_chat' = ANY(shared_registers),
    'can_view_passage_route',
        coalesce((permissions->>'can_view_passage_route')::boolean, false)
        OR 'passage_route' = ANY(shared_registers),
    'can_view_passage_checklist',
        coalesce((permissions->>'can_view_passage_checklist')::boolean, false)
        OR 'passage_checklist' = ANY(shared_registers),
    'can_view_passage',
        coalesce((permissions->>'can_view_passage')::boolean, false)
        OR coalesce((permissions->>'can_view_passage_meals')::boolean, false)
        OR coalesce((permissions->>'can_view_passage_chat')::boolean, false)
        OR coalesce((permissions->>'can_view_passage_route')::boolean, false)
        OR coalesce((permissions->>'can_view_passage_checklist')::boolean, false)
        OR shared_registers && ARRAY[
            'passage_meals',
            'passage_chat',
            'passage_route',
            'passage_checklist'
        ]::TEXT[]
);

CREATE OR REPLACE FUNCTION public.can_access_passage(
    p_owner_id UUID,
    p_voyage_id UUID,
    p_permission TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT
        p_owner_id = auth.uid()
        OR (
            p_permission = ANY(ARRAY[
                'can_view_passage',
                'can_view_passage_meals',
                'can_view_passage_chat',
                'can_view_passage_route',
                'can_view_passage_checklist'
            ]::TEXT[])
            AND EXISTS (
                SELECT 1
                FROM public.vessel_crew AS membership
                WHERE membership.owner_id = p_owner_id
                  AND membership.crew_user_id = auth.uid()
                  AND membership.status = 'accepted'
                  AND coalesce(membership.permissions->>p_permission, 'false') = 'true'
                  AND (
                      membership.voyage_id IS NULL
                      OR (
                          p_voyage_id IS NOT NULL
                          AND membership.voyage_id = p_voyage_id::TEXT
                      )
                  )
            )
        );
$$;

REVOKE ALL ON FUNCTION public.can_access_passage(UUID, UUID, TEXT)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_passage(UUID, UUID, TEXT)
    TO authenticated;

-- Replace the original policy, which allowed anybody with any vessel_crew row
-- (including pending and unrelated memberships) to read every voyage.
DROP POLICY IF EXISTS "Crew read active voyages"
    ON public.voyages;
DROP POLICY IF EXISTS "Authorized crew read shared voyages"
    ON public.voyages;
CREATE POLICY "Authorized crew read shared voyages"
    ON public.voyages FOR SELECT TO authenticated
    USING (
        public.can_access_passage(
            user_id,
            id,
            'can_view_passage'
        )
    );

-- Offline INSERTs initially carry the caller's user_id. For a shared passage,
-- bind the row to the verified voyage owner before RLS evaluates WITH CHECK.
CREATE OR REPLACE FUNCTION public.rewrite_passage_row_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    voyage_owner UUID;
    required_permission TEXT := TG_ARGV[0];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '28000';
    END IF;
    IF NEW.voyage_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT voyage.user_id
    INTO voyage_owner
    FROM public.voyages AS voyage
    WHERE voyage.id = NEW.voyage_id;

    IF voyage_owner IS NULL
       OR NOT public.can_access_passage(
           voyage_owner,
           NEW.voyage_id,
           required_permission
       ) THEN
        RAISE EXCEPTION 'Passage row is not editable'
            USING ERRCODE = '42501';
    END IF;

    NEW.user_id := voyage_owner;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rewrite_meal_plan_owner
    ON public.meal_plans;
CREATE TRIGGER trg_rewrite_meal_plan_owner
    BEFORE INSERT OR UPDATE ON public.meal_plans
    FOR EACH ROW EXECUTE FUNCTION public.rewrite_passage_row_owner(
        'can_view_passage_meals'
    );

DROP TRIGGER IF EXISTS trg_rewrite_provision_owner
    ON public.passage_provisions;
CREATE TRIGGER trg_rewrite_provision_owner
    BEFORE INSERT OR UPDATE ON public.passage_provisions
    FOR EACH ROW EXECUTE FUNCTION public.rewrite_passage_row_owner(
        'can_view_passage_meals'
    );

DROP TRIGGER IF EXISTS trg_rewrite_shopping_owner
    ON public.shopping_list;
CREATE TRIGGER trg_rewrite_shopping_owner
    BEFORE INSERT OR UPDATE ON public.shopping_list
    FOR EACH ROW EXECUTE FUNCTION public.rewrite_passage_row_owner(
        'can_view_passage_meals'
    );

DROP POLICY IF EXISTS "Authorized meal crew manage shared plans"
    ON public.meal_plans;
CREATE POLICY "Authorized meal crew manage shared plans"
    ON public.meal_plans FOR ALL TO authenticated
    USING (
        public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    )
    WITH CHECK (
        public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    );

DROP POLICY IF EXISTS "Authorized meal crew manage shared provisions"
    ON public.passage_provisions;
CREATE POLICY "Authorized meal crew manage shared provisions"
    ON public.passage_provisions FOR ALL TO authenticated
    USING (
        voyage_id IS NOT NULL
        AND public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    )
    WITH CHECK (
        voyage_id IS NOT NULL
        AND public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    );

DROP POLICY IF EXISTS "Authorized meal crew manage shared shopping"
    ON public.shopping_list;
CREATE POLICY "Authorized meal crew manage shared shopping"
    ON public.shopping_list FOR ALL TO authenticated
    USING (
        voyage_id IS NOT NULL
        AND public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    )
    WITH CHECK (
        voyage_id IS NOT NULL
        AND public.can_access_passage(
            user_id,
            voyage_id,
            'can_view_passage_meals'
        )
    );

DROP POLICY IF EXISTS "watch_assignments_crew_read"
    ON public.watch_assignments;
CREATE POLICY "watch_assignments_crew_read"
    ON public.watch_assignments FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.voyages AS voyage
            WHERE voyage.id::TEXT = watch_assignments.voyage_id
              AND public.can_access_passage(
                  voyage.user_id,
                  voyage.id,
                  'can_view_passage_checklist'
              )
        )
    );

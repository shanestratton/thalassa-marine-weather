-- Close manifest-code enumeration, constrain crew self-service, and restore
-- register sharing without the destructive legacy crew_sharing.sql replay.

-- Per-voyage crew membership was added after the original two-column unique
-- constraint. Use PostgreSQL 15's NULLS NOT DISTINCT so both global and
-- voyage-scoped memberships have a single conflict target.
ALTER TABLE public.vessel_crew
    DROP CONSTRAINT IF EXISTS vessel_crew_owner_id_crew_user_id_key;
ALTER TABLE public.vessel_crew
    DROP CONSTRAINT IF EXISTS vessel_crew_scope_unique;
ALTER TABLE public.vessel_crew
    ADD CONSTRAINT vessel_crew_scope_unique
    UNIQUE NULLS NOT DISTINCT (owner_id, crew_user_id, voyage_id);

UPDATE public.vessel_crew
SET role = 'deckhand'
WHERE role = 'crew';
ALTER TABLE public.vessel_crew
    ALTER COLUMN role SET DEFAULT 'deckhand';
ALTER TABLE public.vessel_crew
    DROP CONSTRAINT IF EXISTS vessel_crew_role_check;
ALTER TABLE public.vessel_crew
    ADD CONSTRAINT vessel_crew_role_check
    CHECK (role IN ('co-skipper', 'navigator', 'deckhand', 'punter'));

CREATE OR REPLACE FUNCTION public.guard_vessel_crew_member_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    -- Captains manage their own rows. Crew may only answer a pending invite;
    -- they cannot promote themselves or alter permissions/ownership.
    IF auth.uid() = OLD.crew_user_id AND auth.uid() <> OLD.owner_id THEN
        IF OLD.status <> 'pending'
           OR NEW.status NOT IN ('accepted', 'declined')
           OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
           OR NEW.crew_user_id IS DISTINCT FROM OLD.crew_user_id
           OR NEW.crew_email IS DISTINCT FROM OLD.crew_email
           OR NEW.owner_email IS DISTINCT FROM OLD.owner_email
           OR NEW.shared_registers IS DISTINCT FROM OLD.shared_registers
           OR NEW.permissions IS DISTINCT FROM OLD.permissions
           OR NEW.role IS DISTINCT FROM OLD.role
           OR NEW.voyage_id IS DISTINCT FROM OLD.voyage_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'Crew members may only accept or decline a pending invite';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_vessel_crew_member_update
    ON public.vessel_crew;
CREATE TRIGGER trg_guard_vessel_crew_member_update
    BEFORE UPDATE ON public.vessel_crew
    FOR EACH ROW EXECUTE FUNCTION public.guard_vessel_crew_member_update();

DROP POLICY IF EXISTS "owner_manage_crew" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_see_invites" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_respond_invite" ON public.vessel_crew;
DROP POLICY IF EXISTS "Owners can manage their crew" ON public.vessel_crew;
DROP POLICY IF EXISTS "Crew can view own membership" ON public.vessel_crew;
DROP POLICY IF EXISTS "Crew can update own membership" ON public.vessel_crew;
DROP POLICY IF EXISTS "Crew can leave vessel" ON public.vessel_crew;

CREATE POLICY "Owners can manage their crew"
    ON public.vessel_crew FOR ALL TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Crew can view own membership"
    ON public.vessel_crew FOR SELECT TO authenticated
    USING (crew_user_id = auth.uid());
CREATE POLICY "Crew can update own membership"
    ON public.vessel_crew FOR UPDATE TO authenticated
    USING (crew_user_id = auth.uid() AND status = 'pending')
    WITH CHECK (
        crew_user_id = auth.uid()
        AND status IN ('accepted', 'declined')
    );
CREATE POLICY "Crew can leave vessel"
    ON public.vessel_crew FOR DELETE TO authenticated
    USING (crew_user_id = auth.uid());

-- Exact email lookup is useful for captain invites, but it must not be a free
-- auth-directory search endpoint.
CREATE OR REPLACE FUNCTION public.lookup_user_by_email(lookup_email TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    found_user RECORD;
    caller_email TEXT;
    normalized_email TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('found', false, 'reason', 'authentication');
    END IF;
    IF NOT public.consume_edge_quota('crew_lookup', 30, 3600) THEN
        RETURN json_build_object('found', false, 'reason', 'rate_limit');
    END IF;

    normalized_email := lower(trim(lookup_email));
    IF normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR char_length(normalized_email) > 254 THEN
        RETURN json_build_object('found', false, 'reason', 'invalid');
    END IF;

    SELECT lower(email) INTO caller_email
    FROM auth.users
    WHERE id = auth.uid();
    IF caller_email = normalized_email THEN
        RETURN json_build_object('found', false, 'reason', 'self');
    END IF;

    SELECT id, lower(email) AS email INTO found_user
    FROM auth.users
    WHERE lower(email) = normalized_email
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN json_build_object('found', false);
    END IF;

    RETURN json_build_object(
        'found', true,
        'user_id', found_user.id,
        'email', found_user.email
    );
END;
$$;
REVOKE ALL ON FUNCTION public.lookup_user_by_email(TEXT)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_user_by_email(TEXT)
    TO authenticated;

-- Manifest rows and their bearer codes are visible only to their creator.
DROP POLICY IF EXISTS "Owner full access to manifest_invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Auth users can read pending invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Auth users can accept invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Manifest owners read invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Manifest owners create invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Manifest owners update invites"
    ON public.manifest_invites;
DROP POLICY IF EXISTS "Manifest owners delete invites"
    ON public.manifest_invites;

CREATE POLICY "Manifest owners read invites"
    ON public.manifest_invites FOR SELECT TO authenticated
    USING (owner_id = auth.uid());
CREATE POLICY "Manifest owners create invites"
    ON public.manifest_invites FOR INSERT TO authenticated
    WITH CHECK (
        owner_id = auth.uid()
        AND status = 'pending'
        AND accepted_by IS NULL
        AND accepted_at IS NULL
        AND device_id IS NULL
    );
CREATE POLICY "Manifest owners update invites"
    ON public.manifest_invites FOR UPDATE TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());
CREATE POLICY "Manifest owners delete invites"
    ON public.manifest_invites FOR DELETE TO authenticated
    USING (owner_id = auth.uid());

CREATE OR REPLACE FUNCTION public.redeem_manifest_invite(
    p_code TEXT,
    p_device_id TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    invite public.manifest_invites%ROWTYPE;
    caller_email TEXT;
    caller_id UUID := auth.uid();
    owner_email_value TEXT;
    vessel_name_value TEXT;
    register_values TEXT[];
BEGIN
    IF caller_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Not authenticated');
    END IF;
    IF NOT public.consume_edge_quota('manifest_redeem', 20, 3600) THEN
        RETURN json_build_object('success', false, 'error', 'Too many attempts; try again later');
    END IF;
    IF upper(trim(p_code)) !~ '^[A-HJ-NP-Z]{2}-[0-9]{4}$'
       OR p_device_id IS NULL
       OR char_length(p_device_id) NOT BETWEEN 16 AND 160 THEN
        RETURN json_build_object('success', false, 'error', 'Invalid or expired code');
    END IF;

    SELECT * INTO invite
    FROM public.manifest_invites
    WHERE invite_code = upper(trim(p_code))
      AND status = 'pending'
      AND expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Invalid or expired code');
    END IF;
    IF invite.owner_id = caller_id THEN
        RETURN json_build_object('success', false, 'error', 'You cannot redeem your own code');
    END IF;

    SELECT lower(email) INTO caller_email
    FROM auth.users
    WHERE id = caller_id;
    IF invite.email IS NOT NULL
       AND lower(trim(invite.email)) <> caller_email THEN
        RETURN json_build_object(
            'success', false,
            'error', 'This code is reserved for a different email'
        );
    END IF;

    SELECT email INTO owner_email_value
    FROM auth.users
    WHERE id = invite.owner_id;
    SELECT vessel_name INTO vessel_name_value
    FROM public.vessel_identity
    WHERE owner_id = invite.owner_id;

    register_values := ARRAY(
        SELECT value
        FROM unnest(ARRAY[
            CASE WHEN coalesce((invite.permissions->>'can_view_stores')::boolean, false)
                       OR coalesce((invite.permissions->>'can_edit_stores')::boolean, false)
                 THEN 'stores' END,
            CASE WHEN coalesce((invite.permissions->>'can_view_galley')::boolean, false)
                 THEN 'galley' END,
            CASE WHEN coalesce((invite.permissions->>'can_view_passage_meals')::boolean, false)
                 THEN 'passage_meals' END,
            CASE WHEN coalesce((invite.permissions->>'can_view_passage_chat')::boolean, false)
                 THEN 'passage_chat' END,
            CASE WHEN coalesce((invite.permissions->>'can_view_passage_route')::boolean, false)
                 THEN 'passage_route' END,
            CASE WHEN coalesce((invite.permissions->>'can_view_passage_checklist')::boolean, false)
                 THEN 'passage_checklist' END
        ]) AS allowed(value)
        WHERE value IS NOT NULL
    );

    INSERT INTO public.vessel_crew(
        owner_id, crew_user_id, crew_email, owner_email,
        shared_registers, permissions, status, role, voyage_id
    )
    VALUES (
        invite.owner_id, caller_id, coalesce(caller_email, ''),
        coalesce(owner_email_value, ''), register_values,
        invite.permissions, 'accepted', invite.role, NULL
    )
    ON CONFLICT (owner_id, crew_user_id, voyage_id)
    DO UPDATE SET
        status = 'accepted',
        updated_at = now()
    WHERE public.vessel_crew.status = 'pending';

    UPDATE public.manifest_invites
    SET status = 'accepted',
        accepted_by = caller_id,
        accepted_at = now(),
        device_id = p_device_id
    WHERE id = invite.id;

    RETURN json_build_object(
        'success', true,
        'vessel_name', coalesce(vessel_name_value, 'Vessel')
    );
END;
$$;
REVOKE ALL ON FUNCTION public.redeem_manifest_invite(TEXT, TEXT)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_manifest_invite(TEXT, TEXT)
    TO authenticated;

-- Centralized, non-recursive register check for the five vessel tables.
CREATE OR REPLACE FUNCTION public.can_access_vessel_register(
    p_owner_id UUID,
    p_register TEXT,
    p_write BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT p_owner_id = auth.uid()
       OR EXISTS (
            SELECT 1
            FROM public.vessel_crew AS membership
            WHERE membership.owner_id = p_owner_id
              AND membership.crew_user_id = auth.uid()
              AND membership.status = 'accepted'
              AND (
                  p_register = ANY(membership.shared_registers)
                  OR (
                      p_register = 'stores'
                      AND CASE
                          WHEN p_write THEN coalesce(
                              (membership.permissions->>'can_edit_stores')::boolean,
                              false
                          )
                          ELSE coalesce(
                              (membership.permissions->>'can_view_stores')::boolean,
                              false
                          ) OR coalesce(
                              (membership.permissions->>'can_edit_stores')::boolean,
                              false
                          )
                      END
                  )
              )
       );
$$;
REVOKE ALL ON FUNCTION public.can_access_vessel_register(UUID, TEXT, BOOLEAN)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_vessel_register(UUID, TEXT, BOOLEAN)
    TO authenticated;

CREATE OR REPLACE FUNCTION public.crew_rewrite_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    captain_id UUID;
    captain_count INTEGER;
    register_name TEXT := TG_ARGV[0];
BEGIN
    IF auth.uid() IS NULL OR NEW.user_id <> auth.uid() THEN
        RETURN NEW;
    END IF;

    SELECT min(owner_id::text)::uuid, count(DISTINCT owner_id)
    INTO captain_id, captain_count
    FROM public.vessel_crew
    WHERE crew_user_id = auth.uid()
      AND status = 'accepted'
      AND public.can_access_vessel_register(owner_id, register_name, true);

    IF captain_count = 1 THEN
        NEW.user_id := captain_id;
    ELSIF captain_count > 1 THEN
        RAISE EXCEPTION 'Select a vessel before editing a shared register';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crew_rewrite_inventory ON public.inventory_items;
CREATE TRIGGER trg_crew_rewrite_inventory
    BEFORE INSERT ON public.inventory_items
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('stores');
DROP TRIGGER IF EXISTS trg_crew_rewrite_equipment ON public.equipment_register;
CREATE TRIGGER trg_crew_rewrite_equipment
    BEFORE INSERT ON public.equipment_register
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('equipment');
DROP TRIGGER IF EXISTS trg_crew_rewrite_maintenance_tasks ON public.maintenance_tasks;
CREATE TRIGGER trg_crew_rewrite_maintenance_tasks
    BEFORE INSERT ON public.maintenance_tasks
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('maintenance');
DROP TRIGGER IF EXISTS trg_crew_rewrite_maintenance_history ON public.maintenance_history;
CREATE TRIGGER trg_crew_rewrite_maintenance_history
    BEFORE INSERT ON public.maintenance_history
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('maintenance');
DROP TRIGGER IF EXISTS trg_crew_rewrite_documents ON public.ship_documents;
CREATE TRIGGER trg_crew_rewrite_documents
    BEFORE INSERT ON public.ship_documents
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('documents');

-- Replace both the canonical owner policies and any manually-applied legacy
-- policies with the final register-aware rules.
DROP POLICY IF EXISTS "Users can view own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can insert own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can update own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can delete own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "owner_or_crew_select" ON public.inventory_items;
DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.inventory_items;
DROP POLICY IF EXISTS "owner_or_crew_update" ON public.inventory_items;
DROP POLICY IF EXISTS "owner_only_delete" ON public.inventory_items;
CREATE POLICY "Register members read inventory"
    ON public.inventory_items FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'stores', false));
CREATE POLICY "Register editors create inventory"
    ON public.inventory_items FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'stores', true));
CREATE POLICY "Register editors update inventory"
    ON public.inventory_items FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'stores', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'stores', true));
CREATE POLICY "Inventory owners delete"
    ON public.inventory_items FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own equipment" ON public.equipment_register;
DROP POLICY IF EXISTS "Users can create own equipment" ON public.equipment_register;
DROP POLICY IF EXISTS "Users can update own equipment" ON public.equipment_register;
DROP POLICY IF EXISTS "Users can delete own equipment" ON public.equipment_register;
DROP POLICY IF EXISTS "owner_or_crew_select" ON public.equipment_register;
DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.equipment_register;
DROP POLICY IF EXISTS "owner_or_crew_update" ON public.equipment_register;
DROP POLICY IF EXISTS "owner_only_delete" ON public.equipment_register;
CREATE POLICY "Register members read equipment"
    ON public.equipment_register FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'equipment', false));
CREATE POLICY "Register editors create equipment"
    ON public.equipment_register FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'equipment', true));
CREATE POLICY "Register editors update equipment"
    ON public.equipment_register FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'equipment', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'equipment', true));
CREATE POLICY "Equipment owners delete"
    ON public.equipment_register FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can create own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can update own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can delete own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "owner_or_crew_select" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "owner_or_crew_update" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "owner_only_delete" ON public.maintenance_tasks;
CREATE POLICY "Register members read maintenance tasks"
    ON public.maintenance_tasks FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', false));
CREATE POLICY "Register editors create maintenance tasks"
    ON public.maintenance_tasks FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));
CREATE POLICY "Register editors update maintenance tasks"
    ON public.maintenance_tasks FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));
CREATE POLICY "Maintenance task owners delete"
    ON public.maintenance_tasks FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own history" ON public.maintenance_history;
DROP POLICY IF EXISTS "Users can log own history" ON public.maintenance_history;
DROP POLICY IF EXISTS "Users can delete own history" ON public.maintenance_history;
DROP POLICY IF EXISTS "owner_or_crew_select" ON public.maintenance_history;
DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.maintenance_history;
DROP POLICY IF EXISTS "owner_or_crew_update" ON public.maintenance_history;
DROP POLICY IF EXISTS "owner_only_delete" ON public.maintenance_history;
CREATE POLICY "Register members read maintenance history"
    ON public.maintenance_history FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', false));
CREATE POLICY "Register editors create maintenance history"
    ON public.maintenance_history FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));
CREATE POLICY "Register editors update maintenance history"
    ON public.maintenance_history FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'maintenance', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'maintenance', true));
CREATE POLICY "Maintenance history owners delete"
    ON public.maintenance_history FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own documents" ON public.ship_documents;
DROP POLICY IF EXISTS "Users can create own documents" ON public.ship_documents;
DROP POLICY IF EXISTS "Users can update own documents" ON public.ship_documents;
DROP POLICY IF EXISTS "Users can delete own documents" ON public.ship_documents;
DROP POLICY IF EXISTS "owner_or_crew_select" ON public.ship_documents;
DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.ship_documents;
DROP POLICY IF EXISTS "owner_or_crew_update" ON public.ship_documents;
DROP POLICY IF EXISTS "owner_only_delete" ON public.ship_documents;
CREATE POLICY "Register members read documents"
    ON public.ship_documents FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'documents', false));
CREATE POLICY "Register editors create documents"
    ON public.ship_documents FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'documents', true));
CREATE POLICY "Register editors update documents"
    ON public.ship_documents FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'documents', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'documents', true));
CREATE POLICY "Document owners delete"
    ON public.ship_documents FOR DELETE TO authenticated
    USING (user_id = auth.uid());

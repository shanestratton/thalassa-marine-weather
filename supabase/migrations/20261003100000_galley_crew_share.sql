-- The Galley can be shared with crew (Shane, 2026-10-03: "can we share the
-- galley as well with invitees (as an option)").
--
-- The crew access form has always offered a Galley register, and an invite or
-- crew code can carry it (vessel_crew.shared_registers 'galley',
-- can_access_vessel_register's ELSE branch: read = write = ticked), but no
-- galley table consulted it, so ticking Galley gave the crew member nothing.
-- With this, an accepted crew member the skipper shares the Galley with sees
-- and uses the SKIPPER's galley in place of their own, as with the shared
-- binders (services/vessel/sharedBinders.ts, register 'galley'):
--
--   - recipes: crew read the skipper's library, and may ADD a recipe to it,
--     personal only (sharing a recipe with every sailor is the skipper's
--     call). Editing and deleting a recipe stay the owner's: a recipe's photo
--     and its community copy are tied to the owner's account.
--   - meal_plans and shopping_list rows with NO passage (voyage_id IS NULL)
--     are the galley's: crew read, add, change and delete them, as the
--     passage Meal Planner share already lets crew do with a passage's rows
--     (20260723104000). Rows with a voyage_id keep the passage rules.
--   - passage_provisions belong to the passage Meal Planner and are untouched.
--   - community_recipes (the public Captain's Table) are untouched.
--
-- No crew_rewrite_user_id trigger: the app stamps the skipper's id on a crew
-- add itself (galleyShareOwner), and a crew member's own galley is never
-- written while a skipper's is shared. A crew member may not hand a skipper's
-- meal plan or grocery item to another owner, nor move it into their own
-- passage (guard_galley_row_owner below).
--
-- Ticking a grocery item bought adds a receipt to Ship's Stores in the same
-- commit, and that needs Stores edit permission (42501 otherwise). The
-- decided rule: a galley action works for crew the galley is shared with,
-- and the Stores part is skipped where Stores is not theirs to edit, never an
-- error and never a stores row in the crew member's own binder. So on the
-- galley's own list (no passage) such a tick records the purchase and leaves
-- Ship's Stores as it is; a passage list keeps its rule. The function below is
-- the live body (identical to 20260723104300's on 2026-10-03) with that one
-- branch added.
--
-- galley_share_ready() is how the app knows this is on the server. Until it
-- answers, a ticked Galley shares nothing in the app either, the galley
-- tables are not swept, and no realtime channel opens for recipes or meal
-- plans: the app behaves exactly as before this was pushed.
--
-- Realtime: recipes and meal_plans join supabase_realtime (shopping_list is
-- already published), guarded like 20261002150000 so a replay is a no-op.
-- Realtime applies RLS to INSERT and UPDATE per subscriber; a DELETE reaches
-- every subscriber of the table as its primary key alone (a random UUID).
--
-- Nobody shares a galley they did not tick. Until now 'galley' in
-- shared_registers did nothing, and since the role picker (2026-09-08) every
-- crew code minted for a co-skipper, navigator or deckhand has carried
-- can_view_galley true from the role preset, which redeem_manifest_invite
-- turned into 'galley'. So the first step below clears that from every crew
-- row and pending code, except a tick this build made (share_galley, written
-- only from the Galley tick), and the redeem now reads share_galley, so a code
-- an older build mints never shares a galley. No deliberate share is lost:
-- none ever did anything. A skipper who wants one ticks Galley again.
--
-- PUSH ORDER: app before database, as with the Pi. Push this only once the
-- build that carries the galley share is what crew are running. The policies
-- send the skipper's recipes, meals and grocery list to every galley crew
-- device; an older build mixes them into the crew member's own galley, lets
-- them cook or complete his meals, and queues Stores writes RLS refuses.
--
-- Not pushed with this commit: Shane says yes first.

-- ── Nobody shares a galley they did not tick ───────────────────────────────

-- Rows of an account being deleted are write-fenced
-- (block_tombstoned_account_write, 20260806120000): they are left alone, so
-- one such row cannot fail the whole migration. Flags are compared as text so
-- an odd value is skipped, never a cast error.
UPDATE public.vessel_crew AS membership
SET shared_registers = array_remove(coalesce(membership.shared_registers, '{}'::text[]), 'galley'),
    permissions = coalesce(membership.permissions, '{}'::jsonb)
        || '{"can_view_galley": false, "share_galley": false}'::jsonb
WHERE (
        'galley' = ANY(coalesce(membership.shared_registers, '{}'::text[]))
        OR (membership.permissions->>'can_view_galley') = 'true'
        OR (membership.permissions->>'share_galley') = 'true'
    )
  AND NOT (
        'galley' = ANY(coalesce(membership.shared_registers, '{}'::text[]))
        AND (membership.permissions->>'share_galley') = 'true'
    )
  AND NOT EXISTS (
        SELECT 1
        FROM public.account_deletion_jobs AS job
        WHERE job.user_id IN (membership.owner_id, membership.crew_user_id)
    );

UPDATE public.manifest_invites AS invite
SET permissions = coalesce(invite.permissions, '{}'::jsonb) || '{"can_view_galley": false}'::jsonb
WHERE invite.status = 'pending'
  AND (invite.permissions->>'can_view_galley') = 'true'
  AND (invite.permissions->>'share_galley') IS DISTINCT FROM 'true'
  AND NOT EXISTS (
        SELECT 1
        FROM public.account_deletion_jobs AS job
        WHERE job.user_id IN (invite.owner_id, invite.accepted_by)
    );

-- The redeem, word for word as 20260723100000 (the live body on 2026-10-03),
-- except that 'galley' comes from share_galley, which only a Galley tick
-- writes (services/CrewService.ts syncPassagePermissions), and the new crew
-- row's two galley flags say what its registers say.
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
            CASE WHEN coalesce((invite.permissions->>'share_galley')::boolean, false)
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
        invite.permissions || jsonb_build_object(
            'can_view_galley', 'galley' = ANY(register_values),
            'share_galley', 'galley' = ANY(register_values)
        ),
        'accepted', invite.role, NULL
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

-- ── recipes ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Galley crew read recipes" ON public.recipes;
CREATE POLICY "Galley crew read recipes"
    ON public.recipes FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'galley', false));

DROP POLICY IF EXISTS "Galley crew add recipes" ON public.recipes;
CREATE POLICY "Galley crew add recipes"
    ON public.recipes FOR INSERT TO authenticated
    WITH CHECK (
        user_id <> auth.uid()
        AND visibility = 'personal'
        AND public.can_access_vessel_register(user_id, 'galley', true)
    );

-- ── meal_plans (no passage) ────────────────────────────────────────────────

DROP POLICY IF EXISTS "Galley crew read meal plans" ON public.meal_plans;
CREATE POLICY "Galley crew read meal plans"
    ON public.meal_plans FOR SELECT TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', false));

DROP POLICY IF EXISTS "Galley crew add meal plans" ON public.meal_plans;
CREATE POLICY "Galley crew add meal plans"
    ON public.meal_plans FOR INSERT TO authenticated
    WITH CHECK (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

DROP POLICY IF EXISTS "Galley crew update meal plans" ON public.meal_plans;
CREATE POLICY "Galley crew update meal plans"
    ON public.meal_plans FOR UPDATE TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true))
    WITH CHECK (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

DROP POLICY IF EXISTS "Galley crew delete meal plans" ON public.meal_plans;
CREATE POLICY "Galley crew delete meal plans"
    ON public.meal_plans FOR DELETE TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

-- RLS checks the NEW owner only, so crew who may edit a skipper's galley
-- could otherwise hand his meal plan or grocery item to someone else, or move
-- it into their own passage (the passage owner rewrite then makes it theirs).
-- Only the owner moves a galley row to another owner. The triggers are named
-- to fire AFTER every other BEFORE trigger on the table (they fire in name
-- order), so they see the owner the rewrite settled on. No signed-in caller
-- (an operator's repair) is not crew and is let through; the rewrite
-- triggers already refuse an unauthenticated write from the app.
CREATE OR REPLACE FUNCTION public.guard_galley_row_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.uid() IS NOT NULL
       AND OLD.voyage_id IS NULL
       AND NEW.user_id IS DISTINCT FROM OLD.user_id
       AND OLD.user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Only the skipper can move a galley item to another owner'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_galley_row_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_zz_guard_galley_meal_plan_owner ON public.meal_plans;
CREATE TRIGGER trg_zz_guard_galley_meal_plan_owner
    BEFORE UPDATE ON public.meal_plans
    FOR EACH ROW EXECUTE FUNCTION public.guard_galley_row_owner();

-- ── shopping_list (no passage) ─────────────────────────────────────────────

DROP POLICY IF EXISTS "Galley crew read shopping" ON public.shopping_list;
CREATE POLICY "Galley crew read shopping"
    ON public.shopping_list FOR SELECT TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', false));

DROP POLICY IF EXISTS "Galley crew add shopping" ON public.shopping_list;
CREATE POLICY "Galley crew add shopping"
    ON public.shopping_list FOR INSERT TO authenticated
    WITH CHECK (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

DROP POLICY IF EXISTS "Galley crew update shopping" ON public.shopping_list;
CREATE POLICY "Galley crew update shopping"
    ON public.shopping_list FOR UPDATE TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true))
    WITH CHECK (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

DROP POLICY IF EXISTS "Galley crew delete shopping" ON public.shopping_list;
CREATE POLICY "Galley crew delete shopping"
    ON public.shopping_list FOR DELETE TO authenticated
    USING (voyage_id IS NULL AND public.can_access_vessel_register(user_id, 'galley', true));

DROP TRIGGER IF EXISTS trg_zz_guard_galley_shopping_owner ON public.shopping_list;
CREATE TRIGGER trg_zz_guard_galley_shopping_owner
    BEFORE UPDATE ON public.shopping_list
    FOR EACH ROW EXECUTE FUNCTION public.guard_galley_row_owner();

-- ── Ticking bought without the Stores share ────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_grocery_purchase_inventory()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    receipt public.inventory_items%ROWTYPE;
    prior_operation public.grocery_purchase_operations%ROWTYPE;
    receipt_quantity NUMERIC;
    receipt_unit TEXT;
    shopping_owner UUID := OLD.user_id;
    receipt_provenance TEXT := 'Added from Grocery List purchase ' || NEW.id::TEXT;
    reversed_provenance TEXT := 'Stock retained after undoing Grocery List purchase ' || NEW.id::TEXT;
    receipt_unit_value NUMERIC;
    purchase_sensitive_changed BOOLEAN;
    purchase_integrity_changed BOOLEAN;
    -- A shared galley's tick by crew who may not edit the skipper's Stores
    -- (20261003100000): the purchase is recorded, Ship's Stores is left alone.
    galley_only BOOLEAN := false;
BEGIN
    -- The existing shopping row is the authoritative owner. This trigger runs
    -- before the generic owner-rewrite trigger, so NEW.user_id is not trusted.
    NEW.user_id := shopping_owner;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '28000';
    END IF;

    purchase_integrity_changed :=
        NEW.purchased IS DISTINCT FROM OLD.purchased
        OR NEW.purchased_at IS DISTINCT FROM OLD.purchased_at
        OR NEW.purchased_quantity IS DISTINCT FROM OLD.purchased_quantity
        OR NEW.purchased_unit IS DISTINCT FROM OLD.purchased_unit
        OR NEW.purchase_revision IS DISTINCT FROM OLD.purchase_revision
        OR NEW.purchase_operation_id IS DISTINCT FROM OLD.purchase_operation_id;
    purchase_sensitive_changed :=
        purchase_integrity_changed
        OR (
            (OLD.purchased OR NEW.purchased)
            AND (
                NEW.actual_cost IS DISTINCT FROM OLD.actual_cost
                OR NEW.currency IS DISTINCT FROM OLD.currency
                OR NEW.purchase_retailer IS DISTINCT FROM OLD.purchase_retailer
                OR NEW.store_location IS DISTINCT FROM OLD.store_location
                OR NEW.notes IS DISTINCT FROM OLD.notes
            )
        );

    IF purchase_sensitive_changed
       AND NOT public.can_access_vessel_register(shopping_owner, 'stores', true) THEN
        -- The galley's own grocery list (no passage), shared with this crew
        -- member, may be ticked without the Stores share: no receipt then.
        -- A passage list keeps the rule it had, and so does a legacy client
        -- with no operation key: it queues its own Stores writes, so a tick
        -- or untick from it goes the old way.
        IF OLD.voyage_id IS NULL
           AND NEW.voyage_id IS NULL
           AND (NEW.purchase_operation_id IS NOT NULL
                OR NEW.purchased IS NOT DISTINCT FROM OLD.purchased)
           AND public.can_access_vessel_register(shopping_owner, 'galley', true) THEN
            galley_only := true;
        ELSE
            RAISE EXCEPTION 'Ship''s Stores edit permission is required'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.purchase_operation_id IS NOT NULL THEN
        SELECT *
        INTO prior_operation
        FROM public.grocery_purchase_operations
        WHERE operation_id = NEW.purchase_operation_id;

        IF FOUND THEN
            IF prior_operation.shopping_item_id IS DISTINCT FROM NEW.id
               OR prior_operation.actor_id IS DISTINCT FROM auth.uid()
               OR prior_operation.target_purchased IS DISTINCT FROM NEW.purchased
               OR prior_operation.resulting_revision IS DISTINCT FROM NEW.purchase_revision THEN
                RAISE EXCEPTION 'Purchase operation ID was reused for another transition'
                    USING ERRCODE = '22023';
            END IF;

            -- A response can be lost after commit. If another device has since
            -- undone/repurchased, replaying this old operation must preserve the
            -- newer row and inventory state.
            RETURN OLD;
        END IF;
    END IF;

    -- Once a receipt exists, the identity fields used to validate/reverse it
    -- are immutable. Undo the purchase before changing the item or voyage.
    IF (OLD.purchased OR NEW.purchased)
       AND (
           NEW.id IS DISTINCT FROM OLD.id
           OR NEW.voyage_id IS DISTINCT FROM OLD.voyage_id
           OR NEW.ingredient_name IS DISTINCT FROM OLD.ingredient_name
           OR NEW.unit IS DISTINCT FROM OLD.unit
       ) THEN
        RAISE EXCEPTION 'Undo the grocery purchase before changing its identity or voyage'
            USING ERRCODE = '23514';
    END IF;

    -- Older clients independently queued their inventory receipt and carry no
    -- operation key. Preserve their authorized shopping write without also
    -- applying this trigger, avoiding a mixed-version double insert.
    IF NEW.purchase_operation_id IS NULL THEN
        -- Metadata such as an authorized price correction remains editable,
        -- but receipt/revision fields cannot be rewritten behind the ledger
        -- unless this is the legacy purchased-state transition itself.
        IF NEW.purchased IS NOT DISTINCT FROM OLD.purchased
           AND purchase_integrity_changed THEN
            RAISE EXCEPTION 'Purchase receipt fields require a revisioned transition'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.purchase_revision IS DISTINCT FROM OLD.purchase_revision THEN
            RAISE EXCEPTION 'Legacy purchase transitions cannot change the purchase revision'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- Optimistic revision fencing prevents a previously unseen offline
    -- operation from overwriting a newer transition made on another device.
    IF NEW.purchase_revision IS DISTINCT FROM OLD.purchase_revision + 1
       OR NEW.purchased IS NOT DISTINCT FROM OLD.purchased THEN
        RETURN OLD;
    END IF;

    IF galley_only THEN
        -- A purchase that put stock in Ship's Stores is undone only by someone
        -- who may take it back out. Left behind, the receipt would be adopted
        -- by the next tick, or refuse it for good once some was eaten.
        IF OLD.purchased
           AND NOT NEW.purchased
           AND EXISTS (
               SELECT 1
               FROM public.inventory_items
               WHERE id = OLD.id
                 AND description = receipt_provenance
           ) THEN
            RAISE EXCEPTION 'Only someone who can edit Ship''s Stores can undo this purchase'
                USING ERRCODE = '42501';
        END IF;
        -- No Stores receipt to add or reverse: only validate a purchase.
        IF NEW.purchased
           AND (NEW.purchased_quantity IS NULL
                OR NEW.purchased_quantity <= 0
                OR NEW.purchased_quantity::TEXT IN ('NaN', 'Infinity', '-Infinity')
                OR NEW.purchased_unit IS NULL
                OR trim(NEW.purchased_unit) = ''
                OR NEW.purchased_at IS NULL) THEN
            RAISE EXCEPTION 'A purchased item requires an exact quantity, unit, and purchase time'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.purchased THEN
        receipt_quantity := NEW.purchased_quantity;
        receipt_unit := trim(NEW.purchased_unit);

        IF receipt_quantity IS NULL
           OR receipt_quantity <= 0
           OR receipt_quantity::TEXT IN ('NaN', 'Infinity', '-Infinity')
           OR receipt_unit IS NULL
           OR receipt_unit = ''
           OR NEW.purchased_at IS NULL THEN
            RAISE EXCEPTION 'A purchased item requires an exact quantity, unit, and purchase time'
                USING ERRCODE = '23514';
        END IF;

        receipt_unit_value := CASE
            WHEN NEW.actual_cost IS NULL THEN 0
            ELSE NEW.actual_cost / receipt_quantity
        END;

        SELECT *
        INTO receipt
        FROM public.inventory_items
        WHERE id = NEW.id
        FOR UPDATE;

        IF NOT FOUND THEN
            INSERT INTO public.inventory_items(
                id,
                user_id,
                item_name,
                description,
                category,
                quantity,
                min_quantity,
                unit,
                currency,
                unit_value,
                location_zone,
                location_specific
            )
            VALUES (
                NEW.id,
                shopping_owner,
                NEW.ingredient_name,
                receipt_provenance,
                'Provisions',
                receipt_quantity,
                0,
                receipt_unit,
                NEW.currency,
                receipt_unit_value,
                coalesce(nullif(trim(NEW.store_location), ''), 'Galley'),
                ''
            );
        ELSE
            IF receipt.user_id IS DISTINCT FROM shopping_owner
               OR lower(trim(receipt.item_name)) IS DISTINCT FROM lower(trim(NEW.ingredient_name))
               OR lower(trim(receipt.unit)) IS DISTINCT FROM lower(receipt_unit) THEN
                RAISE EXCEPTION 'The grocery receipt ID belongs to another stores item'
                    USING ERRCODE = '23505';
            END IF;

            IF receipt.description = reversed_provenance THEN
                UPDATE public.inventory_items
                SET quantity = receipt.quantity + receipt_quantity,
                    description = receipt_provenance,
                    category = 'Provisions',
                    min_quantity = 0,
                    currency = NEW.currency,
                    unit_value = receipt_unit_value,
                    location_zone = coalesce(
                        nullif(trim(receipt.location_zone), ''),
                        nullif(trim(NEW.store_location), ''),
                        'Galley'
                    )
                WHERE id = NEW.id;
            ELSIF receipt.description = receipt_provenance THEN
                -- A pre-trigger client may already have inserted this exact
                -- deterministic receipt. Adopt it without adding stock twice.
                IF receipt.quantity < receipt_quantity THEN
                    RAISE EXCEPTION 'The existing grocery receipt has an invalid quantity'
                        USING ERRCODE = '23514';
                END IF;
                UPDATE public.inventory_items
                SET category = 'Provisions',
                    min_quantity = 0,
                    currency = NEW.currency,
                    unit_value = receipt_unit_value,
                    location_zone = coalesce(
                        nullif(trim(receipt.location_zone), ''),
                        nullif(trim(NEW.store_location), ''),
                        'Galley'
                    )
                WHERE id = NEW.id;
            ELSE
                RAISE EXCEPTION 'The grocery receipt ID belongs to another stores item'
                    USING ERRCODE = '23505';
            END IF;
        END IF;
    ELSE
        -- Legacy purchases without an exact receipt deliberately remain
        -- untouched: guessing a package conversion here could delete unrelated
        -- stock. New purchases always carry these fields.
        receipt_quantity := OLD.purchased_quantity;
        receipt_unit := trim(OLD.purchased_unit);
        IF receipt_quantity IS NOT NULL
           AND receipt_quantity > 0
           AND receipt_unit IS NOT NULL
           AND receipt_unit <> '' THEN
            SELECT *
            INTO receipt
            FROM public.inventory_items
            WHERE id = OLD.id
            FOR UPDATE;

            IF FOUND AND receipt.description IS DISTINCT FROM reversed_provenance THEN
                IF receipt.user_id IS DISTINCT FROM shopping_owner
                   OR receipt.description IS DISTINCT FROM receipt_provenance
                   OR lower(trim(receipt.item_name)) IS DISTINCT FROM lower(trim(OLD.ingredient_name))
                   OR lower(trim(receipt.unit)) IS DISTINCT FROM lower(receipt_unit) THEN
                    RAISE EXCEPTION 'The grocery receipt no longer matches this purchase'
                        USING ERRCODE = '23514';
                END IF;

                IF receipt.quantity <= receipt_quantity THEN
                    DELETE FROM public.inventory_items
                    WHERE id = OLD.id;
                ELSE
                    UPDATE public.inventory_items
                    SET quantity = receipt.quantity - receipt_quantity,
                        description = reversed_provenance
                    WHERE id = OLD.id;
                END IF;
            END IF;
        END IF;
    END IF;

    INSERT INTO public.grocery_purchase_operations(
        operation_id,
        shopping_item_id,
        actor_id,
        target_purchased,
        resulting_revision
    )
    VALUES (
        NEW.purchase_operation_id,
        NEW.id,
        auth.uid(),
        NEW.purchased,
        NEW.purchase_revision
    );

    -- The durable operation ledger owns idempotency. Clearing the transient
    -- key from the row lets authorized older clients continue to update it;
    -- a timed-out new client still retries with its original payload/key and
    -- is recognized by the ledger above.
    NEW.purchase_operation_id := NULL;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_grocery_purchase_inventory()
    FROM PUBLIC, anon, authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

DO $$
DECLARE
    galley_table TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        RETURN;
    END IF;

    FOREACH galley_table IN ARRAY ARRAY[
        'recipes',
        'meal_plans',
        'shopping_list'
    ]
    LOOP
        IF to_regclass(format('public.%I', galley_table)) IS NOT NULL
        AND NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = galley_table
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', galley_table);
        END IF;
    END LOOP;
END;
$$;

-- ── The app's signal ───────────────────────────────────────────────────────

-- Last, so it answers only once everything above is in place. The app asks
-- it from services/vessel/sharedBinders.ts (askGalleyShareReady); PostgREST's
-- PGRST202 (no such function) means "not yet".
CREATE OR REPLACE FUNCTION public.galley_share_ready()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT true;
$$;

REVOKE ALL ON FUNCTION public.galley_share_ready() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.galley_share_ready() TO authenticated;

-- Make "mark grocery purchased" one remote transaction. The shopping row is
-- the sole outbox mutation; this trigger creates/reverses its deterministic
-- Ship's Stores receipt in the same PostgreSQL commit.

ALTER TABLE public.shopping_list
    ADD COLUMN IF NOT EXISTS purchase_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS purchase_operation_id UUID;
ALTER TABLE public.shopping_list
    DROP CONSTRAINT IF EXISTS shopping_list_purchase_revision_check;
ALTER TABLE public.shopping_list
    ADD CONSTRAINT shopping_list_purchase_revision_check
    CHECK (purchase_revision >= 0);

CREATE TABLE IF NOT EXISTS public.grocery_purchase_operations (
    operation_id UUID PRIMARY KEY,
    shopping_item_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    target_purchased BOOLEAN NOT NULL,
    resulting_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grocery_purchase_operations_item
    ON public.grocery_purchase_operations(shopping_item_id, created_at DESC);

ALTER TABLE public.grocery_purchase_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.grocery_purchase_operations
    FROM PUBLIC, anon, authenticated;

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
        RAISE EXCEPTION 'Ship''s Stores edit permission is required'
            USING ERRCODE = '42501';
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

    IF NEW.purchased THEN
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

CREATE OR REPLACE FUNCTION public.guard_grocery_purchase_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Every supported client inserts the shopping intent first, then performs
    -- a revisioned purchase transition. Importing a pre-purchased row would
    -- bypass the operation ledger and atomic Stores receipt.
    IF NEW.purchased
       OR NEW.purchase_revision <> 0
       OR NEW.purchase_operation_id IS NOT NULL
       OR NEW.purchased_at IS NOT NULL
       OR NEW.purchased_quantity IS NOT NULL
       OR NEW.purchased_unit IS NOT NULL THEN
        RAISE EXCEPTION 'Shopping items must be inserted before they are purchased'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_grocery_purchase_insert()
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_grocery_purchase_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.purchased THEN
        IF auth.uid() IS NULL
           OR NOT public.can_access_vessel_register(OLD.user_id, 'stores', true) THEN
            RAISE EXCEPTION 'Ship''s Stores edit permission is required'
                USING ERRCODE = '42501';
        END IF;

        -- Deleting a purchased row would orphan its deterministic Stores
        -- receipt. The supported flow is an atomic undo followed by deletion.
        RAISE EXCEPTION 'Undo the grocery purchase before deleting the item'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_grocery_purchase_delete()
    FROM PUBLIC, anon, authenticated;

-- Keep the replacement in one protocol statement. Some managed poolers reject
-- a final DROP/CREATE pair when the migration transport prepares it as a batch.
DO $$
BEGIN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_guard_grocery_purchase_insert ON public.shopping_list';
    EXECUTE $trigger$
        CREATE TRIGGER trg_guard_grocery_purchase_insert
        BEFORE INSERT ON public.shopping_list
        FOR EACH ROW EXECUTE FUNCTION public.guard_grocery_purchase_insert()
    $trigger$;

    EXECUTE 'DROP TRIGGER IF EXISTS trg_guard_grocery_purchase_delete ON public.shopping_list';
    EXECUTE $trigger$
        CREATE TRIGGER trg_guard_grocery_purchase_delete
        BEFORE DELETE ON public.shopping_list
        FOR EACH ROW EXECUTE FUNCTION public.guard_grocery_purchase_delete()
    $trigger$;

    EXECUTE 'DROP TRIGGER IF EXISTS trg_atomic_grocery_purchase ON public.shopping_list';
    EXECUTE $trigger$
        CREATE TRIGGER trg_atomic_grocery_purchase
        BEFORE UPDATE
        ON public.shopping_list
        FOR EACH ROW
        EXECUTE FUNCTION public.sync_grocery_purchase_inventory()
    $trigger$;
END;
$$;

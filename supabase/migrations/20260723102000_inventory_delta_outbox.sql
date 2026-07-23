-- Make offline inventory quantity changes atomic and retry-safe.
--
-- The client sends each outbox operation UUID to this function. The receipt
-- and quantity update commit in the same transaction, so a timeout followed by
-- a retry returns the original result without applying the delta twice.

-- Quantities are used for fractional recipe consumption. The original stores
-- migration documented DECIMAL quantities but left the base INTEGER type in
-- place. Rebuild the read-only compatibility view around the type correction.
DROP VIEW IF EXISTS public.ships_stores;
ALTER TABLE public.inventory_items
    ALTER COLUMN quantity TYPE NUMERIC
    USING quantity::NUMERIC;
CREATE VIEW public.ships_stores
    WITH (security_invoker = true)
AS
    SELECT * FROM public.inventory_items;
GRANT SELECT ON public.ships_stores TO authenticated;

CREATE TABLE IF NOT EXISTS public.inventory_delta_receipts (
    operation_id UUID PRIMARY KEY,
    inventory_item_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    delta NUMERIC NOT NULL,
    resulting_quantity NUMERIC NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_delta_receipts_item
    ON public.inventory_delta_receipts(inventory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_delta_receipts_actor
    ON public.inventory_delta_receipts(actor_id, created_at DESC);

ALTER TABLE public.inventory_delta_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_delta_receipts
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_inventory_quantity_delta(
    p_operation_id UUID,
    p_inventory_item_id UUID,
    p_delta NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    existing_receipt public.inventory_delta_receipts%ROWTYPE;
    inventory_owner UUID;
    current_quantity NUMERIC;
    next_quantity NUMERIC;
BEGIN
    IF caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '28000';
    END IF;
    IF p_operation_id IS NULL
       OR p_inventory_item_id IS NULL
       OR p_delta IS NULL
       OR p_delta::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'A valid operation, inventory item, and finite delta are required'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO existing_receipt
    FROM public.inventory_delta_receipts
    WHERE operation_id = p_operation_id;

    IF FOUND THEN
        IF existing_receipt.actor_id IS DISTINCT FROM caller_id
           OR existing_receipt.inventory_item_id IS DISTINCT FROM p_inventory_item_id
           OR existing_receipt.delta IS DISTINCT FROM p_delta THEN
            RAISE EXCEPTION 'Operation ID was already used for a different inventory mutation'
                USING ERRCODE = '22023';
        END IF;
        RETURN existing_receipt.resulting_quantity;
    END IF;

    SELECT user_id, quantity
    INTO inventory_owner, current_quantity
    FROM public.inventory_items
    WHERE id = p_inventory_item_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Inventory item was not found or is not editable'
            USING ERRCODE = '42501';
    END IF;
    IF NOT public.can_access_vessel_register(inventory_owner, 'stores', true) THEN
        RAISE EXCEPTION 'Inventory item was not found or is not editable'
            USING ERRCODE = '42501';
    END IF;

    -- A same-operation retry may have waited for the row lock while the first
    -- request committed. Recheck its receipt after acquiring that lock.
    SELECT *
    INTO existing_receipt
    FROM public.inventory_delta_receipts
    WHERE operation_id = p_operation_id;

    IF FOUND THEN
        IF existing_receipt.actor_id IS DISTINCT FROM caller_id
           OR existing_receipt.inventory_item_id IS DISTINCT FROM p_inventory_item_id
           OR existing_receipt.delta IS DISTINCT FROM p_delta THEN
            RAISE EXCEPTION 'Operation ID was already used for a different inventory mutation'
                USING ERRCODE = '22023';
        END IF;
        RETURN existing_receipt.resulting_quantity;
    END IF;

    next_quantity := GREATEST(0::NUMERIC, current_quantity + p_delta);

    UPDATE public.inventory_items
    SET quantity = next_quantity
    WHERE id = p_inventory_item_id;

    INSERT INTO public.inventory_delta_receipts(
        operation_id,
        inventory_item_id,
        actor_id,
        delta,
        resulting_quantity
    )
    VALUES (
        p_operation_id,
        p_inventory_item_id,
        caller_id,
        p_delta,
        next_quantity
    );

    RETURN next_quantity;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_quantity_delta(UUID, UUID, NUMERIC)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_inventory_quantity_delta(UUID, UUID, NUMERIC)
    TO authenticated;

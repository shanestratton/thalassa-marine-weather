-- Align every offline-sync row shape with a source-controlled remote schema.
-- This closes three silent failure modes:
--   * custom recipes carried an is_custom field the API schema did not know;
--   * passage_provisions was pulled by updated_at but had no such column;
--   * shopping_list was synced and subscribed to without ever being created.

ALTER TABLE public.recipes
    ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.passage_provisions
    ADD COLUMN IF NOT EXISTS recipe_title TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS store_item_name TEXT,
    ADD COLUMN IF NOT EXISTS voyage_id UUID REFERENCES public.voyages(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.update_passage_provisions_ts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_passage_provisions_updated
    ON public.passage_provisions;
CREATE TRIGGER trg_passage_provisions_updated
    BEFORE UPDATE ON public.passage_provisions
    FOR EACH ROW EXECUTE FUNCTION public.update_passage_provisions_ts();

CREATE TABLE IF NOT EXISTS public.shopping_list (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ingredient_name       TEXT NOT NULL,
    required_qty          NUMERIC NOT NULL CHECK (required_qty > 0),
    unit                  TEXT NOT NULL DEFAULT 'each',
    market_zone           TEXT NOT NULL DEFAULT 'General'
                          CHECK (market_zone IN (
                              'Butcher', 'Produce', 'Bottle Shop', 'Bakery',
                              'Dairy', 'Chandlery', 'Fuel Dock', 'Pharmacy',
                              'General'
                          )),
    actual_cost           NUMERIC CHECK (actual_cost IS NULL OR actual_cost >= 0),
    currency              TEXT NOT NULL DEFAULT 'AUD',
    purchased             BOOLEAN NOT NULL DEFAULT false,
    purchased_at          TIMESTAMPTZ,
    store_location        TEXT NOT NULL DEFAULT 'Galley',
    purchase_retailer     TEXT,
    purchased_quantity    NUMERIC
                          CHECK (purchased_quantity IS NULL OR purchased_quantity > 0),
    purchased_unit        TEXT,
    purchase_revision     BIGINT NOT NULL DEFAULT 0
                          CHECK (purchase_revision >= 0),
    purchase_operation_id UUID,
    provision_id          UUID,
    voyage_id             UUID REFERENCES public.voyages(id) ON DELETE CASCADE,
    notes                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Legacy cached purchases predate explicit receipt quantities. Permit the
    -- all-null legacy shape, but never a half-populated new receipt.
    CONSTRAINT shopping_list_purchase_shape CHECK (
        (purchased_quantity IS NULL AND purchased_unit IS NULL)
        OR (
            purchased = true
            AND purchased_at IS NOT NULL
            AND purchased_quantity > 0
            AND purchased_unit IS NOT NULL
            AND length(trim(purchased_unit)) > 0
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_shopping_list_owner
    ON public.shopping_list(user_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_voyage
    ON public.shopping_list(voyage_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_open
    ON public.shopping_list(user_id, voyage_id, updated_at DESC)
    WHERE purchased = false;

CREATE OR REPLACE FUNCTION public.update_shopping_list_ts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shopping_list_updated
    ON public.shopping_list;
CREATE TRIGGER trg_shopping_list_updated
    BEFORE UPDATE ON public.shopping_list
    FOR EACH ROW EXECUTE FUNCTION public.update_shopping_list_ts();

ALTER TABLE public.shopping_list ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Shopping owners manage own list"
    ON public.shopping_list;
CREATE POLICY "Shopping owners manage own list"
    ON public.shopping_list FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.shopping_list TO authenticated;

-- Realtime DELETE payloads need at least the primary key, which the default
-- replica identity supplies. Add the table once without making migration
-- replays fail when a dashboard-created publication entry already exists.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'shopping_list'
    ) THEN
        ALTER PUBLICATION supabase_realtime
            ADD TABLE public.shopping_list;
    END IF;
END;
$$;

-- Bound incremental pulls with database time rather than the device clock.
-- A phone whose clock is hours ahead must never advance its cursor past rows
-- the server has not created yet.
CREATE OR REPLACE FUNCTION public.get_sync_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT statement_timestamp();
$$;

REVOKE ALL ON FUNCTION public.get_sync_watermark()
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sync_watermark()
    TO authenticated;

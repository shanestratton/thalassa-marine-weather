-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Ship's Inventory & Spares                                      ║
-- ║  Tracks marine gear, spare parts, provisions, and their storage locations  ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Table ──
CREATE TABLE IF NOT EXISTS public.inventory_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Item identification
    barcode         TEXT,                                        -- EAN/UPC barcode (nullable — not all items have one)
    item_name       TEXT NOT NULL,                               -- e.g. "Racor 2010PM-OR Fuel Filter"
    description     TEXT,                                        -- Optional notes / part numbers

    -- Classification
    category        TEXT NOT NULL DEFAULT 'Provisions'
                    CHECK (category IN (
                        'Engine', 'Plumbing', 'Electrical', 'Rigging',
                        'Safety', 'Provisions', 'Medical'
                    )),

    -- Quantity tracking
    quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    min_quantity    INTEGER DEFAULT 0,                           -- Alert threshold for low stock

    -- Storage location
    location_zone   TEXT,                                        -- High-level: "Saloon Port", "Engine Room", "Lazarette"
    location_specific TEXT,                                      -- Exact: "Under the settee, green box"

    -- Metadata
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes for fast lookup ──
CREATE INDEX IF NOT EXISTS idx_inventory_user_id     ON public.inventory_items(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode     ON public.inventory_items(user_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_category    ON public.inventory_items(user_id, category);
CREATE INDEX IF NOT EXISTS idx_inventory_name_search ON public.inventory_items USING gin(to_tsvector('english', item_name));

-- ── Auto-update timestamp trigger ──
CREATE OR REPLACE FUNCTION update_inventory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_updated_at
    BEFORE UPDATE ON public.inventory_items
    FOR EACH ROW EXECUTE FUNCTION update_inventory_updated_at();

-- ══════════════════════════════════════════
-- Row Level Security (RLS)
-- Users can only CRUD their own inventory
-- ══════════════════════════════════════════

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

-- SELECT: Own items only
CREATE POLICY "Users can view own inventory"
    ON public.inventory_items FOR SELECT
    USING (auth.uid() = user_id);

-- INSERT: Can only insert as themselves
CREATE POLICY "Users can insert own inventory"
    ON public.inventory_items FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- UPDATE: Own items only
CREATE POLICY "Users can update own inventory"
    ON public.inventory_items FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- DELETE: Own items only
CREATE POLICY "Users can delete own inventory"
    ON public.inventory_items FOR DELETE
    USING (auth.uid() = user_id);

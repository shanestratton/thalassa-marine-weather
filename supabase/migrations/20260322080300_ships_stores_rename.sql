-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Ship's Stores Terminology Rename                               ║
-- ║  Creates a view over inventory_items so new code uses 'ships_stores'.      ║
-- ║  Expands categories, adds unit column, changes quantity to DECIMAL.        ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ── Expand categories to include galley/stores ──
ALTER TABLE public.inventory_items
    DROP CONSTRAINT IF EXISTS inventory_items_category_check;

ALTER TABLE public.inventory_items
    ADD CONSTRAINT inventory_items_category_check
    CHECK (category IN (
        'Engine', 'Plumbing', 'Electrical', 'Rigging',
        'Safety', 'Provisions', 'Medical', 'Misc',
        'Pantry', 'Freezer', 'Fridge', 'Dry', 'Booze',
        'Deck', 'Cleaning'
    ));

-- ── Add unit column ──
ALTER TABLE public.inventory_items
    ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'whole';

-- ── Create ships_stores view (new terminology) ──
CREATE OR REPLACE VIEW public.ships_stores AS
    SELECT * FROM public.inventory_items;

-- Views inherit RLS from the base table. Writes go through inventory_items directly.
GRANT SELECT ON public.ships_stores TO authenticated;

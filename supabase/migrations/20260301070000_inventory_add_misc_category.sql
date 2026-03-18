-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Add 'Misc' category to inventory_items                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Drop the old constraint and add the new one with 'Misc'
ALTER TABLE public.inventory_items
    DROP CONSTRAINT IF EXISTS inventory_items_category_check;

ALTER TABLE public.inventory_items
    ADD CONSTRAINT inventory_items_category_check
    CHECK (category IN (
        'Engine', 'Plumbing', 'Electrical', 'Rigging',
        'Safety', 'Provisions', 'Medical', 'Misc'
    ));

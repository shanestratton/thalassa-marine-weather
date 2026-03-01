-- ═══════════════════════════════════════════════════════════════════
-- Add 'User Manuals' category to ship_documents
-- The original CHECK constraint didn't include it.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ship_documents
    DROP CONSTRAINT IF EXISTS ship_documents_category_check;

ALTER TABLE ship_documents
    ADD CONSTRAINT ship_documents_category_check
    CHECK (category IN (
        'Registration', 'Insurance', 'Crew Visas/IDs',
        'Radio/MMSI', 'Customs Clearances', 'User Manuals'
    ));

-- ═══════════════════════════════════════════════════════════════════
-- Equipment Register & Ship's Documents
-- Cloud-side tables mirroring local SQLite schemas
-- ═══════════════════════════════════════════════════════════════════

-- ── Table A: equipment_register ─────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_register (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    equipment_name      TEXT NOT NULL,                       -- "Main Engine"
    category            TEXT NOT NULL CHECK (category IN (
                            'Propulsion', 'Electronics', 'HVAC',
                            'Plumbing', 'Rigging', 'Galley'
                        )),
    make                TEXT NOT NULL DEFAULT '',            -- "Yanmar"
    model               TEXT NOT NULL DEFAULT '',            -- "4JH4-TE"
    serial_number       TEXT NOT NULL DEFAULT '',            -- "YNM-4JH4TE-12345"

    installation_date   TIMESTAMPTZ,                        -- When installed
    warranty_expiry     TIMESTAMPTZ,                        -- Warranty end date
    manual_uri          TEXT,                                -- Cloud URL → vessel_vault bucket
    notes               TEXT,                                -- Free-form notes

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Table B: ship_documents ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS ship_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    document_name       TEXT NOT NULL,                       -- "Hull Insurance 2026"
    category            TEXT NOT NULL CHECK (category IN (
                            'Registration', 'Insurance', 'Crew Visas/IDs',
                            'Radio/MMSI', 'Customs Clearances'
                        )),
    issue_date          TIMESTAMPTZ,                        -- Document issue date
    expiry_date         TIMESTAMPTZ,                        -- Document expiry date
    file_uri            TEXT,                                -- Cloud URL → vessel_vault bucket
    notes               TEXT,                                -- Free-form notes

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════

-- Equipment register
CREATE INDEX IF NOT EXISTS idx_equipment_register_user
    ON equipment_register(user_id);

CREATE INDEX IF NOT EXISTS idx_equipment_register_category
    ON equipment_register(user_id, category);

CREATE INDEX IF NOT EXISTS idx_equipment_register_updated
    ON equipment_register(updated_at);

-- Ship documents
CREATE INDEX IF NOT EXISTS idx_ship_documents_user
    ON ship_documents(user_id);

CREATE INDEX IF NOT EXISTS idx_ship_documents_category
    ON ship_documents(user_id, category);

CREATE INDEX IF NOT EXISTS idx_ship_documents_expiry
    ON ship_documents(user_id, expiry_date)
    WHERE expiry_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ship_documents_updated
    ON ship_documents(updated_at);

-- ═══════════════════════════════════════════════════════════════════
-- Auto-update triggers for updated_at
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_equipment_register_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_equipment_register_updated_at ON equipment_register;
CREATE TRIGGER trg_equipment_register_updated_at
    BEFORE UPDATE ON equipment_register
    FOR EACH ROW EXECUTE FUNCTION update_equipment_register_updated_at();

CREATE OR REPLACE FUNCTION update_ship_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ship_documents_updated_at ON ship_documents;
CREATE TRIGGER trg_ship_documents_updated_at
    BEFORE UPDATE ON ship_documents
    FOR EACH ROW EXECUTE FUNCTION update_ship_documents_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE equipment_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE ship_documents ENABLE ROW LEVEL SECURITY;

-- equipment_register policies
CREATE POLICY "Users can view own equipment"
    ON equipment_register FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create own equipment"
    ON equipment_register FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own equipment"
    ON equipment_register FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own equipment"
    ON equipment_register FOR DELETE
    USING (auth.uid() = user_id);

-- ship_documents policies
CREATE POLICY "Users can view own documents"
    ON ship_documents FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create own documents"
    ON ship_documents FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own documents"
    ON ship_documents FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own documents"
    ON ship_documents FOR DELETE
    USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════
-- Supabase Storage — vessel_vault bucket
-- Stores PDF manuals, passport scans, insurance docs, etc.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('vessel_vault', 'vessel_vault', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: users can only access files in their own folder
-- Path convention: {user_id}/{equipment|documents}/{filename}

CREATE POLICY "Users can upload to own vault folder"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'vessel_vault'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Users can view own vault files"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'vessel_vault'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Users can update own vault files"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'vessel_vault'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

CREATE POLICY "Users can delete own vault files"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'vessel_vault'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- AMSA Ship Register — all Australian registered vessels
-- Keyed on official_number (unique AMSA registration ID)
-- Used for real-time enrichment when Australian AIS vessels appear

CREATE TABLE IF NOT EXISTS amsa_register (
    official_number TEXT PRIMARY KEY,
    ship_name       TEXT NOT NULL,
    ship_name_upper TEXT GENERATED ALWAYS AS (UPPER(ship_name)) STORED,
    imo_number      TEXT,
    length_m        REAL,
    year_built      INTEGER,
    vessel_type     TEXT,
    home_port       TEXT,
    status          TEXT DEFAULT 'Registered',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast name lookups (the primary match path)
CREATE INDEX IF NOT EXISTS idx_amsa_ship_name_upper ON amsa_register (ship_name_upper);

-- Index for IMO lookups
CREATE INDEX IF NOT EXISTS idx_amsa_imo ON amsa_register (imo_number) WHERE imo_number IS NOT NULL;

-- Enable RLS but allow public reads (vessel specs are public info)
ALTER TABLE amsa_register ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amsa_register_public_read"
    ON amsa_register FOR SELECT
    USING (true);

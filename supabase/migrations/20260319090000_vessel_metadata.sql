-- ============================================================================
-- Vessel Metadata — "Global Caller ID" enrichment layer
--
-- Enriches live AIS positions (public.vessels) with identity data:
-- name, flag, photo, dimensions, and verification status.
-- Populated by the Railway.app scraper service ("The Railroad").
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.vessel_metadata (
    mmsi            bigint PRIMARY KEY,

    -- Identity
    vessel_name     text,
    vessel_type     text,           -- 'Cargo', 'Tanker', 'Sailing Vessel', etc.
    flag_country    text,           -- 'Australia', 'United States', etc.
    flag_emoji      text,           -- '🇦🇺', '🇺🇸', etc.
    call_sign       text,
    imo_number      integer,

    -- Dimensions (metres)
    loa             float,          -- Length overall
    beam            float,          -- Beam
    draft           float,          -- Draft

    -- Imagery
    photo_url       text,           -- Full-size vessel photo
    thumbnail_url   text,           -- 64×64 thumbnail for map popups

    -- Provenance
    data_source     text,           -- 'AMSA', 'USCG', 'Equasis', 'ITU', 'GFW'
    is_verified     boolean DEFAULT false,
    last_scraped_at timestamptz DEFAULT now()
);

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS vessel_metadata_flag_idx
    ON public.vessel_metadata (flag_country);

CREATE INDEX IF NOT EXISTS vessel_metadata_type_idx
    ON public.vessel_metadata (vessel_type);

CREATE INDEX IF NOT EXISTS vessel_metadata_source_idx
    ON public.vessel_metadata (data_source);

-- ── RLS ──

ALTER TABLE public.vessel_metadata ENABLE ROW LEVEL SECURITY;

-- Anon users can read vessel metadata (non-sensitive public registry data)
CREATE POLICY "Vessel metadata is publicly readable"
    ON public.vessel_metadata FOR SELECT
    USING (true);

-- Only service_role can insert/update/delete (scraper uses service key)
CREATE POLICY "Only service role can modify vessel metadata"
    ON public.vessel_metadata FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ── Batch lookup function (called by client for popup enrichment) ──

CREATE OR REPLACE FUNCTION public.lookup_vessel_metadata(mmsi_list bigint[])
RETURNS SETOF public.vessel_metadata
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT * FROM public.vessel_metadata
    WHERE mmsi = ANY(mmsi_list);
$$;

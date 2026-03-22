-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Vessel Identity ("Ship's DNA")                                 ║
-- ║  Stores vessel identity data synced across all crew devices.               ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.vessel_identity (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Core identity
    vessel_name     TEXT NOT NULL,
    reg_number      TEXT,                   -- Official state/national registration
    mmsi            TEXT,                   -- 9-digit Maritime Mobile Service Identity
    call_sign       TEXT,                   -- VHF radio call sign
    phonetic_name   TEXT,                   -- TTS pronunciation (e.g., "tah-LASS-ah")

    -- Vessel details (mirrors VesselProfile essentials for crew access)
    vessel_type     TEXT DEFAULT 'sail' CHECK (vessel_type IN ('sail', 'power', 'observer')),
    hull_color      TEXT,
    model           TEXT,

    -- Metadata
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One vessel identity per owner
    CONSTRAINT vessel_identity_owner_unique UNIQUE (owner_id)
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_vessel_identity_owner ON public.vessel_identity(owner_id);
CREATE INDEX IF NOT EXISTS idx_vessel_identity_mmsi  ON public.vessel_identity(mmsi) WHERE mmsi IS NOT NULL;

-- ── Auto-update timestamp ──
CREATE OR REPLACE FUNCTION update_vessel_identity_ts()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vessel_identity_updated
    BEFORE UPDATE ON public.vessel_identity
    FOR EACH ROW EXECUTE FUNCTION update_vessel_identity_ts();

-- ── RLS ──
ALTER TABLE public.vessel_identity ENABLE ROW LEVEL SECURITY;

-- Owner can do everything
CREATE POLICY "Owner full access to vessel_identity"
    ON public.vessel_identity FOR ALL
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

-- Crew can READ vessel identity (linked via vessel_crew)
CREATE POLICY "Crew can read vessel identity"
    ON public.vessel_identity FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = vessel_identity.owner_id
              AND vc.crew_user_id = auth.uid()
              AND vc.status = 'accepted'
        )
    );

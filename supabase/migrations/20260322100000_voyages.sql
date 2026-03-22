-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Voyages (Passage State)                                        ║
-- ║  Tracks active trips. When active, prioritises Report Position UI.         ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.voyages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    vessel_id           UUID REFERENCES public.vessel_identity(id) ON DELETE SET NULL,
    voyage_name         TEXT NOT NULL DEFAULT 'Unnamed Passage',
    departure_port      TEXT,
    destination_port    TEXT,
    departure_time      TIMESTAMPTZ,
    eta                 TIMESTAMPTZ,
    crew_count          INTEGER DEFAULT 2,
    status              TEXT DEFAULT 'planning'
                        CHECK (status IN ('planning', 'active', 'completed', 'aborted')),
    weather_master_id   UUID REFERENCES auth.users(id),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voyages_owner ON public.voyages(user_id);
CREATE INDEX IF NOT EXISTS idx_voyages_active ON public.voyages(status) WHERE status = 'active';

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_voyages_ts()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_voyages_updated
    BEFORE UPDATE ON public.voyages
    FOR EACH ROW EXECUTE FUNCTION update_voyages_ts();

-- RLS
ALTER TABLE public.voyages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage own voyages"
    ON public.voyages FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Crew can read active voyages for vessels they're linked to
CREATE POLICY "Crew read active voyages"
    ON public.voyages FOR SELECT
    USING (
        auth.uid() = user_id
        OR
        EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.crew_user_id = auth.uid()
        )
    );

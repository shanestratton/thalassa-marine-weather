-- The boat's live instrument snapshot in the cloud (2026-09-06, build 104).
--
-- Shane: the Pi should be the primary device — it holds the boat's GPS and the
-- whole instrument bus — and crew should see the Instrument Panel anywhere
-- without configuring a VPN. This is the row that carries it: one per skipper,
-- upserted every few seconds by the Pi through the telemetry-relay Edge
-- Function (relay-token authenticated, same pairing as the diary relay), read
-- by the skipper and by the boat's crew.
--
-- Reads: the owner, members of the boat (boat_members), and accepted vessel
-- crew (vessel_crew). Writes: the service role only — the relay function. The
-- row is a snapshot, not a history; the ship's log remains the record.

CREATE TABLE IF NOT EXISTS public.vessel_telemetry (
    owner_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_id         UUID REFERENCES public.boats(id) ON DELETE SET NULL,
    source          TEXT NOT NULL CHECK (source IN ('pi', 'device')),
    device_label    TEXT CHECK (device_label IS NULL OR char_length(device_label) <= 60),
    reported_at     TIMESTAMPTZ NOT NULL,
    lat             DOUBLE PRECISION CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    lon             DOUBLE PRECISION CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
    sog_kts         DOUBLE PRECISION,
    cog_deg         DOUBLE PRECISION,
    heading_deg     DOUBLE PRECISION,
    stw_kts         DOUBLE PRECISION,
    tws_kts         DOUBLE PRECISION,
    twa_deg         DOUBLE PRECISION,
    twd_deg         DOUBLE PRECISION,
    aws_kts         DOUBLE PRECISION,
    awa_deg         DOUBLE PRECISION,
    depth_m         DOUBLE PRECISION,
    heel_deg        DOUBLE PRECISION,
    pitch_deg       DOUBLE PRECISION,
    water_temp_c    DOUBLE PRECISION,
    pressure_hpa    DOUBLE PRECISION,
    rudder_deg      DOUBLE PRECISION,
    rpm             DOUBLE PRECISION,
    voltage_v       DOUBLE PRECISION,
    extra           JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vessel_telemetry_boat_idx ON public.vessel_telemetry (boat_id);

ALTER TABLE public.vessel_telemetry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vessel_telemetry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.vessel_telemetry TO authenticated;

DROP POLICY IF EXISTS vessel_telemetry_owner_reads ON public.vessel_telemetry;
CREATE POLICY vessel_telemetry_owner_reads
    ON public.vessel_telemetry FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

DROP POLICY IF EXISTS vessel_telemetry_crew_reads ON public.vessel_telemetry;
CREATE POLICY vessel_telemetry_crew_reads
    ON public.vessel_telemetry FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.boat_members AS member
            WHERE member.boat_id = vessel_telemetry.boat_id
              AND member.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1
            FROM public.vessel_crew AS membership
            WHERE membership.owner_id = vessel_telemetry.owner_id
              AND membership.crew_user_id = auth.uid()
              AND membership.status = 'accepted'
        )
    );

-- Realtime, so a crew phone can subscribe instead of polling once it is wired.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'vessel_telemetry'
        ) THEN
            ALTER PUBLICATION supabase_realtime
                ADD TABLE public.vessel_telemetry;
        END IF;
    END IF;
END;
$$;

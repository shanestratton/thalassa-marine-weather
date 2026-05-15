-- ═══════════════════════════════════════════════════════════════
-- Voyage Log — multi-crew model
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Three URLs per yacht: one per crew member ("shane-on-serene-summer",
-- "emma-on-serene-summer") plus a combined log ("serene-summer") that
-- merges everyone's entries on the same boat's track.
--
-- Data model:
--   boats          — one row per yacht. Telemetry lives here, not on the user.
--   boat_members   — many-to-many join (which users sail on which boat).
--   voyage_log_configs — gains boat_id + scope:
--       scope = 'personal'  → one user's diary, byline hidden in renderer
--       scope = 'combined'  → entries from every boat_member, with byline
--   ship_log       — gains boat_id (the canonical telemetry source)
--
-- Existing single-user data is migrated automatically.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. boats ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.boats (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    name        TEXT NOT NULL,                        -- "Serene Summer"
    vessel_type TEXT,                                 -- "sail" | "power" | …
    model       TEXT,                                 -- "Tayana 55"

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boats_owner ON public.boats (owner_id);

CREATE TRIGGER trg_boats_updated
    BEFORE UPDATE ON public.boats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 2. boat_members ─────────────────────────────────────────────
-- Per-boat display name lets the same person be "Shane" on one boat and
-- "Captain" on another. Role is informational for now (no auth split).

CREATE TABLE IF NOT EXISTS public.boat_members (
    boat_id      UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,                       -- byline shown on combined log
    role         TEXT NOT NULL DEFAULT 'crew'
                    CHECK (role IN ('owner', 'crew')),
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (boat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_boat_members_user ON public.boat_members (user_id);

-- ── 3. voyage_log_configs: drop owner_id uniqueness, add boat_id + scope ─
-- Users may now own multiple configs (their personal + the boat's combined).
ALTER TABLE public.voyage_log_configs
    DROP CONSTRAINT IF EXISTS voyage_log_configs_owner_id_key;

ALTER TABLE public.voyage_log_configs
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
        CHECK (scope IN ('personal', 'combined'));

-- One combined config per boat. Personal configs are unique per (boat, user).
CREATE UNIQUE INDEX IF NOT EXISTS uq_voyage_log_combined_per_boat
    ON public.voyage_log_configs (boat_id)
    WHERE scope = 'combined';

CREATE UNIQUE INDEX IF NOT EXISTS uq_voyage_log_personal_per_member
    ON public.voyage_log_configs (boat_id, owner_id)
    WHERE scope = 'personal';

CREATE INDEX IF NOT EXISTS idx_voyage_log_boat ON public.voyage_log_configs (boat_id);

-- ── 4. ship_log: gain boat_id (the canonical telemetry key) ────
-- Kept user_id alongside for backwards compatibility with code that
-- writes per-user. Triggers below keep boat_id populated automatically.
ALTER TABLE public.ship_log
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ship_log_boat_time
    ON public.ship_log (boat_id, timestamp DESC);

-- ── 5. Backfill existing single-user data ──────────────────────
-- For every existing voyage_log_configs row, create a boats row from
-- the user's vessel_identity (or a sensible default), link the user as
-- owner in boat_members, point the config at the new boat, and
-- backfill ship_log.

DO $$
DECLARE
    cfg RECORD;
    new_boat_id UUID;
    v_name TEXT;
    v_type TEXT;
    v_model TEXT;
BEGIN
    FOR cfg IN
        SELECT id, owner_id, handle
        FROM public.voyage_log_configs
        WHERE boat_id IS NULL
    LOOP
        SELECT vessel_name, vessel_type, model
          INTO v_name, v_type, v_model
          FROM public.vessel_identity
         WHERE owner_id = cfg.owner_id;

        v_name  := COALESCE(NULLIF(v_name, ''), 'Unnamed Vessel');
        v_type  := COALESCE(v_type, 'sail');

        INSERT INTO public.boats (owner_id, name, vessel_type, model)
        VALUES (cfg.owner_id, v_name, v_type, v_model)
        RETURNING id INTO new_boat_id;

        INSERT INTO public.boat_members (boat_id, user_id, display_name, role)
        VALUES (new_boat_id, cfg.owner_id, split_part(v_name, ' ', 1), 'owner')
        ON CONFLICT DO NOTHING;

        UPDATE public.voyage_log_configs
           SET boat_id = new_boat_id,
               scope = 'personal'
         WHERE id = cfg.id;

        UPDATE public.ship_log
           SET boat_id = new_boat_id
         WHERE user_id = cfg.owner_id AND boat_id IS NULL;
    END LOOP;
END $$;

-- ── 6. Rename Shane's existing handle + add the combined log ───
-- Pre-launch transition: serene-summer becomes the COMBINED handle
-- (Shane + future crew). Shane's personal log moves to
-- shane-on-serene-summer. No-op if the handle doesn't exist locally.

DO $$
DECLARE
    shane_boat UUID;
    shane_owner UUID;
BEGIN
    SELECT boat_id, owner_id
      INTO shane_boat, shane_owner
      FROM public.voyage_log_configs
     WHERE handle = 'serene-summer'
     LIMIT 1;

    IF shane_boat IS NOT NULL THEN
        UPDATE public.voyage_log_configs
           SET handle = 'shane-on-serene-summer'
         WHERE handle = 'serene-summer';

        INSERT INTO public.voyage_log_configs (owner_id, boat_id, handle, scope, enabled)
        VALUES (shane_owner, shane_boat, 'serene-summer', 'combined', true)
        ON CONFLICT (handle) DO NOTHING;
    END IF;
END $$;

-- ── 7. Keep boats.name in sync with vessel_identity writes ─────
-- iOS still writes vessel_name to vessel_identity. Mirror those edits
-- onto the user's owned boat so the public log stays consistent
-- without touching the iOS code path.

CREATE OR REPLACE FUNCTION public.sync_vessel_identity_to_boat()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.boats
       SET name        = COALESCE(NULLIF(NEW.vessel_name, ''), name),
           vessel_type = COALESCE(NEW.vessel_type, vessel_type),
           model       = COALESCE(NEW.model, model)
     WHERE owner_id = NEW.owner_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_vessel_to_boat ON public.vessel_identity;
CREATE TRIGGER trg_sync_vessel_to_boat
    AFTER INSERT OR UPDATE ON public.vessel_identity
    FOR EACH ROW EXECUTE FUNCTION public.sync_vessel_identity_to_boat();

-- ── 8. Auto-populate ship_log.boat_id on new pings ─────────────
-- The Pi/app writes (user_id, timestamp, ...) without knowing boat_id.
-- This trigger fills it from the user's owned boat. Crew members on
-- another's boat: they shouldn't be writing telemetry anyway (the boat's
-- Pi/owner phone is the source), so the user_id → owner mapping is sane.

CREATE OR REPLACE FUNCTION public.ship_log_set_boat_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.boat_id IS NULL THEN
        SELECT id INTO NEW.boat_id
          FROM public.boats
         WHERE owner_id = NEW.user_id
         LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ship_log_set_boat_id ON public.ship_log;
CREATE TRIGGER trg_ship_log_set_boat_id
    BEFORE INSERT ON public.ship_log
    FOR EACH ROW EXECUTE FUNCTION public.ship_log_set_boat_id();

-- ── 9. RLS for the new tables ──────────────────────────────────
ALTER TABLE public.boats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boat_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their boats"
    ON public.boats FOR ALL
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Members see their boat rows"
    ON public.boats FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.boat_members m
        WHERE m.boat_id = boats.id AND m.user_id = auth.uid()
    ));

CREATE POLICY "Owners manage their boat members"
    ON public.boat_members FOR ALL
    USING (EXISTS (
        SELECT 1 FROM public.boats b
        WHERE b.id = boat_members.boat_id AND b.owner_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.boats b
        WHERE b.id = boat_members.boat_id AND b.owner_id = auth.uid()
    ));

CREATE POLICY "Members see their own membership"
    ON public.boat_members FOR SELECT
    USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════
-- Done. To inspect after running:
--   SELECT b.name, m.display_name, m.role
--     FROM public.boats b
--     JOIN public.boat_members m ON m.boat_id = b.id;
--   SELECT handle, scope FROM public.voyage_log_configs;
-- ═══════════════════════════════════════════════════════════════

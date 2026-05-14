-- ═══════════════════════════════════════════════════════════════
-- Voyage Log — public API config + diary publish flag
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Adds the data model behind the public Voyage Log API:
--   • is_public flag on diary entries (nothing is public by default)
--   • voyage_log_configs — one row per vessel that opts in, holding
--     the public handle + publishable API key
-- Multi-tenant by design; only vessels with a config row are exposed.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Publish flag on diary entries ───────────────────────────
-- Default false: existing entries stay private until explicitly published.

ALTER TABLE public.diary_entries
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_diary_public
    ON public.diary_entries (user_id, created_at DESC)
    WHERE is_public = true;

-- ── 2. slugify helper ──────────────────────────────────────────
-- Turns a vessel name into a URL-safe handle: "Serene Summer" → "serene-summer"

CREATE OR REPLACE FUNCTION public.slugify(input TEXT)
RETURNS TEXT AS $$
    SELECT trim(both '-' from regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'));
$$ LANGUAGE sql IMMUTABLE;

-- ── 3. voyage_log_configs ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.voyage_log_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Public handle (slug of the vessel name) and publishable API key.
    -- The key is an identifier, not a secret: it gates rate-limiting and
    -- revocation, but the data it unlocks is public-by-publication.
    handle      TEXT UNIQUE,
    api_key     TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),

    -- Off until the owner flips it on in the app.
    enabled     BOOLEAN NOT NULL DEFAULT false,

    -- How many days of ship_log breadcrumb the API exposes as the track.
    track_days  INTEGER NOT NULL DEFAULT 30 CHECK (track_days BETWEEN 1 AND 365),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voyage_log_handle ON public.voyage_log_configs (handle);

-- ── 4. Auto-derive handle from the vessel name on insert ───────
-- The app can insert a bare row (owner_id only) and get a handle + key
-- for free. Collisions get a numeric suffix: serene-summer, serene-summer-2…

CREATE OR REPLACE FUNCTION public.voyage_log_set_handle()
RETURNS TRIGGER AS $$
DECLARE
    base_slug TEXT;
    candidate TEXT;
    suffix    INT := 1;
BEGIN
    IF NEW.handle IS NOT NULL AND NEW.handle <> '' THEN
        RETURN NEW;
    END IF;

    SELECT public.slugify(vessel_name) INTO base_slug
    FROM public.vessel_identity
    WHERE owner_id = NEW.owner_id;

    IF base_slug IS NULL OR base_slug = '' THEN
        base_slug := 'vessel-' || substr(NEW.owner_id::text, 1, 8);
    END IF;

    candidate := base_slug;
    WHILE EXISTS (SELECT 1 FROM public.voyage_log_configs WHERE handle = candidate) LOOP
        suffix := suffix + 1;
        candidate := base_slug || '-' || suffix;
    END LOOP;

    NEW.handle := candidate;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_voyage_log_set_handle
    BEFORE INSERT ON public.voyage_log_configs
    FOR EACH ROW EXECUTE FUNCTION public.voyage_log_set_handle();

-- updated_at trigger (update_updated_at_column is defined in the ship_log migration)
CREATE TRIGGER trg_voyage_log_updated
    BEFORE UPDATE ON public.voyage_log_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 5. Row Level Security ──────────────────────────────────────
-- Owners manage their own config. The public API reads via the service
-- role (in the voyage-log edge function), so no public SELECT policy.

ALTER TABLE public.voyage_log_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner full access to voyage_log_configs"
    ON public.voyage_log_configs FOR ALL
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

-- ═══════════════════════════════════════════════════════════════
-- Done. To set up your own vessel after running this:
--   INSERT INTO public.voyage_log_configs (owner_id, enabled)
--   VALUES (auth.uid(), true);
-- then read back your handle + api_key:
--   SELECT handle, api_key FROM public.voyage_log_configs WHERE owner_id = auth.uid();
-- ═══════════════════════════════════════════════════════════════

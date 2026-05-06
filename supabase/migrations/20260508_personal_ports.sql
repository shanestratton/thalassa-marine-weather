-- ============================================================================
-- Personal Port Directory — per-user geocoded port cache
--
-- Each row records a place the user has successfully geocoded during route
-- planning. The local PersonalPortDirectory service writes to localStorage
-- AND to this table (fire-and-forget) so the directory follows the user
-- between devices: plan a route on the iPad → the same port resolves
-- instantly on the iPhone next time.
--
-- Phase 1 (this migration): per-user cache, owner-only RLS.
-- Phase 2 (later): the public_status column + admin moderation flow let a
-- user promote a personal port to the shared MARINE_PORTS list. Schema is
-- in place; the moderation tooling is not.
--
-- Used by:
--   - services/PersonalPortDirectory.ts: load on startup, upsert on record,
--     delete on remove
--   - services/weather/api/geocoding.ts: parseLocation reads via the
--     directory service before falling through to Mapbox
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.personal_ports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- What the user typed verbatim — the lookup key.
    typed_name TEXT NOT NULL,
    -- The canonical name resolved by Mapbox (used as the display label).
    canonical_name TEXT NOT NULL,

    -- Resolved coordinates of the feature.
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,

    -- Usage stats — drive LRU eviction client-side and could power
    -- "frequently visited" UI later.
    times_used INTEGER NOT NULL DEFAULT 1,
    first_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Phase 2 (deferred): community contribution flow.
    --   NULL          = personal-only (the default)
    --   'pending'     = user has tapped "Promote to public" (Phase 2 UI)
    --   'approved'    = admin has accepted; entry visible to all users
    --   'rejected'    = admin declined; stays personal
    public_status TEXT,
    public_promoted_at TIMESTAMPTZ,
    public_approved_by UUID REFERENCES auth.users(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One entry per (user, typed_name) — re-recording updates the existing
    -- row instead of inserting a duplicate. Mirrors the client-side cache
    -- semantics so the upsert round-trips cleanly.
    UNIQUE (user_id, typed_name)
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_personal_ports_user_id
    ON public.personal_ports (user_id);

-- Lower-cased typed_name index for the substring search the client does.
-- Trigram index would be ideal but pg_trgm isn't enabled by default in
-- Supabase projects; a plain lower() index covers exact + prefix matches.
CREATE INDEX IF NOT EXISTS idx_personal_ports_typed_name_lower
    ON public.personal_ports (user_id, LOWER(TRIM(typed_name)));

-- Public-status filter for Phase 2 (cheap to add now, no-op until used).
CREATE INDEX IF NOT EXISTS idx_personal_ports_public_status
    ON public.personal_ports (public_status)
    WHERE public_status IS NOT NULL;

-- ── Auto-update updated_at on row UPDATE ──
CREATE OR REPLACE FUNCTION public.update_personal_ports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_personal_ports_updated_at ON public.personal_ports;
CREATE TRIGGER trg_personal_ports_updated_at
    BEFORE UPDATE ON public.personal_ports
    FOR EACH ROW
    EXECUTE FUNCTION public.update_personal_ports_updated_at();

-- ── RLS — owner-only read/write ──
ALTER TABLE public.personal_ports ENABLE ROW LEVEL SECURITY;

-- A user can do anything with their own ports.
CREATE POLICY "personal_ports_owner_all"
    ON public.personal_ports
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.personal_ports TO authenticated;

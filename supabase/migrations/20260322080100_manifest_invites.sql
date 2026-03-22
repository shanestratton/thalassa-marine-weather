-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — 6-Digit Manifest Invites                                       ║
-- ║  Skipper generates a code → crew enters it → linked to vessel.            ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.manifest_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- The 6-digit alphanumeric code (e.g., "TX-5501")
    invite_code     TEXT NOT NULL UNIQUE,

    -- Target (optional — if blank, anyone with the code can use it)
    email           TEXT,

    -- Role & permissions
    role            TEXT NOT NULL DEFAULT 'deckhand'
                    CHECK (role IN ('co-skipper', 'navigator', 'deckhand', 'punter')),
    permissions     JSONB NOT NULL DEFAULT '{
        "can_view_stores": false,
        "can_edit_stores": false,
        "can_view_galley": false,
        "can_view_nav": false,
        "can_view_weather": false,
        "can_edit_log": false
    }'::jsonb,

    -- Status
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
    accepted_by     UUID REFERENCES auth.users(id),
    accepted_at     TIMESTAMPTZ,

    -- Security: lock to device after first use
    device_id       TEXT,   -- Set on acceptance, prevents code reuse on another device

    -- Expiry
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_manifest_code ON public.manifest_invites(invite_code);
CREATE INDEX IF NOT EXISTS idx_manifest_owner ON public.manifest_invites(owner_id);
CREATE INDEX IF NOT EXISTS idx_manifest_status ON public.manifest_invites(status) WHERE status = 'pending';

-- ── Auto-update timestamp ──
CREATE OR REPLACE FUNCTION update_manifest_invite_ts()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_manifest_invite_updated
    BEFORE UPDATE ON public.manifest_invites
    FOR EACH ROW EXECUTE FUNCTION update_manifest_invite_ts();

-- ── RLS ──
ALTER TABLE public.manifest_invites ENABLE ROW LEVEL SECURITY;

-- Owner can do everything with their invites
CREATE POLICY "Owner full access to manifest_invites"
    ON public.manifest_invites FOR ALL
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

-- Any authenticated user can read a pending invite (to redeem a code)
CREATE POLICY "Auth users can read pending invites"
    ON public.manifest_invites FOR SELECT
    USING (status = 'pending' AND expires_at > now());

-- Any authenticated user can update a pending invite (to accept it)
CREATE POLICY "Auth users can accept invites"
    ON public.manifest_invites FOR UPDATE
    USING (status = 'pending' AND expires_at > now())
    WITH CHECK (accepted_by = auth.uid());

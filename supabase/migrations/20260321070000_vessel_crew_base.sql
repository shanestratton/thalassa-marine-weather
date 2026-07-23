-- Canonical vessel_crew foundation. Later migrations add JSON permissions,
-- per-voyage membership, boat bridging, and the final hardened policies.
-- This definition is deliberately non-destructive for databases where the
-- original dashboard-run crew_sharing.sql was already applied.

CREATE TABLE IF NOT EXISTS public.vessel_crew (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    crew_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    crew_email TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    shared_registers TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined')),
    role TEXT NOT NULL DEFAULT 'crew',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(owner_id, crew_user_id)
);

CREATE INDEX IF NOT EXISTS idx_vessel_crew_owner
    ON public.vessel_crew(owner_id);
CREATE INDEX IF NOT EXISTS idx_vessel_crew_member
    ON public.vessel_crew(crew_user_id);
CREATE INDEX IF NOT EXISTS idx_vessel_crew_status
    ON public.vessel_crew(status);

ALTER TABLE public.vessel_crew ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_manage_crew" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_see_invites" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_respond_invite" ON public.vessel_crew;

CREATE POLICY "owner_manage_crew"
    ON public.vessel_crew FOR ALL TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());
CREATE POLICY "crew_see_invites"
    ON public.vessel_crew FOR SELECT TO authenticated
    USING (crew_user_id = auth.uid());
CREATE POLICY "crew_respond_invite"
    ON public.vessel_crew FOR UPDATE TO authenticated
    USING (crew_user_id = auth.uid() AND status = 'pending')
    WITH CHECK (crew_user_id = auth.uid() AND status IN ('accepted', 'declined'));

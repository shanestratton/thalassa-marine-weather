-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Voice Conversations (Calypso shared chat across the vessel)    ║
-- ║                                                                            ║
-- ║  Stores text-only conversation turns (transcript + answer) for sharing     ║
-- ║  across crew on the same vessel. Audio is NOT persisted — the skipper      ║
-- ║  who asked hears their own answer locally; crew see only the text.         ║
-- ║                                                                            ║
-- ║  Vessel scope is owner_id (matches the existing vessel_identity model      ║
-- ║  where one row per captain). RLS lets the captain plus accepted crew on    ║
-- ║  vessel_crew read + insert their own turns. Cross-vessel reads are         ║
-- ║  impossible by construction — RLS refuses.                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS public.voice_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Vessel scope: the captain's user_id (owner_id in vessel_identity).
    -- Same model as vessel_crew.owner_id — every conversation row belongs
    -- to exactly one vessel-as-identified-by-its-captain.
    vessel_owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Who asked. Could be the captain themselves (auth.uid() = vessel_owner_id)
    -- or a crew member with accepted vessel_crew status.
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Display name for speaker attribution in the conversation log.
    -- Captured at insert time so renaming a user later doesn't retroactively
    -- rewrite history. Falls back to email if no display name.
    user_name       TEXT NOT NULL,

    -- Conversation content
    transcript      TEXT NOT NULL,
    answer_text     TEXT NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('cloud', 'bosun', 'unknown')),

    -- Optional tool-call audit trail (orchestrator records which Pi/cloud
    -- tools fired). JSONB so we can query/index without schema churn.
    tool_calls      JSONB,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Index for the common query: "give me this vessel's recent turns" ──
CREATE INDEX IF NOT EXISTS idx_voice_conv_vessel_created
    ON public.voice_conversations(vessel_owner_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.voice_conversations ENABLE ROW LEVEL SECURITY;

-- Captain (vessel owner) can do everything for their own vessel.
CREATE POLICY "Owner full access to voice_conversations"
    ON public.voice_conversations FOR ALL
    USING (auth.uid() = vessel_owner_id)
    WITH CHECK (auth.uid() = vessel_owner_id AND user_id = auth.uid());

-- Accepted crew can READ all turns on the vessel (Marta sees Shane's
-- conversation, Shane sees Marta's, neither sees other vessels).
CREATE POLICY "Crew can read voice_conversations"
    ON public.voice_conversations FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = voice_conversations.vessel_owner_id
              AND vc.crew_user_id = auth.uid()
              AND vc.status = 'accepted'
        )
    );

-- Accepted crew can INSERT turns they themselves authored. RLS prevents
-- crew from impersonating another user (user_id = auth.uid() check).
CREATE POLICY "Crew can insert own voice_conversations"
    ON public.voice_conversations FOR INSERT
    WITH CHECK (
        user_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = voice_conversations.vessel_owner_id
              AND vc.crew_user_id = auth.uid()
              AND vc.status = 'accepted'
        )
    );

-- ── Realtime ─────────────────────────────────────────────────────────
-- Lets the iOS clients subscribe to per-vessel changes for live sharing.
-- Marta's phone gets push-notified when Shane inserts a turn, and vice
-- versa. The RLS policies above gate which rows the subscription emits
-- to which user.
ALTER PUBLICATION supabase_realtime ADD TABLE public.voice_conversations;

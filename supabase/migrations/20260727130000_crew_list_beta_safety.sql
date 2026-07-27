-- The Crew List beta is an opt-in, safety-gated community feature.
--
-- Existing Find Crew rows deliberately remain private.  A profile only becomes
-- discoverable after its owner opts in, submits it for review, and an admin
-- verifies and approves it.  This migration also aligns the source-controlled
-- table with the fields LonelyHeartsService has long read and written.

-- ── Bring the historical Crew Finder schema up to the client contract ──────

ALTER TABLE public.sailor_crew_profiles
    ADD COLUMN IF NOT EXISTS vibe TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS smoking TEXT,
    ADD COLUMN IF NOT EXISTS drinking TEXT,
    ADD COLUMN IF NOT EXISTS pets TEXT,
    ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS location_city TEXT,
    ADD COLUMN IF NOT EXISTS location_state TEXT,
    ADD COLUMN IF NOT EXISTS location_country TEXT,
    ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';

-- ── Explicit Crew List lifecycle ──────────────────────────────────────────

ALTER TABLE public.sailor_crew_profiles
    ADD COLUMN IF NOT EXISTS community_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS crew_intents TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS crew_list_visibility TEXT NOT NULL DEFAULT 'private',
    ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
    ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.sailor_crew_profiles
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_crew_intents_check,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_visibility_check,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_approval_status_check,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_verification_status_check,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_pending_review_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_approved_review_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_visible_profile_shape;

ALTER TABLE public.sailor_crew_profiles
    ADD CONSTRAINT sailor_crew_profiles_crew_intents_check
        CHECK (crew_intents <@ ARRAY['find_crew', 'find_skipper']::TEXT[]),
    ADD CONSTRAINT sailor_crew_profiles_visibility_check
        CHECK (crew_list_visibility IN ('private', 'visible')),
    ADD CONSTRAINT sailor_crew_profiles_approval_status_check
        CHECK (approval_status IN ('draft', 'pending', 'approved', 'rejected', 'suspended')),
    ADD CONSTRAINT sailor_crew_profiles_verification_status_check
        CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
    ADD CONSTRAINT sailor_crew_profiles_pending_review_shape
        CHECK (
            approval_status <> 'pending'
            OR (
                community_enabled
                AND verification_status = 'pending'
                AND review_requested_at IS NOT NULL
                AND cardinality(crew_intents) > 0
                AND NULLIF(BTRIM(COALESCE(photo_url, '')), '') IS NOT NULL
            )
        ),
    ADD CONSTRAINT sailor_crew_profiles_approved_review_shape
        CHECK (
            approval_status <> 'approved'
            OR (
                community_enabled
                AND verification_status = 'verified'
                AND cardinality(crew_intents) > 0
                AND NULLIF(BTRIM(COALESCE(photo_url, '')), '') IS NOT NULL
            )
        ),
    ADD CONSTRAINT sailor_crew_profiles_visible_profile_shape
        CHECK (
            crew_list_visibility <> 'visible'
            OR (
                community_enabled
                AND approval_status = 'approved'
                AND verification_status = 'verified'
                AND cardinality(crew_intents) > 0
                AND NULLIF(BTRIM(COALESCE(photo_url, '')), '') IS NOT NULL
            )
        );

CREATE INDEX IF NOT EXISTS sailor_crew_profiles_public_browse_idx
    ON public.sailor_crew_profiles (listing_type, updated_at DESC)
    WHERE community_enabled
      AND crew_list_visibility = 'visible'
      AND approval_status = 'approved'
      AND verification_status = 'verified';

CREATE INDEX IF NOT EXISTS sailor_crew_profiles_public_intents_idx
    ON public.sailor_crew_profiles USING GIN (crew_intents)
    WHERE community_enabled
      AND crew_list_visibility = 'visible'
      AND approval_status = 'approved'
      AND verification_status = 'verified';

-- A client may edit its profile or submit it for review, but it can never
-- manufacture a verification/approval result.  Admin review happens only via
-- the narrowly scoped RPC below; service-role jobs may also update the row.
CREATE OR REPLACE FUNCTION public.guard_sailor_crew_profile_beta()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    is_elevated BOOLEAN := COALESCE(auth.role(), '') = 'service_role'
        OR public.is_chat_admin(auth.uid());
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Crew profile ownership is immutable';
    END IF;

    IF is_elevated THEN
        RETURN NEW;
    END IF;

    IF COALESCE(auth.role(), '') <> 'authenticated'
       OR auth.uid() IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'Only the profile owner may edit this Crew List profile';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.approval_status <> 'draft'
           OR NEW.verification_status <> 'unverified'
           OR NEW.is_verified
           OR NEW.review_requested_at IS NOT NULL
           OR NEW.reviewed_at IS NOT NULL
           OR NEW.reviewed_by IS NOT NULL
           OR NEW.crew_list_visibility <> 'private' THEN
            RAISE EXCEPTION 'Crew List review fields are managed by Thalassa';
        END IF;
        RETURN NEW;
    END IF;

    -- An approval attests to the public-facing profile as reviewed.  Any
    -- material edit must therefore take the profile offline and require a new
    -- review; otherwise a verified owner could swap in a different headshot or
    -- public bio while retaining the old approval badge.
    IF OLD.approval_status = 'approved' AND (
        NEW.listing_type IS DISTINCT FROM OLD.listing_type
        OR NEW.first_name IS DISTINCT FROM OLD.first_name
        OR NEW.gender IS DISTINCT FROM OLD.gender
        OR NEW.age_range IS DISTINCT FROM OLD.age_range
        OR NEW.has_partner IS DISTINCT FROM OLD.has_partner
        OR NEW.partner_details IS DISTINCT FROM OLD.partner_details
        OR NEW.skills IS DISTINCT FROM OLD.skills
        OR NEW.sailing_experience IS DISTINCT FROM OLD.sailing_experience
        OR NEW.sailing_region IS DISTINCT FROM OLD.sailing_region
        OR NEW.available_from IS DISTINCT FROM OLD.available_from
        OR NEW.available_to IS DISTINCT FROM OLD.available_to
        OR NEW.bio IS DISTINCT FROM OLD.bio
        OR NEW.vibe IS DISTINCT FROM OLD.vibe
        OR NEW.languages IS DISTINCT FROM OLD.languages
        OR NEW.smoking IS DISTINCT FROM OLD.smoking
        OR NEW.drinking IS DISTINCT FROM OLD.drinking
        OR NEW.pets IS DISTINCT FROM OLD.pets
        OR NEW.interests IS DISTINCT FROM OLD.interests
        OR NEW.location_city IS DISTINCT FROM OLD.location_city
        OR NEW.location_state IS DISTINCT FROM OLD.location_state
        OR NEW.location_country IS DISTINCT FROM OLD.location_country
        OR NEW.photo_url IS DISTINCT FROM OLD.photo_url
        OR NEW.photos IS DISTINCT FROM OLD.photos
        OR NEW.crew_intents IS DISTINCT FROM OLD.crew_intents
    ) THEN
        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.crew_list_visibility := 'private';
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        RETURN NEW;
    END IF;

    IF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
        RAISE EXCEPTION 'Crew List verification is managed by Thalassa';
    END IF;

    IF NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.review_requested_at IS DISTINCT FROM OLD.review_requested_at
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
        -- Owners may only submit/re-submit a draft or rejected profile.  A
        -- submission is intentionally private until an admin verifies it.
        IF NOT (
            OLD.approval_status IN ('draft', 'rejected')
            AND NEW.approval_status = 'pending'
            AND NEW.verification_status = 'pending'
            AND NEW.review_requested_at IS NOT NULL
            AND NEW.reviewed_at IS NULL
            AND NEW.reviewed_by IS NULL
            AND NEW.crew_list_visibility = 'private'
        ) THEN
            RAISE EXCEPTION 'Crew List review fields are managed by Thalassa';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sailor_crew_profiles_beta_guard ON public.sailor_crew_profiles;
CREATE TRIGGER sailor_crew_profiles_beta_guard
    BEFORE INSERT OR UPDATE ON public.sailor_crew_profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_sailor_crew_profile_beta();

ALTER TABLE public.sailor_crew_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view crew profiles" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can insert own crew profile" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can update own crew profile" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "Users can delete own crew profile" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "crew_profiles_owner_or_approved_visible" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "crew_profiles_owner_create" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "crew_profiles_owner_update" ON public.sailor_crew_profiles;
DROP POLICY IF EXISTS "crew_profiles_owner_delete" ON public.sailor_crew_profiles;

CREATE POLICY "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.is_chat_admin(auth.uid())
        OR (
            community_enabled
            AND crew_list_visibility = 'visible'
            AND approval_status = 'approved'
            AND verification_status = 'verified'
        )
    );

CREATE POLICY "crew_profiles_owner_create"
    ON public.sailor_crew_profiles FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "crew_profiles_owner_update"
    ON public.sailor_crew_profiles FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "crew_profiles_owner_delete"
    ON public.sailor_crew_profiles FOR DELETE TO authenticated
    USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sailor_crew_profiles TO authenticated;

-- Admin-only review: callers cannot choose verification fields or reviewers.
CREATE OR REPLACE FUNCTION public.review_crew_profile(
    p_profile_user_id UUID,
    p_decision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    updated_profile BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR NOT public.is_chat_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Crew List administrator role required'
            USING ERRCODE = '42501';
    END IF;

    IF p_profile_user_id IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Invalid Crew List review request'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = p_decision,
           verification_status = CASE WHEN p_decision = 'approved' THEN 'verified' ELSE 'rejected' END,
           is_verified = p_decision = 'approved',
           crew_list_visibility = CASE WHEN p_decision = 'approved' THEN 'visible' ELSE 'private' END,
           reviewed_at = now(),
           reviewed_by = auth.uid(),
           updated_at = now()
     WHERE user_id = p_profile_user_id
       AND community_enabled
       AND approval_status = 'pending'
    RETURNING true INTO updated_profile;

    RETURN COALESCE(updated_profile, false);
END;
$$;

REVOKE ALL ON FUNCTION public.review_crew_profile(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_crew_profile(UUID, TEXT) TO authenticated;

-- ── Private, mutual-introduction requests ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crew_intro_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- A short, in-app-only note.  No separate contact fields exist by design.
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    CONSTRAINT crew_intro_requests_distinct_people CHECK (sender_id <> recipient_id),
    CONSTRAINT crew_intro_requests_status_check
        CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
    CONSTRAINT crew_intro_requests_message_length_check
        CHECK (char_length(message) BETWEEN 0 AND 500),
    CONSTRAINT crew_intro_requests_message_shape_check
        CHECK (
            message = BTRIM(message)
            AND message !~ E'[\\n\\r\\t]'
            AND message !~* '[[:alnum:]._%+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}'
            AND message !~* '(https?://|www[.]|[[:alnum:]-]+[.](com|net|org|edu|gov|io|co|app|dev|me|au|nz|uk|us|ca))'
            AND message !~ '[+]?([[:digit:]][[:digit:] .()/-]*){7,}'
        ),
    CONSTRAINT crew_intro_requests_state_timestamps_check
        CHECK (
            (status = 'pending' AND responded_at IS NULL AND withdrawn_at IS NULL)
            OR (status IN ('accepted', 'declined') AND responded_at IS NOT NULL AND withdrawn_at IS NULL)
            OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND responded_at IS NULL)
        ),
    CONSTRAINT crew_intro_requests_one_direction UNIQUE (sender_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS crew_intro_requests_sender_idx
    ON public.crew_intro_requests (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crew_intro_requests_recipient_idx
    ON public.crew_intro_requests (recipient_id, created_at DESC);

-- This helper runs outside the caller's dm_blocks RLS so a recipient's block
-- remains effective even though the sender cannot inspect that private row.
CREATE OR REPLACE FUNCTION public.can_send_crew_intro(p_recipient_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_recipient_id IS NOT NULL
       AND p_recipient_id <> auth.uid()
       AND EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = auth.uid()
              AND profile.community_enabled
              AND profile.crew_list_visibility = 'visible'
              AND profile.approval_status = 'approved'
              AND profile.verification_status = 'verified'
       )
       AND EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = p_recipient_id
              AND profile.community_enabled
              AND profile.crew_list_visibility = 'visible'
              AND profile.approval_status = 'approved'
              AND profile.verification_status = 'verified'
       )
       AND NOT EXISTS (
            SELECT 1
            FROM public.dm_blocks block
            WHERE (block.blocker_id = auth.uid() AND block.blocked_id = p_recipient_id)
               OR (block.blocker_id = p_recipient_id AND block.blocked_id = auth.uid())
       );
$$;

REVOKE ALL ON FUNCTION public.can_send_crew_intro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_crew_intro(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_crew_intro_request_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
       OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Crew introductions are immutable apart from their response state';
    END IF;

    IF COALESCE(auth.role(), '') = 'service_role' THEN
        RETURN NEW;
    END IF;

    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'A resolved Crew List introduction cannot be changed';
    END IF;

    IF auth.uid() = OLD.sender_id AND NEW.status = 'withdrawn' THEN
        NEW.responded_at := NULL;
        NEW.withdrawn_at := now();
        RETURN NEW;
    END IF;

    IF auth.uid() = OLD.recipient_id AND NEW.status IN ('accepted', 'declined') THEN
        NEW.responded_at := now();
        NEW.withdrawn_at := NULL;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Only the request sender may withdraw or the recipient may respond';
END;
$$;

DROP TRIGGER IF EXISTS crew_intro_requests_state_guard ON public.crew_intro_requests;
CREATE TRIGGER crew_intro_requests_state_guard
    BEFORE UPDATE ON public.crew_intro_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_crew_intro_request_update();

ALTER TABLE public.crew_intro_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_intro_requests_participants_read" ON public.crew_intro_requests;
DROP POLICY IF EXISTS "crew_intro_requests_sender_create" ON public.crew_intro_requests;
DROP POLICY IF EXISTS "crew_intro_requests_participants_update" ON public.crew_intro_requests;

CREATE POLICY "crew_intro_requests_participants_read"
    ON public.crew_intro_requests FOR SELECT TO authenticated
    USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "crew_intro_requests_sender_create"
    ON public.crew_intro_requests FOR INSERT TO authenticated
    WITH CHECK (
        sender_id = auth.uid()
        AND status = 'pending'
        AND responded_at IS NULL
        AND withdrawn_at IS NULL
        AND public.can_send_crew_intro(recipient_id)
    );

CREATE POLICY "crew_intro_requests_participants_update"
    ON public.crew_intro_requests FOR UPDATE TO authenticated
    USING (
        (sender_id = auth.uid() OR recipient_id = auth.uid())
        AND status = 'pending'
    )
    WITH CHECK (
        (sender_id = auth.uid() AND status = 'withdrawn' AND withdrawn_at IS NOT NULL AND responded_at IS NULL)
        OR (
            recipient_id = auth.uid()
            AND status IN ('accepted', 'declined')
            AND responded_at IS NOT NULL
            AND withdrawn_at IS NULL
        )
    );

GRANT SELECT, INSERT, UPDATE ON public.crew_intro_requests TO authenticated;

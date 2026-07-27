-- Follow-up hardening for the Crew List beta.
--
-- This deliberately creates a separate, consent-gated conversation path for
-- Crew List introductions. Generic chat and Marketplace DMs retain their
-- existing flows, except that a discoverable Crew List recipient cannot be
-- contacted cold through the generic DM table as a bypass around consent.

-- ── Public-profile content and lifecycle ─────────────────────────────────

-- Crew List profiles are public-facing only after review.  Keep contact
-- details and precise positions out of the stored public fields as a
-- database backstop; client validation is only a usability aid.
CREATE OR REPLACE FUNCTION public.crew_list_public_text_is_safe(
    p_value TEXT,
    p_max_length INTEGER,
    p_reject_exact_coordinates BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_value IS NULL THEN
        RETURN true;
    END IF;

    IF p_max_length < 1 OR char_length(p_value) > p_max_length THEN
        RETURN false;
    END IF;

    IF p_value ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}'
       OR p_value ~* '(https?://|www[.]|([[:alnum:]]([[:alnum:]-]{0,61}[[:alnum:]])?[.])+[[:alpha:]]{2,63})'
       OR p_value ~ '[+]?([[:digit:]][[:digit:] .()/-]*){7,}' THEN
        RETURN false;
    END IF;

    -- Decimal lat/lon with cardinal suffixes, bare decimal lat/lon pairs,
    -- and common degrees/minutes notation.  Approximate local references are
    -- fine; this only catches precise coordinates that do not belong on a
    -- public Crew List profile.
    IF p_reject_exact_coordinates AND (
        p_value ~* '(^|[^[:digit:]])[-+]?([0-8]?[[:digit:]]|90)[.][[:digit:]]{3,}[[:space:]]*[NS][[:space:]]*[,;/ ]+[[:space:]]*[-+]?([[:digit:]]{1,2}|1[0-7][[:digit:]]|180)[.][[:digit:]]{3,}[[:space:]]*[EW]($|[^[:digit:]])'
        OR p_value ~ '(^|[^[:digit:]])[-+]?([0-8]?[[:digit:]]|90)[.][[:digit:]]{3,}[[:space:]]*[,;/][[:space:]]*[-+]?([[:digit:]]{1,2}|1[0-7][[:digit:]]|180)[.][[:digit:]]{3,}($|[^[:digit:]])'
        OR p_value ~* '[[:digit:]]{1,2}[°º][[:space:]]*[[:digit:]]{1,2}([[:space:]]*[''’][[:space:]]*[[:digit:]]{1,2}([.][[:digit:]]+)?["”]?)?[[:space:]]*[NS].{0,24}[[:digit:]]{1,3}[°º][[:space:]]*[[:digit:]]{1,2}([[:space:]]*[''’][[:space:]]*[[:digit:]]{1,2}([.][[:digit:]]+)?["”]?)?[[:space:]]*[EW]'
    ) THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.crew_list_public_text_array_is_safe(
    p_values TEXT[],
    p_max_items INTEGER,
    p_item_max_length INTEGER,
    p_reject_exact_coordinates BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    public_value TEXT;
BEGIN
    IF p_values IS NULL THEN
        RETURN true;
    END IF;

    IF p_max_items < 0 OR cardinality(p_values) > p_max_items THEN
        RETURN false;
    END IF;

    FOREACH public_value IN ARRAY p_values LOOP
        IF public_value IS NULL
           OR NOT public.crew_list_public_text_is_safe(
                public_value,
                p_item_max_length,
                p_reject_exact_coordinates
           ) THEN
            RETURN false;
        END IF;
    END LOOP;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.crew_list_public_text_is_safe(TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_list_public_text_array_is_safe(TEXT[], INTEGER, INTEGER, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_list_public_text_is_safe(TEXT, INTEGER, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crew_list_public_text_array_is_safe(TEXT[], INTEGER, INTEGER, BOOLEAN) TO authenticated, service_role;

-- Introduction notes are deliberately as conservative as public Crew List
-- text until both sailors have consented. The generic bare-domain predicate
-- closes the old fixed-TLD gap (for example `crew.xyz`). `NOT VALID` preserves
-- historical immutable notes while enforcing the stronger rule for every new
-- or changed row from this deployment onward.
ALTER TABLE public.crew_intro_requests
    DROP CONSTRAINT IF EXISTS crew_intro_requests_message_shape_check;

ALTER TABLE public.crew_intro_requests
    ADD CONSTRAINT crew_intro_requests_message_shape_check
        CHECK (
            message = BTRIM(message)
            AND message !~ E'[\\n\\r\\t]'
            AND public.crew_list_public_text_is_safe(message, 500, true)
        ) NOT VALID;

-- Crew List verification photos are never uploaded to the public chat-avatar
-- bucket. The profile stores private object paths; the service mints a short
-- signed display URL only for the owner, a reviewer, or an eligible viewer.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'crew-list-photos',
    'crew-list-photos',
    false,
    2097152,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.sailor_crew_profiles
    ADD COLUMN IF NOT EXISTS crew_photo_path TEXT,
    ADD COLUMN IF NOT EXISTS crew_photo_paths TEXT[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.crew_list_photo_path_is_valid(
    p_path TEXT,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT p_path IS NOT NULL
       AND p_user_id IS NOT NULL
       AND split_part(p_path, '/', 1) = p_user_id::TEXT
       AND p_path ~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9._-]{1,180}[.]jpg$';
$$;

CREATE OR REPLACE FUNCTION public.crew_list_photo_paths_are_valid(
    p_paths TEXT[],
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
    photo_path TEXT;
BEGIN
    IF p_paths IS NULL OR cardinality(p_paths) > 6 THEN
        RETURN false;
    END IF;

    FOREACH photo_path IN ARRAY p_paths LOOP
        IF NOT public.crew_list_photo_path_is_valid(photo_path, p_user_id) THEN
            RETURN false;
        END IF;
    END LOOP;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.crew_list_photo_path_is_valid(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crew_list_photo_paths_are_valid(TEXT[], UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_list_photo_path_is_valid(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crew_list_photo_paths_are_valid(TEXT[], UUID) TO authenticated, service_role;

-- Earlier beta approvals could only point to the public chat-avatar bucket.
-- Downgrade those rows before the private-photo/review constraints land, so a
-- deploy cannot preserve a public legacy headshot or fail on malformed legacy
-- text. Owners keep their draft data but must upload a new private headshot
-- and submit the exact profile that is to be reviewed.
ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER sailor_crew_profiles_beta_guard;

UPDATE public.sailor_crew_profiles
   SET crew_list_visibility = 'private',
       approval_status = 'draft',
       verification_status = 'unverified',
       is_verified = false,
       review_requested_at = NULL,
       reviewed_at = NULL,
       reviewed_by = NULL,
       photo_url = NULL,
       photos = ARRAY[]::TEXT[]
 WHERE approval_status IN ('pending', 'approved');

UPDATE public.sailor_crew_profiles
   SET photo_url = NULL,
       photos = ARRAY[]::TEXT[]
 WHERE photo_url IS NOT NULL
    OR cardinality(COALESCE(photos, ARRAY[]::TEXT[])) > 0;

ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER sailor_crew_profiles_beta_guard;

-- Disabling the feature is a true privacy reset: it takes the profile offline
-- and removes the approval attestation.  A later re-enable is deliberately a
-- fresh submit/review, while already-accepted conversations remain intact.
CREATE OR REPLACE FUNCTION public.guard_sailor_crew_profile_beta()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    is_service_role BOOLEAN := COALESCE(auth.role(), '') = 'service_role';
    is_trusted_reviewer BOOLEAN := current_user <> session_user
        AND public.is_chat_admin(auth.uid())
        AND NEW.user_id IS DISTINCT FROM auth.uid();
    is_elevated BOOLEAN := is_service_role OR is_trusted_reviewer;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Crew profile ownership is immutable';
    END IF;

    IF NOT is_elevated AND (
        COALESCE(auth.role(), '') <> 'authenticated'
        OR auth.uid() IS DISTINCT FROM NEW.user_id
    ) THEN
        RAISE EXCEPTION 'Only the profile owner may edit this Crew List profile';
    END IF;

    IF NEW.photo_url IS NOT NULL
       OR cardinality(COALESCE(NEW.photos, ARRAY[]::TEXT[])) > 0 THEN
        RAISE EXCEPTION 'Crew List photos must use private Crew List storage paths'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.crew_list_photo_paths_are_valid(NEW.crew_photo_paths, NEW.user_id)
       OR (
            NEW.crew_photo_path IS NULL
            AND cardinality(NEW.crew_photo_paths) <> 0
       )
       OR (
            NEW.crew_photo_path IS NOT NULL
            AND (
                NOT public.crew_list_photo_path_is_valid(NEW.crew_photo_path, NEW.user_id)
                OR NOT (NEW.crew_photo_path = ANY(NEW.crew_photo_paths))
            )
       ) THEN
        RAISE EXCEPTION 'Crew List photos must belong to this sailor in private storage'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.crew_list_public_text_is_safe(NEW.first_name, 80, false)
       OR NOT public.crew_list_public_text_is_safe(NEW.bio, 2000, true)
       OR NOT public.crew_list_public_text_is_safe(NEW.sailing_region, 160, true)
       OR NOT public.crew_list_public_text_is_safe(NEW.sailing_experience, 160, false)
       OR NOT public.crew_list_public_text_is_safe(NEW.partner_details, 500, true)
       OR NOT public.crew_list_public_text_is_safe(NEW.smoking, 80, false)
       OR NOT public.crew_list_public_text_is_safe(NEW.drinking, 80, false)
       OR NOT public.crew_list_public_text_is_safe(NEW.pets, 80, false)
       OR NOT public.crew_list_public_text_is_safe(NEW.location_city, 120, true)
       OR NOT public.crew_list_public_text_is_safe(NEW.location_state, 120, true)
       OR NOT public.crew_list_public_text_is_safe(NEW.location_country, 120, true)
       OR NOT public.crew_list_public_text_array_is_safe(NEW.skills, 30, 80, false)
       OR NOT public.crew_list_public_text_array_is_safe(NEW.vibe, 20, 80, false)
       OR NOT public.crew_list_public_text_array_is_safe(NEW.languages, 20, 80, false)
       OR NOT public.crew_list_public_text_array_is_safe(NEW.interests, 40, 80, false) THEN
        RAISE EXCEPTION 'Keep email, phone, links, and exact coordinates out of public Crew List fields'
            USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.community_enabled AND NOT NEW.community_enabled THEN
        NEW.crew_list_visibility := 'private';
        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        RETURN NEW;
    END IF;

    IF is_elevated THEN
        RETURN NEW;
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
    IF OLD.approval_status IN ('approved', 'pending') AND (
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
        OR NEW.crew_photo_path IS DISTINCT FROM OLD.crew_photo_path
        OR NEW.crew_photo_paths IS DISTINCT FROM OLD.crew_photo_paths
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

-- Review is intentionally the only authenticated path that can transition a
-- profile into approved/verified state. Its SECURITY DEFINER identity is
-- recognised by the trigger, while ordinary client UPDATEs remain owner-only.
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

    IF p_profile_user_id IS NULL
       OR p_profile_user_id = auth.uid()
       OR p_decision NOT IN ('approved', 'rejected') THEN
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

ALTER TABLE public.sailor_crew_profiles
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_reviewable_profile_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_pending_review_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_approved_review_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_visible_profile_shape;

ALTER TABLE public.sailor_crew_profiles
    ADD CONSTRAINT sailor_crew_profiles_pending_review_shape
        CHECK (
            approval_status <> 'pending'
            OR (
                community_enabled
                AND verification_status = 'pending'
                AND review_requested_at IS NOT NULL
                AND cardinality(crew_intents) > 0
                AND NULLIF(BTRIM(COALESCE(crew_photo_path, '')), '') IS NOT NULL
            )
        ),
    ADD CONSTRAINT sailor_crew_profiles_approved_review_shape
        CHECK (
            approval_status <> 'approved'
            OR (
                community_enabled
                AND verification_status = 'verified'
                AND cardinality(crew_intents) > 0
                AND NULLIF(BTRIM(COALESCE(crew_photo_path, '')), '') IS NOT NULL
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
                AND NULLIF(BTRIM(COALESCE(crew_photo_path, '')), '') IS NOT NULL
            )
        ),
    ADD CONSTRAINT sailor_crew_profiles_reviewable_profile_shape
        CHECK (
            approval_status NOT IN ('pending', 'approved')
            OR (
                NULLIF(BTRIM(COALESCE(first_name, '')), '') IS NOT NULL
                AND char_length(BTRIM(first_name)) <= 80
                AND char_length(BTRIM(COALESCE(bio, ''))) BETWEEN 20 AND 2000
            )
        );

-- Keep RLS non-recursive: a SECURITY DEFINER helper checks the requesting
-- sailor's own profile, rather than querying this table from its own policy.
CREATE OR REPLACE FUNCTION public.crew_list_profile_is_discoverable(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = p_user_id
              AND profile.community_enabled
              AND profile.crew_list_visibility = 'visible'
              AND profile.approval_status = 'approved'
              AND profile.verification_status = 'verified'
              AND NULLIF(BTRIM(COALESCE(profile.crew_photo_path, '')), '') IS NOT NULL
       );
$$;

CREATE OR REPLACE FUNCTION public.can_browse_crew_list()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND public.crew_list_profile_is_discoverable(auth.uid());
$$;

REVOKE ALL ON FUNCTION public.crew_list_profile_is_discoverable(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_browse_crew_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_browse_crew_list() TO authenticated;

-- This pair-only helper deliberately reveals no dm_blocks rows. It is defined
-- before the photo access helper because both photo reads and profile browsing
-- must suppress either direction of a block.
CREATE OR REPLACE FUNCTION public.crew_list_pair_is_blocked(
    p_left_user_id UUID,
    p_right_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_left_user_id IS NOT NULL
       AND p_right_user_id IS NOT NULL
       AND p_left_user_id <> p_right_user_id
       AND EXISTS (
            SELECT 1
            FROM public.dm_blocks block
            WHERE (block.blocker_id = p_left_user_id AND block.blocked_id = p_right_user_id)
               OR (block.blocker_id = p_right_user_id AND block.blocked_id = p_left_user_id)
       );
$$;

REVOKE ALL ON FUNCTION public.crew_list_pair_is_blocked(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crew_list_pair_is_blocked(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_view_crew_list_photo(p_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_object_name IS NOT NULL
       AND (
            split_part(p_object_name, '/', 1) = auth.uid()::TEXT
            OR public.is_chat_admin(auth.uid())
            OR (
                EXISTS (
                    SELECT 1
                    FROM public.sailor_crew_profiles profile
                    WHERE profile.user_id::TEXT = split_part(p_object_name, '/', 1)
                      AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
                      AND (
                            profile.crew_photo_path = p_object_name
                         OR p_object_name = ANY(profile.crew_photo_paths)
                      )
                      AND (
                            (
                                public.can_browse_crew_list()
                                AND profile.community_enabled
                                AND profile.crew_list_visibility = 'visible'
                                AND profile.approval_status = 'approved'
                                AND profile.verification_status = 'verified'
                            )
                            OR EXISTS (
                                SELECT 1
                                FROM public.crew_intro_requests request
                                WHERE request.status = 'accepted'
                                  AND (
                                        (request.sender_id = auth.uid() AND request.recipient_id = profile.user_id)
                                     OR (request.sender_id = profile.user_id AND request.recipient_id = auth.uid())
                                  )
                            )
                      )
                )
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_view_crew_list_photo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_crew_list_photo(TEXT) TO authenticated;

DROP POLICY IF EXISTS "Crew List photo owner upload" ON storage.objects;
DROP POLICY IF EXISTS "Crew List photo owner update" ON storage.objects;
DROP POLICY IF EXISTS "Crew List photo owner delete" ON storage.objects;
DROP POLICY IF EXISTS "Crew List photo eligible read" ON storage.objects;

CREATE POLICY "Crew List photo owner upload"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'crew-list-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
        AND name ~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9._-]{1,180}[.]jpg$'
    );

CREATE POLICY "Crew List photo owner update"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'crew-list-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
    )
    WITH CHECK (
        bucket_id = 'crew-list-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
        AND name ~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9._-]{1,180}[.]jpg$'
    );

CREATE POLICY "Crew List photo owner delete"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'crew-list-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
    );

CREATE POLICY "Crew List photo eligible read"
    ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'crew-list-photos'
        AND public.can_view_crew_list_photo(name)
    );

-- The companion helper returns only the current sailor's bilateral suppression
-- set, so the client can mirror the server policy without reading dm_blocks.
CREATE OR REPLACE FUNCTION public.get_crew_list_blocked_user_ids()
RETURNS TABLE (user_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT CASE
        WHEN block.blocker_id = auth.uid() THEN block.blocked_id
        ELSE block.blocker_id
    END AS user_id
    FROM public.dm_blocks block
    WHERE auth.role() = 'authenticated'
      AND auth.uid() IS NOT NULL
      AND (block.blocker_id = auth.uid() OR block.blocked_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public.get_crew_list_blocked_user_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crew_list_blocked_user_ids() TO authenticated;

DROP POLICY IF EXISTS "crew_profiles_owner_or_approved_visible" ON public.sailor_crew_profiles;
CREATE POLICY "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.is_chat_admin(auth.uid())
    );

-- A browser never needs the raw profile row (review audit fields, direct asset
-- URLs, or future owner-only metadata). Keep base-table reads owner/admin-only
-- and expose a deliberately narrow, block-aware card feed through this
-- server-gated function instead. Opaque private object paths are included only
-- so the client can ask Storage for a policy-checked, short-lived signed URL.
CREATE OR REPLACE FUNCTION public.browse_crew_list_profiles(
    p_target_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    user_id UUID,
    listing_type TEXT,
    first_name TEXT,
    gender TEXT,
    age_range TEXT,
    has_partner BOOLEAN,
    partner_details TEXT,
    skills TEXT[],
    sailing_experience TEXT,
    sailing_region TEXT,
    available_from TEXT,
    available_to TEXT,
    bio TEXT,
    vibe TEXT[],
    languages TEXT[],
    smoking TEXT,
    drinking TEXT,
    pets TEXT,
    interests TEXT[],
    last_active TIMESTAMPTZ,
    location_state TEXT,
    location_country TEXT,
    crew_photo_path TEXT,
    crew_photo_paths TEXT[],
    community_enabled BOOLEAN,
    crew_intents TEXT[],
    crew_list_visibility TEXT,
    approval_status TEXT,
    verification_status TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT
        profile.user_id,
        profile.listing_type,
        profile.first_name,
        profile.gender,
        profile.age_range,
        COALESCE(profile.has_partner, false),
        profile.partner_details,
        COALESCE(profile.skills, ARRAY[]::TEXT[]),
        profile.sailing_experience,
        profile.sailing_region,
        profile.available_from,
        profile.available_to,
        profile.bio,
        COALESCE(profile.vibe, ARRAY[]::TEXT[]),
        COALESCE(profile.languages, ARRAY[]::TEXT[]),
        profile.smoking,
        profile.drinking,
        profile.pets,
        COALESCE(profile.interests, ARRAY[]::TEXT[]),
        profile.last_active,
        profile.location_state,
        profile.location_country,
        profile.crew_photo_path,
        COALESCE(profile.crew_photo_paths, ARRAY[]::TEXT[]),
        profile.community_enabled,
        COALESCE(profile.crew_intents, ARRAY[]::TEXT[]),
        profile.crew_list_visibility,
        profile.approval_status,
        profile.verification_status,
        profile.created_at,
        profile.updated_at
    FROM public.sailor_crew_profiles profile
    WHERE auth.role() = 'authenticated'
      AND auth.uid() IS NOT NULL
      AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
      AND (p_target_id IS NULL OR profile.user_id = p_target_id)
      AND (
            (
                public.can_browse_crew_list()
                AND profile.community_enabled
                AND profile.crew_list_visibility = 'visible'
                AND profile.approval_status = 'approved'
                AND profile.verification_status = 'verified'
            )
            OR (
                p_target_id IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM public.crew_intro_requests request
                    WHERE request.status = 'accepted'
                      AND (
                            (request.sender_id = auth.uid() AND request.recipient_id = profile.user_id)
                         OR (request.sender_id = profile.user_id AND request.recipient_id = auth.uid())
                      )
                )
            )
      )
    ORDER BY profile.updated_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 100));
$$;

REVOKE ALL ON FUNCTION public.browse_crew_list_profiles(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.browse_crew_list_profiles(UUID, INTEGER) TO authenticated;

-- A visible Crew List card exposes a user id to the app, so generic DMs need
-- the same first-contact consent fence. Existing generic conversations and
-- all non-discoverable recipients keep working exactly as before; new contact
-- with a discoverable Crew List sailor must follow an accepted introduction.
CREATE OR REPLACE FUNCTION public.can_send_generic_dm_to_recipient(p_recipient_id UUID)
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
       AND (
            NOT public.crew_list_profile_is_discoverable(p_recipient_id)
            OR EXISTS (
                SELECT 1
                FROM public.crew_intro_requests request
                WHERE request.status = 'accepted'
                  AND (
                        (request.sender_id = auth.uid() AND request.recipient_id = p_recipient_id)
                     OR (request.sender_id = p_recipient_id AND request.recipient_id = auth.uid())
                  )
            )
            OR EXISTS (
                SELECT 1
                FROM public.chat_direct_messages dm
                WHERE (dm.sender_id = auth.uid() AND dm.recipient_id = p_recipient_id)
                   OR (dm.sender_id = p_recipient_id AND dm.recipient_id = auth.uid())
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_send_generic_dm_to_recipient(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_generic_dm_to_recipient(UUID) TO authenticated;

DROP POLICY IF EXISTS "Users can send unblocked DMs" ON public.chat_direct_messages;
CREATE POLICY "Users can send unblocked DMs" ON public.chat_direct_messages FOR INSERT TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    AND sender_id <> recipient_id
    AND char_length(message) BETWEEN 1 AND 4000
    AND char_length(sender_name) BETWEEN 1 AND 120
    AND NOT EXISTS (
        SELECT 1
        FROM public.dm_blocks block
        WHERE (block.blocker_id = sender_id AND block.blocked_id = recipient_id)
           OR (block.blocker_id = recipient_id AND block.blocked_id = sender_id)
    )
    AND NOT EXISTS (
        SELECT 1
        FROM public.chat_roles chat_role
        WHERE chat_role.user_id = auth.uid()
          AND (COALESCE(chat_role.is_blocked, false) OR chat_role.muted_until > now())
    )
    AND public.can_send_generic_dm_to_recipient(recipient_id)
);

-- A reciprocal pair of pending introductions could exist before this version.
-- Preserve the request row for audit, but mark the later duplicate as
-- superseded before the canonical conversation backfill runs. New accepts are
-- prevented atomically by reserve_crew_intro_conversation below.
ALTER TABLE public.crew_intro_requests
    DROP CONSTRAINT IF EXISTS crew_intro_requests_status_check,
    DROP CONSTRAINT IF EXISTS crew_intro_requests_state_timestamps_check;

ALTER TABLE public.crew_intro_requests
    ADD CONSTRAINT crew_intro_requests_status_check
        CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'superseded')),
    ADD CONSTRAINT crew_intro_requests_state_timestamps_check
        CHECK (
            (status = 'pending' AND responded_at IS NULL AND withdrawn_at IS NULL)
            OR (status IN ('accepted', 'declined', 'superseded') AND responded_at IS NOT NULL AND withdrawn_at IS NULL)
            OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND responded_at IS NULL)
        );

ALTER TABLE public.crew_intro_requests DISABLE TRIGGER crew_intro_requests_state_guard;

WITH ranked_accepted_requests AS (
    SELECT
        request.id,
        row_number() OVER (
            PARTITION BY LEAST(request.sender_id, request.recipient_id), GREATEST(request.sender_id, request.recipient_id)
            ORDER BY request.responded_at ASC NULLS LAST, request.created_at ASC, request.id ASC
        ) AS accepted_rank
    FROM public.crew_intro_requests request
    WHERE request.status = 'accepted'
)
UPDATE public.crew_intro_requests request
   SET status = 'superseded',
       responded_at = COALESCE(request.responded_at, now()),
       withdrawn_at = NULL
  FROM ranked_accepted_requests ranked
 WHERE request.id = ranked.id
   AND ranked.accepted_rank > 1;

ALTER TABLE public.crew_intro_requests ENABLE TRIGGER crew_intro_requests_state_guard;

-- Both parties must remain approved and visible at the moment an introduction
-- is accepted.  Once accepted, the conversation does not depend on either
-- listing remaining active, so pausing never strands an already-consenting pair.
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
       AND public.crew_list_profile_is_discoverable(auth.uid())
       AND public.crew_list_profile_is_discoverable(p_recipient_id)
       AND NOT public.crew_list_pair_is_blocked(auth.uid(), p_recipient_id)
       AND NOT EXISTS (
            SELECT 1
            FROM public.crew_intro_requests request
            WHERE request.status = 'accepted'
              AND (
                    (request.sender_id = auth.uid() AND request.recipient_id = p_recipient_id)
                 OR (request.sender_id = p_recipient_id AND request.recipient_id = auth.uid())
              )
       );
$$;

CREATE OR REPLACE FUNCTION public.can_accept_crew_intro(
    p_sender_id UUID,
    p_recipient_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() = p_recipient_id
       AND p_sender_id IS NOT NULL
       AND p_recipient_id IS NOT NULL
       AND p_sender_id <> p_recipient_id
       AND public.crew_list_profile_is_discoverable(p_sender_id)
       AND public.crew_list_profile_is_discoverable(p_recipient_id)
       AND NOT public.crew_list_pair_is_blocked(p_sender_id, p_recipient_id)
       AND NOT EXISTS (
            SELECT 1
            FROM public.crew_intro_requests request
            WHERE request.status = 'accepted'
              AND (
                    (request.sender_id = p_sender_id AND request.recipient_id = p_recipient_id)
                 OR (request.sender_id = p_recipient_id AND request.recipient_id = p_sender_id)
              )
       );
$$;

REVOKE ALL ON FUNCTION public.can_send_crew_intro(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_accept_crew_intro(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_crew_intro(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_accept_crew_intro(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_crew_intro_request_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
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
        IF NEW.status = 'accepted'
           AND NOT public.can_accept_crew_intro(OLD.sender_id, OLD.recipient_id) THEN
            RAISE EXCEPTION 'Both Crew List profiles must remain approved, active, and unblocked to accept an introduction'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.status = 'accepted' THEN
            PERFORM public.reserve_crew_intro_conversation(NEW.id, OLD.sender_id, OLD.recipient_id);
        END IF;
        NEW.responded_at := now();
        NEW.withdrawn_at := NULL;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Only the request sender may withdraw or the recipient may respond';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_intro_request_update() FROM PUBLIC, anon, authenticated;

-- ── Server-gated Crew List conversations ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crew_intro_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The first accepted request that established this private conversation.
    -- A canonical pair constraint prevents a duplicate thread if both sailors
    -- happened to send introductions before either one accepted.
    intro_request_id UUID NOT NULL UNIQUE REFERENCES public.crew_intro_requests(id) ON DELETE CASCADE,
    participant_one_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    participant_two_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT crew_intro_conversations_distinct_people CHECK (participant_one_id <> participant_two_id),
    CONSTRAINT crew_intro_conversations_canonical_pair CHECK (participant_one_id < participant_two_id),
    CONSTRAINT crew_intro_conversations_one_pair UNIQUE (participant_one_id, participant_two_id)
);

CREATE INDEX IF NOT EXISTS crew_intro_conversations_participant_one_idx
    ON public.crew_intro_conversations (participant_one_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crew_intro_conversations_participant_two_idx
    ON public.crew_intro_conversations (participant_two_id, created_at DESC);

-- Reserve the canonical thread inside the BEFORE acceptance guard. The unique
-- pair insert is an atomic consent fence: crossed requests cannot both become
-- accepted under concurrent transactions.
CREATE OR REPLACE FUNCTION public.reserve_crew_intro_conversation(
    p_intro_request_id UUID,
    p_sender_id UUID,
    p_recipient_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    first_participant UUID;
    second_participant UUID;
    conversation_id UUID;
BEGIN
    IF p_intro_request_id IS NULL
       OR p_sender_id IS NULL
       OR p_recipient_id IS NULL
       OR p_sender_id = p_recipient_id THEN
        RAISE EXCEPTION 'Invalid Crew List conversation reservation'
            USING ERRCODE = '22023';
    END IF;

    IF p_sender_id < p_recipient_id THEN
        first_participant := p_sender_id;
        second_participant := p_recipient_id;
    ELSE
        first_participant := p_recipient_id;
        second_participant := p_sender_id;
    END IF;

    INSERT INTO public.crew_intro_conversations (
        intro_request_id,
        participant_one_id,
        participant_two_id
    )
    VALUES (
        p_intro_request_id,
        first_participant,
        second_participant
    )
    ON CONFLICT (participant_one_id, participant_two_id) DO NOTHING
    RETURNING id INTO conversation_id;

    IF conversation_id IS NULL THEN
        RAISE EXCEPTION 'A Crew List conversation already exists for these sailors'
            USING ERRCODE = '23505';
    END IF;

    RETURN conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_crew_intro_conversation(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS crew_intro_requests_create_conversation ON public.crew_intro_requests;

-- Existing accepted introductions (if any) gain the same private conversation
-- path at deploy time.  Their request rows remain the consent audit trail.
INSERT INTO public.crew_intro_conversations (
    intro_request_id,
    participant_one_id,
    participant_two_id
)
SELECT
    request.id,
    CASE WHEN request.sender_id < request.recipient_id THEN request.sender_id ELSE request.recipient_id END,
    CASE WHEN request.sender_id < request.recipient_id THEN request.recipient_id ELSE request.sender_id END
FROM public.crew_intro_requests request
WHERE request.status = 'accepted'
ON CONFLICT (participant_one_id, participant_two_id) DO NOTHING;

ALTER TABLE public.crew_intro_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_intro_conversations_participants_read" ON public.crew_intro_conversations;
CREATE POLICY "crew_intro_conversations_participants_read"
    ON public.crew_intro_conversations FOR SELECT TO authenticated
    USING (auth.uid() = participant_one_id OR auth.uid() = participant_two_id);

REVOKE ALL ON TABLE public.crew_intro_conversations FROM anon, authenticated;
GRANT SELECT ON TABLE public.crew_intro_conversations TO authenticated;

CREATE TABLE IF NOT EXISTS public.crew_intro_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.crew_intro_conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT crew_intro_messages_message_shape CHECK (
        message = BTRIM(message)
        AND char_length(message) BETWEEN 1 AND 2000
    )
);

CREATE INDEX IF NOT EXISTS crew_intro_messages_conversation_idx
    ON public.crew_intro_messages (conversation_id, created_at ASC);

-- A listing may be paused after both sailors consented.  Conversation message
-- rights are therefore based on that accepted introduction and block status,
-- not on the listing still being visible.  A block immediately freezes both
-- directions without deleting the private history.
CREATE OR REPLACE FUNCTION public.can_send_crew_intro_message(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_conversation_id IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.crew_intro_conversations conversation
            WHERE conversation.id = p_conversation_id
              AND (conversation.participant_one_id = auth.uid() OR conversation.participant_two_id = auth.uid())
              AND EXISTS (
                    SELECT 1
                    FROM public.crew_intro_requests request
                    WHERE request.status = 'accepted'
                      AND (
                            (request.sender_id = conversation.participant_one_id AND request.recipient_id = conversation.participant_two_id)
                         OR (request.sender_id = conversation.participant_two_id AND request.recipient_id = conversation.participant_one_id)
                      )
              )
              AND NOT public.crew_list_pair_is_blocked(
                    conversation.participant_one_id,
                    conversation.participant_two_id
              )
       );
$$;

REVOKE ALL ON FUNCTION public.can_send_crew_intro_message(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_crew_intro_message(UUID) TO authenticated;

ALTER TABLE public.crew_intro_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_intro_messages_participants_read" ON public.crew_intro_messages;
DROP POLICY IF EXISTS "crew_intro_messages_accepted_insert" ON public.crew_intro_messages;

CREATE POLICY "crew_intro_messages_participants_read"
    ON public.crew_intro_messages FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.crew_intro_conversations conversation
            WHERE conversation.id = conversation_id
              AND (conversation.participant_one_id = auth.uid() OR conversation.participant_two_id = auth.uid())
        )
    );

CREATE POLICY "crew_intro_messages_accepted_insert"
    ON public.crew_intro_messages FOR INSERT TO authenticated
    WITH CHECK (
        sender_id = auth.uid()
        AND public.can_send_crew_intro_message(conversation_id)
    );

REVOKE ALL ON TABLE public.crew_intro_messages FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.crew_intro_messages TO authenticated;

-- Delete a Crew List profile without leaving a later-acceptance side door.
-- Accepted conversations are intentionally untouched: their consent has
-- already been established and their own message gate handles blocks.
CREATE OR REPLACE FUNCTION public.retire_pending_crew_intro_requests_on_profile_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE public.crew_intro_requests
       SET status = CASE WHEN sender_id = OLD.user_id THEN 'withdrawn' ELSE 'declined' END,
           responded_at = CASE WHEN recipient_id = OLD.user_id THEN now() ELSE NULL END,
           withdrawn_at = CASE WHEN sender_id = OLD.user_id THEN now() ELSE NULL END
     WHERE status = 'pending'
       AND (sender_id = OLD.user_id OR recipient_id = OLD.user_id);

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS sailor_crew_profiles_retire_pending_intros ON public.sailor_crew_profiles;
CREATE TRIGGER sailor_crew_profiles_retire_pending_intros
    BEFORE DELETE ON public.sailor_crew_profiles
    FOR EACH ROW EXECUTE FUNCTION public.retire_pending_crew_intro_requests_on_profile_delete();

-- ── Private Crew List reports ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crew_list_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reported_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT crew_list_reports_distinct_people CHECK (reporter_id <> reported_id),
    CONSTRAINT crew_list_reports_reason_shape CHECK (
        reason = BTRIM(reason)
        AND char_length(reason) BETWEEN 1 AND 2000
    ),
    CONSTRAINT crew_list_reports_status_check CHECK (status IN ('pending', 'resolved', 'dismissed')),
    CONSTRAINT crew_list_reports_review_shape CHECK (
        (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR (status IN ('resolved', 'dismissed') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);

-- Be defensive if an earlier beta deploy created the report table before the
-- lifecycle fields landed. A table-level pair UNIQUE would permanently block
-- a new report after resolution, so replace it with the open-report index.
ALTER TABLE public.crew_list_reports
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    DROP CONSTRAINT IF EXISTS crew_list_reports_one_open_report_per_pair,
    DROP CONSTRAINT IF EXISTS crew_list_reports_status_check,
    DROP CONSTRAINT IF EXISTS crew_list_reports_review_shape;

ALTER TABLE public.crew_list_reports
    ADD CONSTRAINT crew_list_reports_status_check CHECK (status IN ('pending', 'resolved', 'dismissed')),
    ADD CONSTRAINT crew_list_reports_review_shape CHECK (
        (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR (status IN ('resolved', 'dismissed') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS crew_list_reports_reported_idx
    ON public.crew_list_reports (reported_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS crew_list_reports_one_open_report_per_pair_idx
    ON public.crew_list_reports (reporter_id, reported_id)
    WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.can_report_crew_list_user(p_reported_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_reported_id IS NOT NULL
       AND p_reported_id <> auth.uid()
       AND public.crew_list_profile_is_discoverable(auth.uid())
       AND (
            public.crew_list_profile_is_discoverable(p_reported_id)
            OR EXISTS (
                SELECT 1
                FROM public.crew_intro_requests request
                WHERE request.status = 'accepted'
                  AND (
                        (request.sender_id = auth.uid() AND request.recipient_id = p_reported_id)
                     OR (request.sender_id = p_reported_id AND request.recipient_id = auth.uid())
                  )
            )
       );
$$;

REVOKE ALL ON FUNCTION public.can_report_crew_list_user(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_report_crew_list_user(UUID) TO authenticated;

-- A report is private to its reporter and reviewers. Only a separate admin
-- RPC may resolve it, leaving a durable decision trail and allowing a later
-- report if the original one was dismissed or resolved.
CREATE OR REPLACE FUNCTION public.review_crew_list_report(
    p_report_id UUID,
    p_decision TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    updated_report BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR NOT public.is_chat_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Crew List administrator role required'
            USING ERRCODE = '42501';
    END IF;

    IF p_report_id IS NULL OR p_decision NOT IN ('resolved', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid Crew List report decision'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.crew_list_reports
       SET status = p_decision,
           reviewed_at = now(),
           reviewed_by = auth.uid()
     WHERE id = p_report_id
       AND status = 'pending'
    RETURNING true INTO updated_report;

    RETURN COALESCE(updated_report, false);
END;
$$;

REVOKE ALL ON FUNCTION public.review_crew_list_report(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_crew_list_report(UUID, TEXT) TO authenticated;

ALTER TABLE public.crew_list_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crew_list_reports_reporter_or_admin_read" ON public.crew_list_reports;
DROP POLICY IF EXISTS "crew_list_reports_reporter_create" ON public.crew_list_reports;

CREATE POLICY "crew_list_reports_reporter_or_admin_read"
    ON public.crew_list_reports FOR SELECT TO authenticated
    USING (reporter_id = auth.uid() OR public.is_chat_admin(auth.uid()));

CREATE POLICY "crew_list_reports_reporter_create"
    ON public.crew_list_reports FOR INSERT TO authenticated
    WITH CHECK (
        reporter_id = auth.uid()
        AND public.can_report_crew_list_user(reported_id)
    );

REVOKE ALL ON TABLE public.crew_list_reports FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.crew_list_reports TO authenticated;

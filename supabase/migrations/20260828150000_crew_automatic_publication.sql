-- Risk-based, always-on publication for The Crew List.
--
-- A complete profile may be published automatically only after a trusted Edge
-- worker moderates the canonical database text and every exact private Storage
-- object.  The worker never trusts client-provided bytes or a client-provided
-- verdict.  Finalisation recomputes both snapshots under lock; any edit,
-- replacement, deletion, phone removal, account sanction, safety report, old
-- moderation hold, provider error, or ambiguous verdict fails closed into the
-- private human-review queue.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keep the public profile row auditable without exposing private risk reasons.
ALTER TABLE public.sailor_crew_profiles
    ADD COLUMN IF NOT EXISTS publication_source TEXT NOT NULL DEFAULT 'none';

ALTER TABLE public.sailor_crew_profiles
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_publication_source_check,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_publication_lifecycle_shape,
    DROP CONSTRAINT IF EXISTS sailor_crew_profiles_review_intent_shape;

ALTER TABLE public.sailor_crew_profiles
    ADD CONSTRAINT sailor_crew_profiles_publication_source_check
        CHECK (publication_source IN ('none', 'automatic', 'manual'));

-- Historical approved rows came only from the administrator RPC.  Preserve
-- that decision while making its source explicit.  Automatic rows do not yet
-- exist at this migration boundary.  This one migration-owned backfill must
-- bypass the owner and tombstone write fences; ALTER TABLE holds the table lock
-- throughout, and a failure rolls every trigger change back transactionally.
ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER account_deletion_write_fence;
ALTER TABLE public.sailor_crew_profiles DISABLE TRIGGER sailor_crew_profiles_beta_guard;
UPDATE public.sailor_crew_profiles
   SET publication_source = 'manual'
 WHERE approval_status = 'approved'
   AND publication_source = 'none';

-- A legacy review row with a mismatched/both-intents shape cannot safely be
-- described or discovered. Preserve its editable content as a private draft;
-- the sailor can choose one clear introduction path and publish again.
UPDATE public.sailor_crew_profiles
   SET approval_status = 'draft',
       verification_status = 'unverified',
       is_verified = false,
       crew_list_visibility = 'private',
       publication_source = 'none',
       review_requested_at = NULL,
       reviewed_at = NULL,
       reviewed_by = NULL,
       updated_at = statement_timestamp()
 WHERE approval_status IN ('pending', 'approved')
   AND (
        (listing_type = 'seeking_crew' AND crew_intents = ARRAY['find_crew']::TEXT[])
        OR (listing_type = 'seeking_berth' AND crew_intents = ARRAY['find_skipper']::TEXT[])
   ) IS NOT TRUE;
ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER sailor_crew_profiles_beta_guard;
ALTER TABLE public.sailor_crew_profiles ENABLE TRIGGER account_deletion_write_fence;

ALTER TABLE public.sailor_crew_profiles
    ADD CONSTRAINT sailor_crew_profiles_review_intent_shape
        CHECK (
            approval_status NOT IN ('pending', 'approved')
            OR (
                (listing_type = 'seeking_crew' AND crew_intents = ARRAY['find_crew']::TEXT[])
                OR (listing_type = 'seeking_berth' AND crew_intents = ARRAY['find_skipper']::TEXT[])
            ) IS TRUE
        ),
    ADD CONSTRAINT sailor_crew_profiles_publication_lifecycle_shape
        CHECK (
            (approval_status = 'approved' AND publication_source IN ('automatic', 'manual'))
            OR (approval_status <> 'approved' AND publication_source = 'none')
        );

-- Private, persistent safety holds survive profile edits, pausing, and
-- rejected-profile resubmission. Only a later human approval clears one.
CREATE TABLE public.crew_profile_review_holds (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9_]{1,48}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    cleared_at TIMESTAMPTZ,
    cleared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT crew_profile_review_hold_clear_shape CHECK (
        -- The actor may later be deleted, but a retained actor can never be
        -- attached to an uncleared hold.
        cleared_at IS NOT NULL OR cleared_by IS NULL
    )
);

ALTER TABLE public.crew_profile_review_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_profile_review_holds FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_profile_review_holds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_profile_review_holds TO service_role;

-- Short-lived attempts contain only keyed/canonical snapshot digests and
-- bounded status codes; profile text and image bytes are never copied here.
CREATE TABLE public.crew_profile_publication_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
    photo_manifest_digest TEXT NOT NULL CHECK (photo_manifest_digest ~ '^[0-9a-f]{64}$'),
    moderation_version TEXT NOT NULL CHECK (moderation_version ~ '^[a-z0-9._-]{1,40}$'),
    status TEXT NOT NULL DEFAULT 'checking'
        CHECK (status IN ('checking', 'approved', 'manual_review', 'stale')),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,48}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp() + interval '10 minutes',
    finalized_at TIMESTAMPTZ,
    CONSTRAINT crew_profile_publication_attempt_expiry CHECK (expires_at > created_at),
    CONSTRAINT crew_profile_publication_attempt_final_shape CHECK (
        (status = 'checking' AND finalized_at IS NULL)
        OR (status <> 'checking' AND finalized_at IS NOT NULL)
    )
);

ALTER TABLE public.crew_profile_publication_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_profile_publication_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_profile_publication_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_profile_publication_attempts TO service_role;

CREATE INDEX crew_profile_publication_attempts_user_idx
    ON public.crew_profile_publication_attempts (user_id, created_at DESC);
CREATE INDEX crew_profile_publication_attempts_expiry_idx
    ON public.crew_profile_publication_attempts (expires_at);

-- Append-only private decision history. Attempts are intentionally swept, but
-- a bounded record of why a profile published or entered review remains for
-- incident response. It contains hashes and codes only, never profile text,
-- phone numbers, provider payloads, or image bytes.
CREATE TABLE public.crew_profile_publication_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    attempt_id UUID REFERENCES public.crew_profile_publication_attempts(id) ON DELETE SET NULL,
    decision_channel TEXT NOT NULL
        CHECK (decision_channel IN ('automatic', 'administrator', 'system')),
    decision TEXT NOT NULL CHECK (decision IN ('published', 'manual_review', 'rejected')),
    reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9_]{1,48}$'),
    profile_digest TEXT CHECK (profile_digest IS NULL OR profile_digest ~ '^[0-9a-f]{64}$'),
    photo_manifest_digest TEXT
        CHECK (photo_manifest_digest IS NULL OR photo_manifest_digest ~ '^[0-9a-f]{64}$'),
    moderation_version TEXT
        CHECK (moderation_version IS NULL OR moderation_version ~ '^[a-z0-9._-]{1,40}$'),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.crew_profile_publication_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_profile_publication_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_profile_publication_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.crew_profile_publication_decisions TO service_role;

CREATE INDEX crew_profile_publication_decisions_user_idx
    ON public.crew_profile_publication_decisions (user_id, created_at DESC);

-- A current automatic approval remains bound to its exact canonical profile
-- and Storage-object manifest after the short-lived attempt is swept.
CREATE TABLE public.crew_profile_publication_attestations (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
    photo_manifest_digest TEXT NOT NULL CHECK (photo_manifest_digest ~ '^[0-9a-f]{64}$'),
    moderation_version TEXT NOT NULL CHECK (moderation_version ~ '^[a-z0-9._-]{1,40}$'),
    approved_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

ALTER TABLE public.crew_profile_publication_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_profile_publication_attestations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_profile_publication_attestations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_profile_publication_attestations TO service_role;

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_profile_review_holds;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_profile_review_holds
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_profile_publication_attempts;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_profile_publication_attempts
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_profile_publication_attestations;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.crew_profile_publication_attestations
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.crew_profile_publication_decisions;
CREATE TRIGGER account_deletion_write_fence
    -- Decisions are append-only. Keeping this fence INSERT-only also allows
    -- the attempt FK to perform its internal ON DELETE SET NULL during the
    -- bounded attempt sweep and during account deletion.
    BEFORE INSERT ON public.crew_profile_publication_decisions
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

CREATE OR REPLACE FUNCTION public.crew_list_public_profile_digest(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
    SELECT encode(
        digest(
            jsonb_build_object(
                'user_id', profile.user_id,
                'listing_type', profile.listing_type,
                'first_name', profile.first_name,
                'gender', profile.gender,
                'age_range', profile.age_range,
                'has_partner', profile.has_partner,
                'partner_details', profile.partner_details,
                'skills', profile.skills,
                'sailing_experience', profile.sailing_experience,
                'sailing_region', profile.sailing_region,
                'available_from', profile.available_from,
                'available_to', profile.available_to,
                'bio', profile.bio,
                'vibe', profile.vibe,
                'languages', profile.languages,
                'interests', profile.interests,
                'smoking', profile.smoking,
                'drinking', profile.drinking,
                'pets', profile.pets,
                'location_state', profile.location_state,
                'location_country', profile.location_country,
                'crew_photo_path', profile.crew_photo_path,
                'crew_photo_paths', profile.crew_photo_paths,
                'crew_intents', profile.crew_intents
            )::TEXT,
            'sha256'
        ),
        'hex'
    )
    FROM public.sailor_crew_profiles profile
    WHERE profile.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.crew_list_photo_manifest_digest(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, storage, extensions
AS $$
DECLARE
    expected_count INTEGER := 0;
    distinct_count INTEGER := 0;
    object_count INTEGER := 0;
    primary_path TEXT;
    first_path TEXT;
    manifest JSONB;
BEGIN
    SELECT cardinality(COALESCE(profile.crew_photo_paths, ARRAY[]::TEXT[])),
           profile.crew_photo_path,
           profile.crew_photo_paths[1],
           (
               SELECT count(DISTINCT listed.listed_path)
               FROM unnest(COALESCE(profile.crew_photo_paths, ARRAY[]::TEXT[])) AS listed(listed_path)
           )
      INTO expected_count, primary_path, first_path, distinct_count
      FROM public.sailor_crew_profiles profile
     WHERE profile.user_id = p_user_id;

    IF expected_count < 1
       OR expected_count > 6
       OR distinct_count <> expected_count
       OR primary_path IS DISTINCT FROM first_path THEN
        RETURN NULL;
    END IF;

    SELECT count(*),
           jsonb_agg(
               jsonb_build_object(
                   'ordinal', photo.ordinality,
                   'name', stored_object.name,
                   'object_id', stored_object.id,
                   'updated_at', stored_object.updated_at,
                   'etag', COALESCE(stored_object.metadata ->> 'eTag', stored_object.metadata ->> 'etag', ''),
                   'size', COALESCE(stored_object.metadata ->> 'size', ''),
                   'mime_type', COALESCE(stored_object.metadata ->> 'mimetype', '')
               ) ORDER BY photo.ordinality
           )
      INTO object_count, manifest
      FROM public.sailor_crew_profiles profile
      CROSS JOIN LATERAL unnest(profile.crew_photo_paths) WITH ORDINALITY AS photo(name, ordinality)
      JOIN storage.objects stored_object
        ON stored_object.bucket_id = 'crew-list-photos'
       AND stored_object.name = photo.name
     WHERE profile.user_id = p_user_id;

    IF object_count <> expected_count OR manifest IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN encode(digest(manifest::TEXT, 'sha256'), 'hex');
END;
$$;

REVOKE ALL ON FUNCTION public.crew_list_public_profile_digest(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crew_list_photo_manifest_digest(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crew_list_public_profile_digest(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.crew_list_photo_manifest_digest(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.crew_list_account_is_in_good_standing(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NOT NULL
       AND NOT EXISTS (
            SELECT 1
            FROM public.chat_roles role_row
            WHERE role_row.user_id = p_user_id
              AND (
                    COALESCE(role_row.is_blocked, false)
                    OR role_row.muted_until > statement_timestamp()
              )
       );
$$;

CREATE OR REPLACE FUNCTION public.crew_list_profile_requires_manual_review(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NULL
       OR NOT public.crew_list_account_is_in_good_standing(p_user_id)
       OR EXISTS (
            SELECT 1
            FROM public.crew_profile_review_holds hold
            WHERE hold.user_id = p_user_id
              AND hold.cleared_at IS NULL
       )
       OR EXISTS (
            SELECT 1
            FROM public.crew_list_reports report
            WHERE report.reported_id = p_user_id
              AND report.status = 'pending'
       );
$$;

REVOKE ALL ON FUNCTION public.crew_list_account_is_in_good_standing(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crew_list_profile_requires_manual_review(UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crew_list_has_current_automatic_attestation(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.crew_profile_publication_attestations attestation
        WHERE attestation.user_id = p_user_id
          AND attestation.profile_digest = public.crew_list_public_profile_digest(p_user_id)
          AND attestation.photo_manifest_digest = public.crew_list_photo_manifest_digest(p_user_id)
    );
$$;

REVOKE ALL ON FUNCTION public.crew_list_has_current_automatic_attestation(UUID)
    FROM PUBLIC, anon, authenticated;

-- Existing owner edits continue to save privately, but cannot manufacture an
-- approval source or bypass the trusted finaliser. Editing a pending profile
-- returns it to draft so an administrator can never approve content or photos
-- different from the snapshot they reviewed. Any durable safety hold remains,
-- so resubmission still returns to the human queue.
CREATE OR REPLACE FUNCTION public.guard_sailor_crew_profile_beta()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    is_service_role BOOLEAN := COALESCE(auth.role(), '') = 'service_role';
    is_trusted_reviewer BOOLEAN := current_user <> session_user
        AND public.is_chat_admin(auth.uid())
        AND NEW.user_id IS DISTINCT FROM auth.uid();
    is_elevated BOOLEAN := is_service_role OR is_trusted_reviewer;
    material_change BOOLEAN := false;
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
       OR (NEW.crew_photo_path IS NULL AND cardinality(NEW.crew_photo_paths) <> 0)
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

    IF NOT is_elevated THEN
        IF TG_OP = 'INSERT' AND NEW.publication_source <> 'none' THEN
            RAISE EXCEPTION 'Crew List publication source is managed by Thalassa';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.publication_source IS DISTINCT FROM OLD.publication_source THEN
            RAISE EXCEPTION 'Crew List publication source is managed by Thalassa';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        material_change :=
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
            OR NEW.crew_intents IS DISTINCT FROM OLD.crew_intents;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.community_enabled AND NOT NEW.community_enabled THEN
        NEW.crew_list_visibility := 'private';
        NEW.publication_source := 'none';
        IF OLD.approval_status IN ('rejected', 'suspended') THEN
            NEW.approval_status := CASE
                WHEN OLD.approval_status = 'suspended' THEN 'suspended'
                ELSE 'rejected'
            END;
            NEW.verification_status := 'rejected';
        ELSE
            NEW.approval_status := 'draft';
            NEW.verification_status := 'unverified';
        END IF;
        NEW.is_verified := false;
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'profile_paused', finalized_at = statement_timestamp()
         WHERE user_id = OLD.user_id AND status = 'checking';
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = OLD.user_id;
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

    IF OLD.approval_status = 'approved' AND material_change THEN
        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.crew_list_visibility := 'private';
        NEW.publication_source := 'none';
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = OLD.user_id;
        RETURN NEW;
    END IF;

    IF OLD.approval_status = 'pending' AND material_change THEN
        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.crew_list_visibility := 'private';
        NEW.publication_source := 'none';
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'profile_changed', finalized_at = statement_timestamp()
         WHERE user_id = OLD.user_id AND status = 'checking';
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = OLD.user_id;
        RETURN NEW;
    END IF;

    IF NEW.is_verified IS DISTINCT FROM OLD.is_verified
       OR NEW.approval_status IS DISTINCT FROM OLD.approval_status
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.review_requested_at IS DISTINCT FROM OLD.review_requested_at
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
        -- Rolling clients may still request the private manual-review state,
        -- but only the trusted finaliser or an administrator can approve.
        IF NOT (
            OLD.approval_status IN ('draft', 'rejected')
            AND NEW.approval_status = 'pending'
            AND NEW.verification_status = 'pending'
            AND NOT NEW.is_verified
            AND NEW.review_requested_at IS NOT NULL
            AND NEW.reviewed_at IS NULL
            AND NEW.reviewed_by IS NULL
            AND NEW.crew_list_visibility = 'private'
            AND NEW.publication_source = 'none'
        ) THEN
            RAISE EXCEPTION 'Crew List review fields are managed by Thalassa';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_sailor_crew_profile_beta()
    FROM PUBLIC, anon, authenticated;

-- Phone removal during an automatic check invalidates the attempt as well as
-- withdrawing the pending profile. This preserves the pre-existing immediate
-- privacy guarantee without leaving a token that could later publish stale data.
CREATE OR REPLACE FUNCTION public.guard_crew_phone_publication()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.approval_status = 'pending'
       AND NOT public.crew_list_account_is_verified(NEW.user_id) THEN
        IF TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM NEW.approval_status THEN
            RAISE EXCEPTION 'Confirmed email and phone verification are required before review'
                USING ERRCODE = '42501';
        END IF;

        NEW.approval_status := 'draft';
        NEW.verification_status := 'unverified';
        NEW.is_verified := false;
        NEW.crew_list_visibility := 'private';
        NEW.publication_source := 'none';
        NEW.review_requested_at := NULL;
        NEW.reviewed_at := NULL;
        NEW.reviewed_by := NULL;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'verification_removed', finalized_at = statement_timestamp()
         WHERE user_id = NEW.user_id AND status = 'checking';
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = NEW.user_id;
    END IF;

    IF NEW.crew_list_visibility = 'visible'
       AND NOT public.crew_list_account_is_verified(NEW.user_id) THEN
        RAISE EXCEPTION 'Confirmed email and phone verification are required before publication'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_phone_publication()
    FROM PUBLIC, anon, authenticated;

-- Service-role begin step. It moves a complete profile into a private pending
-- state, then snapshots canonical fields plus immutable Storage object IDs.
CREATE OR REPLACE FUNCTION public.begin_crew_profile_publication(
    p_user_id UUID,
    p_moderation_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    profile_row public.sailor_crew_profiles%ROWTYPE;
    attempt_id UUID;
    profile_hash TEXT;
    photo_hash TEXT;
    manual_reason TEXT;
    abandoned_attempts INTEGER := 0;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL OR p_moderation_version !~ '^[a-z0-9._-]{1,40}$' THEN
        RAISE EXCEPTION 'Invalid publication request' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    SELECT * INTO profile_row
      FROM public.sailor_crew_profiles
     WHERE user_id = p_user_id
     FOR UPDATE;

    IF profile_row.user_id IS NULL THEN
        RETURN jsonb_build_object('status', 'missing');
    END IF;
    IF NOT public.crew_list_account_is_verified(p_user_id) THEN
        RETURN jsonb_build_object('status', 'verification_required');
    END IF;
    IF NOT public.crew_list_account_is_in_good_standing(p_user_id) THEN
        RETURN jsonb_build_object('status', 'blocked');
    END IF;
    IF profile_row.approval_status = 'suspended' THEN
        RETURN jsonb_build_object('status', 'manual_review');
    END IF;
    IF NOT profile_row.community_enabled
       OR profile_row.listing_type NOT IN ('seeking_crew', 'seeking_berth')
       OR (
            (profile_row.listing_type = 'seeking_crew' AND profile_row.crew_intents = ARRAY['find_crew']::TEXT[])
            OR (profile_row.listing_type = 'seeking_berth' AND profile_row.crew_intents = ARRAY['find_skipper']::TEXT[])
       ) IS NOT TRUE
       OR NULLIF(BTRIM(COALESCE(profile_row.first_name, '')), '') IS NULL
       OR char_length(BTRIM(COALESCE(profile_row.bio, ''))) NOT BETWEEN 20 AND 2000
       OR NULLIF(BTRIM(COALESCE(profile_row.crew_photo_path, '')), '') IS NULL
       OR profile_row.crew_photo_paths[1] IS DISTINCT FROM profile_row.crew_photo_path THEN
        RETURN jsonb_build_object('status', 'incomplete');
    END IF;

    -- Snapshot before changing lifecycle fields so an absent, replaced, or
    -- duplicated object never leaves an otherwise clean draft stranded in a
    -- pending state.
    profile_hash := public.crew_list_public_profile_digest(p_user_id);
    photo_hash := public.crew_list_photo_manifest_digest(p_user_id);
    IF profile_hash IS NULL OR photo_hash IS NULL THEN
        RETURN jsonb_build_object('status', 'incomplete');
    END IF;

    -- A network/worker failure after begin must not strand the sailor in the
    -- manual queue. Resume the same still-valid snapshot idempotently; once it
    -- expires, retire it and start a fresh trusted check. Pending rows with no
    -- automatic attempt remain genuine human-review work.
    IF profile_row.approval_status = 'pending' THEN
        SELECT attempt.id INTO attempt_id
          FROM public.crew_profile_publication_attempts attempt
         WHERE attempt.user_id = p_user_id
           AND attempt.status = 'checking'
           AND attempt.expires_at > statement_timestamp() + interval '60 seconds'
           AND attempt.profile_digest = profile_hash
           AND attempt.photo_manifest_digest = photo_hash
           AND attempt.moderation_version = p_moderation_version
         ORDER BY attempt.created_at DESC
         LIMIT 1
         FOR UPDATE;

        IF attempt_id IS NOT NULL THEN
            RETURN jsonb_build_object('status', 'checking', 'attempt_id', attempt_id);
        END IF;

        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'worker_abandoned', finalized_at = statement_timestamp()
         WHERE user_id = p_user_id AND status = 'checking';
        GET DIAGNOSTICS abandoned_attempts = ROW_COUNT;
    END IF;

    -- Re-enable an otherwise valid historical/manual approval after phone
    -- replacement. An approval with a missing reviewer, stale attestation, or
    -- new safety signal is moved into the private human queue instead.
    IF profile_row.approval_status = 'approved'
       AND profile_row.verification_status = 'verified' THEN
        IF NOT public.crew_list_profile_requires_manual_review(p_user_id)
           AND (
                (profile_row.publication_source = 'manual' AND profile_row.reviewed_by IS NOT NULL)
                OR (
                    profile_row.publication_source = 'automatic'
                    AND profile_row.reviewed_by IS NULL
                    AND public.crew_list_has_current_automatic_attestation(p_user_id)
                )
           ) THEN
            UPDATE public.sailor_crew_profiles
               SET crew_list_visibility = 'visible', updated_at = statement_timestamp()
             WHERE user_id = p_user_id;
            RETURN jsonb_build_object('status', 'published');
        END IF;

        UPDATE public.sailor_crew_profiles
           SET approval_status = 'pending',
               verification_status = 'pending',
               is_verified = false,
               crew_list_visibility = 'private',
               publication_source = 'none',
               review_requested_at = statement_timestamp(),
               reviewed_at = NULL,
               reviewed_by = NULL,
               updated_at = statement_timestamp()
         WHERE user_id = p_user_id;
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = p_user_id;
        INSERT INTO public.crew_profile_publication_decisions (
            user_id, decision_channel, decision, reason_code,
            profile_digest, photo_manifest_digest
        ) VALUES (
            p_user_id, 'system', 'manual_review', 'approval_recheck_required',
            profile_hash, photo_hash
        );
        RETURN jsonb_build_object('status', 'manual_review');
    END IF;

    IF public.crew_list_profile_requires_manual_review(p_user_id) THEN
        -- Preserve any existing durable reason (administrator decision or
        -- substantiated report) instead of washing it into a generic retry.
        manual_reason := 'safety_signal';
    ELSIF profile_row.approval_status = 'rejected' THEN
        manual_reason := 'previous_rejection';
        INSERT INTO public.crew_profile_review_holds(user_id, reason_code)
        VALUES (p_user_id, manual_reason)
        ON CONFLICT (user_id) DO UPDATE
            SET reason_code = EXCLUDED.reason_code,
                updated_at = statement_timestamp(),
                cleared_at = NULL,
                cleared_by = NULL;
    ELSIF profile_row.approval_status = 'pending' AND abandoned_attempts = 0 THEN
        manual_reason := 'existing_review';
    END IF;

    IF manual_reason IS NOT NULL THEN
        UPDATE public.sailor_crew_profiles
           SET approval_status = 'pending',
               verification_status = 'pending',
               is_verified = false,
               crew_list_visibility = 'private',
               publication_source = 'none',
               review_requested_at = statement_timestamp(),
               reviewed_at = NULL,
               reviewed_by = NULL,
               updated_at = statement_timestamp()
         WHERE user_id = p_user_id;
        IF manual_reason <> 'existing_review' THEN
            INSERT INTO public.crew_profile_publication_decisions (
                user_id, decision_channel, decision, reason_code,
                profile_digest, photo_manifest_digest
            ) VALUES (
                p_user_id, 'system', 'manual_review', manual_reason,
                profile_hash, photo_hash
            );
        END IF;
        RETURN jsonb_build_object('status', 'manual_review');
    END IF;

    IF profile_row.approval_status <> 'draft' AND abandoned_attempts = 0 THEN
        RETURN jsonb_build_object('status', 'manual_review');
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = 'pending',
           verification_status = 'pending',
           is_verified = false,
           crew_list_visibility = 'private',
           publication_source = 'none',
           review_requested_at = statement_timestamp(),
           reviewed_at = NULL,
           reviewed_by = NULL,
           updated_at = statement_timestamp()
     WHERE user_id = p_user_id;

    UPDATE public.crew_profile_publication_attempts
       SET status = 'stale', reason_code = 'superseded', finalized_at = statement_timestamp()
     WHERE user_id = p_user_id AND status = 'checking';

    INSERT INTO public.crew_profile_publication_attempts (
        user_id, profile_digest, photo_manifest_digest, moderation_version
    ) VALUES (
        p_user_id, profile_hash, photo_hash, p_moderation_version
    ) RETURNING id INTO attempt_id;

    RETURN jsonb_build_object('status', 'checking', 'attempt_id', attempt_id);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_crew_profile_publication(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_crew_profile_publication(UUID, TEXT) TO service_role;

-- The finaliser accepts only a bounded automated verdict. It re-locks and
-- recomputes every trust input before approval. The Edge worker cannot provide
-- profile content, object paths, or an approval timestamp.
CREATE OR REPLACE FUNCTION public.finalize_crew_profile_publication(
    p_user_id UUID,
    p_attempt_id UUID,
    p_verdict TEXT,
    p_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    attempt_row public.crew_profile_publication_attempts%ROWTYPE;
    profile_row public.sailor_crew_profiles%ROWTYPE;
    current_profile_digest TEXT;
    current_photo_digest TEXT;
    manual_reason TEXT;
    has_active_hold BOOLEAN := false;
    has_pending_report BOOLEAN := false;
    published BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL
       OR p_attempt_id IS NULL
       OR p_verdict NOT IN ('approved', 'manual_review')
       OR p_reason_code !~ '^[a-z0-9_]{1,48}$' THEN
        RAISE EXCEPTION 'Invalid publication finalisation' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 20260828));

    -- Match the owner-edit trigger's profile -> attempt lock order so an edit
    -- racing finalisation fails closed without a deadlock victim.
    SELECT * INTO profile_row
      FROM public.sailor_crew_profiles
     WHERE user_id = p_user_id
     FOR UPDATE;

    SELECT * INTO attempt_row
      FROM public.crew_profile_publication_attempts
     WHERE id = p_attempt_id
       AND user_id = p_user_id
     FOR UPDATE;

    IF attempt_row.id IS NULL OR attempt_row.status <> 'checking' THEN
        RETURN jsonb_build_object('status', 'stale');
    END IF;

    IF profile_row.user_id IS NULL
       OR NOT profile_row.community_enabled
       OR profile_row.approval_status <> 'pending'
       OR profile_row.verification_status <> 'pending' THEN
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'state_changed', finalized_at = statement_timestamp()
         WHERE id = p_attempt_id;
        RETURN jsonb_build_object('status', 'stale');
    END IF;

    PERFORM 1
      FROM storage.objects object
     WHERE object.bucket_id = 'crew-list-photos'
       AND object.name IN (
            SELECT unnest(profile.crew_photo_paths)
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = p_user_id
       )
     FOR SHARE;

    current_profile_digest := public.crew_list_public_profile_digest(p_user_id);
    current_photo_digest := public.crew_list_photo_manifest_digest(p_user_id);

    IF attempt_row.expires_at <= statement_timestamp()
       OR current_profile_digest IS DISTINCT FROM attempt_row.profile_digest
       OR current_photo_digest IS DISTINCT FROM attempt_row.photo_manifest_digest THEN
        UPDATE public.sailor_crew_profiles
           SET approval_status = 'draft',
               verification_status = 'unverified',
               is_verified = false,
               crew_list_visibility = 'private',
               publication_source = 'none',
               review_requested_at = NULL,
               reviewed_at = NULL,
               reviewed_by = NULL,
               updated_at = statement_timestamp()
         WHERE user_id = p_user_id
           AND approval_status = 'pending'
           AND NOT public.crew_list_profile_requires_manual_review(p_user_id);
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'snapshot_changed', finalized_at = statement_timestamp()
         WHERE id = p_attempt_id;
        RETURN jsonb_build_object('status', 'stale');
    END IF;

    IF NOT public.crew_list_account_is_verified(p_user_id) THEN
        UPDATE public.sailor_crew_profiles
           SET approval_status = 'draft',
               verification_status = 'unverified',
               is_verified = false,
               crew_list_visibility = 'private',
               publication_source = 'none',
               review_requested_at = NULL,
               reviewed_at = NULL,
               reviewed_by = NULL,
               updated_at = statement_timestamp()
         WHERE user_id = p_user_id;
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = p_user_id;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'verification_changed', finalized_at = statement_timestamp()
         WHERE id = p_attempt_id;
        RETURN jsonb_build_object('status', 'stale');
    END IF;

    IF p_verdict = 'approved'
       AND public.crew_list_account_is_in_good_standing(p_user_id)
       AND NOT public.crew_list_profile_requires_manual_review(p_user_id) THEN
        UPDATE public.sailor_crew_profiles
           SET approval_status = 'approved',
               verification_status = 'verified',
               is_verified = true,
               crew_list_visibility = 'visible',
               publication_source = 'automatic',
               reviewed_at = statement_timestamp(),
               reviewed_by = NULL,
               updated_at = statement_timestamp()
         WHERE user_id = p_user_id
           AND community_enabled
           AND approval_status = 'pending'
           AND verification_status = 'pending'
        RETURNING true INTO published;

        IF COALESCE(published, false) THEN
            INSERT INTO public.crew_profile_publication_attestations (
                user_id, profile_digest, photo_manifest_digest, moderation_version, approved_at
            ) VALUES (
                p_user_id, attempt_row.profile_digest, attempt_row.photo_manifest_digest,
                attempt_row.moderation_version, statement_timestamp()
            )
            ON CONFLICT (user_id) DO UPDATE
                SET profile_digest = EXCLUDED.profile_digest,
                    photo_manifest_digest = EXCLUDED.photo_manifest_digest,
                    moderation_version = EXCLUDED.moderation_version,
                    approved_at = EXCLUDED.approved_at;

            UPDATE public.crew_profile_publication_attempts
               SET status = 'approved', reason_code = 'automatic_approved', finalized_at = statement_timestamp()
             WHERE id = p_attempt_id;
            INSERT INTO public.crew_profile_publication_decisions (
                user_id, attempt_id, decision_channel, decision, reason_code,
                profile_digest, photo_manifest_digest, moderation_version
            ) VALUES (
                p_user_id, p_attempt_id, 'automatic', 'published', 'automatic_approved',
                attempt_row.profile_digest, attempt_row.photo_manifest_digest,
                attempt_row.moderation_version
            );
            RETURN jsonb_build_object('status', 'published');
        END IF;

        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'state_changed', finalized_at = statement_timestamp()
         WHERE id = p_attempt_id;
        RETURN jsonb_build_object('status', 'stale');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.crew_profile_review_holds hold
        WHERE hold.user_id = p_user_id AND hold.cleared_at IS NULL
    ) INTO has_active_hold;
    SELECT EXISTS (
        SELECT 1 FROM public.crew_list_reports report
        WHERE report.reported_id = p_user_id AND report.status = 'pending'
    ) INTO has_pending_report;

    manual_reason := CASE
        WHEN NOT public.crew_list_account_is_in_good_standing(p_user_id) OR has_active_hold
            THEN 'safety_signal'
        WHEN has_pending_report THEN 'pending_report'
        ELSE p_reason_code
    END;

    IF NOT has_active_hold THEN
        INSERT INTO public.crew_profile_review_holds(user_id, reason_code)
        VALUES (p_user_id, manual_reason)
        ON CONFLICT (user_id) DO UPDATE
            SET reason_code = EXCLUDED.reason_code,
                updated_at = statement_timestamp(),
                cleared_at = NULL,
                cleared_by = NULL;
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = 'pending',
           verification_status = 'pending',
           is_verified = false,
           crew_list_visibility = 'private',
           publication_source = 'none',
           reviewed_at = NULL,
           reviewed_by = NULL,
           updated_at = statement_timestamp()
     WHERE user_id = p_user_id
       AND community_enabled;

    DELETE FROM public.crew_profile_publication_attestations WHERE user_id = p_user_id;
    UPDATE public.crew_profile_publication_attempts
       SET status = 'manual_review', reason_code = manual_reason, finalized_at = statement_timestamp()
     WHERE id = p_attempt_id;
    INSERT INTO public.crew_profile_publication_decisions (
        user_id, attempt_id, decision_channel, decision, reason_code,
        profile_digest, photo_manifest_digest, moderation_version
    ) VALUES (
        p_user_id, p_attempt_id, 'automatic', 'manual_review', manual_reason,
        attempt_row.profile_digest, attempt_row.photo_manifest_digest,
        attempt_row.moderation_version
    );
    RETURN jsonb_build_object('status', 'manual_review');
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_crew_profile_publication(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_crew_profile_publication(UUID, UUID, TEXT, TEXT)
    TO service_role;

-- Rolling older app builds can still request review, but this compatibility
-- RPC can only queue privately; it can never manufacture automatic approval.
CREATE OR REPLACE FUNCTION public.submit_crew_profile_for_review()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    submitted BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.crew_list_account_is_verified(caller_id) THEN
        RAISE EXCEPTION 'Confirmed email and phone verification are required before review'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = 'pending',
           verification_status = 'pending',
           is_verified = false,
           crew_list_visibility = 'private',
           publication_source = 'none',
           review_requested_at = statement_timestamp(),
           reviewed_at = NULL,
           reviewed_by = NULL,
           updated_at = statement_timestamp()
     WHERE user_id = caller_id
       AND community_enabled
       AND approval_status IN ('draft', 'rejected')
    RETURNING true INTO submitted;

    RETURN COALESCE(submitted, false);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_crew_profile_for_review() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_crew_profile_for_review() TO authenticated;

-- Human approval remains the explicit override for flagged profiles. Approval
-- clears durable holds; rejection creates one. Automatic checks can never call
-- this authenticated/admin-only function with the service role.
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

    PERFORM pg_advisory_xact_lock(hashtextextended(p_profile_user_id::TEXT, 20260828));
    PERFORM 1
      FROM public.sailor_crew_profiles
     WHERE user_id = p_profile_user_id
     FOR UPDATE;

    IF p_decision = 'approved'
       AND (
            NOT public.crew_list_account_is_verified(p_profile_user_id)
            OR NOT public.crew_list_account_is_in_good_standing(p_profile_user_id)
            OR public.crew_list_photo_manifest_digest(p_profile_user_id) IS NULL
            OR EXISTS (
                SELECT 1 FROM public.crew_list_reports report
                WHERE report.reported_id = p_profile_user_id AND report.status = 'pending'
            )
       ) THEN
        RETURN false;
    END IF;

    UPDATE public.sailor_crew_profiles
       SET approval_status = p_decision,
           verification_status = CASE WHEN p_decision = 'approved' THEN 'verified' ELSE 'rejected' END,
           is_verified = p_decision = 'approved',
           crew_list_visibility = CASE WHEN p_decision = 'approved' THEN 'visible' ELSE 'private' END,
           publication_source = CASE WHEN p_decision = 'approved' THEN 'manual' ELSE 'none' END,
           reviewed_at = statement_timestamp(),
           reviewed_by = auth.uid(),
           updated_at = statement_timestamp()
     WHERE user_id = p_profile_user_id
       AND community_enabled
       AND approval_status = 'pending'
    RETURNING true INTO updated_profile;

    IF COALESCE(updated_profile, false) THEN
        IF p_decision = 'approved' THEN
            UPDATE public.crew_profile_review_holds
               SET cleared_at = statement_timestamp(),
                   cleared_by = auth.uid(),
                   updated_at = statement_timestamp()
             WHERE user_id = p_profile_user_id AND cleared_at IS NULL;
        ELSE
            INSERT INTO public.crew_profile_review_holds(user_id, reason_code)
            VALUES (p_profile_user_id, 'administrator_rejection')
            ON CONFLICT (user_id) DO UPDATE
                SET reason_code = EXCLUDED.reason_code,
                    updated_at = statement_timestamp(),
                    cleared_at = NULL,
                    cleared_by = NULL;
        END IF;
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = p_profile_user_id;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'administrator_decision', finalized_at = statement_timestamp()
         WHERE user_id = p_profile_user_id AND status = 'checking';
        INSERT INTO public.crew_profile_publication_decisions (
            user_id, decision_channel, decision, reason_code,
            profile_digest, photo_manifest_digest, actor_id
        ) VALUES (
            p_profile_user_id,
            'administrator',
            CASE WHEN p_decision = 'approved' THEN 'published' ELSE 'rejected' END,
            CASE WHEN p_decision = 'approved' THEN 'administrator_approved' ELSE 'administrator_rejection' END,
            public.crew_list_public_profile_digest(p_profile_user_id),
            public.crew_list_photo_manifest_digest(p_profile_user_id),
            auth.uid()
        );
    END IF;

    RETURN COALESCE(updated_profile, false);
END;
$$;

REVOKE ALL ON FUNCTION public.review_crew_profile(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_crew_profile(UUID, TEXT) TO authenticated;

-- Report creation and publication finalisation share the same per-profile
-- transaction lock. Whichever arrives first wins a clear serial order, so a
-- report that commits before the safety decision is always seen by finalise.
CREATE OR REPLACE FUNCTION public.guard_crew_list_report_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (
            auth.role() IS DISTINCT FROM 'authenticated'
            OR auth.uid() IS NULL
            OR NEW.reporter_id IS DISTINCT FROM auth.uid()
       ) THEN
        RAISE EXCEPTION 'Only the signed-in sailor may create this report'
            USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.reported_id::TEXT, 20260828));
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_list_report_insert()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crew_list_reports_insert_guard ON public.crew_list_reports;
CREATE TRIGGER crew_list_reports_insert_guard
    BEFORE INSERT ON public.crew_list_reports
    FOR EACH ROW EXECUTE FUNCTION public.guard_crew_list_report_insert();

-- A substantiated report creates a durable hold and queues an active profile
-- for human review. A dismissed report has no account-level consequence.
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
    report_target UUID;
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

    SELECT reported_id INTO report_target
      FROM public.crew_list_reports
     WHERE id = p_report_id AND status = 'pending';
    IF report_target IS NULL THEN RETURN false; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(report_target::TEXT, 20260828));

    SELECT reported_id INTO report_target
      FROM public.crew_list_reports
     WHERE id = p_report_id AND status = 'pending'
     FOR UPDATE;
    IF report_target IS NULL THEN RETURN false; END IF;

    UPDATE public.crew_list_reports
       SET status = p_decision,
           reviewed_at = statement_timestamp(),
           reviewed_by = auth.uid()
     WHERE id = p_report_id AND status = 'pending';

    IF p_decision = 'resolved' THEN
        INSERT INTO public.crew_profile_review_holds(user_id, reason_code)
        VALUES (report_target, 'substantiated_report')
        ON CONFLICT (user_id) DO UPDATE
            SET reason_code = EXCLUDED.reason_code,
                updated_at = statement_timestamp(),
                cleared_at = NULL,
                cleared_by = NULL;

        UPDATE public.sailor_crew_profiles
           SET approval_status = CASE
                   WHEN public.crew_list_account_is_verified(report_target) THEN 'pending'
                   ELSE 'rejected'
               END,
               verification_status = CASE
                   WHEN public.crew_list_account_is_verified(report_target) THEN 'pending'
                   ELSE 'rejected'
               END,
               is_verified = false,
               crew_list_visibility = 'private',
               publication_source = 'none',
               review_requested_at = CASE
                   WHEN public.crew_list_account_is_verified(report_target) THEN statement_timestamp()
                   ELSE NULL
               END,
               reviewed_at = CASE
                   WHEN public.crew_list_account_is_verified(report_target) THEN NULL
                   ELSE statement_timestamp()
               END,
               reviewed_by = CASE
                   WHEN public.crew_list_account_is_verified(report_target) THEN NULL
                   ELSE auth.uid()
               END,
               updated_at = statement_timestamp()
         WHERE user_id = report_target
           AND community_enabled
           AND approval_status = 'approved';
        DELETE FROM public.crew_profile_publication_attestations WHERE user_id = report_target;
        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale', reason_code = 'substantiated_report', finalized_at = statement_timestamp()
         WHERE user_id = report_target AND status = 'checking';
        INSERT INTO public.crew_profile_publication_decisions (
            user_id, decision_channel, decision, reason_code,
            profile_digest, photo_manifest_digest, actor_id
        ) VALUES (
            report_target, 'administrator', 'manual_review', 'substantiated_report',
            public.crew_list_public_profile_digest(report_target),
            public.crew_list_photo_manifest_digest(report_target),
            auth.uid()
        );
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.crew_list_reports report
        WHERE report.reported_id = report_target AND report.status = 'pending'
    ) THEN
        UPDATE public.crew_profile_review_holds
           SET cleared_at = statement_timestamp(),
               cleared_by = auth.uid(),
               updated_at = statement_timestamp()
         WHERE user_id = report_target
           AND reason_code = 'pending_report'
           AND cleared_at IS NULL;

        IF FOUND THEN
            UPDATE public.sailor_crew_profiles
               SET approval_status = 'draft',
                   verification_status = 'unverified',
                   is_verified = false,
                   crew_list_visibility = 'private',
                   publication_source = 'none',
                   review_requested_at = NULL,
                   reviewed_at = NULL,
                   reviewed_by = NULL,
                   updated_at = statement_timestamp()
             WHERE user_id = report_target
               AND approval_status = 'pending'
               AND NOT EXISTS (
                    SELECT 1 FROM public.crew_profile_review_holds other_hold
                    WHERE other_hold.user_id = report_target AND other_hold.cleared_at IS NULL
               );
        END IF;
    END IF;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.review_crew_list_report(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_crew_list_report(UUID, TEXT) TO authenticated;

-- Two independent unresolved reports temporarily suppress discovery while an
-- administrator decides them. One report alone cannot be weaponised as an
-- instant public takedown.
CREATE OR REPLACE FUNCTION public.crew_list_profile_has_report_hold(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT (
        SELECT count(DISTINCT report.reporter_id)
        FROM public.crew_list_reports report
        WHERE report.reported_id = p_user_id
          AND report.status = 'pending'
    ) >= 2;
$$;

REVOKE ALL ON FUNCTION public.crew_list_profile_has_report_hold(UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crew_list_profile_is_discoverable(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT p_user_id IS NOT NULL
       AND public.crew_list_account_is_verified(p_user_id)
       AND public.crew_list_account_is_in_good_standing(p_user_id)
       AND NOT public.crew_list_profile_has_report_hold(p_user_id)
       AND EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = p_user_id
              AND profile.community_enabled
              AND profile.crew_list_visibility = 'visible'
              AND profile.approval_status = 'approved'
              AND profile.verification_status = 'verified'
              AND (
                    (profile.listing_type = 'seeking_crew' AND profile.crew_intents = ARRAY['find_crew']::TEXT[])
                    OR (profile.listing_type = 'seeking_berth' AND profile.crew_intents = ARRAY['find_skipper']::TEXT[])
              ) IS TRUE
              AND NULLIF(BTRIM(COALESCE(profile.crew_photo_path, '')), '') IS NOT NULL
              AND public.crew_list_photo_manifest_digest(profile.user_id) IS NOT NULL
              AND (
                    (profile.publication_source = 'manual' AND profile.reviewed_by IS NOT NULL)
                    OR (
                        profile.publication_source = 'automatic'
                        AND profile.reviewed_by IS NULL
                        AND public.crew_list_has_current_automatic_attestation(profile.user_id)
                    )
              )
       );
$$;

REVOKE ALL ON FUNCTION public.crew_list_profile_is_discoverable(UUID)
    FROM PUBLIC, anon, authenticated;

-- Ordinary members browse only through the narrow RPC below. Direct SELECT *
-- is owner/admin-only so town-level and review metadata cannot leak.
DROP POLICY IF EXISTS "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles;
CREATE POLICY "crew_profiles_owner_or_approved_visible"
    ON public.sailor_crew_profiles FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_chat_admin(auth.uid()));

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
            OR EXISTS (
                SELECT 1
                FROM public.sailor_crew_profiles profile
                WHERE profile.user_id::TEXT = split_part(p_object_name, '/', 1)
                  AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
                  AND (profile.crew_photo_path = p_object_name OR p_object_name = ANY(profile.crew_photo_paths))
                  AND (
                        (
                            public.can_browse_crew_list()
                            AND public.crew_list_profile_is_discoverable(profile.user_id)
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
       );
$$;

REVOKE ALL ON FUNCTION public.can_view_crew_list_photo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_crew_list_photo(TEXT) TO authenticated;

-- Owner uploads are immutable. Removal is permitted only after the owner has
-- first removed the path from the profile, which also invalidates any pending
-- or automatic moderation snapshot through the profile trigger.
CREATE OR REPLACE FUNCTION public.can_delete_crew_list_photo(p_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND p_object_name IS NOT NULL
       AND split_part(p_object_name, '/', 1) = auth.uid()::TEXT
       AND NOT EXISTS (
            SELECT 1
            FROM public.sailor_crew_profiles profile
            WHERE profile.user_id = auth.uid()
              AND (
                    profile.crew_photo_path = p_object_name
                    OR p_object_name = ANY(profile.crew_photo_paths)
              )
       );
$$;

REVOKE ALL ON FUNCTION public.can_delete_crew_list_photo(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_delete_crew_list_photo(TEXT) TO authenticated;

DROP POLICY IF EXISTS "Crew List photo owner update" ON storage.objects;
DROP POLICY IF EXISTS "Crew List photo owner delete" ON storage.objects;
CREATE POLICY "Crew List photo owner delete"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'crew-list-photos'
        AND public.can_delete_crew_list_photo(name)
    );

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
        profile.user_id, profile.listing_type, profile.first_name, profile.gender, profile.age_range,
        COALESCE(profile.has_partner, false), profile.partner_details,
        COALESCE(profile.skills, ARRAY[]::TEXT[]), profile.sailing_experience, profile.sailing_region,
        profile.available_from, profile.available_to, profile.bio,
        COALESCE(profile.vibe, ARRAY[]::TEXT[]), COALESCE(profile.languages, ARRAY[]::TEXT[]),
        profile.smoking, profile.drinking, profile.pets, COALESCE(profile.interests, ARRAY[]::TEXT[]),
        profile.last_active, profile.location_state, profile.location_country, profile.crew_photo_path,
        COALESCE(profile.crew_photo_paths, ARRAY[]::TEXT[]), profile.community_enabled,
        COALESCE(profile.crew_intents, ARRAY[]::TEXT[]), profile.crew_list_visibility,
        profile.approval_status, profile.verification_status, profile.created_at, profile.updated_at
    FROM public.sailor_crew_profiles profile
    WHERE auth.role() = 'authenticated'
      AND auth.uid() IS NOT NULL
      AND NOT public.crew_list_pair_is_blocked(auth.uid(), profile.user_id)
      AND (p_target_id IS NULL OR profile.user_id = p_target_id)
      AND (
            (public.can_browse_crew_list() AND public.crew_list_profile_is_discoverable(profile.user_id))
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

-- Newly automatic profiles get a short probation: at most five introductions
-- per rolling day and three simultaneously pending. Everyone is bounded to 20
-- per day. Existing mutual/accepted-conversation behaviour is unchanged.
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
       AND (
            SELECT count(*)
            FROM public.crew_intro_requests request
            WHERE request.sender_id = auth.uid()
              AND request.created_at >= statement_timestamp() - interval '24 hours'
       ) < 20
       AND (
            NOT EXISTS (
                SELECT 1
                FROM public.sailor_crew_profiles own_profile
                WHERE own_profile.user_id = auth.uid()
                  AND own_profile.publication_source = 'automatic'
                  AND own_profile.reviewed_at > statement_timestamp() - interval '7 days'
            )
            OR (
                (
                    SELECT count(*)
                    FROM public.crew_intro_requests recent
                    WHERE recent.sender_id = auth.uid()
                      AND recent.created_at >= statement_timestamp() - interval '24 hours'
                ) < 5
                AND (
                    SELECT count(*)
                    FROM public.crew_intro_requests pending
                    WHERE pending.sender_id = auth.uid()
                      AND pending.status = 'pending'
                ) < 3
            )
       )
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

REVOKE ALL ON FUNCTION public.can_send_crew_intro(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_send_crew_intro(UUID) TO authenticated;

-- RLS checks alone do not serialize concurrent INSERT statements. Lock each
-- sender before re-evaluating the same eligibility and probation counts so a
-- burst of parallel requests cannot jump past the daily or pending limits.
CREATE OR REPLACE FUNCTION public.guard_crew_intro_request_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(), '') = 'service_role' THEN
        RETURN NEW;
    END IF;
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR auth.uid() IS NULL
       OR NEW.sender_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Only the signed-in sailor may send this introduction'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.sender_id::TEXT, 20260829));
    IF NOT public.can_send_crew_intro(NEW.recipient_id) THEN
        RAISE EXCEPTION 'This Crew List introduction is not currently allowed'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_intro_request_insert()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crew_intro_requests_insert_guard ON public.crew_intro_requests;
CREATE TRIGGER crew_intro_requests_insert_guard
    BEFORE INSERT ON public.crew_intro_requests
    FOR EACH ROW EXECUTE FUNCTION public.guard_crew_intro_request_insert();

-- Preserve single-request inserts from already-installed clients while
-- preventing a multi-row INSERT from using one pre-statement quota snapshot
-- for every row. The row trigger still serializes separate statements; this
-- statement trigger rejects an authenticated batch atomically.
CREATE OR REPLACE FUNCTION public.guard_crew_intro_request_batch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() = 'authenticated'
       AND (SELECT count(*) FROM inserted_requests) > 1 THEN
        RAISE EXCEPTION 'Only one Crew List introduction may be sent at a time'
            USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_crew_intro_request_batch()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crew_intro_requests_batch_guard ON public.crew_intro_requests;
CREATE TRIGGER crew_intro_requests_batch_guard
    AFTER INSERT ON public.crew_intro_requests
    REFERENCING NEW TABLE AS inserted_requests
    FOR EACH STATEMENT EXECUTE FUNCTION public.guard_crew_intro_request_batch();

-- New clients use a locked one-request RPC, while the guarded legacy INSERT
-- path above remains compatible with already-installed beta builds.

CREATE OR REPLACE FUNCTION public.create_crew_intro_request(
    p_recipient_id UUID,
    p_message TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    caller_id UUID := auth.uid();
    created_request public.crew_intro_requests%ROWTYPE;
BEGIN
    IF auth.role() IS DISTINCT FROM 'authenticated'
       OR caller_id IS NULL
       OR p_recipient_id IS NULL
       OR p_recipient_id = caller_id THEN
        RAISE EXCEPTION 'Invalid Crew List introduction'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(caller_id::TEXT, 20260829));
    IF NOT public.can_send_crew_intro(p_recipient_id) THEN
        RAISE EXCEPTION 'This Crew List introduction is not currently allowed'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.crew_intro_requests(sender_id, recipient_id, message)
    VALUES (caller_id, p_recipient_id, COALESCE(p_message, ''))
    RETURNING * INTO created_request;

    RETURN to_jsonb(created_request);
END;
$$;

REVOKE ALL ON FUNCTION public.create_crew_intro_request(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_crew_intro_request(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_send_crew_intro_message(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT auth.role() = 'authenticated'
       AND auth.uid() IS NOT NULL
       AND public.crew_list_account_is_in_good_standing(auth.uid())
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

CREATE OR REPLACE FUNCTION public.sweep_crew_profile_publication_attempts(p_limit INTEGER DEFAULT 1000)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    deleted_count INTEGER := 0;
    batch_deleted_count INTEGER := 0;
    candidate RECORD;
    current_attempt_user UUID;
    previous_claim_role TEXT := current_setting('request.jwt.claim.role', true);
    has_active_hold BOOLEAN;
    has_pending_report BOOLEAN;
BEGIN
    IF p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE = '22023';
    END IF;

    -- The function is executable only by its owner/pg_cron. Its transaction-
    -- local service claim lets the existing profile guard recognise these
    -- narrowly scoped recovery writes; application roles cannot call it.
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);

    FOR candidate IN
        SELECT attempt.id, attempt.user_id
        FROM public.crew_profile_publication_attempts attempt
        WHERE attempt.status = 'checking'
          AND attempt.expires_at <= statement_timestamp()
        ORDER BY attempt.expires_at
        LIMIT p_limit
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate.user_id::TEXT, 20260828));
        -- Match owner edits and finalisation: profile first, then attempt.
        -- A tombstoned account may already have no profile, which is harmless.
        PERFORM 1
          FROM public.sailor_crew_profiles profile
         WHERE profile.user_id = candidate.user_id
         FOR UPDATE;
        current_attempt_user := NULL;
        SELECT attempt.user_id INTO current_attempt_user
          FROM public.crew_profile_publication_attempts attempt
         WHERE attempt.id = candidate.id
           AND attempt.status = 'checking'
           AND attempt.expires_at <= statement_timestamp()
         FOR UPDATE;
        IF current_attempt_user IS NULL THEN CONTINUE; END IF;

        IF EXISTS (
            SELECT 1 FROM public.account_deletion_jobs deletion
            WHERE deletion.user_id = current_attempt_user
        ) THEN
            -- DELETE is intentionally unfenced and the owning account is
            -- already on its durable removal path. Avoid any UPDATE that the
            -- account-deletion write fence must reject.
            DELETE FROM public.crew_profile_publication_attempts
             WHERE id = candidate.id;
            GET DIAGNOSTICS batch_deleted_count = ROW_COUNT;
            deleted_count := deleted_count + batch_deleted_count;
            CONTINUE;
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM public.crew_profile_review_holds hold
            WHERE hold.user_id = current_attempt_user AND hold.cleared_at IS NULL
        ) INTO has_active_hold;
        SELECT EXISTS (
            SELECT 1 FROM public.crew_list_reports report
            WHERE report.reported_id = current_attempt_user AND report.status = 'pending'
        ) INTO has_pending_report;

        IF NOT has_active_hold
           AND (
                has_pending_report
                OR NOT public.crew_list_account_is_in_good_standing(current_attempt_user)
           ) THEN
            INSERT INTO public.crew_profile_review_holds(user_id, reason_code)
            VALUES (
                current_attempt_user,
                CASE WHEN has_pending_report THEN 'pending_report' ELSE 'safety_signal' END
            )
            ON CONFLICT (user_id) DO UPDATE
                SET reason_code = EXCLUDED.reason_code,
                    updated_at = statement_timestamp(),
                    cleared_at = NULL,
                    cleared_by = NULL;
            has_active_hold := true;
        END IF;

        IF NOT has_active_hold AND NOT has_pending_report THEN
            UPDATE public.sailor_crew_profiles
               SET approval_status = 'draft',
                   verification_status = 'unverified',
                   is_verified = false,
                   crew_list_visibility = 'private',
                   publication_source = 'none',
                   review_requested_at = NULL,
                   reviewed_at = NULL,
                   reviewed_by = NULL,
                   updated_at = statement_timestamp()
             WHERE user_id = current_attempt_user
               AND approval_status = 'pending';
        END IF;

        UPDATE public.crew_profile_publication_attempts
           SET status = 'stale',
               reason_code = 'worker_abandoned',
               finalized_at = statement_timestamp()
         WHERE id = candidate.id AND status = 'checking';
    END LOOP;

    WITH stale AS MATERIALIZED (
        SELECT attempt.id
        FROM public.crew_profile_publication_attempts attempt
        WHERE attempt.created_at < statement_timestamp() - interval '24 hours'
          AND attempt.status <> 'checking'
        ORDER BY attempt.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.crew_profile_publication_attempts attempt
    USING stale
    WHERE attempt.id = stale.id;
    GET DIAGNOSTICS batch_deleted_count = ROW_COUNT;
    deleted_count := deleted_count + batch_deleted_count;
    PERFORM set_config('request.jwt.claim.role', COALESCE(previous_claim_role, ''), true);
    RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claim.role', COALESCE(previous_claim_role, ''), true);
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_crew_profile_publication_attempts(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('sweep-crew-profile-publication-attempts')
        WHERE EXISTS (
            SELECT 1 FROM cron.job WHERE jobname = 'sweep-crew-profile-publication-attempts'
        );
        PERFORM cron.schedule(
            'sweep-crew-profile-publication-attempts',
            '31 * * * *',
            'SELECT public.sweep_crew_profile_publication_attempts(1000)'
        );
    END IF;
END;
$$;

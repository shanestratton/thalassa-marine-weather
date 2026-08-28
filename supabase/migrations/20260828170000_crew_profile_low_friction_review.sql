-- Keep private operational edits frictionless while preserving exact-snapshot
-- moderation for every field shown to another sailor. In particular,
-- location_city is owner/admin-only: it is not in the browse projection,
-- publication digest, or automated moderation request, so changing it must not
-- withdraw an otherwise approved listing.

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
    moderated_change BOOLEAN := false;
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
        moderated_change :=
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
            -- City/town is deliberately private and excluded here. State and
            -- country are discoverable public profile fields and remain bound
            -- to the exact moderated snapshot.
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

    IF OLD.approval_status = 'approved' AND moderated_change THEN
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

    IF OLD.approval_status = 'pending' AND moderated_change THEN
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

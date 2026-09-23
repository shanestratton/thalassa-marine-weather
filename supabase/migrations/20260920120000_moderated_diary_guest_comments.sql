-- Guest comments are a separate, moderated public-log feature. No diary,
-- publication, media, voyage or boat permissions are widened by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.diary_guest_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID NOT NULL REFERENCES public.diary_entries(id) ON DELETE CASCADE,
    log_config_id UUID NOT NULL REFERENCES public.voyage_log_configs(id) ON DELETE CASCADE,
    submission_id UUID NOT NULL,
    guest_name TEXT NOT NULL CHECK (char_length(btrim(guest_name)) BETWEEN 1 AND 60),
    body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    UNIQUE (log_config_id, entry_id, submission_id),
    CHECK (guest_name !~ '[<>[:cntrl:]]' AND guest_name !~* '(https?://|www\.|javascript:|data:)'),
    CHECK (body !~ '[<>]' AND body !~* '(https?://|www\.|javascript:|data:)'),
    CHECK (regexp_replace(body, E'[\n\t]', '', 'g') !~ '[[:cntrl:]]')
);
CREATE INDEX IF NOT EXISTS diary_guest_comments_entry_status_created_idx
    ON public.diary_guest_comments (entry_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS diary_guest_comments_log_created_idx
    ON public.diary_guest_comments (log_config_id, created_at DESC);

ALTER TABLE public.diary_guest_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.diary_guest_comments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.diary_guest_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.diary_guest_comments TO service_role;
CREATE POLICY diary_guest_comments_log_owner_read ON public.diary_guest_comments
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.voyage_log_configs AS config
                WHERE config.id = diary_guest_comments.log_config_id AND config.owner_id = auth.uid())
    );

-- Matches the existing voyage-log all-diary publication rule: explicit public
-- entry + enabled handle + matching boat + personal owner or combined member.
-- Re-evaluated on EVERY read and submission; an approved comment is not a
-- durable permission to expose an unpublished entry or disabled public log.
CREATE OR REPLACE FUNCTION public.public_diary_comment_config(p_handle TEXT, p_entry_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT config.id FROM public.voyage_log_configs AS config
    JOIN public.diary_entries AS entry ON entry.id = p_entry_id
    WHERE config.handle = p_handle AND config.enabled IS TRUE AND entry.is_public IS TRUE
      AND (config.boat_id IS NULL OR entry.boat_id = config.boat_id)
      AND (entry.user_id = config.owner_id OR (
          config.scope = 'combined' AND config.boat_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.boat_members AS member
              WHERE member.boat_id = config.boat_id AND member.user_id = entry.user_id
          )
      ))
    LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.public_diary_comment_config(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_diary_comment_config(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.read_public_diary_comments(p_handle TEXT, p_entry_id UUID)
RETURNS TABLE (id UUID, guest_name TEXT, body TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT comment.id, comment.guest_name, comment.body, comment.created_at
    FROM public.diary_guest_comments AS comment
    WHERE comment.entry_id = p_entry_id AND comment.status = 'approved'
      AND comment.log_config_id = public.public_diary_comment_config(p_handle, p_entry_id)
      AND comment.reviewed_by = (SELECT config.owner_id FROM public.voyage_log_configs AS config WHERE config.id = comment.log_config_id)
    ORDER BY comment.created_at DESC, comment.id DESC LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.read_public_diary_comments(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_public_diary_comments(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.submit_diary_guest_comment(
    p_handle TEXT, p_entry_id UUID, p_submission_id UUID, p_guest_name TEXT, p_body TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    config_id UUID;
    existing public.diary_guest_comments%ROWTYPE;
BEGIN
    IF p_submission_id IS NULL OR p_guest_name IS NULL OR p_body IS NULL
       OR char_length(btrim(p_guest_name)) NOT BETWEEN 1 AND 60
       OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 2000
       OR p_guest_name ~ '[<>[:cntrl:]]' OR p_body ~ '[<>]'
       OR p_guest_name ~* '(https?://|www\.|javascript:|data:)'
       OR p_body ~* '(https?://|www\.|javascript:|data:)'
       OR regexp_replace(p_body, E'[\n\t]', '', 'g') ~ '[[:cntrl:]]'
    THEN RAISE EXCEPTION 'Invalid comment' USING ERRCODE = '22023'; END IF;

    config_id := public.public_diary_comment_config(p_handle, p_entry_id);
    IF config_id IS NULL THEN RETURN false; END IF;
    -- Serialize bounded inventory checks per public log, including concurrent
    -- requests from different IPs/accounts. Network quotas are also enforced.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(config_id::TEXT, 819));
    -- Publication may have changed while waiting for the inventory lock.
    IF public.public_diary_comment_config(p_handle, p_entry_id) IS DISTINCT FROM config_id THEN RETURN false; END IF;
    SELECT * INTO existing FROM public.diary_guest_comments AS comment
      WHERE comment.log_config_id = config_id AND comment.entry_id = p_entry_id
        AND comment.submission_id = p_submission_id;
    IF FOUND THEN
        IF existing.guest_name <> btrim(p_guest_name) OR existing.body <> btrim(p_body) THEN
            RAISE EXCEPTION 'Submission ID already used' USING ERRCODE = '22023';
        END IF;
        RETURN true;
    END IF;
    IF (SELECT count(*) FROM public.diary_guest_comments AS comment
        WHERE comment.log_config_id = config_id AND comment.entry_id = p_entry_id AND comment.status = 'pending') >= 100
       OR (SELECT count(*) FROM public.diary_guest_comments AS comment
           WHERE comment.log_config_id = config_id AND comment.created_at >= now() - interval '24 hours') >= 200
    THEN RAISE EXCEPTION 'Comment queue is full' USING ERRCODE = '54000'; END IF;
    INSERT INTO public.diary_guest_comments (entry_id, log_config_id, submission_id, guest_name, body, status)
    VALUES (p_entry_id, config_id, p_submission_id, btrim(p_guest_name), btrim(p_body), 'pending');
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.submit_diary_guest_comment(TEXT, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_diary_guest_comment(TEXT, UUID, UUID, TEXT, TEXT) TO service_role;

-- No direct client UPDATE grant: the owner can approve/reject, but cannot
-- rewrite a guest's words, reassign ownership or spoof an approval timestamp.
CREATE OR REPLACE FUNCTION public.moderate_diary_guest_comment(p_comment_id UUID, p_action TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    IF p_action IS NULL OR p_action NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'Invalid action' USING ERRCODE = '22023';
    END IF;
    IF NOT public.consume_edge_quota('diary_comment_moderate', 180, 3600) THEN
        RAISE EXCEPTION 'Too many requests' USING ERRCODE = '54000';
    END IF;
    UPDATE public.diary_guest_comments AS comment
    SET status = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
        reviewed_at = now(), reviewed_by = auth.uid()
    FROM public.voyage_log_configs AS config
    WHERE comment.id = p_comment_id AND config.id = comment.log_config_id AND config.owner_id = auth.uid();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.moderate_diary_guest_comment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_diary_guest_comment(UUID, TEXT) TO authenticated;

COMMENT ON TABLE public.diary_guest_comments IS
    'Guest plaintext comments. Pending until the public-log owner approves; publication gates are rechecked on public reads. No guest email or raw IP retained.';
COMMIT;

-- Urgent repair of Security Advisor 0013 findings verified on 2026-09-09.
-- These legacy tables existed in production but were absent from migration
-- history. Preserve their text identity columns and all existing rows.
-- Anonymous access is removed. A member owns their blocks and may submit,
-- but cannot read or edit, reports. Privileged moderation/maintenance stays.
-- This database-only fix does not rebuild or reuse uploaded iOS build 107.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.sailor_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS public.sailor_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id TEXT NOT NULL,
    reported_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Fail rather than silently combine our owner policy with an unexpected
-- permissive policy. No policies existed on either table during the audit.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('sailor_blocks', 'sailor_reports')
          AND policyname NOT IN ('sailor_blocks_owner', 'sailor_reports_submit_own')
    ) THEN
        RAISE EXCEPTION 'Unexpected sailor safety policy: review before repair';
    END IF;
END;
$$;

ALTER TABLE public.sailor_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sailor_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sailor_blocks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sailor_reports FROM PUBLIC, anon, authenticated;

-- The app upserts the two block identity fields, then reads/deletes its own
-- blocks. Do not grant client changes to generated IDs or timestamps.
GRANT SELECT, DELETE ON TABLE public.sailor_blocks TO authenticated;
GRANT INSERT (blocker_id, blocked_id), UPDATE (blocker_id, blocked_id)
    ON TABLE public.sailor_blocks TO authenticated;

-- reportUser() inserts these fields without requesting returned rows.
GRANT INSERT (reporter_id, reported_id, reason, created_at)
    ON TABLE public.sailor_reports TO authenticated;

GRANT ALL ON TABLE public.sailor_blocks, public.sailor_reports TO service_role;

DROP POLICY IF EXISTS sailor_blocks_owner ON public.sailor_blocks;
CREATE POLICY sailor_blocks_owner ON public.sailor_blocks
    FOR ALL TO authenticated
    USING (blocker_id = (SELECT auth.uid())::TEXT)
    WITH CHECK (blocker_id = (SELECT auth.uid())::TEXT);

DROP POLICY IF EXISTS sailor_reports_submit_own ON public.sailor_reports;
CREATE POLICY sailor_reports_submit_own ON public.sailor_reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter_id = (SELECT auth.uid())::TEXT);

-- No row deletions, identity rewrites, auth changes or PostGIS relocation.
COMMIT;

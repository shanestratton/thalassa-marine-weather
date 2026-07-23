-- Give the existing offline checklist/outbox services a real remote schema.
-- Without these tables, every checklist mutation is quarantined as an
-- unsupported sync operation and remains dirty forever.

CREATE TABLE IF NOT EXISTS public.checklists (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('heading', 'detail')),
    text        TEXT NOT NULL CHECK (length(trim(text)) > 0),
    heading_id  UUID REFERENCES public.checklists(id) ON DELETE CASCADE,
    "order"     INTEGER NOT NULL DEFAULT 0 CHECK ("order" >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT checklist_heading_shape CHECK (
        (type = 'heading' AND heading_id IS NULL)
        OR (type = 'detail' AND heading_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.checklist_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ NOT NULL,
    completed_at  TIMESTAMPTZ,
    items         JSONB NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(items) = 'array'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT checklist_run_time_order CHECK (
        completed_at IS NULL OR completed_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS idx_checklists_owner_order
    ON public.checklists(user_id, "order");
CREATE INDEX IF NOT EXISTS idx_checklist_runs_owner_started
    ON public.checklist_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_checklists_updated
    ON public.checklists(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_checklist_runs_updated
    ON public.checklist_runs(updated_at, id);

CREATE OR REPLACE FUNCTION public.touch_vessel_checklist_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checklists_updated
    ON public.checklists;
CREATE TRIGGER trg_checklists_updated
    BEFORE UPDATE ON public.checklists
    FOR EACH ROW EXECUTE FUNCTION public.touch_vessel_checklist_updated_at();

DROP TRIGGER IF EXISTS trg_checklist_runs_updated
    ON public.checklist_runs;
CREATE TRIGGER trg_checklist_runs_updated
    BEFORE UPDATE ON public.checklist_runs
    FOR EACH ROW EXECUTE FUNCTION public.touch_vessel_checklist_updated_at();

ALTER TABLE public.checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_runs ENABLE ROW LEVEL SECURITY;

-- These are vessel-reference templates, not voyage readiness records (which
-- live in passage_readiness_checks and carry voyage_id). Keep them private to
-- their owner rather than reusing the voyage-scoped "passage_checklist" grant
-- and accidentally exposing every voyage's templates and run history.
DROP POLICY IF EXISTS "Checklist owners manage entries"
    ON public.checklists;
CREATE POLICY "Checklist owners manage entries"
    ON public.checklists FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Checklist owners manage runs"
    ON public.checklist_runs;
CREATE POLICY "Checklist owners manage runs"
    ON public.checklist_runs FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.checklists, public.checklist_runs TO authenticated;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'checklists'
        ) THEN
            ALTER PUBLICATION supabase_realtime
                ADD TABLE public.checklists;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'checklist_runs'
        ) THEN
            ALTER PUBLICATION supabase_realtime
                ADD TABLE public.checklist_runs;
        END IF;
    END IF;
END;
$$;

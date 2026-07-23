-- Vessel performance data used by weather routing.

CREATE TABLE IF NOT EXISTS public.vessel_polars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_model TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('database', 'file_import', 'manual')),
    polar_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id)
);

ALTER TABLE public.vessel_polars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own polars" ON public.vessel_polars;
DROP POLICY IF EXISTS "Users can insert own polars" ON public.vessel_polars;
DROP POLICY IF EXISTS "Users can update own polars" ON public.vessel_polars;
DROP POLICY IF EXISTS "Users can delete own polars" ON public.vessel_polars;
CREATE POLICY "Users can view own polars"
    ON public.vessel_polars FOR SELECT TO authenticated
    USING (user_id = auth.uid());
CREATE POLICY "Users can insert own polars"
    ON public.vessel_polars FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own polars"
    ON public.vessel_polars FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own polars"
    ON public.vessel_polars FOR DELETE TO authenticated
    USING (user_id = auth.uid());

DROP TRIGGER IF EXISTS vessel_polars_updated ON public.vessel_polars;
CREATE TRIGGER vessel_polars_updated
    BEFORE UPDATE ON public.vessel_polars
    FOR EACH ROW EXECUTE FUNCTION public.update_marketplace_timestamp();

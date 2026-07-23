-- Canonical foundation for the vessel inventory and maintenance schemas.
--
-- The original definitions lived in dashboard-run SQL files whose names were
-- ignored by the Supabase migration runner. Keep this migration safe both for
-- a clean database and for an existing database where those files were applied
-- manually: CREATE TABLE/INDEX is conditional, and policy/trigger replacement
-- is limited to the original owner-only objects.

CREATE TABLE IF NOT EXISTS public.inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    barcode TEXT,
    item_name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'Provisions'
        CHECK (category IN (
            'Engine', 'Plumbing', 'Electrical', 'Rigging',
            'Safety', 'Provisions', 'Medical'
        )),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    min_quantity INTEGER DEFAULT 0,
    location_zone TEXT,
    location_specific TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_user_id
    ON public.inventory_items(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode
    ON public.inventory_items(user_id, barcode)
    WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_category
    ON public.inventory_items(user_id, category);
CREATE INDEX IF NOT EXISTS idx_inventory_name_search
    ON public.inventory_items USING gin(to_tsvector('english', item_name));

CREATE OR REPLACE FUNCTION public.update_inventory_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_updated_at ON public.inventory_items;
CREATE TRIGGER trg_inventory_updated_at
    BEFORE UPDATE ON public.inventory_items
    FOR EACH ROW EXECUTE FUNCTION public.update_inventory_updated_at();

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can insert own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can update own inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Users can delete own inventory" ON public.inventory_items;
CREATE POLICY "Users can view own inventory"
    ON public.inventory_items FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own inventory"
    ON public.inventory_items FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own inventory"
    ON public.inventory_items FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own inventory"
    ON public.inventory_items FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.maintenance_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL CHECK (category IN (
        'Engine', 'Safety', 'Hull', 'Rigging', 'Routine'
    )),
    trigger_type TEXT NOT NULL CHECK (trigger_type IN (
        'date', 'engine_hours', 'recurring_days'
    )),
    interval_value INTEGER,
    next_due_date TIMESTAMPTZ,
    next_due_hours INTEGER,
    last_completed TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.maintenance_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES public.maintenance_tasks(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    engine_hours_at_service INTEGER,
    notes TEXT,
    cost DECIMAL(10, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.maintenance_history
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_user
    ON public.maintenance_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_category
    ON public.maintenance_tasks(user_id, category);
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due_date
    ON public.maintenance_tasks(user_id, next_due_date)
    WHERE next_due_date IS NOT NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due_hours
    ON public.maintenance_tasks(user_id, next_due_hours)
    WHERE next_due_hours IS NOT NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_maintenance_history_task
    ON public.maintenance_history(task_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_history_user
    ON public.maintenance_history(user_id, completed_at DESC);

CREATE OR REPLACE FUNCTION public.update_maintenance_tasks_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maintenance_tasks_updated_at ON public.maintenance_tasks;
CREATE TRIGGER trg_maintenance_tasks_updated_at
    BEFORE UPDATE ON public.maintenance_tasks
    FOR EACH ROW EXECUTE FUNCTION public.update_maintenance_tasks_updated_at();

DROP TRIGGER IF EXISTS trg_maintenance_history_updated_at ON public.maintenance_history;
CREATE TRIGGER trg_maintenance_history_updated_at
    BEFORE UPDATE ON public.maintenance_history
    FOR EACH ROW EXECUTE FUNCTION public.update_maintenance_tasks_updated_at();

ALTER TABLE public.maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can create own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can update own tasks" ON public.maintenance_tasks;
DROP POLICY IF EXISTS "Users can delete own tasks" ON public.maintenance_tasks;
CREATE POLICY "Users can view own tasks"
    ON public.maintenance_tasks FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can create own tasks"
    ON public.maintenance_tasks FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own tasks"
    ON public.maintenance_tasks FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own tasks"
    ON public.maintenance_tasks FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own history" ON public.maintenance_history;
DROP POLICY IF EXISTS "Users can log own history" ON public.maintenance_history;
DROP POLICY IF EXISTS "Users can delete own history" ON public.maintenance_history;
CREATE POLICY "Users can view own history"
    ON public.maintenance_history FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
CREATE POLICY "Users can log own history"
    ON public.maintenance_history FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own history"
    ON public.maintenance_history FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

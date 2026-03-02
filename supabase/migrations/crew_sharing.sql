-- ═══════════════════════════════════════════════════════════════
-- Thalassa Crew Sharing — SQL Migration
-- Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Create vessel_crew table
CREATE TABLE IF NOT EXISTS public.vessel_crew (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- The captain (data owner)
    owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    
    -- The crew member granted access
    crew_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    
    -- Denormalized for display
    crew_email TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    
    -- Which registers are shared (granular permissions)
    -- Values: 'inventory', 'equipment', 'maintenance', 'documents'
    shared_registers TEXT[] NOT NULL DEFAULT '{}',
    
    -- Invite status: pending → accepted/declined
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined')),
    
    -- Role for future extensibility
    role TEXT NOT NULL DEFAULT 'crew',
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    
    -- Prevent duplicate invites
    UNIQUE(owner_id, crew_user_id)
);

-- 2. Enable RLS
ALTER TABLE public.vessel_crew ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies for vessel_crew (drop first for safe re-run)
DROP POLICY IF EXISTS "owner_manage_crew" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_see_invites" ON public.vessel_crew;
DROP POLICY IF EXISTS "crew_respond_invite" ON public.vessel_crew;

-- Owner can see and manage their crew entries
CREATE POLICY "owner_manage_crew" ON public.vessel_crew
    FOR ALL USING (auth.uid() = owner_id);

-- Crew member can see invites sent to them
CREATE POLICY "crew_see_invites" ON public.vessel_crew
    FOR SELECT USING (auth.uid() = crew_user_id);

-- Crew member can update their own invite (accept/decline)
CREATE POLICY "crew_respond_invite" ON public.vessel_crew
    FOR UPDATE USING (auth.uid() = crew_user_id)
    WITH CHECK (auth.uid() = crew_user_id);

-- 4. Index for fast crew lookups
CREATE INDEX IF NOT EXISTS idx_vessel_crew_owner ON public.vessel_crew(owner_id);
CREATE INDEX IF NOT EXISTS idx_vessel_crew_member ON public.vessel_crew(crew_user_id);
CREATE INDEX IF NOT EXISTS idx_vessel_crew_status ON public.vessel_crew(status);

-- ═══════════════════════════════════════════════════════════════
-- 5. Update RLS on vessel data tables
--    Add crew access for ACCEPTED members with matching register
-- ═══════════════════════════════════════════════════════════════

-- Helper: Drop old policies if they exist (safe re-run)
DO $$ BEGIN
    -- inventory_items
    DROP POLICY IF EXISTS "owner_select" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_insert" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_update" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_delete" ON public.inventory_items;
    DROP POLICY IF EXISTS "Users can view their own inventory" ON public.inventory_items;
    DROP POLICY IF EXISTS "Users can insert their own inventory" ON public.inventory_items;
    DROP POLICY IF EXISTS "Users can update their own inventory" ON public.inventory_items;
    DROP POLICY IF EXISTS "Users can delete their own inventory" ON public.inventory_items;

    -- equipment_register
    DROP POLICY IF EXISTS "owner_select" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_insert" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_update" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_delete" ON public.equipment_register;
    DROP POLICY IF EXISTS "Users can view their own equipment" ON public.equipment_register;
    DROP POLICY IF EXISTS "Users can insert their own equipment" ON public.equipment_register;
    DROP POLICY IF EXISTS "Users can update their own equipment" ON public.equipment_register;
    DROP POLICY IF EXISTS "Users can delete their own equipment" ON public.equipment_register;

    -- maintenance_tasks
    DROP POLICY IF EXISTS "owner_select" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_insert" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_update" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_delete" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "Users can view their own tasks" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "Users can insert their own tasks" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "Users can update their own tasks" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "Users can delete their own tasks" ON public.maintenance_tasks;

    -- maintenance_history
    DROP POLICY IF EXISTS "owner_select" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_insert" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_update" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_delete" ON public.maintenance_history;
    DROP POLICY IF EXISTS "Users can view their own history" ON public.maintenance_history;
    DROP POLICY IF EXISTS "Users can insert their own history" ON public.maintenance_history;
    DROP POLICY IF EXISTS "Users can update their own history" ON public.maintenance_history;
    DROP POLICY IF EXISTS "Users can delete their own history" ON public.maintenance_history;

    -- ship_documents
    DROP POLICY IF EXISTS "owner_select" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_insert" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_update" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_delete" ON public.ship_documents;
    DROP POLICY IF EXISTS "Users can view their own documents" ON public.ship_documents;
    DROP POLICY IF EXISTS "Users can insert their own documents" ON public.ship_documents;
    DROP POLICY IF EXISTS "Users can update their own documents" ON public.ship_documents;
    DROP POLICY IF EXISTS "Users can delete their own documents" ON public.ship_documents;

    -- Also drop the new crew policies if they exist (safe re-run)
    DROP POLICY IF EXISTS "owner_or_crew_select" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_or_crew_update" ON public.inventory_items;
    DROP POLICY IF EXISTS "owner_only_delete" ON public.inventory_items;

    DROP POLICY IF EXISTS "owner_or_crew_select" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_or_crew_update" ON public.equipment_register;
    DROP POLICY IF EXISTS "owner_only_delete" ON public.equipment_register;

    DROP POLICY IF EXISTS "owner_or_crew_select" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_or_crew_update" ON public.maintenance_tasks;
    DROP POLICY IF EXISTS "owner_only_delete" ON public.maintenance_tasks;

    DROP POLICY IF EXISTS "owner_or_crew_select" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_or_crew_update" ON public.maintenance_history;
    DROP POLICY IF EXISTS "owner_only_delete" ON public.maintenance_history;

    DROP POLICY IF EXISTS "owner_or_crew_select" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_or_crew_insert" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_or_crew_update" ON public.ship_documents;
    DROP POLICY IF EXISTS "owner_only_delete" ON public.ship_documents;
END $$;

-- ── inventory_items ──
CREATE POLICY "owner_or_crew_select" ON public.inventory_items
    FOR SELECT USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = inventory_items.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'inventory' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_insert" ON public.inventory_items
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'inventory' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_update" ON public.inventory_items
    FOR UPDATE USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = inventory_items.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'inventory' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_only_delete" ON public.inventory_items
    FOR DELETE USING (auth.uid() = user_id);

-- ── equipment_register ──
CREATE POLICY "owner_or_crew_select" ON public.equipment_register
    FOR SELECT USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = equipment_register.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'equipment' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_insert" ON public.equipment_register
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'equipment' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_update" ON public.equipment_register
    FOR UPDATE USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = equipment_register.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'equipment' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_only_delete" ON public.equipment_register
    FOR DELETE USING (auth.uid() = user_id);

-- ── maintenance_tasks ──
CREATE POLICY "owner_or_crew_select" ON public.maintenance_tasks
    FOR SELECT USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = maintenance_tasks.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_insert" ON public.maintenance_tasks
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_update" ON public.maintenance_tasks
    FOR UPDATE USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = maintenance_tasks.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_only_delete" ON public.maintenance_tasks
    FOR DELETE USING (auth.uid() = user_id);

-- ── maintenance_history ──
CREATE POLICY "owner_or_crew_select" ON public.maintenance_history
    FOR SELECT USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = maintenance_history.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_insert" ON public.maintenance_history
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_update" ON public.maintenance_history
    FOR UPDATE USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = maintenance_history.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'maintenance' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_only_delete" ON public.maintenance_history
    FOR DELETE USING (auth.uid() = user_id);

-- ── ship_documents ──
CREATE POLICY "owner_or_crew_select" ON public.ship_documents
    FOR SELECT USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = ship_documents.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'documents' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_insert" ON public.ship_documents
    FOR INSERT WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'documents' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_or_crew_update" ON public.ship_documents
    FOR UPDATE USING (
        auth.uid() = user_id
        OR EXISTS (
            SELECT 1 FROM public.vessel_crew vc
            WHERE vc.owner_id = ship_documents.user_id
            AND vc.crew_user_id = auth.uid()
            AND vc.status = 'accepted'
            AND 'documents' = ANY(vc.shared_registers)
        )
    );

CREATE POLICY "owner_only_delete" ON public.ship_documents
    FOR DELETE USING (auth.uid() = user_id);

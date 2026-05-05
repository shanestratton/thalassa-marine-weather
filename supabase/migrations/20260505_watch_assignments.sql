-- Watch Schedule Assignments
--
-- Persists per-voyage watch slot → crew member mapping. The watch
-- schedule itself (rotation pattern, time slots) is still generated
-- algorithmically client-side from crew count. This table just
-- records WHO is on each slot.
--
-- Used by:
--   - WatchScheduleCard: shows crew names instead of generic "Watch A"
--   - WatchAlarmService: schedules local notifications 15 min before
--     each watch the current user is assigned to
--   - send-push edge function: notifies crew when schedule is published
--
-- Design notes:
--   - voyage_id is TEXT (not UUID) because draft voyages have synthetic
--     IDs like "planned_<timestamp>_<rand>" — see PassagePlanSave.ts
--   - watch_index is the 0-based position in the generated rotation;
--     stable as long as crew count doesn't change. If count changes
--     the rotation regenerates and old assignments may need rebinding.
--   - assigned_crew_name is denormalised so the UI doesn't need to
--     join vessel_crew on every render

-- Ensure vessel_crew has the voyage_id column the per-voyage RLS
-- policies below reference. The original crew_sharing.sql migration
-- predates per-voyage scoping; CrewService.ts already declares the
-- column in its TypeScript type but the remote schema can drift if
-- the column was never explicitly added. Idempotent ALTER.
ALTER TABLE vessel_crew ADD COLUMN IF NOT EXISTS voyage_id TEXT;
CREATE INDEX IF NOT EXISTS idx_vessel_crew_voyage_id ON vessel_crew(voyage_id);

CREATE TABLE IF NOT EXISTS watch_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_id TEXT NOT NULL,
    watch_index INTEGER NOT NULL,
    watch_label TEXT NOT NULL,
    watch_time_label TEXT NOT NULL,
    assigned_crew_email TEXT,
    assigned_crew_name TEXT,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    assigned_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(voyage_id, watch_index)
);

CREATE INDEX IF NOT EXISTS idx_watch_assignments_voyage_id ON watch_assignments(voyage_id);
CREATE INDEX IF NOT EXISTS idx_watch_assignments_assigned_crew_email ON watch_assignments(assigned_crew_email);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_watch_assignments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_watch_assignments_updated_at ON watch_assignments;
CREATE TRIGGER trg_watch_assignments_updated_at
    BEFORE UPDATE ON watch_assignments
    FOR EACH ROW
    EXECUTE FUNCTION update_watch_assignments_updated_at();

ALTER TABLE watch_assignments ENABLE ROW LEVEL SECURITY;

-- Voyage owner manages all assignments for their voyages
CREATE POLICY "watch_assignments_owner_all" ON watch_assignments
    FOR ALL
    USING (
        assigned_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM voyages
            WHERE voyages.id::text = watch_assignments.voyage_id
              AND voyages.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM voyages
            WHERE voyages.id::text = watch_assignments.voyage_id
              AND voyages.user_id = auth.uid()
        )
    );

-- Crew members can READ assignments for voyages they're invited to
CREATE POLICY "watch_assignments_crew_read" ON watch_assignments
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM vessel_crew
            WHERE vessel_crew.voyage_id = watch_assignments.voyage_id
              AND vessel_crew.crew_user_id = auth.uid()
              AND vessel_crew.status = 'accepted'
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON watch_assignments TO authenticated;

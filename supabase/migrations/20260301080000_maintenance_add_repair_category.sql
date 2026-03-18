-- ═══════════════════════════════════════════════════════════════════
-- Migration: Add 'Repair' to maintenance_tasks category constraint
-- Without this, repairs fail with a constraint violation
-- ═══════════════════════════════════════════════════════════════════

-- Drop existing constraint (try both naming conventions)
ALTER TABLE maintenance_tasks
DROP CONSTRAINT IF EXISTS maintenance_tasks_category_check;

DO $$
BEGIN
    EXECUTE (
        SELECT 'ALTER TABLE maintenance_tasks DROP CONSTRAINT ' || conname
        FROM pg_constraint
        WHERE conrelid = 'maintenance_tasks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%category%'
        LIMIT 1
    );
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

-- Add new constraint with Repair included
ALTER TABLE maintenance_tasks
ADD CONSTRAINT maintenance_tasks_category_check
CHECK (category IN (
    'Engine', 'Safety', 'Hull', 'Rigging', 'Routine', 'Repair'
));

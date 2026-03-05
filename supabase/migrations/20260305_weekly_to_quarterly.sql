-- Migration: Swap 'weekly' trigger type for 'quarterly'
-- Weekly was unused; quarterly maps to the 90-day "Every 3 months" schedule.

-- 1. Update any existing tasks using 'weekly' to 'quarterly'
UPDATE maintenance_tasks
SET trigger_type = 'quarterly',
    interval_value = 90
WHERE trigger_type = 'weekly';

-- 2. Recreate the enum constraint
ALTER TABLE maintenance_tasks
DROP CONSTRAINT IF EXISTS maintenance_tasks_trigger_type_check;

ALTER TABLE maintenance_tasks
ADD CONSTRAINT maintenance_tasks_trigger_type_check
CHECK (trigger_type IN ('engine_hours', 'daily', 'quarterly', 'monthly', 'bi_annual', 'annual'));

-- ═══════════════════════════════════════════════════════════════════
-- Migration: Expand maintenance trigger_type values
-- Old: 'date', 'engine_hours', 'recurring_days'
-- New: 'engine_hours', 'daily', 'weekly', 'monthly', 'bi_annual', 'annual'
-- ═══════════════════════════════════════════════════════════════════

-- 1. DROP old constraint FIRST (before any data changes)
ALTER TABLE maintenance_tasks
DROP CONSTRAINT IF EXISTS maintenance_tasks_trigger_type_check;

-- Also try the auto-generated name pattern in case it differs
DO $$
BEGIN
    EXECUTE (
        SELECT 'ALTER TABLE maintenance_tasks DROP CONSTRAINT ' || conname
        FROM pg_constraint
        WHERE conrelid = 'maintenance_tasks'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%trigger_type%'
        LIMIT 1
    );
EXCEPTION WHEN OTHERS THEN
    -- Constraint already dropped, ignore
    NULL;
END $$;

-- 2. Migrate existing data to new trigger types
UPDATE maintenance_tasks
SET trigger_type = 'annual'
WHERE trigger_type = 'date';

UPDATE maintenance_tasks
SET trigger_type = 'monthly'
WHERE trigger_type = 'recurring_days';

-- 3. Add new constraint with expanded values
ALTER TABLE maintenance_tasks
ADD CONSTRAINT maintenance_tasks_trigger_type_check
CHECK (trigger_type IN (
    'engine_hours', 'daily', 'weekly', 'monthly', 'bi_annual', 'annual'
));

-- 4. Update log_service RPC to handle new trigger types
CREATE OR REPLACE FUNCTION log_service(
    p_task_id            UUID,
    p_engine_hours       INTEGER DEFAULT NULL,
    p_notes              TEXT    DEFAULT NULL,
    p_cost               DECIMAL DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
    v_task          maintenance_tasks%ROWTYPE;
    v_history_id    UUID;
    v_new_due_date  TIMESTAMPTZ;
    v_new_due_hours INTEGER;
BEGIN
    -- 1. Fetch the task (RLS enforced)
    SELECT * INTO v_task
    FROM maintenance_tasks
    WHERE id = p_task_id AND user_id = auth.uid();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Task not found or access denied';
    END IF;

    -- 2. Calculate new due thresholds
    CASE v_task.trigger_type
        WHEN 'engine_hours' THEN
            v_new_due_hours := COALESCE(p_engine_hours, 0) + COALESCE(v_task.interval_value, 200);
            v_new_due_date := v_task.next_due_date;
        ELSE
            -- All time-based triggers: advance by interval_value days from NOW
            v_new_due_date := now() + (COALESCE(v_task.interval_value, 30) || ' days')::INTERVAL;
            v_new_due_hours := v_task.next_due_hours;
    END CASE;

    -- 3. INSERT history record
    INSERT INTO maintenance_history (user_id, task_id, completed_at, engine_hours_at_service, notes, cost)
    VALUES (auth.uid(), p_task_id, now(), p_engine_hours, p_notes, p_cost)
    RETURNING id INTO v_history_id;

    -- 4. UPDATE task with new due thresholds + last_completed
    UPDATE maintenance_tasks
    SET next_due_date   = v_new_due_date,
        next_due_hours  = v_new_due_hours,
        last_completed  = now(),
        updated_at      = now()
    WHERE id = p_task_id;

    -- 5. Return confirmation
    RETURN json_build_object(
        'history_id',     v_history_id,
        'next_due_date',  v_new_due_date,
        'next_due_hours', v_new_due_hours
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

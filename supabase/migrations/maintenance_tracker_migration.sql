-- ═══════════════════════════════════════════════════════════════════
-- Vessel Maintenance & Routine Tracker
-- Tables: maintenance_tasks, maintenance_history
-- RPC: log_service (atomic: insert history + update next due)
-- ═══════════════════════════════════════════════════════════════════

-- ── Table A: maintenance_tasks (The Engine) ──────────────────────
CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    title           TEXT NOT NULL,                     -- "Main Engine Oil Change"
    description     TEXT,                              -- Optional detail
    category        TEXT NOT NULL CHECK (category IN (
                        'Engine', 'Safety', 'Hull', 'Rigging', 'Routine'
                    )),
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN (
                        'date', 'engine_hours', 'recurring_days'
                    )),

    -- Interval value: 200 (hours), 30 (days), 365 (days), etc.
    interval_value  INTEGER,

    -- Next-due thresholds (one or both set depending on trigger_type)
    next_due_date   TIMESTAMPTZ,                      -- Calendar triggers
    next_due_hours  INTEGER,                           -- Engine hour triggers

    -- Status tracking
    last_completed  TIMESTAMPTZ,                       -- Most recent service date
    is_active       BOOLEAN NOT NULL DEFAULT true,     -- Soft delete / pause

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Table B: maintenance_history (The Logbook) ──────────────────
CREATE TABLE IF NOT EXISTS maintenance_history (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    task_id                 UUID NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,

    completed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    engine_hours_at_service INTEGER,                   -- Snapshot of engine hours
    notes                   TEXT,                      -- "Found slight weeping on raw water pump gasket"
    cost                    DECIMAL(10,2),              -- Optional cost tracking

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_user
    ON maintenance_tasks(user_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_category
    ON maintenance_tasks(user_id, category);

CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due_date
    ON maintenance_tasks(user_id, next_due_date)
    WHERE next_due_date IS NOT NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due_hours
    ON maintenance_tasks(user_id, next_due_hours)
    WHERE next_due_hours IS NOT NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_maintenance_history_task
    ON maintenance_history(task_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_history_user
    ON maintenance_history(user_id, completed_at DESC);

-- ── Auto-update trigger for updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION update_maintenance_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintenance_tasks_updated_at ON maintenance_tasks;
CREATE TRIGGER trg_maintenance_tasks_updated_at
    BEFORE UPDATE ON maintenance_tasks
    FOR EACH ROW EXECUTE FUNCTION update_maintenance_tasks_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_history ENABLE ROW LEVEL SECURITY;

-- maintenance_tasks policies
CREATE POLICY "Users can view own tasks"
    ON maintenance_tasks FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create own tasks"
    ON maintenance_tasks FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
    ON maintenance_tasks FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
    ON maintenance_tasks FOR DELETE
    USING (auth.uid() = user_id);

-- maintenance_history policies
CREATE POLICY "Users can view own history"
    ON maintenance_history FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can log own history"
    ON maintenance_history FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own history"
    ON maintenance_history FOR DELETE
    USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════
-- RPC: log_service — Atomic "Log Service" action
-- INSERT history + UPDATE task's next_due in a single transaction
-- ═══════════════════════════════════════════════════════════════════

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
    -- 1. Fetch the task (RLS enforced: user can only see own tasks)
    SELECT * INTO v_task
    FROM maintenance_tasks
    WHERE id = p_task_id AND user_id = auth.uid();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Task not found or access denied';
    END IF;

    -- 2. Calculate new due thresholds
    CASE v_task.trigger_type
        WHEN 'date' THEN
            -- Advance by interval_value days from NOW
            v_new_due_date := now() + (COALESCE(v_task.interval_value, 365) || ' days')::INTERVAL;
            v_new_due_hours := v_task.next_due_hours; -- Preserve if set
        WHEN 'engine_hours' THEN
            -- Advance by interval_value hours from current reading
            v_new_due_hours := COALESCE(p_engine_hours, 0) + COALESCE(v_task.interval_value, 200);
            v_new_due_date := v_task.next_due_date; -- Preserve if set
        WHEN 'recurring_days' THEN
            -- Recurring: advance by interval_value days from NOW
            v_new_due_date := now() + (COALESCE(v_task.interval_value, 30) || ' days')::INTERVAL;
            v_new_due_hours := v_task.next_due_hours;
        ELSE
            v_new_due_date := v_task.next_due_date;
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

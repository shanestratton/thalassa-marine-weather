-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — Upgrade vessel_crew permissions to JSONB                       ║
-- ║  Replaces text[] shared_registers with granular JSONB permissions object.  ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Add the new JSONB permissions column
ALTER TABLE public.vessel_crew
    ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{
        "can_view_stores": false,
        "can_edit_stores": false,
        "can_view_galley": false,
        "can_view_nav": false,
        "can_view_weather": false,
        "can_edit_log": false
    }'::jsonb;

-- Migrate existing shared_registers data into the new permissions column
UPDATE public.vessel_crew
SET permissions = jsonb_build_object(
    'can_view_stores', (shared_registers @> ARRAY['inventory']::text[] OR shared_registers @> ARRAY['equipment']::text[]),
    'can_edit_stores', (shared_registers @> ARRAY['inventory']::text[]),
    'can_view_galley', false,
    'can_view_nav', false,
    'can_view_weather', false,
    'can_edit_log', (shared_registers @> ARRAY['documents']::text[])
)
WHERE shared_registers IS NOT NULL;

-- Add role column if not present (upgrade from flat 'crew' string)
-- Note: role may already exist as TEXT, so we just add a CHECK if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vessel_crew' AND column_name = 'role'
    ) THEN
        ALTER TABLE public.vessel_crew ADD COLUMN role TEXT DEFAULT 'deckhand';
    END IF;
END $$;

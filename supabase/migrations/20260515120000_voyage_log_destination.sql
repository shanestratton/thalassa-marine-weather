-- ═══════════════════════════════════════════════════════════════
-- Voyage Log destination — per-vessel passage target
--
-- Adds the destination columns the public Voyage Log uses to compute
-- DTG / ETA / progress (Newport → here → Noumea-style bar). Origin
-- is derived from the first track point — only the destination needs
-- to be configured.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.voyage_log_configs
    ADD COLUMN IF NOT EXISTS destination_name TEXT,
    ADD COLUMN IF NOT EXISTS destination_lat  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS destination_lon  DOUBLE PRECISION;

-- Seed the demo passage. Only sets the destination if it's not already
-- set — won't overwrite a real edit.
UPDATE public.voyage_log_configs
SET destination_name = 'Nouméa, New Caledonia',
    destination_lat  = -22.27,
    destination_lon  = 166.44
WHERE handle = 'serene-summer'
  AND destination_lat IS NULL;

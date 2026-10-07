-- Which receiver produced each logged position (build 123, package VL).
--
-- Shane 2026-08-30 decided a phone standing in for the boat's GPS needs "a
-- modal opt-in AND per-point tagging"; Shane 2026-10-07 asked that the log
-- use the vessel GPS whenever it is available. The client now tags every
-- point; this column keeps the tag:
--   vessel          her bus (a gateway socket, or her Pi on her own Wi-Fi)
--   vessel-relay    her receivers relayed (the Pi direct, her cloud row, or
--                   her LAN reached over a private network)
--   vessel-pi-log   her Pi's own recorded track (backfill)
--   phone           a phone's GPS
--   phone-accessory a Bad Elf / MFi receiver feeding a phone's Core Location
--
-- Additive and nullable: existing rows stay NULL, meaning unknown. The
-- client writes the field only after probing that this column exists
-- (services/shiplog/positionSourceColumn.ts), so the offline queue can never
-- be refused for an unknown column while this migration waits to be pushed.

ALTER TABLE public.ship_logs
    ADD COLUMN IF NOT EXISTS position_source TEXT;

ALTER TABLE public.ship_logs
    DROP CONSTRAINT IF EXISTS ship_logs_position_source_check;
ALTER TABLE public.ship_logs
    ADD CONSTRAINT ship_logs_position_source_check
    CHECK (
        position_source IS NULL
        OR position_source IN ('vessel', 'vessel-relay', 'vessel-pi-log', 'phone', 'phone-accessory')
    );

COMMENT ON COLUMN public.ship_logs.position_source IS
    'Receiver that produced this position: vessel, vessel-relay, vessel-pi-log, phone, phone-accessory. NULL = unknown (rows before build 123).';

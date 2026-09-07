-- Instrument publication is a separate, explicit choice from sharing a voyage.
-- Existing pages remain public, but no instrument readings are opted in for them.
ALTER TABLE public.voyage_log_configs
    ADD COLUMN IF NOT EXISTS public_instruments_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.voyage_log_configs.public_instruments_enabled IS
    'Explicit opt-in to public instrument readings. Enforced by voyage-log; does not grant anonymous table access.';

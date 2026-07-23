-- One logical device capture must produce at most one ship_logs row, even
-- when the first request times out, commits late, and the offline queue later
-- replays it. Existing rows remain valid because the key is nullable.

ALTER TABLE public.ship_logs
    ADD COLUMN IF NOT EXISTS client_operation_id TEXT;

ALTER TABLE public.ship_logs
    DROP CONSTRAINT IF EXISTS ship_logs_client_operation_id_shape;
ALTER TABLE public.ship_logs
    ADD CONSTRAINT ship_logs_client_operation_id_shape
    CHECK (
        client_operation_id IS NULL
        OR client_operation_id ~ '^[A-Za-z0-9_-]{1,128}$'
    );

CREATE UNIQUE INDEX IF NOT EXISTS ship_logs_owner_operation_uidx
    ON public.ship_logs(user_id, client_operation_id);

COMMENT ON COLUMN public.ship_logs.client_operation_id IS
    'Stable client-generated capture id used to deduplicate timeout and offline replay.';

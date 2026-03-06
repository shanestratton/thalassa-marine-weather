-- ============================================================
-- Push Queue Trigger — Auto-invoke send-push Edge Function
-- ============================================================
-- This trigger fires the send-push Edge Function whenever a new
-- notification is inserted into push_notification_queue.
--
-- OPTION A (below): pg_net HTTP trigger (requires pg_net extension)
-- OPTION B: Configure a Database Webhook in Supabase Dashboard instead
--           (Database → Webhooks → New → INSERT on push_notification_queue → send-push)
-- ============================================================

-- Ensure pg_net is enabled
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Trigger function: POST the new row to send-push Edge Function
CREATE OR REPLACE FUNCTION notify_push_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    _supabase_url TEXT;
    _service_key  TEXT;
BEGIN
    -- Read from Vault secrets (set via Supabase Dashboard → Settings → Vault)
    -- Fallback: hardcode or use app.settings
    SELECT decrypted_secret INTO _supabase_url
        FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1;
    SELECT decrypted_secret INTO _service_key
        FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

    -- Fallback to app.settings if Vault not configured
    IF _supabase_url IS NULL THEN
        _supabase_url := current_setting('app.settings.supabase_url', true);
    END IF;
    IF _service_key IS NULL THEN
        _service_key := current_setting('app.settings.service_role_key', true);
    END IF;

    -- Fire HTTP POST to send-push Edge Function
    PERFORM net.http_post(
        url     := _supabase_url || '/functions/v1/send-push',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || _service_key,
            'Content-Type', 'application/json'
        ),
        body    := jsonb_build_object('record', row_to_json(NEW))::text
    );

    RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS on_push_queue_insert ON push_notification_queue;
CREATE TRIGGER on_push_queue_insert
    AFTER INSERT ON push_notification_queue
    FOR EACH ROW
    EXECUTE FUNCTION notify_push_queue();

-- ISOLATED FRESH FIXTURES ONLY. Install AFTER relay.sql, never as a migration.
-- No network, pg_net, cron, APNs, device-token lookup or hosted grants exist here.
-- A notification row records one accepted relay decision; it proves neither
-- encryption nor recipient delivery/reading. gen_random_uuid() requires PG 13+.
BEGIN;

CREATE ROLE e2ee_research_notification_processor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_notification_processor;
SET LOCAL ROLE e2ee_research_owner;

-- Fail installation when the authoritative one-way account policy is absent.
-- Runtime lookups are fresh after lock_pilot, never cached gateway flags.
DO $$
BEGIN
    IF to_regclass('e2ee_research.protected_accounts') IS NULL
       OR to_regprocedure('e2ee_research.requires_protected(text)') IS NULL
       OR to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
        RAISE EXCEPTION 'Isolated private notification fixture unavailable' USING ERRCODE = '22023';
    END IF;
END $$;

CREATE TABLE e2ee_research.private_notifications (
    decision_server_id bigint PRIMARY KEY REFERENCES e2ee_research.decisions(server_id),
    message_id uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid()
        CHECK (message_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    state text NOT NULL CHECK (state IN ('pending','claimed','sink-accepted','suppressed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claim_id uuid,
    claimed_at timestamptz,
    sink_accepted_at timestamptz,
    suppressed_at timestamptz,
    CHECK (
        (state = 'pending' AND claim_id IS NULL AND claimed_at IS NULL
            AND sink_accepted_at IS NULL AND suppressed_at IS NULL)
        OR (state = 'claimed' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL
            AND sink_accepted_at IS NULL AND suppressed_at IS NULL)
        OR (state = 'sink-accepted' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL
            AND sink_accepted_at IS NOT NULL AND suppressed_at IS NULL)
        OR (state = 'suppressed' AND claim_id IS NULL AND claimed_at IS NULL
            AND sink_accepted_at IS NULL AND suppressed_at IS NOT NULL)
    )
);
ALTER TABLE e2ee_research.private_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2ee_research.private_notifications FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;

CREATE FUNCTION e2ee_research.private_notification_projection(message_id uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT jsonb_build_object(
    'version', 1, 'type', 'private-message', 'title', 'Thalassa',
    'body', 'Open Thalassa to view your private messages.',
    'route', jsonb_build_object('messageId', message_id::text)) $$;

-- Internal only. Lock precedes every device/block/account-policy observation.
-- Owner/peer generations in relay records are client values, not authority.
CREATE FUNCTION e2ee_research.private_notification_eligible(decision_id bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $$
DECLARE eligible boolean;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    SELECT entry.accepted AND NOT sender.revoked AND NOT recipient.revoked
           AND e2ee_research.same_text(recipient.identity_key_id, entry.recipient_identity_key_id)
           AND COALESCE(e2ee_research.requires_protected(entry.owner_id), false)
           AND COALESCE(e2ee_research.requires_protected(entry.recipient_user_id), false)
           AND NOT e2ee_research.is_blocked(entry.owner_id, entry.recipient_user_id)
    INTO eligible
    FROM e2ee_research.decisions entry
    JOIN e2ee_research.devices sender
      ON sender.user_id = entry.owner_id AND sender.device_id = entry.sender_device_id
    JOIN e2ee_research.devices recipient
      ON recipient.user_id = entry.recipient_user_id AND recipient.device_id = entry.recipient_device_id
    WHERE entry.server_id = decision_id;
    RETURN COALESCE(eligible, false);
END $$;

-- This trigger executes in the exact transaction that creates the decision.
-- Exact retries/conflicts create no new decision and cannot enqueue or revive.
CREATE FUNCTION e2ee_research.queue_private_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE eligible boolean;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    eligible := e2ee_research.private_notification_eligible(NEW.server_id);
    INSERT INTO e2ee_research.private_notifications(decision_server_id, state, suppressed_at)
    VALUES (NEW.server_id, CASE WHEN eligible THEN 'pending' ELSE 'suppressed' END,
            CASE WHEN eligible THEN NULL ELSE clock_timestamp() END);
    RETURN NEW;
END $$;
CREATE TRIGGER queue_private_notification
AFTER INSERT ON e2ee_research.decisions FOR EACH ROW WHEN (NEW.accepted)
EXECUTE FUNCTION e2ee_research.queue_private_notification();

-- Suppress under the same lifecycle transaction, so a block followed by an
-- unblock before processing still cannot revive a pending notification.
CREATE FUNCTION e2ee_research.suppress_private_notifications() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF TG_TABLE_NAME = 'devices' AND TG_OP = 'UPDATE' THEN
        -- Sender identity IDs are not recorded in existing relay decisions.
        -- Conservatively invalidate this device's work on any bundle/binding
        -- replacement, without copying keys/bundles into the notification row.
        IF OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.device_id IS DISTINCT FROM NEW.device_id
           OR OLD.identity_key_id IS DISTINCT FROM NEW.identity_key_id
           OR NOT e2ee_research.same_text(OLD.signed_bundle, NEW.signed_bundle) THEN
            UPDATE e2ee_research.private_notifications notification
            SET state = 'suppressed', claim_id = NULL, claimed_at = NULL,
                suppressed_at = clock_timestamp()
            FROM e2ee_research.decisions entry
            WHERE notification.decision_server_id = entry.server_id
              AND notification.state IN ('pending','claimed')
              AND ((entry.owner_id = OLD.user_id AND entry.sender_device_id = OLD.device_id)
                   OR (entry.recipient_user_id = OLD.user_id AND entry.recipient_device_id = OLD.device_id));
        END IF;
    END IF;
    UPDATE e2ee_research.private_notifications notification
    SET state = 'suppressed', claim_id = NULL, claimed_at = NULL,
        suppressed_at = clock_timestamp()
    WHERE notification.state IN ('pending','claimed')
      AND NOT e2ee_research.private_notification_eligible(notification.decision_server_id);
    RETURN NULL;
END $$;
CREATE TRIGGER suppress_private_notification_blocks
AFTER INSERT OR UPDATE OR DELETE ON e2ee_research.blocks FOR EACH STATEMENT
EXECUTE FUNCTION e2ee_research.suppress_private_notifications();
CREATE TRIGGER suppress_private_notification_devices
AFTER UPDATE OR DELETE ON e2ee_research.devices FOR EACH ROW
EXECUTE FUNCTION e2ee_research.suppress_private_notifications();
CREATE TRIGGER suppress_private_notification_account_policy
AFTER INSERT OR UPDATE OR DELETE ON e2ee_research.protected_accounts FOR EACH STATEMENT
EXECUTE FUNCTION e2ee_research.suppress_private_notifications();

-- One route and one UUID token scope a claim. The same token can retry its
-- immutable projection while eligible; another token cannot take over.
-- There is deliberately no expiry/reclaim or actual external sink in this
-- bounded fixture. A consumer crash can strand a claim (availability gate).
CREATE FUNCTION e2ee_research.claim_private_notification(route_id uuid, token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE notification e2ee_research.private_notifications;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF route_id IS NULL OR token IS NULL THEN
        RAISE EXCEPTION 'Isolated private notification fixture unavailable' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO notification FROM e2ee_research.private_notifications
    WHERE message_id = route_id FOR UPDATE;
    IF NOT FOUND OR notification.state IN ('suppressed','sink-accepted') THEN RETURN NULL; END IF;
    IF NOT e2ee_research.private_notification_eligible(notification.decision_server_id) THEN
        UPDATE e2ee_research.private_notifications SET state = 'suppressed', claim_id = NULL,
            claimed_at = NULL, suppressed_at = clock_timestamp() WHERE message_id = route_id;
        RETURN NULL;
    END IF;
    IF notification.state = 'claimed' AND notification.claim_id <> token THEN RETURN NULL; END IF;
    IF notification.state = 'pending' THEN
        UPDATE e2ee_research.private_notifications SET state = 'claimed', claim_id = token,
            claimed_at = clock_timestamp() WHERE message_id = route_id;
    END IF;
    RETURN e2ee_research.private_notification_projection(route_id);
END $$;

-- Local trusted sink acknowledgment only, never delivery/read evidence.
-- Duplicate acknowledgments of the same completed token are historical facts;
-- they emit no projection and grant no current authority.
CREATE FUNCTION e2ee_research.finish_private_notification(route_id uuid, token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE notification e2ee_research.private_notifications;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF route_id IS NULL OR token IS NULL THEN
        RAISE EXCEPTION 'Isolated private notification fixture unavailable' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO notification FROM e2ee_research.private_notifications
    WHERE message_id = route_id FOR UPDATE;
    IF NOT FOUND OR notification.state IN ('pending','suppressed')
       OR notification.claim_id <> token THEN RETURN false; END IF;
    IF notification.state = 'sink-accepted' THEN RETURN true; END IF;
    IF NOT e2ee_research.private_notification_eligible(notification.decision_server_id) THEN
        UPDATE e2ee_research.private_notifications SET state = 'suppressed', claim_id = NULL,
            claimed_at = NULL, suppressed_at = clock_timestamp() WHERE message_id = route_id;
        RETURN false;
    END IF;
    UPDATE e2ee_research.private_notifications SET state = 'sink-accepted',
        sink_accepted_at = clock_timestamp() WHERE message_id = route_id;
    RETURN true;
END $$;

REVOKE ALL ON FUNCTION e2ee_research.private_notification_projection(uuid) FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
REVOKE ALL ON FUNCTION e2ee_research.private_notification_eligible(bigint) FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
REVOKE ALL ON FUNCTION e2ee_research.queue_private_notification() FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
REVOKE ALL ON FUNCTION e2ee_research.suppress_private_notifications() FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
REVOKE ALL ON FUNCTION e2ee_research.claim_private_notification(uuid, uuid) FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
REVOKE ALL ON FUNCTION e2ee_research.finish_private_notification(uuid, uuid) FROM PUBLIC, e2ee_research_gateway, e2ee_research_notification_processor;
GRANT EXECUTE ON FUNCTION e2ee_research.claim_private_notification(uuid, uuid) TO e2ee_research_notification_processor;
GRANT EXECUTE ON FUNCTION e2ee_research.finish_private_notification(uuid, uuid) TO e2ee_research_notification_processor;
RESET ROLE;
COMMIT;

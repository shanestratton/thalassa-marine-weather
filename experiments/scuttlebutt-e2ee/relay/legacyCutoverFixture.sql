-- ISOLATED FRESH LOCAL FIXTURE ONLY. Install AFTER relay.sql.
-- This stands in for a legacy table and its private push queue; it does not
-- modify public.chat_direct_messages, production RLS/RPCs, send-push or APNs.
-- e2ee_research_fixture.actor_id is a caller-settable local test GUC, NOT Auth.
-- Synthetic clients can spoof it: these fixtures prove SQL policy ordering and
-- ownership checks under a supplied identity, never actual account authentication.
-- The bounded relay has one immutable registered device per synthetic account.
BEGIN;

CREATE ROLE e2ee_research_legacy_fixture_client NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE e2ee_research_legacy_fixture_processor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
SET LOCAL ROLE e2ee_research_owner;

DO $$
BEGIN
    IF to_regclass('e2ee_research.protected_accounts') IS NULL
       OR to_regprocedure('e2ee_research.requires_protected(text)') IS NULL THEN
        RAISE EXCEPTION 'Isolated legacy fixture unavailable' USING ERRCODE = '22023';
    END IF;
END $$;

CREATE TABLE e2ee_research.legacy_fixture_messages (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    sender_id e2ee_research.identifier NOT NULL REFERENCES e2ee_research.devices(user_id),
    recipient_id e2ee_research.identifier NOT NULL REFERENCES e2ee_research.devices(user_id),
    sender_name text NOT NULL DEFAULT 'Synthetic Sailor' CHECK (octet_length(sender_name) <= 256),
    message text NOT NULL CHECK (octet_length(message) BETWEEN 1 AND 65536),
    read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (sender_id <> recipient_id)
);
ALTER TABLE e2ee_research.legacy_fixture_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2ee_research.legacy_fixture_messages FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;

-- A historical plaintext canary is retained to prove that denial/suppression
-- does not encrypt, delete, sanitize or relabel old content. No client grant.
CREATE TABLE e2ee_research.legacy_fixture_push (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    message_id uuid NOT NULL UNIQUE REFERENCES e2ee_research.legacy_fixture_messages(id),
    stored_title text NOT NULL,
    stored_preview text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','suppressed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claimed_at timestamptz,
    suppressed_at timestamptz,
    CHECK ((state = 'pending' AND claimed_at IS NULL AND suppressed_at IS NULL)
        OR (state = 'claimed' AND claimed_at IS NOT NULL AND suppressed_at IS NULL)
        OR (state = 'suppressed' AND suppressed_at IS NOT NULL))
);
ALTER TABLE e2ee_research.legacy_fixture_push ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2ee_research.legacy_fixture_push FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;

-- Internal fresh-read gate; callers enter the same READ COMMITTED lock as
-- cutover/block/revoke BEFORE consulting private state. No direct client grant.
CREATE FUNCTION e2ee_research.legacy_fixture_pair_allowed(first_user text, second_user text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog
AS $$
DECLARE eligible boolean;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(first_user) OR NOT e2ee_research.valid_id(second_user)
       OR e2ee_research.same_text(first_user, second_user) THEN RETURN false; END IF;
    SELECT NOT sender.revoked AND NOT recipient.revoked
        AND NOT COALESCE(e2ee_research.requires_protected(first_user), true)
        AND NOT COALESCE(e2ee_research.requires_protected(second_user), true)
        AND NOT e2ee_research.is_blocked(first_user, second_user)
    INTO eligible
    FROM e2ee_research.devices sender
    JOIN e2ee_research.devices recipient ON recipient.user_id = second_user
    WHERE sender.user_id = first_user;
    RETURN COALESCE(eligible, false);
END $$;

-- Only this narrow definer policy gate is executable by the synthetic client.
-- PostgreSQL RLS needs EXECUTE on functions in its expression. It exposes no
-- raw mode, device, block or table data and first requires the supplied actor
-- to own an endpoint. The GUC remains an explicitly mocked identity boundary.
CREATE FUNCTION e2ee_research.legacy_fixture_client_allowed(sender text, recipient text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE actor text;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    actor := current_setting('e2ee_research_fixture.actor_id', true);
    IF NOT e2ee_research.valid_id(actor)
       OR NOT (e2ee_research.same_text(actor, sender) OR e2ee_research.same_text(actor, recipient)) THEN
        RETURN false;
    END IF;
    RETURN e2ee_research.legacy_fixture_pair_allowed(sender, recipient);
END $$;

CREATE POLICY legacy_fixture_select ON e2ee_research.legacy_fixture_messages
FOR SELECT TO e2ee_research_legacy_fixture_client
USING (sender_id = current_setting('e2ee_research_fixture.actor_id', true)
    OR recipient_id = current_setting('e2ee_research_fixture.actor_id', true));
CREATE POLICY legacy_fixture_insert ON e2ee_research.legacy_fixture_messages
FOR INSERT TO e2ee_research_legacy_fixture_client
WITH CHECK (sender_id = current_setting('e2ee_research_fixture.actor_id', true));
CREATE POLICY legacy_fixture_update ON e2ee_research.legacy_fixture_messages
FOR UPDATE TO e2ee_research_legacy_fixture_client
USING (recipient_id = current_setting('e2ee_research_fixture.actor_id', true))
WITH CHECK (recipient_id = current_setting('e2ee_research_fixture.actor_id', true));
-- An additional permissive policy cannot bypass this AND gate.
CREATE POLICY legacy_fixture_cutover_guard ON e2ee_research.legacy_fixture_messages
AS RESTRICTIVE FOR ALL TO e2ee_research_legacy_fixture_client
USING (e2ee_research.legacy_fixture_client_allowed(sender_id, recipient_id))
WITH CHECK (e2ee_research.legacy_fixture_client_allowed(sender_id, recipient_id));

-- BEFORE guards also run for the table owner/definer writes that bypass RLS.
-- Existing text/identity/timestamps are immutable in this deliberately narrow
-- fixture: only read state can change before cutover, and no UPDATE after it.
CREATE FUNCTION e2ee_research.guard_legacy_fixture_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF TG_OP = 'UPDATE' AND (OLD.id IS DISTINCT FROM NEW.id
       OR OLD.sender_id IS DISTINCT FROM NEW.sender_id OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
       OR NOT e2ee_research.same_text(OLD.sender_name, NEW.sender_name)
       OR NOT e2ee_research.same_text(OLD.message, NEW.message)
       OR OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Isolated legacy fixture unavailable' USING ERRCODE = '22023';
    END IF;
    IF NOT e2ee_research.legacy_fixture_pair_allowed(NEW.sender_id, NEW.recipient_id) THEN
        RAISE EXCEPTION 'Isolated legacy fixture unavailable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_fixture_write BEFORE INSERT OR UPDATE ON e2ee_research.legacy_fixture_messages
FOR EACH ROW EXECUTE FUNCTION e2ee_research.guard_legacy_fixture_write();

CREATE FUNCTION e2ee_research.queue_legacy_fixture_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.legacy_fixture_pair_allowed(NEW.sender_id, NEW.recipient_id) THEN
        RAISE EXCEPTION 'Isolated legacy fixture unavailable' USING ERRCODE = '22023';
    END IF;
    INSERT INTO e2ee_research.legacy_fixture_push(message_id, stored_title, stored_preview)
    VALUES (NEW.id, left(NEW.sender_name, 60), left(NEW.message, 100));
    RETURN NEW;
END $$;
CREATE TRIGGER queue_legacy_fixture_push AFTER INSERT ON e2ee_research.legacy_fixture_messages
FOR EACH ROW EXECUTE FUNCTION e2ee_research.queue_legacy_fixture_push();

-- Lifecycle suppression is terminal, including block then unblock before a
-- claim. Historical stored_title/stored_preview and legacy messages stay intact.
CREATE FUNCTION e2ee_research.suppress_legacy_fixture_push() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    PERFORM e2ee_research.lock_pilot();
    UPDATE e2ee_research.legacy_fixture_push notification
    SET state = 'suppressed', suppressed_at = clock_timestamp()
    FROM e2ee_research.legacy_fixture_messages message
    WHERE notification.message_id = message.id AND notification.state IN ('pending','claimed')
      AND NOT e2ee_research.legacy_fixture_pair_allowed(message.sender_id, message.recipient_id);
    RETURN NULL;
END $$;
CREATE TRIGGER suppress_legacy_fixture_push_protection
AFTER INSERT OR UPDATE OR DELETE ON e2ee_research.protected_accounts FOR EACH STATEMENT
EXECUTE FUNCTION e2ee_research.suppress_legacy_fixture_push();
CREATE TRIGGER suppress_legacy_fixture_push_blocks
AFTER INSERT OR UPDATE OR DELETE ON e2ee_research.blocks FOR EACH STATEMENT
EXECUTE FUNCTION e2ee_research.suppress_legacy_fixture_push();
CREATE TRIGGER suppress_legacy_fixture_push_devices
AFTER UPDATE OR DELETE ON e2ee_research.devices FOR EACH STATEMENT
EXECUTE FUNCTION e2ee_research.suppress_legacy_fixture_push();

-- Trusted local processor only. No actual network/sink/lease or completion is
-- implemented. A claimed projection cannot retract an already dispatched OS
-- banner, and possession of its opaque route UUID grants no message retrieval.
-- Even a permitted fixture claim projects fixed generic content, never stored
-- previews. Suppressed work returns NULL and cannot be reactivated by retries.
CREATE FUNCTION e2ee_research.claim_legacy_fixture_push(queue_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE notification e2ee_research.legacy_fixture_push; message e2ee_research.legacy_fixture_messages;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF queue_id IS NULL THEN
        RAISE EXCEPTION 'Isolated legacy fixture unavailable' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO notification FROM e2ee_research.legacy_fixture_push WHERE id = queue_id FOR UPDATE;
    IF NOT FOUND OR notification.state = 'suppressed' THEN RETURN NULL; END IF;
    SELECT * INTO message FROM e2ee_research.legacy_fixture_messages WHERE id = notification.message_id;
    IF NOT FOUND OR NOT e2ee_research.legacy_fixture_pair_allowed(message.sender_id, message.recipient_id) THEN
        UPDATE e2ee_research.legacy_fixture_push SET state = 'suppressed', suppressed_at = clock_timestamp()
        WHERE id = queue_id;
        RETURN NULL;
    END IF;
    IF notification.state = 'pending' THEN
        UPDATE e2ee_research.legacy_fixture_push SET state = 'claimed', claimed_at = clock_timestamp()
        WHERE id = queue_id;
    END IF;
    RETURN jsonb_build_object('version', 1, 'type', 'private-message', 'title', 'Thalassa',
        'body', 'Open Thalassa to view your private messages.',
        'route', jsonb_build_object('messageId', queue_id::text));
END $$;

REVOKE ALL ON FUNCTION e2ee_research.legacy_fixture_pair_allowed(text, text) FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
REVOKE ALL ON FUNCTION e2ee_research.legacy_fixture_client_allowed(text, text) FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
REVOKE ALL ON FUNCTION e2ee_research.guard_legacy_fixture_write() FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
REVOKE ALL ON FUNCTION e2ee_research.queue_legacy_fixture_push() FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
REVOKE ALL ON FUNCTION e2ee_research.suppress_legacy_fixture_push() FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
REVOKE ALL ON FUNCTION e2ee_research.claim_legacy_fixture_push(uuid) FROM PUBLIC, e2ee_research_gateway,
    e2ee_research_legacy_fixture_client, e2ee_research_legacy_fixture_processor;
GRANT EXECUTE ON FUNCTION e2ee_research.legacy_fixture_client_allowed(text, text) TO e2ee_research_legacy_fixture_client;
GRANT EXECUTE ON FUNCTION e2ee_research.claim_legacy_fixture_push(uuid) TO e2ee_research_legacy_fixture_processor;
GRANT SELECT, INSERT ON TABLE e2ee_research.legacy_fixture_messages TO e2ee_research_legacy_fixture_client;
GRANT UPDATE (read) ON TABLE e2ee_research.legacy_fixture_messages TO e2ee_research_legacy_fixture_client;
RESET ROLE;
COMMIT;

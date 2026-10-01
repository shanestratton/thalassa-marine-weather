-- ISOLATED RESEARCH ONLY. Run in a fresh disposable PostgreSQL-compatible DB.
-- Deliberately not a Supabase migration, and not an app/deployment dependency.
-- The gateway must authenticate the account and verify bundle signatures before
-- calling these RPCs. An actor argument is trusted gateway input, not JWT proof.
-- Device ownership here is account authorization, NOT device-key possession.
-- One global transaction lock serializes this bounded pilot, including lifecycle
-- changes. This is intentionally not a scalable relay or a concurrency proof.
-- RPCs require READ COMMITTED; a snapshot established before waiting for the
-- advisory lock must not hide an already committed block or revocation.
BEGIN;

-- Existing roles/schema cause failure; never silently reuse privileged objects.
CREATE ROLE e2ee_research_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE e2ee_research_gateway NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE SCHEMA e2ee_research AUTHORIZATION e2ee_research_owner;
REVOKE ALL ON SCHEMA e2ee_research FROM PUBLIC;
GRANT USAGE ON SCHEMA e2ee_research TO e2ee_research_gateway;
SET LOCAL ROLE e2ee_research_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA e2ee_research REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA e2ee_research REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA e2ee_research REVOKE ALL ON SEQUENCES FROM PUBLIC;

CREATE DOMAIN e2ee_research.identifier AS text COLLATE "C"
    CHECK (length(VALUE) BETWEEN 1 AND 128 AND VALUE !~ '[^A-Za-z0-9._:-]');

CREATE FUNCTION e2ee_research.valid_id(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND 128
    AND value !~ '[^A-Za-z0-9._:-]' $$;

CREATE FUNCTION e2ee_research.valid_uint(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $$
BEGIN
    IF value IS NULL OR jsonb_typeof(value) <> 'number' THEN RETURN false; END IF;
    IF value::text !~ '^(0|[1-9][0-9]{0,15})$' THEN RETURN false; END IF;
    RETURN value::text::numeric BETWEEN 0 AND 9007199254740991;
END $$;

CREATE FUNCTION e2ee_research.valid_key(value text, bytes integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $$
DECLARE padded text;
BEGIN
    IF value IS NULL OR bytes NOT IN (32, 64)
       OR length(value) <> (CASE bytes WHEN 32 THEN 43 ELSE 86 END)
       OR value !~ '^[A-Za-z0-9+/]+$' THEN RETURN false; END IF;
    padded := value || (CASE bytes WHEN 32 THEN '=' ELSE '==' END);
    RETURN octet_length(decode(padded, 'base64')) = bytes
       AND replace(encode(decode(padded, 'base64'), 'base64'), E'\n', '') = padded;
EXCEPTION WHEN others THEN RETURN false;
END $$;

-- Exact text equality below is byte equality even under a nondeterministic DB
-- collation. Canonical formats contain ASCII only, including identifiers.
CREATE FUNCTION e2ee_research.same_text(left_value text, right_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
AS $$ SELECT convert_to(left_value, 'UTF8') = convert_to(right_value, 'UTF8') $$;

CREATE FUNCTION e2ee_research.lock_pilot() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Invalid research relay transaction' USING ERRCODE = '25000';
    END IF;
    PERFORM pg_advisory_xact_lock(734812, 1);
END $$;

CREATE FUNCTION e2ee_research.parse_bundle(raw text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $$
DECLARE value jsonb; canonical text;
BEGIN
    IF raw IS NULL OR octet_length(raw) > 4096 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    value := raw::jsonb;
    IF jsonb_typeof(value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 11
       OR NOT value ?& ARRAY['version','protocol','userId','deviceId','identityKeyId',
                            'signingKey','curveKey','prekeyId','prekey','expiresAt','signature']
       OR value->'version' <> '1'::jsonb OR value->>'protocol' <> 'olm-v1'
       OR EXISTS (SELECT 1 FROM jsonb_each(value) AS entry WHERE entry.key NOT IN ('version','expiresAt')
                  AND jsonb_typeof(entry.value) <> 'string')
       OR NOT e2ee_research.valid_id(value->>'userId')
       OR NOT e2ee_research.valid_id(value->>'deviceId')
       OR NOT e2ee_research.valid_id(value->>'identityKeyId')
       OR NOT e2ee_research.valid_id(value->>'prekeyId')
       OR NOT e2ee_research.valid_key(value->>'signingKey', 32)
       OR NOT e2ee_research.valid_key(value->>'curveKey', 32)
       OR NOT e2ee_research.valid_key(value->>'prekey', 32)
       OR NOT e2ee_research.valid_key(value->>'signature', 64)
       OR NOT e2ee_research.valid_uint(value->'expiresAt') THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    canonical := format('{"version":1,"protocol":"olm-v1","userId":"%s","deviceId":"%s","identityKeyId":"%s","signingKey":"%s","curveKey":"%s","prekeyId":"%s","prekey":"%s","expiresAt":%s,"signature":"%s"}',
        value->>'userId', value->>'deviceId', value->>'identityKeyId', value->>'signingKey',
        value->>'curveKey', value->>'prekeyId', value->>'prekey', value->>'expiresAt', value->>'signature');
    IF NOT e2ee_research.same_text(raw, canonical) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    RETURN value;
EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
END $$;

CREATE FUNCTION e2ee_research.parse_envelope(raw text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog
AS $$
DECLARE value jsonb; cipher text; canonical text;
BEGIN
    IF raw IS NULL OR octet_length(raw) > 90156 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    value := raw::jsonb;
    IF jsonb_typeof(value) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 7
       OR NOT value ?& ARRAY['version','protocol','messageType','clientMessageId',
                            'senderDeviceId','recipientDeviceId','ciphertext']
       OR value->'version' <> '2'::jsonb OR value->>'protocol' <> 'olm-v1'
       OR EXISTS (SELECT 1 FROM jsonb_each(value) AS entry WHERE entry.key <> 'version'
                  AND jsonb_typeof(entry.value) <> 'string')
       OR value->>'messageType' NOT IN ('prekey','session')
       OR NOT e2ee_research.valid_id(value->>'clientMessageId')
       OR NOT e2ee_research.valid_id(value->>'senderDeviceId')
       OR NOT e2ee_research.valid_id(value->>'recipientDeviceId') THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    cipher := value->>'ciphertext';
    IF cipher IS NULL OR length(cipher) NOT BETWEEN 4 AND 88748
       OR cipher !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
       OR octet_length(decode(cipher, 'base64')) NOT BETWEEN 1 AND 66560
       OR NOT e2ee_research.same_text(replace(encode(decode(cipher, 'base64'), 'base64'), E'\n', ''), cipher) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    canonical := format('{"version":2,"protocol":"olm-v1","messageType":"%s","clientMessageId":"%s","senderDeviceId":"%s","recipientDeviceId":"%s","ciphertext":"%s"}',
        value->>'messageType', value->>'clientMessageId', value->>'senderDeviceId', value->>'recipientDeviceId', cipher);
    IF NOT e2ee_research.same_text(raw, canonical) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    RETURN value;
EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
END $$;

CREATE TABLE e2ee_research.devices (
    user_id e2ee_research.identifier PRIMARY KEY,
    device_id e2ee_research.identifier NOT NULL UNIQUE,
    identity_key_id e2ee_research.identifier NOT NULL,
    signed_bundle text NOT NULL CHECK (octet_length(signed_bundle) <= 4096),
    prekey_id e2ee_research.identifier NOT NULL,
    prekey text NOT NULL CHECK (e2ee_research.valid_key(prekey, 32)),
    expires_at bigint NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
    revoked boolean NOT NULL DEFAULT false,
    UNIQUE (user_id, device_id),
    CHECK (e2ee_research.parse_bundle(signed_bundle)->>'userId' = user_id),
    CHECK (e2ee_research.parse_bundle(signed_bundle)->>'deviceId' = device_id),
    CHECK (e2ee_research.parse_bundle(signed_bundle)->>'identityKeyId' = identity_key_id),
    CHECK (e2ee_research.parse_bundle(signed_bundle)->>'prekeyId' = prekey_id),
    CHECK (e2ee_research.parse_bundle(signed_bundle)->>'prekey' = prekey),
    CHECK ((e2ee_research.parse_bundle(signed_bundle)->>'expiresAt')::bigint = expires_at)
);

CREATE TABLE e2ee_research.blocks (
    owner_id e2ee_research.identifier NOT NULL REFERENCES e2ee_research.devices(user_id),
    other_id e2ee_research.identifier NOT NULL REFERENCES e2ee_research.devices(user_id),
    blocked boolean NOT NULL,
    PRIMARY KEY (owner_id, other_id),
    CHECK (owner_id <> other_id)
);

CREATE TABLE e2ee_research.claims (
    owner_id e2ee_research.identifier NOT NULL,
    sender_device_id e2ee_research.identifier NOT NULL,
    request_id e2ee_research.identifier NOT NULL,
    target_user_id e2ee_research.identifier NOT NULL,
    target_device_id e2ee_research.identifier NOT NULL UNIQUE,
    PRIMARY KEY (owner_id, sender_device_id, request_id),
    CHECK (owner_id <> target_user_id AND sender_device_id <> target_device_id),
    FOREIGN KEY (owner_id, sender_device_id) REFERENCES e2ee_research.devices(user_id, device_id),
    FOREIGN KEY (target_user_id, target_device_id) REFERENCES e2ee_research.devices(user_id, device_id)
);

CREATE TABLE e2ee_research.decisions (
    server_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    owner_id e2ee_research.identifier NOT NULL,
    owner_generation bigint NOT NULL CHECK (owner_generation BETWEEN 0 AND 9007199254740991),
    recipient_user_id e2ee_research.identifier NOT NULL,
    recipient_identity_key_id e2ee_research.identifier NOT NULL,
    recipient_generation bigint NOT NULL CHECK (recipient_generation BETWEEN 0 AND 9007199254740991),
    serialized_envelope text NOT NULL CHECK (octet_length(serialized_envelope) <= 90156),
    sender_device_id e2ee_research.identifier NOT NULL,
    recipient_device_id e2ee_research.identifier NOT NULL,
    client_message_id e2ee_research.identifier NOT NULL,
    accepted boolean NOT NULL,
    reason text,
    PRIMARY KEY (owner_id, sender_device_id, client_message_id, recipient_device_id),
    CHECK (owner_id <> recipient_user_id AND sender_device_id <> recipient_device_id),
    FOREIGN KEY (owner_id, sender_device_id) REFERENCES e2ee_research.devices(user_id, device_id),
    FOREIGN KEY (recipient_user_id, recipient_device_id) REFERENCES e2ee_research.devices(user_id, device_id),
    CHECK ((accepted AND reason IS NULL) OR (NOT accepted AND reason IS NOT NULL AND reason IN ('blocked','device-revoked'))),
    CHECK (e2ee_research.parse_envelope(serialized_envelope)->>'senderDeviceId' = sender_device_id),
    CHECK (e2ee_research.parse_envelope(serialized_envelope)->>'recipientDeviceId' = recipient_device_id),
    CHECK (e2ee_research.parse_envelope(serialized_envelope)->>'clientMessageId' = client_message_id)
);

-- No client policies or direct gateway table access. Table-owner definer RPCs
-- perform all account checks; their deliberate RLS bypass is part of the boundary.
ALTER TABLE e2ee_research.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE e2ee_research.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE e2ee_research.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE e2ee_research.decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA e2ee_research FROM PUBLIC, e2ee_research_gateway;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA e2ee_research FROM PUBLIC, e2ee_research_gateway;

CREATE FUNCTION e2ee_research.is_blocked(first_user text, second_user text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT EXISTS (SELECT 1 FROM e2ee_research.blocks
    WHERE blocked AND ((owner_id = first_user AND other_id = second_user)
                    OR (owner_id = second_user AND other_id = first_user))) $$;

CREATE FUNCTION e2ee_research.record_json(value e2ee_research.decisions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT jsonb_build_object(
    'ownerUserId', (value).owner_id, 'ownerSessionGeneration', (value).owner_generation,
    'recipientUserId', (value).recipient_user_id, 'recipientIdentityKeyId', (value).recipient_identity_key_id,
    'recipientIdentityGeneration', (value).recipient_generation, 'serializedEnvelope', (value).serialized_envelope) $$;

CREATE FUNCTION e2ee_research.register_device(actor text, bundle text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE value jsonb; existing e2ee_research.devices; now_seconds bigint;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    value := e2ee_research.parse_bundle(bundle);
    IF NOT e2ee_research.valid_id(actor) OR NOT e2ee_research.same_text(actor, value->>'userId') THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO existing FROM e2ee_research.devices WHERE user_id = actor;
    IF FOUND THEN
        IF existing.revoked OR NOT e2ee_research.same_text(existing.signed_bundle, bundle) THEN
            RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_build_object('registered', true, 'userId', actor, 'deviceId', existing.device_id);
    END IF;
    now_seconds := floor(extract(epoch FROM clock_timestamp()))::bigint;
    IF (value->>'expiresAt')::bigint <= now_seconds
       OR (value->>'expiresAt')::bigint > now_seconds + 604800
       OR EXISTS (SELECT 1 FROM e2ee_research.devices WHERE device_id = value->>'deviceId')
       OR (SELECT count(*) FROM e2ee_research.devices) >= 64 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    INSERT INTO e2ee_research.devices(user_id, device_id, identity_key_id, signed_bundle, prekey_id, prekey, expires_at)
    VALUES (actor, value->>'deviceId', value->>'identityKeyId', bundle, value->>'prekeyId', value->>'prekey',
            (value->>'expiresAt')::bigint);
    RETURN jsonb_build_object('registered', true, 'userId', actor, 'deviceId', value->>'deviceId');
END $$;

CREATE FUNCTION e2ee_research.revoke_device(actor text, device text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(actor) OR NOT e2ee_research.valid_id(device)
       OR NOT EXISTS (SELECT 1 FROM e2ee_research.devices WHERE user_id = actor AND device_id = device) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    UPDATE e2ee_research.devices SET revoked = true WHERE user_id = actor AND device_id = device;
    RETURN jsonb_build_object('revoked', true, 'userId', actor, 'deviceId', device);
END $$;

CREATE FUNCTION e2ee_research.set_block(actor text, other text, blocked boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE prior boolean;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(actor) OR NOT e2ee_research.valid_id(other) OR blocked IS NULL
       OR e2ee_research.same_text(actor, other)
       OR NOT EXISTS (SELECT 1 FROM e2ee_research.devices WHERE user_id = actor)
       OR NOT EXISTS (SELECT 1 FROM e2ee_research.devices WHERE user_id = other) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT entry.blocked INTO prior FROM e2ee_research.blocks entry WHERE owner_id = actor AND other_id = other;
    IF FOUND AND prior = blocked THEN RETURN jsonb_build_object('blocked', blocked); END IF;
    IF NOT FOUND AND (SELECT count(*) FROM e2ee_research.blocks WHERE owner_id = actor) >= 64 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    INSERT INTO e2ee_research.blocks(owner_id, other_id, blocked) VALUES (actor, other, blocked)
    ON CONFLICT (owner_id, other_id) DO UPDATE SET blocked = EXCLUDED.blocked;
    RETURN jsonb_build_object('blocked', blocked);
END $$;

CREATE FUNCTION e2ee_research.claim_prekey(actor text, device text, target_user text, target_device text, request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE destination e2ee_research.devices; existing e2ee_research.claims;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(actor) OR NOT e2ee_research.valid_id(device)
       OR NOT e2ee_research.valid_id(target_user) OR NOT e2ee_research.valid_id(target_device)
       OR NOT e2ee_research.valid_id(request_id)
       OR e2ee_research.same_text(actor, target_user) OR e2ee_research.same_text(device, target_device)
       OR NOT EXISTS (SELECT 1 FROM e2ee_research.devices
                      WHERE user_id = actor AND device_id = device AND NOT revoked) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO destination FROM e2ee_research.devices WHERE user_id = target_user AND device_id = target_device;
    IF NOT FOUND OR destination.revoked OR destination.expires_at <= extract(epoch FROM clock_timestamp())
       OR e2ee_research.is_blocked(actor, target_user) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO existing FROM e2ee_research.claims entry
    WHERE owner_id = actor AND sender_device_id = device AND entry.request_id = claim_prekey.request_id;
    IF FOUND THEN
        IF NOT e2ee_research.same_text(existing.target_user_id, target_user)
           OR NOT e2ee_research.same_text(existing.target_device_id, target_device) THEN
            RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM e2ee_research.claims WHERE target_device_id = target_device)
           OR (SELECT count(*) FROM e2ee_research.claims WHERE owner_id = actor) >= 64 THEN
            RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
        END IF;
        INSERT INTO e2ee_research.claims(owner_id, sender_device_id, request_id, target_user_id, target_device_id)
        VALUES (actor, device, request_id, target_user, target_device);
    END IF;
    RETURN jsonb_build_object('signedBundle', destination.signed_bundle, 'prekeyId', destination.prekey_id,
                              'prekey', destination.prekey);
END $$;

CREATE FUNCTION e2ee_research.send_message(actor text, record jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE envelope jsonb; sender e2ee_research.devices; recipient e2ee_research.devices;
        existing e2ee_research.decisions; refusal text; outcome boolean;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(actor) OR record IS NULL OR jsonb_typeof(record) <> 'object'
       OR octet_length(record::text) > 92000 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(record)) <> 6
       OR NOT record ?& ARRAY['ownerUserId','ownerSessionGeneration','recipientUserId',
                             'recipientIdentityKeyId','recipientIdentityGeneration','serializedEnvelope']
       OR EXISTS (SELECT 1 FROM jsonb_each(record) AS entry
                  WHERE entry.key NOT IN ('ownerSessionGeneration','recipientIdentityGeneration')
                    AND jsonb_typeof(entry.value) <> 'string')
       OR NOT e2ee_research.valid_id(record->>'ownerUserId')
       OR NOT e2ee_research.same_text(actor, record->>'ownerUserId')
       OR NOT e2ee_research.valid_id(record->>'recipientUserId')
       OR e2ee_research.same_text(actor, record->>'recipientUserId')
       OR NOT e2ee_research.valid_id(record->>'recipientIdentityKeyId')
       OR NOT e2ee_research.valid_uint(record->'ownerSessionGeneration')
       OR NOT e2ee_research.valid_uint(record->'recipientIdentityGeneration') THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    envelope := e2ee_research.parse_envelope(record->>'serializedEnvelope');
    IF e2ee_research.same_text(envelope->>'senderDeviceId', envelope->>'recipientDeviceId') THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO sender FROM e2ee_research.devices WHERE user_id = actor AND device_id = envelope->>'senderDeviceId';
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023'; END IF;
    SELECT * INTO existing FROM e2ee_research.decisions
    WHERE owner_id = actor AND sender_device_id = envelope->>'senderDeviceId'
      AND client_message_id = envelope->>'clientMessageId' AND recipient_device_id = envelope->>'recipientDeviceId';
    IF FOUND THEN
        IF NOT e2ee_research.same_text(e2ee_research.record_json(existing)::text, record::text) THEN
            RETURN record || jsonb_build_object('accepted', false, 'reason', 'record-conflict');
        END IF;
        RETURN record || (CASE WHEN existing.accepted THEN jsonb_build_object('accepted', true)
            ELSE jsonb_build_object('accepted', false, 'reason', existing.reason) END);
    END IF;
    SELECT * INTO recipient FROM e2ee_research.devices
    WHERE user_id = record->>'recipientUserId' AND device_id = envelope->>'recipientDeviceId'
      AND identity_key_id = record->>'recipientIdentityKeyId';
    IF NOT FOUND OR (SELECT count(*) FROM e2ee_research.decisions WHERE owner_id = actor) >= 256 THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    IF sender.revoked OR recipient.revoked THEN refusal := 'device-revoked';
    ELSIF e2ee_research.is_blocked(actor, recipient.user_id) THEN refusal := 'blocked'; END IF;
    outcome := refusal IS NULL;
    INSERT INTO e2ee_research.decisions(owner_id, owner_generation, recipient_user_id, recipient_identity_key_id,
        recipient_generation, serialized_envelope, sender_device_id, recipient_device_id, client_message_id, accepted, reason)
    VALUES (actor, (record->>'ownerSessionGeneration')::bigint, recipient.user_id, recipient.identity_key_id,
        (record->>'recipientIdentityGeneration')::bigint, record->>'serializedEnvelope', sender.device_id,
        recipient.device_id, envelope->>'clientMessageId', outcome, refusal);
    RETURN record || (CASE WHEN outcome THEN jsonb_build_object('accepted', true)
        ELSE jsonb_build_object('accepted', false, 'reason', refusal) END);
END $$;

CREATE FUNCTION e2ee_research.list_messages(actor text, device text, after_id bigint, batch integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE result jsonb;
BEGIN
    PERFORM e2ee_research.lock_pilot();
    IF NOT e2ee_research.valid_id(actor) OR NOT e2ee_research.valid_id(device)
       OR after_id IS NULL OR after_id NOT BETWEEN 0 AND 9007199254740991
       OR batch IS NULL OR batch NOT BETWEEN 1 AND 16
       OR NOT EXISTS (SELECT 1 FROM e2ee_research.devices WHERE user_id = actor AND device_id = device AND NOT revoked) THEN
        RAISE EXCEPTION 'Invalid research relay request' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(item.payload ORDER BY item.server_id), '[]'::jsonb) INTO result FROM (
        SELECT entry.server_id, e2ee_research.record_json(entry) ||
               jsonb_build_object('accepted', true, 'serverId', entry.server_id) AS payload
        FROM e2ee_research.decisions entry
        WHERE recipient_user_id = actor AND recipient_device_id = device AND accepted AND server_id > after_id
          AND NOT e2ee_research.is_blocked(actor, owner_id)
        ORDER BY server_id LIMIT batch
    ) item;
    RETURN result;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA e2ee_research FROM PUBLIC, e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.register_device(text, text) TO e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.revoke_device(text, text) TO e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.set_block(text, text, boolean) TO e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.claim_prekey(text, text, text, text, text) TO e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.send_message(text, jsonb) TO e2ee_research_gateway;
GRANT EXECUTE ON FUNCTION e2ee_research.list_messages(text, text, bigint, integer) TO e2ee_research_gateway;
RESET ROLE;
COMMIT;

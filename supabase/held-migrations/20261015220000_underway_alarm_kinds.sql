-- HELD: build 133-04. Review and apply this file alone before deploying the
-- compatible pi-alarm-relay and send-push functions. Do not run a blanket push.
-- No rows are written. Existing AIS keys, grants and owner-only RLS remain.
-- Chart-derived positions, depths, distances, names and ETAs stay aboard.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pi_alarm_events
    DROP CONSTRAINT pi_alarm_events_alarm_key_check,
    DROP CONSTRAINT pi_alarm_events_kind_check,
    DROP CONSTRAINT IF EXISTS pi_alarm_events_underway_payload_check;

ALTER TABLE public.pi_alarm_events
    ADD CONSTRAINT pi_alarm_events_alarm_key_check CHECK (
        char_length(alarm_key) <= 64 AND alarm_key ~
        '^((collision|close-quarters|distress|blind|no-fix|test):[0-9]{0,9}|(off-route|chart-ahead):):[0-9]{10,13}$'
    ),
    ADD CONSTRAINT pi_alarm_events_kind_check CHECK (
        kind IN ('collision', 'close-quarters', 'distress', 'blind', 'no-fix', 'test', 'off-route', 'chart-ahead')
    ),
    ADD CONSTRAINT pi_alarm_events_underway_payload_check CHECK (
        kind NOT IN ('off-route', 'chart-ahead') OR (
            mmsi IS NULL
            AND alarm_key ~ '^(off-route|chart-ahead)::[0-9]{10,13}$'
            AND payload <@ '{"name":"","cpa_nm":null,"tcpa_min":null,"range_nm":null,"bearing_deg":null,"lat":null,"lon":null,"lost":null,"distress_kind":null,"position_known":null,"silent_min":null,"cause":null,"position_basis":null,"uncertainty_nm":null}'::jsonb
        )
    );

CREATE OR REPLACE FUNCTION public.acknowledge_pi_alarm(p_alarm_key TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    caller UUID := auth.uid();
    acknowledged INTEGER;
BEGIN
    IF caller IS NULL THEN RAISE EXCEPTION 'sign in to acknowledge' USING ERRCODE = '42501';
    END IF;
    IF p_alarm_key IS NULL OR char_length(p_alarm_key) > 64 OR (
        p_alarm_key !~ '^(collision|close-quarters|distress):[0-9]{7,9}:[0-9]{10,13}$'
        AND p_alarm_key !~ '^(off-route|chart-ahead)::[0-9]{10,13}$'
    ) THEN
        RAISE EXCEPTION 'not an alarm key' USING ERRCODE = '22023';
    END IF;
    UPDATE public.pi_alarm_events
    SET acked_at = COALESCE(acked_at, now()), acked_by = COALESCE(acked_by, caller)
    WHERE owner_id = caller AND alarm_key = p_alarm_key AND resolved_at IS NULL;
    GET DIAGNOSTICS acknowledged = ROW_COUNT;
    RETURN acknowledged;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_pi_alarm(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_pi_alarm(TEXT) TO authenticated;

-- A version marker is returned only while the deployed constraints and
-- acknowledgement function contain this contract. It is private to the edge
-- service role; the authenticated Pi sees only its bounded probe response.
CREATE OR REPLACE FUNCTION public.pi_alarm_underway_capability()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE WHEN (
        SELECT count(*) = 3
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.pi_alarm_events'::regclass AND contype = 'c' AND convalidated
          AND conname IN ('pi_alarm_events_alarm_key_check', 'pi_alarm_events_kind_check', 'pi_alarm_events_underway_payload_check')
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%off-route%'
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%chart-ahead%'
    ) AND pg_catalog.pg_get_functiondef('public.acknowledge_pi_alarm(text)'::regprocedure) LIKE '%off-route|chart-ahead%'
    THEN 1 ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION public.pi_alarm_underway_capability() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pi_alarm_underway_capability() TO service_role;

DO $check$
BEGIN
    IF public.pi_alarm_underway_capability() <> 1 THEN
        RAISE EXCEPTION 'underway alarm schema capability is not version 1';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.pi_alarm_events'::regclass)
        OR has_table_privilege('anon', 'public.pi_alarm_events', 'SELECT')
        OR has_table_privilege('authenticated', 'public.pi_alarm_events', 'INSERT,UPDATE,DELETE')
        OR has_function_privilege('anon', 'public.pi_alarm_underway_capability()', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.pi_alarm_underway_capability()', 'EXECUTE') THEN
        RAISE EXCEPTION 'underway alarm access grants are not private';
    END IF;
END;
$check$;
COMMIT;

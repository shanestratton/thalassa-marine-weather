-- Disposable fixture only: no network extension, push trigger or credentials.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT current_setting('request.jwt.claim.role', true)
$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon,authenticated,service_role;
CREATE TABLE public.fixture_tombstones(user_id uuid PRIMARY KEY);
CREATE FUNCTION public.block_tombstoned_account_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.fixture_tombstones WHERE user_id=NEW.owner_id) THEN
        RAISE check_violation USING MESSAGE='fixture account write fence';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TABLE public.pi_diary_relays(
    relay_id text PRIMARY KEY,owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true
);
ALTER TABLE public.pi_diary_relays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pi_diary_relays FROM PUBLIC,anon,authenticated;
CREATE TABLE public.anchor_watch_sessions(
    session_code text PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id),expires_at timestamptz NOT NULL
);
CREATE TABLE public.anchor_alarm_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_code text,user_id uuid,pi_relay_id text,
    alarm_kind text,distance_m real,swing_radius_m real,vessel_lat real,vessel_lon real,
    resolved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;

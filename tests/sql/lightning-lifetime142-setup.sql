\set ON_ERROR_STOP on
DO $$ BEGIN IF current_database()<>'lightning142_test' THEN RAISE EXCEPTION 'Disposable lightning142_test database required'; END IF; END $$;
BEGIN;
\ir lightning-watch142-bootstrap.sql
INSERT INTO auth.users VALUES('10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000001');
INSERT INTO public.boats(id,owner_id) VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
INSERT INTO fixture.positions VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',gen_random_uuid(),-27,154,clock_timestamp()-interval '30 seconds',true);
INSERT INTO cron.job VALUES(1,'licensed-lightning-watch','*/2 * * * *','SELECT public.invoke_edge_function(''licensed-lightning-watch'', 55000)',true);
INSERT INTO cron.job_run_details VALUES(1,'succeeded',clock_timestamp());
CREATE FUNCTION fixture.reset_watch() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Disposable fixture seeding only, not an alternate production authority.
    DELETE FROM public.account_deletion_jobs;
    INSERT INTO auth.users VALUES('10000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
    INSERT INTO public.boats(id,owner_id) VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
    DELETE FROM public.push_notification_queue;
    DELETE FROM private_lightning142.deliveries;
    DELETE FROM private_lightning142.attempts;
    DELETE FROM public.lightning_watch_profiles;
    DELETE FROM fixture.state;
    UPDATE public.boats SET owner_id='10000000-0000-4000-8000-000000000001',archived_at=NULL,released_at=NULL;
    UPDATE fixture.positions SET owner_id='10000000-0000-4000-8000-000000000001',revision=gen_random_uuid(),lat=-27,lon=154,measured_at=clock_timestamp()-interval '30 seconds',enabled=true;
    UPDATE private_lightning142.health SET polling_enabled=true,function_version=1,delivery_version=1,entitlement_until=clock_timestamp()+interval '1 day',succeeded_at=clock_timestamp();
    UPDATE cron.job_run_details SET end_time=clock_timestamp();
    INSERT INTO private_presence.boat_presence(owner_id,boat_id,tier) VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','crew')
    ON CONFLICT(owner_id) DO UPDATE SET boat_id=EXCLUDED.boat_id,tier='crew';
    INSERT INTO private_comfort.contexts(owner_id) VALUES('10000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
    INSERT INTO private_comfort.cohorts(owner_id,boat_id,revision,profile) VALUES('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,'{}')
    ON CONFLICT(owner_id,boat_id) DO NOTHING;
    PERFORM set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
    PERFORM set_config('request.jwt.claim.role','authenticated',true);
    PERFORM public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',NULL,true);
    PERFORM set_config('request.jwt.claim.role','service_role',true);
    INSERT INTO fixture.state VALUES('expected',(SELECT to_jsonb(revision) FROM public.lightning_watch_profiles));
    INSERT INTO fixture.state VALUES('work',public.lightning_watch_work());
    IF jsonb_array_length((SELECT document FROM fixture.state WHERE key='work'))<>1 THEN RAISE EXCEPTION 'Fixture work unavailable'; END IF;
END $$;
CREATE FUNCTION fixture.claim(pulse text DEFAULT 'race-original',source timestamptz DEFAULT date_trunc('milliseconds',clock_timestamp())-interval '1 second') RETURNS boolean LANGUAGE sql AS $$
    SELECT public.lightning_watch_claim((j->>'boat_id')::uuid,(j->>'revision')::uuid,(j->>'lease')::uuid,pulse,-27,154,source)
    FROM (SELECT document->0 j FROM fixture.state WHERE key='work') s
$$;
CREATE FUNCTION fixture.old_current() RETURNS boolean LANGUAGE sql AS $$
    SELECT public.lightning_watch_attempt_current((j->>'boat_id')::uuid,(j->>'revision')::uuid,(j->>'lease')::uuid)
    FROM (SELECT document->0 j FROM fixture.state WHERE key='work') s
$$;
CREATE FUNCTION fixture.delivery_current() RETURNS boolean LANGUAGE sql AS $$
    SELECT coalesce(bool_or(public.lightning_watch_delivery_current(id)),false) FROM public.push_notification_queue
$$;
CREATE FUNCTION fixture.queue_empty() RETURNS boolean LANGUAGE sql AS $$
    SELECT NOT EXISTS(SELECT 1 FROM public.push_notification_queue) AND NOT EXISTS(SELECT 1 FROM private_lightning142.deliveries)
$$;
COMMIT;

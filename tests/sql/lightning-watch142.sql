\set ON_ERROR_STOP on
-- Disposable PostgreSQL only. The position transport is explicitly synthetic;
-- the actual new migration, RLS, role ACLs, locks and queue transaction execute.
DO $$ BEGIN IF current_database()<>'lightning142_test' THEN RAISE EXCEPTION 'Disposable lightning142_test database required'; END IF; END $$;
BEGIN;
\ir lightning-watch142-bootstrap.sql

INSERT INTO auth.users VALUES('10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000001');
INSERT INTO public.boats(id,owner_id,archived_at) VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',null);
INSERT INTO fixture.positions VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',-27,154,now()-interval '30 seconds',true);
SELECT fixture.assert(NOT has_function_privilege('anon','public.configure_lightning_watch(uuid,uuid,boolean)','EXECUTE'),'anonymous cannot configure');
SELECT fixture.assert(NOT has_function_privilege('authenticated','public.lightning_watch_work()','EXECUTE'),'ordinary user cannot obtain private work');
SELECT fixture.assert(NOT has_function_privilege('authenticated','public.lightning_watch_claim(uuid,uuid,uuid,text,double precision,double precision,timestamptz)','EXECUTE'),'ordinary user cannot enqueue paid-source claims');
SELECT fixture.assert(NOT has_table_privilege('authenticated','private_lightning142.deliveries','SELECT'),'precise pulse delivery data is private');
SELECT fixture.assert(NOT private_lightning142.ready(),'new licence/polling/sender/schedule admission is OFF');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT fixture.assert(public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',null,false)->>'enabled'='false','owner can confirm disabled state without licence');
SELECT fixture.error($sql$UPDATE public.lightning_watch_profiles SET enabled=true$sql$,'42501','ordinary direct writes refused');
SELECT fixture.error($sql$SELECT public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',null,false)$sql$,'40001','stale CAS revision refused');
SELECT fixture.error($sql$SELECT public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',(SELECT revision FROM public.lightning_watch_profiles),true)$sql$,'55000','unlicensed watch cannot be enabled');
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
SELECT fixture.assert((SELECT count(*) FROM public.lightning_watch_profiles)=0,'other owner cannot read profile through RLS');
SELECT fixture.assert(public.lightning_watch_status('30000000-0000-4000-8000-000000000001') IS NULL,'other owner cannot read watch status');
SELECT fixture.error($sql$SELECT public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',null,false)$sql$,'42501','other owner cannot configure boat');
RESET ROLE;
UPDATE private_lightning142.health SET polling_enabled=true,function_version=1,delivery_version=1,entitlement_until=now()+interval '1 day',succeeded_at=now();
SELECT fixture.assert(NOT private_lightning142.ready(),'configured licence does not fabricate actual schedule evidence');
INSERT INTO cron.job VALUES(1,'licensed-lightning-watch','*/2 * * * *','SELECT public.invoke_edge_function(''licensed-lightning-watch'', 55000)',true);
INSERT INTO cron.job_run_details VALUES(1,'succeeded',now());
SELECT fixture.assert(private_lightning142.ready(),'explicit synthetic actual schedule and heartbeat admitted');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT fixture.assert(public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',(SELECT revision FROM public.lightning_watch_profiles),true)->>'enabled'='true','owner explicitly enables with current rights and fresh position');
RESET ROLE;
UPDATE fixture.positions SET measured_at=now()-interval '121 seconds';
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT fixture.assert(public.lightning_watch_work()='[]'::jsonb,'stale original position never starts a paid attempt');
RESET ROLE;
UPDATE fixture.positions SET measured_at=now()-interval '30 seconds';
SET ROLE service_role;
INSERT INTO fixture.state VALUES('work',public.lightning_watch_work());
SELECT fixture.assert(jsonb_array_length((SELECT document FROM fixture.state WHERE key='work'))=1,'one current bounded work lease returned');
SELECT fixture.assert(public.lightning_watch_work()='[]'::jsonb,'second work claim retains original two-minute reservation');
RESET ROLE;
CREATE FUNCTION fixture.claim(pulse text DEFAULT 'original-pulse',latitude double precision DEFAULT -27,longitude double precision DEFAULT 154,source timestamptz DEFAULT date_trunc('milliseconds',now())-interval '1 second') RETURNS boolean LANGUAGE sql AS $$
    SELECT public.lightning_watch_claim((j->>'boat_id')::uuid,(j->>'revision')::uuid,(j->>'lease')::uuid,pulse,latitude,longitude,source)
    FROM (SELECT document->0 j FROM fixture.state WHERE key='work') s
$$;
CREATE FUNCTION fixture.current_attempt() RETURNS boolean LANGUAGE sql AS $$
    SELECT public.lightning_watch_attempt_current((j->>'boat_id')::uuid,(j->>'revision')::uuid,(j->>'lease')::uuid)
    FROM (SELECT document->0 j FROM fixture.state WHERE key='work') s
$$;
SET ROLE service_role;
SELECT fixture.assert(fixture.current_attempt(),'one-use lease is current before read');
SELECT fixture.assert(NOT fixture.claim('too-far',0,0),'distant pulse refused against current actual boat position');
SELECT fixture.assert(NOT fixture.claim('future',-27,154,now()+interval '1 second'),'future original pulse refused');
SELECT fixture.assert(NOT fixture.claim('old',-27,154,now()-interval '6 minutes'),'expired original pulse refused');
SELECT fixture.assert((SELECT count(*) FROM public.push_notification_queue)=0,'refusals do not enqueue');
RESET ROLE;
ALTER TABLE private_lightning142.deliveries ADD CONSTRAINT fixture_atomicity CHECK(pulse_id<>'reject-after-queue');
SET ROLE service_role;
SELECT fixture.error($sql$SELECT fixture.claim('reject-after-queue')$sql$,'23514','private delivery insertion failure rolls back queue atomically');
SELECT fixture.assert((SELECT count(*) FROM public.push_notification_queue)=0,'failed private insert left no queue row');
SELECT fixture.assert(fixture.current_attempt(),'failed transaction did not consume logical claim');
SELECT fixture.assert(fixture.claim(),'one current original pulse atomically queued');
SELECT fixture.assert(NOT fixture.claim(),'duplicate pulse/lease cannot enqueue again');
SELECT fixture.assert(NOT fixture.current_attempt(),'success consumes one-use claim lease');
SELECT fixture.assert((SELECT count(*) FROM public.push_notification_queue)=1,'exactly one queue row exists');
SELECT fixture.assert(public.lightning_watch_delivery_current((SELECT id FROM public.push_notification_queue)),'current opted-in event passes delivery guard');
RESET ROLE;
UPDATE fixture.positions SET lon=0;
SET ROLE service_role;
SELECT fixture.assert(NOT public.lightning_watch_delivery_current((SELECT id FROM public.push_notification_queue)),'boat movement outside20NM retires queued pulse');
RESET ROLE;
UPDATE fixture.positions SET lon=154;
-- Integrated real boat-retirement bodies: a no-op is distinct from a
-- committed lifecycle transition. Savepoints isolate these extra controls
-- while preserving every original core assertion below.
INSERT INTO fixture.state VALUES('original-revision',(SELECT to_jsonb(revision) FROM public.lightning_watch_profiles));
SELECT set_config('fixture.lightning_revision',(SELECT revision::text FROM public.lightning_watch_profiles),true);
SELECT fixture.assert((SELECT array_agg(tgname ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.boats'::regclass AND NOT tgisinternal AND (tgtype & 2)=2)=ARRAY['aa_lightning_watch_boat_retirement','account_deletion_write_fence']::name[],'actual boat BEFORE triggers admit nonblocking authority before inherited account fence');
UPDATE public.boats SET archived_at=archived_at;
SELECT fixture.assert((SELECT revision::text FROM public.lightning_watch_profiles)=(SELECT document#>>'{}' FROM fixture.state WHERE key='original-revision'),'no-op boat update retains exact watch revision');
SELECT fixture.assert((SELECT enabled FROM public.lightning_watch_profiles),'no-op does not disable explicit consent');
UPDATE public.boats SET name='Changed metadata';
SELECT fixture.assert((SELECT revision::text FROM public.lightning_watch_profiles)=(SELECT document#>>'{}' FROM fixture.state WHERE key='original-revision'),'ordinary boat metadata retains exact watch revision');
SELECT fixture.assert((SELECT enabled FROM public.lightning_watch_profiles),'ordinary metadata does not disable explicit consent');
SAVEPOINT archive_lifecycle;
UPDATE public.boats SET archived_at=clock_timestamp();
SELECT fixture.assert(NOT(SELECT enabled FROM public.lightning_watch_profiles),'archive durably disables consent');
SELECT fixture.assert(NOT EXISTS(SELECT 1 FROM private_lightning142.attempts),'archive retires original work lease');
SELECT fixture.assert((SELECT count(*) FROM private_lightning142.deliveries)=1,'archive retains dedupe and quota history');
UPDATE public.boats SET archived_at=NULL;
SELECT fixture.assert(NOT(SELECT enabled FROM public.lightning_watch_profiles),'unarchive cannot revive old consent');
SET ROLE service_role;
SELECT fixture.assert(NOT public.lightning_watch_delivery_current((SELECT id FROM public.push_notification_queue)),'archive ABA cannot revive queued authority');
RESET ROLE;
SET ROLE authenticated;
SELECT fixture.error($sql$SELECT public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',current_setting('fixture.lightning_revision')::uuid,true)$sql$,'40001','pre-archive CAS revision cannot silently enable again');
RESET ROLE;
ROLLBACK TO archive_lifecycle;
SAVEPOINT owner_lifecycle;
UPDATE public.boats SET owner_id='20000000-0000-4000-8000-000000000001';
UPDATE public.boats SET owner_id='10000000-0000-4000-8000-000000000001';
SELECT fixture.assert(NOT(SELECT enabled FROM public.lightning_watch_profiles),'owner A B A cannot revive consent');
SELECT fixture.assert((SELECT revision::text FROM public.lightning_watch_profiles)<>(SELECT document#>>'{}' FROM fixture.state WHERE key='original-revision'),'owner ABA advances durable revision');
SET ROLE service_role;
SELECT fixture.assert(NOT public.lightning_watch_delivery_current((SELECT id FROM public.push_notification_queue)),'owner ABA cannot revive original queued delivery');
RESET ROLE;
ROLLBACK TO owner_lifecycle;
SAVEPOINT release_lifecycle;
UPDATE public.boats SET released_at=clock_timestamp();
UPDATE public.boats SET released_at=NULL;
SELECT fixture.assert(NOT(SELECT enabled FROM public.lightning_watch_profiles),'release undo cannot revive consent');
ROLLBACK TO release_lifecycle;
SAVEPOINT deletion_lifecycle;
INSERT INTO public.account_deletion_jobs VALUES('10000000-0000-4000-8000-000000000001');
SELECT fixture.error($sql$UPDATE public.boats SET archived_at=clock_timestamp()$sql$,'55000','actual canonical account fence still refuses a tombstoned boat update');
DELETE FROM public.boats;
SELECT fixture.assert(NOT EXISTS(SELECT 1 FROM public.lightning_watch_profiles),'tombstoned boat deletion retires without a fenced UPDATE');
ROLLBACK TO deletion_lifecycle;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT fixture.assert(public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',(SELECT revision FROM public.lightning_watch_profiles),false)->>'enabled'='false','explicit disable advances revision');
RESET ROLE;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT fixture.assert(NOT public.lightning_watch_delivery_current((SELECT id FROM public.push_notification_queue)),'revoked opt-in retires already queued event');
RESET ROLE;
UPDATE public.boats SET owner_id='20000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
SELECT fixture.assert(public.lightning_watch_status('30000000-0000-4000-8000-000000000001')->'profile'='null'::jsonb,'new owner never inherits old consent');
SELECT fixture.assert(public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',null,false)->>'enabled'='false','new owner can reset to OFF without old private revision');
RESET ROLE;
INSERT INTO public.account_deletion_jobs VALUES('20000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT fixture.assert(public.lightning_watch_status('30000000-0000-4000-8000-000000000001') IS NULL,'deleted account gets no watch status');
SELECT fixture.error($sql$SELECT public.configure_lightning_watch('30000000-0000-4000-8000-000000000001',(SELECT revision FROM public.lightning_watch_profiles),false)$sql$,'42501','deleted account cannot configure');
RESET ROLE;
SELECT fixture.error($sql$UPDATE public.lightning_watch_profiles SET enabled=true$sql$,'55000','actual tombstone trigger fences privileged writes too');
SELECT fixture.assert(private_lightning142.within_radius(0,179.99,0,-179.99),'20NM predicate handles antimeridian');
ROLLBACK;
\echo LIGHTNING142_POSTGRES_REPLAY_PASSED

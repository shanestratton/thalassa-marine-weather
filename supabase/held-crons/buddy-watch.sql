-- HELD: not an automatic migration. No existing job is resumed/replaced.
DO $held$
BEGIN
 IF current_setting('thalassa.activate_buddy_watch',true) IS DISTINCT FROM 'reviewed-137' THEN
  RAISE EXCEPTION 'Buddy notice source/delivery review required';
 END IF;
 IF to_regprocedure('public.invoke_edge_function(text,integer,jsonb)') IS NULL OR
  NOT private_buddy_watch.permitted() THEN RAISE EXCEPTION 'Reviewed source entitlement and sender required'; END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='buddy-watch') THEN
  RAISE EXCEPTION 'Existing buddy job needs explicit comparison; left untouched';
 END IF;
 PERFORM cron.schedule('buddy-watch','*/5 * * * *','SELECT public.invoke_edge_function(''buddy-watch'', 25000)');
END $held$;
-- Rollback: disable private_buddy_watch.control.enabled first, then pause only
-- this reviewed cron. Every queued attempt fails closed; preserve owned follows.

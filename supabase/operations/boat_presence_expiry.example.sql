-- HELD OPERATOR TEMPLATE, NOT A MIGRATION. No job has been installed.
-- Root must review the deployed canonical migration and actual pg_cron
-- capability first, then explicitly set this transaction-local review marker.
-- Never add the marker to this file or run it through automatic db push.
BEGIN;
DO $$ BEGIN
    IF current_user<>'postgres' OR current_setting('thalassa.reviewed_presence_expiry',true) IS DISTINCT FROM '140-04'
    THEN RAISE EXCEPTION 'Held presence expiry template requires explicit operator review'; END IF;
    IF to_regclass('cron.job') IS NULL OR to_regprocedure('private_presence.expire_batch()') IS NULL
    THEN RAISE EXCEPTION 'Existing pg_cron and reviewed presence migration required'; END IF;
    IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='thalassa-presence-140-expiry')
    THEN RAISE EXCEPTION 'Inspect existing presence expiry job; do not duplicate or replace it'; END IF;
    IF EXISTS(SELECT 1 FROM pg_publication p LEFT JOIN pg_publication_namespace pn ON pn.pnpubid=p.oid
        LEFT JOIN pg_namespace n ON n.oid=pn.pnnspid WHERE p.puballtables OR n.nspname='private_presence')
    THEN RAISE EXCEPTION 'Private presence publication policy changed'; END IF;
    PERFORM cron.schedule('thalassa-presence-140-expiry','* * * * *','SELECT private_presence.expire_batch();');
END $$;
COMMIT;

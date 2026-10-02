-- Binders live across devices (Shane, 2026-10-02: "if i change something on
-- one machine, it is not reflected in the other").
--
-- The open binder pages subscribe to postgres_changes on these five tables,
-- but no migration ever added them to the supabase_realtime publication
-- (only shopping_list, checklists, checklist_runs, chat, guardian, voice and
-- telemetry tables are). The live database already publishes all five: they
-- were switched on from the dashboard (read on 2026-10-02). This records that
-- in the migrations, so a fresh or branch database delivers them too; without
-- it the socket would deliver nothing for them, silently.
--
-- Guarded like 20260723103000_offline_schema_alignment.sql: a table already
-- published is left as it is, so the migration is a no-op on the live
-- database and safe to replay.
--
-- Realtime still applies RLS to INSERT and UPDATE per subscriber. A DELETE
-- cannot be checked against a row that no longer exists, so every subscriber
-- of the table hears it; with the default replica identity the payload is the
-- primary key alone (a random UUID), and the app only removes a local row
-- with that id.
--
-- vessel_crew is deliberately NOT added here: its realtime handler forces a
-- full reconciliation on every event, and DELETE events reach every
-- subscriber, so each crew removal anywhere would make every open Vessel Hub
-- pull all twelve tables. Membership changes are picked up by the share
-- refresh at the start of every sync cycle instead.
DO $$
DECLARE
    binder_table TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        RETURN;
    END IF;

    FOREACH binder_table IN ARRAY ARRAY[
        'inventory_items',
        'maintenance_tasks',
        'maintenance_history',
        'equipment_register',
        'ship_documents'
    ]
    LOOP
        IF to_regclass(format('public.%I', binder_table)) IS NOT NULL
        AND NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = binder_table
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', binder_table);
        END IF;
    END LOOP;
END;
$$;

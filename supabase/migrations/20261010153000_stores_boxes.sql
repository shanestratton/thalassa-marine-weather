-- Boxes in Ship's Stores (2026-10-10, build 126, package 126-11a).
--
-- Not pushed with this commit: it goes in the 126 release push, on Shane's yes
-- (after 20261010152000_inventory_items_expiry_date, before 126-13's
-- 20261010154000-155000, whose anon sweep then also covers this table).
--
-- Why
-- ───
-- Shane, 2026-10-09: "i have 50 nfc tags ... so that we can have boxes in the
-- engine room, that i scan the nfc tag which is stuck on the front of the box
-- and it will show me everything that is in that box. if i remove an item
-- from the box, i should just be able to -1 to the item that i took."
--
-- What
-- ────
-- public.stores_boxes: one row per named box in a skipper's Ship's Stores
-- (name, zone, notes). Its id is a random UUID that names nothing; 126-11b
-- writes it on the tag (https://thalassawx.app/box/<id>, 63 bytes, well inside
-- an NTAG213's 144).
--
-- inventory_items.box_id: the box an item is in. Nullable, and deliberately
-- NOT a foreign key: the app pushes its offline outbox table by table, so an
-- item can reach the server before the box it points at, and a box deleted on
-- one phone may still be named by an item edited offline on another. The app
-- treats an unknown box id as "not in a box". Indexed for "what is in this
-- box".
--
-- Shared exactly as inventory_items is, through the 'stores' register
-- (20260723100000_crew_manifest_hardening.sql): register members read; editors
-- (crew with write on a shared Stores) create and update; only the owner
-- deletes; crew_rewrite_user_id('stores') stamps a crew insert with the
-- skipper's id. The triggers are every one inventory_items has (read from the
-- migrations on 2026-10-10): the crew rewrite, the updated_at stamp, and the
-- account-deletion write fence (installed on inventory_items by
-- 20260806120000's foreign-key sweep).
--
-- Deploy order: none needed. The app works before this is pushed: it skips
-- stores_boxes quietly while PostgREST answers PGRST205 and writes no box, and
-- no box_id, until it has read this table from the server once
-- (SyncService OPTIONAL_TABLES, StoresBoxService.serverHasBoxes). The table
-- and the column arrive together in this one file, so finding the table proves
-- the column.
--
-- New tables get anon grants by default (Supabase): this file revokes them
-- itself rather than wait for 126-13's sweep.
--
-- Undo
-- ────
--     ALTER PUBLICATION supabase_realtime DROP TABLE public.stores_boxes;
--     DROP TABLE IF EXISTS public.stores_boxes;
--     DROP INDEX IF EXISTS public.idx_inventory_items_box_id;
--     ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS box_id;
-- (an app that has seen the table then stops writing boxes once a pull meets
-- PGRST205 again; a queued item edit carrying box_id would fail until then).
--
-- No BEGIN/COMMIT: the CLI applies the file, and a rolled-back rehearsal can
-- run it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.stores_boxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location_zone TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stores_boxes_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT stores_boxes_zone_length CHECK (location_zone IS NULL OR char_length(location_zone) <= 80),
    CONSTRAINT stores_boxes_notes_length CHECK (notes IS NULL OR char_length(notes) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_stores_boxes_user_id ON public.stores_boxes (user_id);

-- The soft link (no foreign key: see above). Where the column is new this
-- changes the catalogue only: no rewrite, a lock for milliseconds.
ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS box_id UUID;
CREATE INDEX IF NOT EXISTS idx_inventory_items_box_id ON public.inventory_items (box_id) WHERE box_id IS NOT NULL;

ALTER TABLE public.stores_boxes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.stores_boxes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stores_boxes TO authenticated;

-- A crew editor's new box goes into the skipper's Stores, as a crew item does.
DROP TRIGGER IF EXISTS trg_crew_rewrite_stores_boxes ON public.stores_boxes;
CREATE TRIGGER trg_crew_rewrite_stores_boxes
    BEFORE INSERT ON public.stores_boxes
    FOR EACH ROW EXECUTE FUNCTION public.crew_rewrite_user_id('stores');

-- The same BEFORE UPDATE stamp inventory_items uses (20260219000000), so an
-- edit moves updated_at on the database clock and incremental pulls see it.
DROP TRIGGER IF EXISTS trg_stores_boxes_updated_at ON public.stores_boxes;
CREATE TRIGGER trg_stores_boxes_updated_at
    BEFORE UPDATE ON public.stores_boxes
    FOR EACH ROW EXECUTE FUNCTION public.update_inventory_updated_at();

-- A deleted account's tombstone refuses new writes, as on every user-owned
-- table (20260806120000_account_deletion_durability.sql).
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.stores_boxes;
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.stores_boxes
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('user_id');

DROP POLICY IF EXISTS "Register members read boxes" ON public.stores_boxes;
CREATE POLICY "Register members read boxes"
    ON public.stores_boxes FOR SELECT TO authenticated
    USING (public.can_access_vessel_register(user_id, 'stores', false));

DROP POLICY IF EXISTS "Register editors create boxes" ON public.stores_boxes;
CREATE POLICY "Register editors create boxes"
    ON public.stores_boxes FOR INSERT TO authenticated
    WITH CHECK (public.can_access_vessel_register(user_id, 'stores', true));

DROP POLICY IF EXISTS "Register editors update boxes" ON public.stores_boxes;
CREATE POLICY "Register editors update boxes"
    ON public.stores_boxes FOR UPDATE TO authenticated
    USING (public.can_access_vessel_register(user_id, 'stores', true))
    WITH CHECK (public.can_access_vessel_register(user_id, 'stores', true));

DROP POLICY IF EXISTS "Box owners delete" ON public.stores_boxes;
CREATE POLICY "Box owners delete"
    ON public.stores_boxes FOR DELETE TO authenticated
    USING (user_id = auth.uid());

-- Live across devices: the Stores page subscribes to it once the table is
-- live on the phone. Guarded like 20261002150000, so a replay (or a table
-- published from the dashboard) is a no-op.
DO $publish$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'stores_boxes'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.stores_boxes;
    END IF;
END;
$publish$;

NOTIFY pgrst, 'reload schema';

DO $check$
DECLARE
    verb TEXT;
BEGIN
    IF to_regclass('public.stores_boxes') IS NULL THEN
        RAISE EXCEPTION 'stores_boxes: the table is missing';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stores_boxes'::regclass) THEN
        RAISE EXCEPTION 'stores_boxes: row level security is off';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'inventory_items'
           AND column_name = 'box_id'
           AND data_type = 'uuid'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'stores_boxes: inventory_items.box_id (nullable uuid) is missing';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.inventory_items'::regclass
           AND contype = 'f'
           AND conkey @> ARRAY[(
               SELECT attnum FROM pg_attribute
                WHERE attrelid = 'public.inventory_items'::regclass AND attname = 'box_id'
           )]
    ) THEN
        RAISE EXCEPTION 'stores_boxes: inventory_items.box_id must not be a foreign key';
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stores_boxes') <> 4 THEN
        RAISE EXCEPTION 'stores_boxes: expected exactly four policies';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_trigger
         WHERE tgrelid = 'public.stores_boxes'::regclass
           AND NOT tgisinternal
           AND tgname IN (
               'trg_crew_rewrite_stores_boxes',
               'trg_stores_boxes_updated_at',
               'account_deletion_write_fence'
           )
    ) <> 3 THEN
        RAISE EXCEPTION 'stores_boxes: a trigger did not install';
    END IF;
    FOREACH verb IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege('anon', 'public.stores_boxes', verb) THEN
            RAISE EXCEPTION 'stores_boxes: anon can still %', verb;
        END IF;
        IF NOT has_table_privilege('authenticated', 'public.stores_boxes', verb) THEN
            RAISE EXCEPTION 'stores_boxes: authenticated cannot %', verb;
        END IF;
    END LOOP;
    IF NOT has_column_privilege('authenticated', 'public.inventory_items', 'box_id', 'UPDATE') THEN
        RAISE EXCEPTION 'stores_boxes: the app cannot write inventory_items.box_id';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
        SELECT 1
          FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = 'stores_boxes'
    ) THEN
        RAISE EXCEPTION 'stores_boxes: not in supabase_realtime';
    END IF;
END;
$check$;

RESET lock_timeout;

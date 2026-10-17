-- Exact production retirement dependency subsets; no full migration/provider claim.
-- supabase/migrations/20261017030921_boat_presence.sql sha256=f7bdbca08ec64a2ea41fe81a21d5f7c2413e754ccaf0b5586fd414255f9523d5
-- supabase/migrations/20261017050550_private_passage_comfort.sql sha256=b0485f0b62b948a824f894e4c26b9d3fb022deeafdde0295ba49e01cddf568be
-- supabase/migrations/20260516120000_voyage_log_boats.sql sha256=4a4fb8809793c9ac9abbf17a663edf130e8b66ff438fe70b47a1b807d9fb2e73
-- supabase/migrations/20260806120000_account_deletion_durability.sql sha256=8cdd4889882939a27e24234928201ced3a343c87d5e8d3f02a499eafd0acbe9d
CREATE SCHEMA private_presence;

CREATE SCHEMA private_comfort;

CREATE TABLE private_presence.boat_presence (
    owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Intentionally no boats FK: boat retirement already holds that row lock.
    -- Live ownership joins + retirement triggers avoid a reverse key-share /
    -- config lock cycle. These UUIDs never confer authority by themselves.
    boat_id uuid,
    tier text NOT NULL DEFAULT 'off' CHECK(tier IN ('off','crew','friends','nearby')),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    sequence bigint NOT NULL DEFAULT 1 CHECK(sequence>0),
    reader_revision uuid NOT NULL DEFAULT gen_random_uuid(), reader_nonce uuid, reader_until timestamptz,
    publisher_revision uuid NOT NULL DEFAULT gen_random_uuid(), publisher_nonce uuid, publisher_until timestamptz,
    quota_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    controls integer NOT NULL DEFAULT 0 CHECK(controls BETWEEN 0 AND 30),
    fixes integer NOT NULL DEFAULT 0 CHECK(fixes BETWEEN 0 AND 6),
    reads integer NOT NULL DEFAULT 0 CHECK(reads BETWEEN 0 AND 6),
    CHECK(tier='off' OR boat_id IS NOT NULL),
    CHECK((reader_nonce IS NULL)=(reader_until IS NULL)),
    CHECK((publisher_nonce IS NULL)=(publisher_until IS NULL))
);

CREATE TABLE private_presence.samples (
    owner_id uuid PRIMARY KEY REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    fix_lat double precision, fix_lon double precision, fix_at timestamptz,
    pending_lat double precision, pending_lon double precision, pending_at timestamptz, pending_bucket bigint, pending_source_at timestamptz,
    published_lat double precision, published_lon double precision, published_at timestamptz, published_bucket bigint, published_source_at timestamptz,
    touched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(fix_lat BETWEEN -90 AND 90 AND fix_lon BETWEEN -180 AND 180),
    CHECK(pending_lat BETWEEN -90 AND 90 AND pending_lon BETWEEN -180 AND 180),
    CHECK(published_lat BETWEEN -90 AND 90 AND published_lon BETWEEN -180 AND 180),
    CHECK((fix_lat IS NULL)=(fix_lon IS NULL) AND (fix_lat IS NULL)=(fix_at IS NULL)),
    CHECK((pending_lat IS NULL)=(pending_lon IS NULL) AND (pending_lat IS NULL)=(pending_at IS NULL)
        AND (pending_lat IS NULL)=(pending_bucket IS NULL) AND (pending_lat IS NULL)=(pending_source_at IS NULL)),
    CHECK((published_lat IS NULL)=(published_lon IS NULL) AND (published_lat IS NULL)=(published_at IS NULL)
        AND (published_lat IS NULL)=(published_bucket IS NULL) AND (published_lat IS NULL)=(published_source_at IS NULL))
);

CREATE TABLE private_presence.friend_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    boat_id uuid NOT NULL,
    revision uuid NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
    label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);

CREATE TABLE private_presence.friends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES private_presence.boat_presence(owner_id) ON DELETE CASCADE,
    boat_id uuid NOT NULL,
    grantee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(owner_id<>grantee_id), UNIQUE(owner_id,boat_id,grantee_id)
);

CREATE TABLE private_comfort.contexts(
 owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 quota_at timestamptz NOT NULL DEFAULT clock_timestamp(), calls integer NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 30)
);

CREATE TABLE private_comfort.cohorts(
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 -- No boat FK: its key-share would reverse the existing retirement lock
 -- order (boat row -> account advisory). Live joins and the trigger below
 -- provide retirement/cascade without adding that deadlock edge.
 boat_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
 PRIMARY KEY(owner_id,boat_id)
);

CREATE FUNCTION private_presence.lock_only(p_accounts uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='500ms' AS $$
DECLARE v_id uuid;
BEGIN
    FOR v_id IN SELECT DISTINCT x FROM unnest(p_accounts) x WHERE x IS NOT NULL ORDER BY x LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_id::text,20260806));
    END LOOP;
END $$;

CREATE FUNCTION private_presence.retire_owner(p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
    PERFORM private_presence.lock_only(ARRAY[p_owner]);
    -- Account-deletion cascades must never be blocked by a tombstoned UPDATE.
    IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=p_owner) THEN
        DELETE FROM private_presence.boat_presence p WHERE p.owner_id=p_owner;
        RETURN;
    END IF;
    UPDATE private_presence.boat_presence p SET tier='off',boat_id=NULL,revision=gen_random_uuid(),sequence=p.sequence+1,
        reader_revision=gen_random_uuid(),reader_nonce=NULL,reader_until=NULL,
        publisher_revision=gen_random_uuid(),publisher_nonce=NULL,publisher_until=NULL WHERE p.owner_id=p_owner;
    DELETE FROM private_presence.samples s WHERE s.owner_id=p_owner;
    DELETE FROM private_presence.friend_invites i WHERE i.owner_id=p_owner;
END $$;

CREATE FUNCTION private_presence.boat_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
    IF TG_OP='DELETE' THEN PERFORM private_presence.retire_owner(OLD.owner_id);RETURN OLD; END IF;
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
       OR NEW.released_at IS DISTINCT FROM OLD.released_at THEN
        PERFORM private_presence.lock_only(ARRAY[OLD.owner_id,NEW.owner_id]);
        FOR v_id IN SELECT DISTINCT x FROM unnest(ARRAY[OLD.owner_id,NEW.owner_id]) x ORDER BY x LOOP
            PERFORM private_presence.retire_owner(v_id);
        END LOOP;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER presence_boat_retirement AFTER UPDATE OF owner_id,archived_at,released_at OR DELETE ON public.boats
    FOR EACH ROW EXECUTE FUNCTION private_presence.boat_changed();

CREATE FUNCTION private_comfort.boat_retired() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid;new_owner uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
  AND NEW.released_at IS NOT DISTINCT FROM OLD.released_at THEN RETURN NEW; END IF;
  new_owner:=NEW.owner_id;
 END IF;
 FOR actor IN SELECT DISTINCT x FROM unnest(ARRAY[OLD.owner_id,new_owner]) x WHERE x IS NOT NULL ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text,20260806));
  IF EXISTS(SELECT 1 FROM public.account_deletion_jobs j WHERE j.user_id=actor)
  OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor)
  THEN DELETE FROM private_comfort.contexts WHERE owner_id=actor;
  ELSE UPDATE private_comfort.contexts SET revision=gen_random_uuid() WHERE owner_id=actor; END IF;
 END LOOP;
 DELETE FROM private_comfort.cohorts WHERE boat_id=OLD.id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;

CREATE TRIGGER comfort_boat_retirement AFTER UPDATE OF owner_id,archived_at,released_at OR DELETE ON public.boats
 FOR EACH ROW EXECUTE FUNCTION private_comfort.boat_retired();

ALTER TABLE public.boats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their boats"
    ON public.boats FOR ALL
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

DO $install_account_deletion_fences$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT
            namespace.nspname AS schema_name,
            relation.relname AS table_name,
            string_agg(quote_literal(attribute.attname), ', ' ORDER BY attribute.attnum) AS trigger_arguments
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN unnest(constraint_row.conkey) AS constrained_column(attnum) ON true
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum = constrained_column.attnum
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
        GROUP BY namespace.nspname, relation.relname
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS account_deletion_write_fence ON %I.%I',
            target.schema_name,
            target.table_name
        );
        EXECUTE format(
            'CREATE TRIGGER account_deletion_write_fence BEFORE INSERT OR UPDATE ON %I.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write(%s)',
            target.schema_name,
            target.table_name,
            target.trigger_arguments
        );
    END LOOP;
END;
$install_account_deletion_fences$;

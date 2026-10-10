-- The public key keeps only what a policy gives it, today and for every
-- future table (2026-10-10, build 126, package 126-13).
--
-- Authority
-- ─────────
-- Shane, 2026-10-09 ~11:30, on the chat lockdown: "yes to db changes".
-- Shane, 2026-10-09, starting build 126: "ok,  start on 126?". The roadmap
-- line for 126: remove anon's leftover table rights everywhere and fix the
-- default grants. Standing order: our own recommendation for every call
-- that needs an answer.
-- Never pushed by an agent: Shane runs the push himself. This file goes
-- LAST in the 126 push (after 20261010154000 and 20261010154500), so it
-- sweeps every table the 126 files create (pi_alarm_events, the anchor watch
-- heartbeat, the recipe and drift repairs, expiry_date, stores_boxes).
--
-- Why
-- ───
-- The anon key ships inside the app and the web bundle. The read-only scans
-- of 2026-10-09 found:
-- * anon holding full DML plus TRUNCATE, REFERENCES and TRIGGER on
--   chat_channels, chat_messages, chat_direct_messages, chat_message_helpful,
--   chat_moderation_log, chat_reports, chat_roles and dm_blocks, and on
--   vessel_crew, guardian_profiles and push_notification_queue;
-- * anon holding column SELECT grants on chat_profiles (20260730130000),
--   whose only read policy is for signed-in sailors;
-- * anon holding full DML on RLS-on tables with no policy at all
--   (chat_message_helpful, deepgram_proxy_tickets, edge_function_rate_limits,
--   edge_public_rate_limits, guardian_watchdog_episodes, osm_overlay_cache,
--   weather_alerts_log) and on the security_invoker view ships_stores;
-- * the default privileges for tables postgres creates in public granting
--   anon every privilege, so each new table started open to the public key.
-- Row Level Security is what stops all of it today. One dropped or drifted
-- policy (the 2026-10-09 lockdown found four) turns a grant into a hole, and
-- TRUNCATE ignores RLS altogether. The lockdown (20261009170000) took anon
-- off four tables only.
--
-- What
-- ────
-- 1. A pre-check, before anything changes: the push stops, naming each one,
--    if any of these would lose a signed-out read or write:
--    * a policy anon or PUBLIC can use with a branch (split on OR) that
--      neither asks auth.uid(), auth.role() or auth.jwt() nor calls a public
--      helper that does, on a table and command outside the allowlist;
--    * a table with RLS off, a view that is not security_invoker, a
--      materialized view or a foreign table, where anon holds a privilege
--      outside the allowlist (those give rows with no policy).
-- 2. On every table, partitioned table, view, materialized view, foreign
--    table and sequence in public that is not an extension's own (those are
--    under Not here, spatial_ref_sys among them):
--    * anon and PUBLIC lose every privilege, at table AND column level (a
--      table-level REVOKE drops the matching column grants too, chat_profiles'
--      anon columns among them; a column pass then sweeps any left, and the
--      self-check reads both levels). Whatever PUBLIC held is first granted
--      to authenticated and service_role, so neither loses anything; the
--      scans found nothing held by PUBLIC;
--    * authenticated loses TRUNCATE, REFERENCES (column grants too) and
--      TRIGGER, and MAINTAIN on PostgreSQL 17+. PostgREST never uses them,
--      TRUNCATE ignores RLS, and the lockdown already did this on four
--      tables. Nothing else is taken from authenticated or service_role.
-- 3. anon gets back SELECT on the tables whose policies give signed-out
--    readers rows today, and nothing else:
--      amsa_register, australian_ports, community_recipes, recipe_ratings,
--      vessel_metadata, wx_point_forecasts.
--    This is the set of (table, command) pairs the final policies across
--    all migrations give anon or PUBLIC with a branch not built on auth.*
--    (tests/AnonPrivilegesLockdownMigration.test.ts recomputes it from the
--    files, so a future signed-out policy the list forgot fails CI). The
--    plan's provisional list missed community_recipes: "Anyone reads
--    community recipes" (visibility = 'community') is how a signed-out
--    sailor browses the Community Galley; that test found it.
--    Everything else anon does goes through SECURITY DEFINER functions
--    (announce_wx_cell, consume_deepgram_proxy_ticket, get_ocean_summary,
--    is_boat_owner, ...), which need EXECUTE, not table rights; this file
--    does not touch EXECUTE.
-- 4. The default privileges for tables and sequences postgres creates in
--    public no longer give anon or PUBLIC anything, and give authenticated
--    no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. If a global default for
--    postgres (one for every schema) gives anon or PUBLIC anything, or
--    authenticated one of those four, that goes too: a global default is
--    added on top of a schema's own, so the schema-level revoke alone would
--    not hold. Supabase sets none for postgres; the pre-flight reads it.
-- 5. The push fails unless anon holds nothing outside the allowlist (table,
--    column and sequence), keeps every allowlisted read, authenticated holds
--    no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any public relation, and
--    no default named above gives anon, PUBLIC or those four to anyone.
--
-- So nothing anon can do today changes: without a policy, RLS already gave
-- it no rows. A select, insert or delete on chat_messages, vessel_crew,
-- guardian_profiles or push_notification_queue with the public key now gets
-- "permission denied" instead of an empty reply.
--
-- Not here
-- ────────
-- * Functions are not in this file. Their PUBLIC default is global, and a
--   global revoke reaches beyond public. Default EXECUTE on future functions
--   and an audit of the functions anon may execute today (search_vessels,
--   announce_wx_cell, consume_deepgram_proxy_ticket, get_ocean_summary,
--   traced_routes_near, is_boat_owner, ...) are a later build.
-- * An extension's own relations (PostGIS's geometry_columns and
--   geography_columns views and spatial_ref_sys) are left exactly as they
--   are, and that leaves one hole open, older than this file: PostGIS was
--   created without a schema (20260318080000, 20260319070000), so it lives
--   in public; spatial_ref_sys has RLS off; and under Supabase's default
--   grants anon may still hold INSERT, UPDATE, DELETE and TRUNCATE on it. So
--   the public key may be able to change or empty the SRID table that the
--   geography lookups (vessels_nearby, traced_routes_near,
--   guardian_alerts_nearby, ...) read. This file does not try to close it:
--   postgres probably cannot revoke what supabase_admin granted, and an
--   extension's ACLs change with the extension; the pre-flight's
--   extension_members_anon records what anon holds there and whether postgres
--   could revoke it. The follow-up: move PostGIS to the extensions schema, or
--   have supabase_admin revoke anon's writes on spatial_ref_sys.
-- * supabase_admin's own default privileges cannot be altered by postgres.
--   Tables made by migrations are owned by postgres, so they are covered; a
--   table made as supabase_admin (none known) would not be.
--
-- For Codex (Scuttlebutt E2EE, own branch)
-- ────────────────────────────────────────
-- From this file on, a new table in public gives anon nothing unless its
-- migration grants it, and authenticated gets no TRUNCATE, REFERENCES or
-- TRIGGER by default. A table the E2EE work creates keeps authenticated's
-- SELECT, INSERT, UPDATE and DELETE from the defaults; grant anon explicitly
-- only if a signed-out client must read it, with a policy that says so.
--
-- Undo
-- ────
-- Grant back only the one privilege a path turns out to need, never a
-- blanket grant:
--     GRANT SELECT ON TABLE public.<table> TO anon;
-- The old defaults (not wanted) were:
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end. GRANT and REVOKE take a brief lock on each
-- relation; lock_timeout bounds every wait.

SET lock_timeout = '5s';

-- ── 1. Before anything changes: no signed-out read or write may be lost ──

DO $precheck$
DECLARE
    allowlist CONSTANT TEXT[] := ARRAY[
        'amsa_register', 'australian_ports', 'community_recipes',
        'recipe_ratings', 'vessel_metadata', 'wx_point_forecasts'
    ];
    lost TEXT;
BEGIN
    WITH open_policies AS (
        SELECT p.tablename::text AS relname, p.policyname::text AS policyname, p.cmd::text AS cmd
          FROM pg_policies AS p
         WHERE p.schemaname = 'public'
           AND p.roles && ARRAY['anon', 'public']::name[]
           AND EXISTS (
               SELECT 1
                 FROM unnest(ARRAY[p.qual, p.with_check]) AS e(expr),
                      regexp_split_to_table(lower(e.expr), '\yor\y') AS b(branch)
                WHERE e.expr IS NOT NULL
                  AND btrim(b.branch, ' ()') <> ''
                  AND NOT (b.branch ~ 'auth\.(uid|role|jwt)\(\)')
                  AND NOT EXISTS (
                      SELECT 1
                        FROM regexp_matches(b.branch, '([a-z_][a-z0-9_]*)\s*\(', 'g') AS f(m)
                        JOIN pg_proc AS pr
                          ON pr.proname = f.m[1]
                         AND pr.pronamespace = 'public'::regnamespace
                       WHERE pr.prosrc ~ 'auth\.(uid|role|jwt)\(\)'
                  )
           )
    ),
    relations AS (
        SELECT c.oid, c.relname::text AS relname, c.relkind, c.relrowsecurity,
               array_to_string(c.reloptions, ',') AS options
          FROM pg_class AS c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
           )
    )
    SELECT string_agg(found.item, ', ' ORDER BY found.item) INTO lost
      FROM (
          SELECT format('policy %s.%s (%s)', o.relname, o.policyname, o.cmd) AS item
            FROM open_policies AS o
           WHERE NOT (o.cmd = 'SELECT' AND o.relname = ANY (allowlist))
          UNION ALL
          SELECT format('%s %s (%s, no policy needed)', r.relname, priv.name,
                        CASE r.relkind WHEN 'v' THEN 'definer view' WHEN 'm' THEN 'materialized view'
                                       WHEN 'f' THEN 'foreign table' ELSE 'RLS off' END)
            FROM relations AS r
           CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv(name)
           WHERE ((r.relkind IN ('r', 'p') AND NOT r.relrowsecurity)
                  OR (r.relkind = 'v' AND COALESCE(r.options, '') !~ '(^|,)security_invoker=(true|on|yes|1)(,|$)')
                  OR r.relkind IN ('m', 'f'))
             AND CASE WHEN priv.name = 'DELETE' THEN has_table_privilege('anon', r.oid, priv.name)
                      ELSE has_any_column_privilege('anon', r.oid, priv.name) END
             AND NOT (priv.name = 'SELECT' AND r.relname = ANY (allowlist))
      ) AS found;

    IF lost IS NOT NULL THEN
        RAISE EXCEPTION 'anon privileges lockdown: this would take away a signed-out read or write; nothing changed: %', lost;
    END IF;
END;
$precheck$;

-- ── 2. anon and PUBLIC lose everything; authenticated loses the DDL-only rights ──

DO $revoke$
DECLARE
    has_maintain CONSTANT BOOLEAN := current_setting('server_version_num')::int >= 170000;
    rel RECORD;
    col RECORD;
    held RECORD;
BEGIN
    FOR rel IN
        SELECT c.oid, c.relkind, format('public.%I', c.relname) AS name
          FROM pg_class AS c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
           )
         ORDER BY c.relname
    LOOP
        -- PUBLIC is every role: what it held goes to authenticated and the
        -- service role first, so neither loses a right it relied on.
        FOR held IN
            SELECT DISTINCT x.privilege_type
              FROM pg_class AS c2, aclexplode(c2.relacl) AS x
             WHERE c2.oid = rel.oid
               AND x.grantee = 0
               AND x.privilege_type NOT IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
        LOOP
            EXECUTE format('GRANT %s ON %s %s TO authenticated, service_role',
                           held.privilege_type, CASE WHEN rel.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, rel.name);
        END LOOP;
        FOR held IN
            SELECT a.attname, x.privilege_type
              FROM pg_attribute AS a, aclexplode(a.attacl) AS x
             WHERE a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped
               AND x.grantee = 0 AND x.privilege_type <> 'REFERENCES'
        LOOP
            EXECUTE format('GRANT %s (%I) ON TABLE %s TO authenticated, service_role',
                           held.privilege_type, held.attname, rel.name);
        END LOOP;

        IF rel.relkind = 'S' THEN
            EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon', rel.name);
            CONTINUE;
        END IF;

        EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon', rel.name);
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM authenticated', rel.name);
        IF has_maintain THEN
            EXECUTE format('REVOKE MAINTAIN ON TABLE %s FROM authenticated', rel.name);
        END IF;

        -- The table-level REVOKE above already dropped the matching column
        -- grants; this pass sweeps any left (a grant made at column level
        -- only, as chat_profiles' was, is covered either way).
        FOR col IN
            SELECT a.attname,
                   bool_or(x.grantee IN (0::oid, 'anon'::regrole::oid)) AS client,
                   bool_or(x.grantee = 'authenticated'::regrole::oid AND x.privilege_type = 'REFERENCES') AS references_held
              FROM pg_attribute AS a, aclexplode(a.attacl) AS x
             WHERE a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped
             GROUP BY a.attname
        LOOP
            IF col.client THEN
                EXECUTE format('REVOKE ALL (%I) ON TABLE %s FROM PUBLIC, anon', col.attname, rel.name);
            END IF;
            IF col.references_held THEN
                EXECUTE format('REVOKE REFERENCES (%I) ON TABLE %s FROM authenticated', col.attname, rel.name);
            END IF;
        END LOOP;
    END LOOP;
END;
$revoke$;

-- ── 3. The signed-out reads a policy gives anon today ────────────────────

DO $allow$
DECLARE
    allowlist CONSTANT TEXT[] := ARRAY[
        'amsa_register', 'australian_ports', 'community_recipes',
        'recipe_ratings', 'vessel_metadata', 'wx_point_forecasts'
    ];
    relation TEXT;
BEGIN
    FOREACH relation IN ARRAY allowlist LOOP
        IF to_regclass(format('public.%I', relation)) IS NULL THEN
            RAISE NOTICE 'anon privileges lockdown: no public.% here; nothing to grant', relation;
        ELSE
            EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon', relation);
        END IF;
    END LOOP;
END;
$allow$;

-- ── 4. New tables and sequences: nothing for anon by default ─────────────

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;

DO $defaults$
BEGIN
    IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM authenticated';
    END IF;
    -- A global default (every schema) is added on top of the schema's own.
    IF EXISTS (
        SELECT 1 FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS x
         WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
           AND d.defaclobjtype = 'r' AND x.grantee IN (0::oid, 'anon'::regrole::oid)
    ) THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES FROM PUBLIC, anon';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS x
         WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
           AND d.defaclobjtype = 'S' AND x.grantee IN (0::oid, 'anon'::regrole::oid)
    ) THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON SEQUENCES FROM PUBLIC, anon';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS x
         WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0
           AND d.defaclobjtype = 'r' AND x.grantee = 'authenticated'::regrole::oid
           AND x.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
    ) THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated';
        IF current_setting('server_version_num')::int >= 170000 THEN
            EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE MAINTAIN ON TABLES FROM authenticated';
        END IF;
    END IF;
END;
$defaults$;

-- ── 5. Fail the push unless anon, authenticated and the defaults are as stated ──

DO $check$
DECLARE
    allowlist CONSTANT TEXT[] := ARRAY[
        'amsa_register', 'australian_ports', 'community_recipes',
        'recipe_ratings', 'vessel_metadata', 'wx_point_forecasts'
    ];
    has_maintain CONSTANT BOOLEAN := current_setting('server_version_num')::int >= 170000;
    table_privileges TEXT[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    ddl_privileges TEXT[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'];
    wrong TEXT;
BEGIN
    IF has_maintain THEN
        table_privileges := array_append(table_privileges, 'MAINTAIN');
        ddl_privileges := array_append(ddl_privileges, 'MAINTAIN');
    END IF;

    -- anon, with everything it inherits from PUBLIC, holds only the allowlist.
    SELECT string_agg(format('%s %s', c.relname, p.privilege), ', ' ORDER BY c.relname, p.privilege) INTO wrong
      FROM pg_class AS c
     CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
                                    ELSE table_privileges END) AS p(privilege)
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT EXISTS (
           SELECT 1 FROM pg_depend AS d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
       )
       AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('anon', c.oid, p.privilege)
                WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                    THEN has_any_column_privilege('anon', c.oid, p.privilege)
                ELSE has_table_privilege('anon', c.oid, p.privilege) END
       AND NOT (c.relkind <> 'S' AND p.privilege = 'SELECT' AND c.relname::text = ANY (allowlist));
    IF wrong IS NOT NULL THEN
        RAISE EXCEPTION 'anon privileges lockdown: anon still holds %', left(wrong, 2000);
    END IF;

    SELECT string_agg(a.name, ', ') INTO wrong
      FROM unnest(allowlist) AS a(name)
     WHERE to_regclass(format('public.%I', a.name)) IS NOT NULL
       AND NOT has_table_privilege('anon', to_regclass(format('public.%I', a.name)), 'SELECT');
    IF wrong IS NOT NULL THEN
        RAISE EXCEPTION 'anon privileges lockdown: anon lost a signed-out read: %', wrong;
    END IF;

    SELECT string_agg(format('%s %s', c.relname, p.privilege), ', ' ORDER BY c.relname, p.privilege) INTO wrong
      FROM pg_class AS c
     CROSS JOIN LATERAL unnest(ddl_privileges) AS p(privilege)
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND NOT EXISTS (
           SELECT 1 FROM pg_depend AS d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
       )
       AND CASE WHEN p.privilege = 'REFERENCES' THEN has_any_column_privilege('authenticated', c.oid, p.privilege)
                ELSE has_table_privilege('authenticated', c.oid, p.privilege) END;
    IF wrong IS NOT NULL THEN
        RAISE EXCEPTION 'anon privileges lockdown: authenticated still holds %', left(wrong, 2000);
    END IF;

    SELECT string_agg(format('%s %s %s to %s',
                             CASE d.defaclnamespace WHEN 0 THEN 'global' ELSE 'public' END,
                             CASE d.defaclobjtype WHEN 'S' THEN 'sequences' ELSE 'tables' END,
                             x.privilege_type,
                             CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END), ', ') INTO wrong
      FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS x
     WHERE d.defaclrole = 'postgres'::regrole
       AND d.defaclnamespace IN (0::oid, 'public'::regnamespace::oid)
       AND d.defaclobjtype IN ('r', 'S')
       AND (x.grantee IN (0::oid, 'anon'::regrole::oid)
            OR (d.defaclobjtype = 'r' AND x.grantee = 'authenticated'::regrole::oid
                AND x.privilege_type = ANY (ddl_privileges)));
    IF wrong IS NOT NULL THEN
        RAISE EXCEPTION 'anon privileges lockdown: default privileges still give %', wrong;
    END IF;
END;
$check$;

RESET lock_timeout;

-- The crewing view (Shane 2026-10-03): "once a crew member has been invited to
-- your vessel, can we hide all of the rest of the information in his crew and
-- float plan, it should all pertain to the vessel that the punter has been
-- invited on".
--
-- An accepted crew member's Crew & Float Plan page shows the SKIPPER'S boat:
-- its name, who is aboard (names and roles), and what a crew member needs to
-- make a Mayday. This one read supplies it.
--
-- Why a SECURITY DEFINER function and not a policy:
--   - vessel_crew is own-row only for crew ('Crew can view own membership'),
--     so peers' roles are unreadable. A peer SELECT policy is row-level: it
--     would hand every crew member the others' emails and permissions too.
--   - boat_profiles holds the skipper's EPIRB hex, shore contacts, phones and
--     the roster's ages, which go "only in the float plan, to one chosen
--     person" (types/vessel.ts). Crew get an ALLOW-LIST of it here, never the
--     row. (20261003130000 then makes the raw row owner-only.)
--
-- Contract:
--   - NULL for a signed-out caller and for anyone who is not the owner or
--     ACCEPTED crew of p_owner_id. Never an error, so the answer is no oracle
--     and looks exactly like an empty RLS read. The gate mirrors
--     can_access_vessel_register (20260723100000): voyage_id is ignored,
--     membership is vessel-level, as the shared binders read it.
--   - The hull is the one the caller is a boat member of (where the bridge
--     trigger landed them), else the owner's live hull by the bridge
--     trigger's own rule (20260908170000): active selection, then most
--     recently updated, never archived.
--   - vessel: an allow-list of boat_profiles.profile by key AND JSON type,
--     plus boats.name and the claimed boats.mmsi. The boat's wind and wave
--     limits are in it, so crew score Weather Windows against the skipper's
--     boat. Never included: the EPIRB hex ID, shore contacts, contact and
--     satellite phones, safety notes, polars, comfort settings.
--   - roster: the profile's crewRoster capped at crewCount (as
--     rosterSeedsFromVesselProfile caps it), name and rank only.
--   - manifest: the skipper, then each accepted crew member once, with the
--     most senior role across that person's rows. Names come from
--     boat_members on the caller's own hull (what RLS already shows them),
--     else the person's own name metadata from auth.users, and NULL when
--     there is none (the app then reads 'Crew'). Never user_name_parts: it
--     falls back to the email's local part, which RLS never showed across
--     hulls. No user ids, no emails, no pending or declined rows.
--
-- Written, NOT pushed: Shane says "yes, push it" first. Until then the app
-- degrades (boat_members names, vessel_identity, peers read 'Crew'); it tells
-- PGRST202 / 42883 apart from NULL.
--
-- After the push, check it as the crew user in a rolled-back transaction and
-- print key names and counts only:
--   BEGIN;
--   SELECT set_config('request.jwt.claims', '{"sub":"<crew uuid>","role":"authenticated"}', true);
--   SET LOCAL ROLE authenticated;
--   SELECT jsonb_object_keys(public.get_crew_vessel_view('<owner uuid>'));
--   SELECT jsonb_array_length(public.get_crew_vessel_view('<owner uuid>')->'manifest');
--   ROLLBACK;

CREATE OR REPLACE FUNCTION public.get_crew_vessel_view(p_owner_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    caller UUID := auth.uid();
    text_keys CONSTANT TEXT[] := ARRAY[
        'type', 'model', 'riggingType', 'hullType', 'hullColor', 'trimColor', 'hullMaterial',
        'hailingPort', 'registration', 'mmsi', 'callSign', 'phoneticName', 'sailNumber',
        'radiosMonitored', 'prominentFeatures', 'tenderDescription',
        'liferaftServiceDate', 'flaresExpiry'
    ];
    number_keys CONSTANT TEXT[] := ARRAY[
        'length', 'beam', 'draft', 'airDraft', 'displacement', 'cruisingSpeed',
        'crewCount', 'liferaftCapacity', 'maxWindSpeed', 'maxWaveHeight'
    ];
    unit_keys CONSTANT TEXT[] := ARRAY['length', 'beam', 'draft', 'displacement', 'volume'];
    hull_id UUID;
    hull_name TEXT;
    hull_mmsi TEXT;
    prof JSONB := '{}'::JSONB;
    units_raw JSONB := '{}'::JSONB;
    vessel JSONB;
    units_out JSONB;
    roster JSONB := '[]'::JSONB;
    roster_cap INT;
    manifest JSONB;
BEGIN
    IF caller IS NULL OR p_owner_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF caller <> p_owner_id AND NOT EXISTS (
        SELECT 1
          FROM public.vessel_crew AS m
         WHERE m.owner_id = p_owner_id
           AND m.crew_user_id = caller
           AND m.status = 'accepted'
    ) THEN
        RETURN NULL;
    END IF;

    SELECT boat.id, boat.name, boat.mmsi
      INTO hull_id, hull_name, hull_mmsi
      FROM public.boats AS boat
      LEFT JOIN public.boat_members AS me
        ON me.boat_id = boat.id
       AND me.user_id = caller
      LEFT JOIN public.user_active_vessels AS active
        ON active.user_id = boat.owner_id
       AND active.boat_id = boat.id
     WHERE boat.owner_id = p_owner_id
       AND boat.archived_at IS NULL
     ORDER BY (me.user_id IS NOT NULL) DESC, (active.boat_id IS NOT NULL) DESC, boat.updated_at DESC, boat.id
     LIMIT 1;

    IF hull_id IS NOT NULL THEN
        SELECT COALESCE(bp.profile, '{}'::JSONB), COALESCE(bp.vessel_units, '{}'::JSONB)
          INTO prof, units_raw
          FROM public.boat_profiles AS bp
         WHERE bp.boat_id = hull_id;
        prof := COALESCE(prof, '{}'::JSONB);
        units_raw := COALESCE(units_raw, '{}'::JSONB);

        SELECT COALESCE(
                   jsonb_object_agg(
                       entry.key,
                       CASE
                           WHEN jsonb_typeof(entry.value) = 'string' THEN to_jsonb(left(entry.value #>> '{}', 500))
                           ELSE entry.value
                       END
                   ),
                   '{}'::JSONB
               )
          INTO vessel
          FROM jsonb_each(prof) AS entry
         WHERE (entry.key = ANY (text_keys) AND jsonb_typeof(entry.value) = 'string')
            OR (entry.key = ANY (number_keys) AND jsonb_typeof(entry.value) = 'number');

        vessel := vessel || jsonb_strip_nulls(jsonb_build_object(
            'name', COALESCE(
                NULLIF(btrim(hull_name), ''),
                CASE WHEN jsonb_typeof(prof->'name') = 'string' THEN NULLIF(left(btrim(prof->>'name'), 500), '') END
            ),
            'mmsi', NULLIF(btrim(hull_mmsi), '')
        ));

        SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::JSONB)
          INTO units_out
          FROM jsonb_each(units_raw) AS entry
         WHERE entry.key = ANY (unit_keys)
           AND jsonb_typeof(entry.value) = 'string'
           AND length(entry.value #>> '{}') <= 16;

        roster_cap := CASE
            WHEN jsonb_typeof(prof->'crewCount') = 'number'
                THEN greatest(1, least(99, round((prof->>'crewCount')::NUMERIC)))::INT
            ELSE 99
        END;

        IF jsonb_typeof(prof->'crewRoster') = 'array' THEN
            SELECT COALESCE(
                       jsonb_agg(
                           jsonb_strip_nulls(
                               jsonb_build_object(
                                   'name', left(btrim(person->>'name'), 120),
                                   'rank', CASE
                                       WHEN jsonb_typeof(person->'rank') = 'string'
                                           THEN NULLIF(left(btrim(person->>'rank'), 40), '')
                                   END
                               )
                           ) ORDER BY ord
                       ),
                       '[]'::JSONB
                   )
              INTO roster
              FROM jsonb_array_elements(prof->'crewRoster') WITH ORDINALITY AS r(person, ord)
             WHERE ord <= roster_cap
               AND jsonb_typeof(person) = 'object'
               AND jsonb_typeof(person->'name') = 'string'
               AND btrim(person->>'name') <> '';
        END IF;
    END IF;

    WITH crew AS (
        SELECT m.crew_user_id AS person_id,
               (array_agg(m.role ORDER BY CASE m.role
                    WHEN 'co-skipper' THEN 4 WHEN 'navigator' THEN 3 WHEN 'deckhand' THEN 2 WHEN 'punter' THEN 1 ELSE 0
                END DESC))[1] AS person_role
          FROM public.vessel_crew AS m
         WHERE m.owner_id = p_owner_id
           AND m.status = 'accepted'
           AND m.crew_user_id IS NOT NULL
           AND m.crew_user_id <> p_owner_id
         GROUP BY m.crew_user_id
    ),
    people AS (
        SELECT p_owner_id AS person_id, 'skipper'::TEXT AS person_role, TRUE AS is_skipper
        UNION ALL
        SELECT crew.person_id, COALESCE(crew.person_role, 'crew'), FALSE
          FROM crew
    ),
    named AS (
        SELECT people.is_skipper,
               people.person_id = caller AS is_self,
               people.person_role,
               CASE WHEN bm.user_id IS NOT NULL THEN bm.prefix ELSE meta.prefix END AS prefix,
               CASE WHEN bm.user_id IS NOT NULL THEN bm.first_name ELSE meta.first_name END AS first_name,
               CASE WHEN bm.user_id IS NOT NULL THEN bm.nickname ELSE meta.nickname END AS nickname,
               CASE WHEN bm.user_id IS NOT NULL THEN bm.last_name ELSE meta.last_name END AS last_name
          FROM people
          LEFT JOIN public.boat_members AS bm
            ON bm.boat_id = hull_id
           AND bm.user_id = people.person_id
          LEFT JOIN LATERAL (
              SELECT CASE WHEN jsonb_typeof(u.raw_user_meta_data->'prefix') = 'string'
                          THEN left(u.raw_user_meta_data->>'prefix', 40) END AS prefix,
                     CASE WHEN jsonb_typeof(u.raw_user_meta_data->'first_name') = 'string'
                          THEN left(u.raw_user_meta_data->>'first_name', 80) END AS first_name,
                     CASE WHEN jsonb_typeof(u.raw_user_meta_data->'nickname') = 'string'
                          THEN left(u.raw_user_meta_data->>'nickname', 80) END AS nickname,
                     CASE WHEN jsonb_typeof(u.raw_user_meta_data->'last_name') = 'string'
                          THEN left(u.raw_user_meta_data->>'last_name', 80) END AS last_name
                FROM auth.users AS u
               WHERE u.id = people.person_id
          ) AS meta ON bm.user_id IS NULL
    )
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_strip_nulls(jsonb_build_object(
                       'isSkipper', named.is_skipper,
                       'isSelf', named.is_self,
                       'role', named.person_role,
                       'prefix', NULLIF(btrim(named.prefix), ''),
                       'firstName', NULLIF(btrim(named.first_name), ''),
                       'nickname', NULLIF(btrim(named.nickname), ''),
                       'lastName', NULLIF(btrim(named.last_name), '')
                   ))
                   ORDER BY named.is_skipper DESC, lower(COALESCE(named.first_name, '')), lower(COALESCE(named.last_name, ''))
               ),
               '[]'::JSONB
           )
      INTO manifest
      FROM named;

    RETURN jsonb_build_object(
        'version', 1,
        'vessel', vessel,
        'vesselUnits', units_out,
        'roster', COALESCE(roster, '[]'::JSONB),
        'manifest', COALESCE(manifest, '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_crew_vessel_view(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crew_vessel_view(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_crew_vessel_view(UUID) IS
    'Crewing view (2026-10-03): the boat an accepted crew member is crew on, its people by name and role, and an allow-listed vessel brief. NULL for anyone not the owner or accepted crew of p_owner_id.';

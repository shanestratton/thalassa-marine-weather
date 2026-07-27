-- Hardened vessel fleet model (2026-07-27).
--
-- A skipper can own up to five active vessels.  `boats` remains the stable
-- vessel/history/crew anchor; this migration adds one complete operating
-- profile per boat and a cloud-synchronised active-vessel choice per user.
--
-- Important compatibility boundary:
--   * `profiles.settings.vessel` is legacy account settings, not fleet truth.
--   * `vessel_identity` remains a one-row compatibility projection only for
--     the selected owned boat while older clients are still in the field.
--   * No new code may infer a boat from `owner_id` at recording time. New
--     tracks must carry an explicit `boat_id` captured at cast-off.

-- ── Stable boat lifecycle and five-vessel server-side quota ────────────────

ALTER TABLE IF EXISTS public.boats
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS boats_owner_active_updated_idx
    ON public.boats (owner_id, updated_at DESC)
    WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_owned_boat_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    active_count INTEGER;
BEGIN
    -- Existing legacy rows are allowed through unchanged.  The check applies
    -- only when a row becomes an active vessel for an owner.
    IF NEW.archived_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
       AND OLD.archived_at IS NULL THEN
        RETURN NEW;
    END IF;

    -- A count alone races under two concurrent create requests.  Serialise
    -- the small per-owner critical section without taking a global table lock.
    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || NEW.owner_id::TEXT, 0));

    SELECT COUNT(*)
      INTO active_count
      FROM public.boats AS boat
     WHERE boat.owner_id = NEW.owner_id
       AND boat.archived_at IS NULL;

    IF active_count >= 5 THEN
        RAISE EXCEPTION 'A skipper may have at most five active vessels'
            USING ERRCODE = 'P0001',
                  DETAIL = 'Archive an existing vessel before creating or restoring another one.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boats_enforce_owned_limit ON public.boats;
CREATE TRIGGER boats_enforce_owned_limit
    BEFORE INSERT OR UPDATE OF owner_id, archived_at ON public.boats
    FOR EACH ROW EXECUTE FUNCTION public.enforce_owned_boat_limit();

REVOKE ALL ON FUNCTION public.enforce_owned_boat_limit() FROM PUBLIC, anon, authenticated;

-- ── One full profile per boat ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boat_profiles (
    boat_id               UUID PRIMARY KEY REFERENCES public.boats(id) ON DELETE CASCADE,
    profile               JSONB NOT NULL DEFAULT '{}'::JSONB,
    vessel_units          JSONB NOT NULL DEFAULT '{}'::JSONB,
    polar_data            JSONB,
    polar_boat_model      TEXT,
    polar_source_type     TEXT,
    comfort_params        JSONB NOT NULL DEFAULT '{}'::JSONB,
    revision              BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT boat_profiles_profile_object CHECK (jsonb_typeof(profile) = 'object'),
    CONSTRAINT boat_profiles_units_object CHECK (jsonb_typeof(vessel_units) = 'object'),
    CONSTRAINT boat_profiles_comfort_object CHECK (jsonb_typeof(comfort_params) = 'object'),
    CONSTRAINT boat_profiles_polar_source_type_check CHECK (
        polar_source_type IS NULL
        OR polar_source_type IN ('database', 'file_import', 'manual')
    )
);

CREATE INDEX IF NOT EXISTS boat_profiles_updated_idx
    ON public.boat_profiles (updated_at DESC, boat_id);

-- Per-user active choice, rather than an `is_active` flag on `boats`: the
-- same person may be crew on another vessel and each user can choose their
-- own default without changing the owner's selection.
CREATE TABLE IF NOT EXISTS public.user_active_vessels (
    user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    boat_id               UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_active_vessels_boat_idx
    ON public.user_active_vessels (boat_id);

CREATE OR REPLACE FUNCTION public.boat_profiles_set_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        NEW.revision := OLD.revision + 1;
        NEW.created_at := OLD.created_at;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boat_profiles_set_version ON public.boat_profiles;
CREATE TRIGGER boat_profiles_set_version
    BEFORE UPDATE ON public.boat_profiles
    FOR EACH ROW EXECUTE FUNCTION public.boat_profiles_set_version();

CREATE OR REPLACE FUNCTION public.user_active_vessels_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_active_vessels_set_updated_at ON public.user_active_vessels;
CREATE TRIGGER user_active_vessels_set_updated_at
    BEFORE UPDATE ON public.user_active_vessels
    FOR EACH ROW EXECUTE FUNCTION public.user_active_vessels_set_updated_at();

-- Any direct write is checked too; the RPCs below are the normal client path,
-- but RLS alone must not let a user point their active choice at an unrelated
-- vessel.  `auth.uid()` is NULL during migrations/service maintenance, where
-- ownership is intentionally managed by trusted server code.
CREATE OR REPLACE FUNCTION public.validate_user_active_vessel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND NEW.user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Active vessel may only be changed for the current user'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.boats AS boat
         WHERE boat.id = NEW.boat_id
           AND boat.archived_at IS NULL
           AND (
               boat.owner_id = NEW.user_id
               OR EXISTS (
                   SELECT 1
                     FROM public.boat_members AS member
                    WHERE member.boat_id = boat.id
                      AND member.user_id = NEW.user_id
               )
           )
    ) THEN
        RAISE EXCEPTION 'The selected vessel is unavailable to this user'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_active_vessels_validate_access ON public.user_active_vessels;
CREATE TRIGGER user_active_vessels_validate_access
    BEFORE INSERT OR UPDATE OF user_id, boat_id ON public.user_active_vessels
    FOR EACH ROW EXECUTE FUNCTION public.validate_user_active_vessel();

REVOKE ALL ON FUNCTION public.validate_user_active_vessel() FROM PUBLIC, anon, authenticated;

-- New/legacy direct boat inserts still receive a usable profile shell.  The
-- fleet RPC subsequently replaces this shell atomically with the supplied
-- complete profile.  This avoids a half-created boat being invisible to the
-- new fleet reader if an older client creates it through the old code path.
CREATE OR REPLACE FUNCTION public.create_default_boat_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.boat_profiles (boat_id, profile)
    VALUES (
        NEW.id,
        jsonb_strip_nulls(
            jsonb_build_object(
                'name', NEW.name,
                'type', CASE
                    WHEN NEW.vessel_type IN ('sail', 'power', 'observer') THEN NEW.vessel_type
                    ELSE 'sail'
                END,
                'model', NEW.model
            )
        )
    )
    ON CONFLICT (boat_id) DO NOTHING;

    -- Preserve the old single-boat first-run experience while allowing the
    -- real fleet RPC to deliberately select a newly created vessel later.
    INSERT INTO public.user_active_vessels (user_id, boat_id)
    VALUES (NEW.owner_id, NEW.id)
    ON CONFLICT (user_id) DO NOTHING;

    -- A boat owned through the fleet API must also be immediately usable by
    -- the crew/public-log layer.  Do this server-side so a dropped client
    -- request cannot leave an ownerless membership graph behind.
    INSERT INTO public.boat_members (boat_id, user_id, first_name, role)
    VALUES (
        NEW.id,
        NEW.owner_id,
        COALESCE(NULLIF(BTRIM(split_part(public.user_display_name(NEW.owner_id), ' ', 1)), ''), 'Skipper'),
        'owner'
    )
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boats_create_default_profile ON public.boats;
CREATE TRIGGER boats_create_default_profile
    AFTER INSERT ON public.boats
    FOR EACH ROW EXECUTE FUNCTION public.create_default_boat_profile();

REVOKE ALL ON FUNCTION public.create_default_boat_profile() FROM PUBLIC, anon, authenticated;

-- Some pre-fleet boats were created by older paths that did not insert an
-- owner membership.  Keep existing public logs and crew reads sound without
-- changing a pre-existing membership's chosen role or byline.
INSERT INTO public.boat_members (boat_id, user_id, first_name, role)
SELECT boat.id,
       boat.owner_id,
       COALESCE(NULLIF(BTRIM(split_part(public.user_display_name(boat.owner_id), ' ', 1)), ''), 'Skipper'),
       'owner'
  FROM public.boats AS boat
ON CONFLICT DO NOTHING;

-- Existing owners receive a deterministic active boat before profile
-- backfill. Prefer their enabled combined Voyage Log boat, then the most
-- recently updated boat. This is deliberately a selection only; it does not
-- guess that a second legacy boat has the first boat's specifications.
INSERT INTO public.user_active_vessels (user_id, boat_id)
SELECT DISTINCT ON (boat.owner_id)
       boat.owner_id,
       boat.id
  FROM public.boats AS boat
  LEFT JOIN public.voyage_log_configs AS config
    ON config.boat_id = boat.id
   AND config.scope = 'combined'
 WHERE boat.archived_at IS NULL
 ORDER BY boat.owner_id,
          CASE WHEN config.enabled THEN 0 ELSE 1 END,
          config.updated_at DESC NULLS LAST,
          boat.updated_at DESC,
          boat.id
ON CONFLICT (user_id) DO NOTHING;

-- Backfill each boat profile. The prior model had exactly one full
-- `profiles.settings.vessel` object per account, so it is copied only to the
-- selected legacy boat. Additional legacy boats get their own honest summary
-- shell rather than an unsafe duplicate of another yacht's draft/polars.
INSERT INTO public.boat_profiles (
    boat_id,
    profile,
    vessel_units,
    polar_data,
    polar_boat_model,
    polar_source_type,
    comfort_params
)
SELECT
    boat.id,
    COALESCE(
        CASE
            WHEN active.boat_id = boat.id AND jsonb_typeof(account.settings -> 'vessel') = 'object'
                THEN account.settings -> 'vessel'
            ELSE '{}'::JSONB
        END,
        '{}'::JSONB
    ) || jsonb_strip_nulls(
        jsonb_build_object(
            'name', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'name'
                    END,
                    ''
                ),
                NULLIF(boat.name, ''),
                NULLIF(identity.vessel_name, ''),
                'Unnamed Vessel'
            ),
            'type', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'type'
                    END,
                    ''
                ),
                NULLIF(boat.vessel_type, ''),
                NULLIF(identity.vessel_type, ''),
                'sail'
            ),
            'model', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'model'
                    END,
                    ''
                ),
                NULLIF(boat.model, ''),
                NULLIF(identity.model, '')
            ),
            'registration', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'registration'
                    END,
                    ''
                ),
                NULLIF(identity.reg_number, '')
            ),
            'mmsi', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'mmsi'
                    END,
                    ''
                ),
                NULLIF(identity.mmsi, '')
            ),
            'callSign', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'callSign'
                    END,
                    ''
                ),
                NULLIF(identity.call_sign, '')
            ),
            'phoneticName', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'phoneticName'
                    END,
                    ''
                ),
                NULLIF(identity.phonetic_name, '')
            ),
            'hullColor', COALESCE(
                NULLIF(
                    CASE
                        WHEN active.boat_id = boat.id THEN account.settings -> 'vessel' ->> 'hullColor'
                    END,
                    ''
                ),
                NULLIF(identity.hull_color, '')
            )
        )
    ),
    CASE
        WHEN active.boat_id = boat.id AND jsonb_typeof(account.settings -> 'vesselUnits') = 'object'
            THEN account.settings -> 'vesselUnits'
        ELSE '{}'::JSONB
    END,
    CASE WHEN active.boat_id = boat.id THEN account.settings -> 'polarData' END,
    CASE WHEN active.boat_id = boat.id THEN NULLIF(account.settings ->> 'polarBoatModel', '') END,
    CASE WHEN active.boat_id = boat.id THEN NULLIF(account.settings ->> 'polarSource_type', '') END,
    CASE
        WHEN active.boat_id = boat.id AND jsonb_typeof(account.settings -> 'comfortParams') = 'object'
            THEN account.settings -> 'comfortParams'
        ELSE '{}'::JSONB
    END
  FROM public.boats AS boat
  LEFT JOIN public.user_active_vessels AS active
    ON active.user_id = boat.owner_id
  LEFT JOIN public.profiles AS account
    ON account.id = boat.owner_id
  LEFT JOIN public.vessel_identity AS identity
    ON identity.owner_id = boat.owner_id
ON CONFLICT (boat_id) DO NOTHING;

-- A few legacy boat rows used free-form type labels. Normalise only invalid
-- values now so a later sparse patch is never rejected because of data the
-- skipper did not edit.
UPDATE public.boat_profiles
   SET profile = jsonb_set(profile, '{type}', '"sail"'::JSONB, true)
 WHERE COALESCE(profile ->> 'type', '') NOT IN ('sail', 'power', 'observer');

-- ── Compatibility projection: selected boat only ───────────────────────────

-- This replaces the old all-boats trigger. Legacy callers that still upsert
-- `vessel_identity` can now affect at most the owner's selected vessel.
CREATE OR REPLACE FUNCTION public.sync_vessel_identity_to_boat()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    selected_boat_id UUID;
BEGIN
    SELECT active.boat_id
      INTO selected_boat_id
      FROM public.user_active_vessels AS active
     WHERE active.user_id = NEW.owner_id;

    IF selected_boat_id IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE public.boats AS boat
       SET name = COALESCE(NULLIF(NEW.vessel_name, ''), boat.name),
           vessel_type = COALESCE(NULLIF(NEW.vessel_type, ''), boat.vessel_type),
           model = COALESCE(NULLIF(NEW.model, ''), boat.model)
     WHERE boat.id = selected_boat_id
       AND boat.owner_id = NEW.owner_id
       AND boat.archived_at IS NULL;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_vessel_identity_to_boat() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_selected_boat_to_vessel_identity(p_owner_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    selected_profile JSONB;
    selected_name TEXT;
    selected_type TEXT;
    selected_model TEXT;
BEGIN
    SELECT profile.profile,
           boat.name,
           boat.vessel_type,
           boat.model
      INTO selected_profile, selected_name, selected_type, selected_model
      FROM public.user_active_vessels AS active
      JOIN public.boats AS boat
        ON boat.id = active.boat_id
       AND boat.owner_id = p_owner_id
       AND boat.archived_at IS NULL
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE active.user_id = p_owner_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    INSERT INTO public.vessel_identity (
        owner_id,
        vessel_name,
        reg_number,
        mmsi,
        call_sign,
        phonetic_name,
        vessel_type,
        hull_color,
        model
    )
    VALUES (
        p_owner_id,
        COALESCE(NULLIF(BTRIM(selected_profile ->> 'name'), ''), selected_name, 'Unnamed Vessel'),
        NULLIF(BTRIM(selected_profile ->> 'registration'), ''),
        NULLIF(BTRIM(selected_profile ->> 'mmsi'), ''),
        NULLIF(BTRIM(selected_profile ->> 'callSign'), ''),
        NULLIF(BTRIM(selected_profile ->> 'phoneticName'), ''),
        COALESCE(NULLIF(BTRIM(selected_profile ->> 'type'), ''), selected_type, 'sail'),
        NULLIF(BTRIM(selected_profile ->> 'hullColor'), ''),
        COALESCE(NULLIF(BTRIM(selected_profile ->> 'model'), ''), selected_model)
    )
    ON CONFLICT (owner_id) DO UPDATE
       SET vessel_name = EXCLUDED.vessel_name,
           -- A compatibility row must never leak identity fields from the
           -- previously selected yacht into the newly selected one.
           reg_number = EXCLUDED.reg_number,
           mmsi = EXCLUDED.mmsi,
           call_sign = EXCLUDED.call_sign,
           phonetic_name = EXCLUDED.phonetic_name,
           vessel_type = EXCLUDED.vessel_type,
           hull_color = EXCLUDED.hull_color,
           model = EXCLUDED.model;
END;
$$;

REVOKE ALL ON FUNCTION public.project_selected_boat_to_vessel_identity(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_boat_summary_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    profile_name TEXT;
    profile_type TEXT;
BEGIN
    profile_name := NULLIF(BTRIM(NEW.profile ->> 'name'), '');
    profile_type := NULLIF(BTRIM(NEW.profile ->> 'type'), '');

    IF profile_name IS NOT NULL AND profile_type IN ('sail', 'power', 'observer') THEN
        UPDATE public.boats AS boat
           SET name = profile_name,
               vessel_type = profile_type,
               model = NULLIF(BTRIM(NEW.profile ->> 'model'), '')
         WHERE boat.id = NEW.boat_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boat_profiles_sync_boat_summary ON public.boat_profiles;
CREATE TRIGGER boat_profiles_sync_boat_summary
    AFTER INSERT OR UPDATE OF profile ON public.boat_profiles
    FOR EACH ROW EXECUTE FUNCTION public.sync_boat_summary_from_profile();

REVOKE ALL ON FUNCTION public.sync_boat_summary_from_profile() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_active_profile_to_vessel_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    profile_owner_id UUID;
BEGIN
    SELECT boat.owner_id
      INTO profile_owner_id
      FROM public.boats AS boat
     WHERE boat.id = NEW.boat_id
       AND boat.archived_at IS NULL;

    IF profile_owner_id IS NOT NULL
       AND EXISTS (
           SELECT 1
             FROM public.user_active_vessels AS active
            WHERE active.user_id = profile_owner_id
              AND active.boat_id = NEW.boat_id
       ) THEN
        PERFORM public.project_selected_boat_to_vessel_identity(profile_owner_id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boat_profiles_project_active_identity ON public.boat_profiles;
CREATE TRIGGER boat_profiles_project_active_identity
    AFTER INSERT OR UPDATE OF profile ON public.boat_profiles
    FOR EACH ROW EXECUTE FUNCTION public.project_active_profile_to_vessel_identity();

REVOKE ALL ON FUNCTION public.project_active_profile_to_vessel_identity() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_active_selection_to_vessel_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Crew may hold a personal selection too, but never project that vessel
    -- into another skipper's singleton legacy identity row.
    IF EXISTS (
        SELECT 1
          FROM public.boats AS boat
         WHERE boat.id = NEW.boat_id
           AND boat.owner_id = NEW.user_id
           AND boat.archived_at IS NULL
    ) THEN
        PERFORM public.project_selected_boat_to_vessel_identity(NEW.user_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_active_vessels_project_identity ON public.user_active_vessels;
CREATE TRIGGER user_active_vessels_project_identity
    AFTER INSERT OR UPDATE OF boat_id ON public.user_active_vessels
    FOR EACH ROW EXECUTE FUNCTION public.project_active_selection_to_vessel_identity();

REVOKE ALL ON FUNCTION public.project_active_selection_to_vessel_identity() FROM PUBLIC, anon, authenticated;

-- Archiving cannot leave a user silently selected onto an unavailable vessel.
CREATE OR REPLACE FUNCTION public.clear_active_vessel_on_boat_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
        DELETE FROM public.user_active_vessels
         WHERE boat_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS boats_clear_active_vessel_on_archive ON public.boats;
CREATE TRIGGER boats_clear_active_vessel_on_archive
    AFTER UPDATE OF archived_at ON public.boats
    FOR EACH ROW EXECUTE FUNCTION public.clear_active_vessel_on_boat_archive();

REVOKE ALL ON FUNCTION public.clear_active_vessel_on_boat_archive() FROM PUBLIC, anon, authenticated;

-- Project currently selected legacy boats after all projection triggers and
-- functions exist. This is a one-time compatibility backfill.
DO $$
DECLARE
    owner_row RECORD;
BEGIN
    FOR owner_row IN SELECT user_id FROM public.user_active_vessels LOOP
        PERFORM public.project_selected_boat_to_vessel_identity(owner_row.user_id);
    END LOOP;
END;
$$;

-- ── Explicit boat association on active operational tables ─────────────────
--
-- The old boat migration altered abandoned singular `ship_log`; the active
-- app uses plural `ship_logs`. Add the relationship to the live tables only.
-- Backfill strictly when an owner has exactly one active boat; ambiguous
-- historical data stays NULL rather than being silently attributed wrongly.

ALTER TABLE IF EXISTS public.ship_logs
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS public.live_track
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS public.diary_entries
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS public.voyages
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF to_regclass('public.ship_logs') IS NOT NULL THEN
        EXECUTE '
            CREATE INDEX IF NOT EXISTS ship_logs_boat_voyage_timestamp_idx
                ON public.ship_logs (boat_id, voyage_id, timestamp DESC)
                WHERE boat_id IS NOT NULL';
        EXECUTE '
            WITH sole_owned_boats AS (
                SELECT owner_id, MIN(id) AS boat_id
                  FROM public.boats
                 WHERE archived_at IS NULL
                 GROUP BY owner_id
                HAVING COUNT(*) = 1
            )
            UPDATE public.ship_logs AS log
               SET boat_id = sole.boat_id
              FROM sole_owned_boats AS sole
             WHERE log.user_id = sole.owner_id
               AND log.boat_id IS NULL';
    END IF;

    IF to_regclass('public.live_track') IS NOT NULL THEN
        EXECUTE '
            CREATE INDEX IF NOT EXISTS live_track_boat_voyage_timestamp_idx
                ON public.live_track (boat_id, voyage_id, timestamp DESC)
                WHERE boat_id IS NOT NULL';
        EXECUTE '
            WITH sole_owned_boats AS (
                SELECT owner_id, MIN(id) AS boat_id
                  FROM public.boats
                 WHERE archived_at IS NULL
                 GROUP BY owner_id
                HAVING COUNT(*) = 1
            )
            UPDATE public.live_track AS live
               SET boat_id = sole.boat_id
              FROM sole_owned_boats AS sole
             WHERE live.user_id = sole.owner_id
               AND live.boat_id IS NULL';
    END IF;

    IF to_regclass('public.diary_entries') IS NOT NULL THEN
        EXECUTE '
            CREATE INDEX IF NOT EXISTS diary_entries_boat_voyage_created_idx
                ON public.diary_entries (boat_id, voyage_id, created_at DESC)
                WHERE boat_id IS NOT NULL';
        IF to_regclass('public.ship_logs') IS NOT NULL THEN
            EXECUTE '
                WITH uniquely_mapped_voyages AS (
                    SELECT user_id, voyage_id, MIN(boat_id) AS boat_id
                      FROM public.ship_logs
                     WHERE boat_id IS NOT NULL
                       AND voyage_id IS NOT NULL
                     GROUP BY user_id, voyage_id
                    HAVING COUNT(DISTINCT boat_id) = 1
                )
                UPDATE public.diary_entries AS entry
                   SET boat_id = mapped.boat_id
                  FROM uniquely_mapped_voyages AS mapped
                 WHERE entry.user_id = mapped.user_id
                   AND entry.voyage_id = mapped.voyage_id
                   AND entry.boat_id IS NULL';
        END IF;
        EXECUTE '
            WITH sole_owned_boats AS (
                SELECT owner_id, MIN(id) AS boat_id
                  FROM public.boats
                 WHERE archived_at IS NULL
                 GROUP BY owner_id
                HAVING COUNT(*) = 1
            )
            UPDATE public.diary_entries AS entry
               SET boat_id = sole.boat_id
              FROM sole_owned_boats AS sole
             WHERE entry.user_id = sole.owner_id
               AND entry.boat_id IS NULL';
    END IF;

    IF to_regclass('public.voyages') IS NOT NULL THEN
        EXECUTE '
            CREATE INDEX IF NOT EXISTS voyages_boat_updated_idx
                ON public.voyages (boat_id, updated_at DESC)
                WHERE boat_id IS NOT NULL';
        EXECUTE '
            WITH sole_owned_boats AS (
                SELECT owner_id, MIN(id) AS boat_id
                  FROM public.boats
                 WHERE archived_at IS NULL
                 GROUP BY owner_id
                HAVING COUNT(*) = 1
            )
            UPDATE public.voyages AS voyage
               SET boat_id = sole.boat_id
              FROM sole_owned_boats AS sole
             WHERE voyage.user_id = sole.owner_id
               AND voyage.boat_id IS NULL';
    END IF;
END;
$$;

-- New operational rows must carry the exact vessel selected at the time of
-- writing. Older clients are allowed to omit it, in which case the active
-- *owned* vessel is filled in deterministically. Never resurrect the old
-- `owner_id -> LIMIT 1 boat` behaviour: it corrupts a delivery skipper's
-- tracks as soon as they own more than one yacht.
CREATE OR REPLACE FUNCTION public.assign_and_validate_operational_boat_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    resolved_boat_id UUID := NEW.boat_id;
    caller_is_service BOOLEAN := COALESCE(auth.role(), '') = 'service_role';
BEGIN
    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'Operational rows require a user id' USING ERRCODE = '22023';
    END IF;

    -- A normal device may only write its own row. Service-role relay/Edge
    -- work is trusted to write on behalf of a skipper, but we still require
    -- an existing, non-archived boat below.
    IF NOT caller_is_service AND auth.uid() IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'Operational boat association belongs to another user' USING ERRCODE = '42501';
    END IF;

    -- Historical rows keep their immutable association even after that boat
    -- is archived. An UPSERT may syntactically mention `boat_id` while
    -- retaining its previous value, so do not turn an ordinary diary edit
    -- into an attempt to re-select an unavailable historic vessel.
    IF TG_OP = 'UPDATE'
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.boat_id IS NOT DISTINCT FROM OLD.boat_id THEN
        RETURN NEW;
    END IF;

    IF resolved_boat_id IS NULL THEN
        SELECT active.boat_id
          INTO resolved_boat_id
          FROM public.user_active_vessels AS active
          JOIN public.boats AS boat
            ON boat.id = active.boat_id
           AND boat.owner_id = NEW.user_id
           AND boat.archived_at IS NULL
         WHERE active.user_id = NEW.user_id;
    END IF;

    -- No active selection is a legitimate legacy/offline state. Preserve a
    -- NULL rather than making up a vessel. Once a selection exists, all new
    -- records become explicitly attributable.
    IF resolved_boat_id IS NULL THEN
        NEW.boat_id := NULL;
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
         FROM public.boats AS boat
         WHERE boat.id = resolved_boat_id
           -- A trusted relay may finish delivering a pre-archive record;
           -- ordinary device writes can never start new data on an archived
           -- vessel.
           AND (caller_is_service OR boat.archived_at IS NULL)
           AND (caller_is_service OR boat.owner_id = NEW.user_id)
    ) THEN
        RAISE EXCEPTION 'Operational boat does not belong to this row owner or is unavailable'
            USING ERRCODE = '42501';
    END IF;

    NEW.boat_id := resolved_boat_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_and_validate_operational_boat_id()
    FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    operational_table TEXT;
BEGIN
    FOREACH operational_table IN ARRAY ARRAY['ship_logs', 'live_track', 'diary_entries', 'voyages'] LOOP
        IF to_regclass('public.' || operational_table) IS NOT NULL THEN
            EXECUTE format(
                'DROP TRIGGER IF EXISTS a_assign_operational_boat_id ON public.%I',
                operational_table
            );
            EXECUTE format(
                'CREATE TRIGGER a_assign_operational_boat_id
                   BEFORE INSERT OR UPDATE OF user_id, boat_id ON public.%I
                   FOR EACH ROW EXECUTE FUNCTION public.assign_and_validate_operational_boat_id()',
                operational_table
            );
        END IF;
    END LOOP;
END;
$$;

-- The public trip selector is vessel-scoped. Replace the prior two-argument
-- helper (which aggregated every boat an owner had ever sailed) with one
-- unambiguous three-argument signature; the third argument remains optional
-- for older Edge deployments during rollout.
CREATE INDEX IF NOT EXISTS ship_logs_public_voyage_catalog_boat_timestamp_idx
    ON public.ship_logs (boat_id, timestamp DESC, voyage_id)
    INCLUDE (cumulative_distance_nm, is_on_water, source, entry_type)
    WHERE (archived IS NULL OR archived = false)
      AND voyage_id IS NOT NULL
      AND boat_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.public_voyage_log_trip_catalog(
    p_owner_id UUID,
    p_since TIMESTAMPTZ DEFAULT NULL,
    p_boat_id UUID DEFAULT NULL
)
RETURNS TABLE (
    voyage_id TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    point_count BIGINT,
    distance_nm DOUBLE PRECISION,
    land_fraction DOUBLE PRECISION,
    plan_voyage_id TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' OR p_owner_id IS NULL THEN
        RAISE EXCEPTION 'Service role and an exact owner are required' USING ERRCODE = '42501';
    END IF;

    IF p_boat_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
         FROM public.boats AS boat
         WHERE boat.id = p_boat_id
           AND boat.owner_id = p_owner_id
    ) THEN
        -- Archived boats remain readable here: archive preserves a past
        -- delivery's public/history record, it merely prevents new capture.
        RAISE EXCEPTION 'The requested public vessel is unavailable to this owner' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH eligible_logs AS (
        SELECT
            BTRIM(logs.voyage_id) AS normalized_voyage_id,
            logs.timestamp,
            logs.cumulative_distance_nm,
            logs.is_on_water
        FROM public.ship_logs AS logs
        WHERE logs.user_id = p_owner_id
          AND (p_boat_id IS NULL OR logs.boat_id = p_boat_id)
          AND (logs.archived IS NULL OR logs.archived = false)
          AND logs.voyage_id IS NOT NULL
          AND BTRIM(logs.voyage_id) <> ''
          AND LOWER(BTRIM(logs.voyage_id)) NOT IN ('default', 'default_voyage')
          AND BTRIM(logs.voyage_id) !~* '^planned_'
          AND COALESCE(logs.source, '') <> 'planned_route'
          AND logs.entry_type IS DISTINCT FROM 'manual'
          AND logs.latitude BETWEEN -90 AND 90
          AND logs.longitude BETWEEN -180 AND 180
          AND NOT (ABS(logs.latitude) < 0.001 AND ABS(logs.longitude) < 0.001)
          AND COALESCE(logs.waypoint_name, '') NOT LIKE 'COG %'
          AND COALESCE(logs.notes, '') NOT LIKE 'Auto: COG%'
          AND (p_since IS NULL OR logs.timestamp >= p_since)
    )
    SELECT
        eligible.normalized_voyage_id AS voyage_id,
        MIN(eligible.timestamp) AS started_at,
        MAX(eligible.timestamp) AS ended_at,
        COUNT(*) AS point_count,
        MAX(COALESCE(eligible.cumulative_distance_nm, 0))::DOUBLE PRECISION AS distance_nm,
        (COUNT(*) FILTER (WHERE eligible.is_on_water = false))::DOUBLE PRECISION
            / NULLIF(
                (COUNT(*) FILTER (WHERE eligible.is_on_water IS NOT NULL))::DOUBLE PRECISION,
                0
            ) AS land_fraction,
        links.plan_voyage_id
    FROM eligible_logs AS eligible
    LEFT JOIN public.voyage_plan_links AS links
        ON links.user_id = p_owner_id
       AND links.voyage_id = eligible.normalized_voyage_id
    GROUP BY eligible.normalized_voyage_id, links.plan_voyage_id
    ORDER BY MAX(eligible.timestamp) DESC, eligible.normalized_voyage_id ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ, UUID)
    TO service_role;

COMMENT ON FUNCTION public.public_voyage_log_trip_catalog(UUID, TIMESTAMPTZ, UUID) IS
    'Service-role-only compact catalogue of recorded public voyages, optionally scoped to one exact owner vessel.';

-- Relay writes are service-role mediated, so validate the envelope's vessel
-- here as well as in the ordinary row trigger. This closes the Pi/direct
-- relay path: a syntactically valid UUID for another skipper can never be
-- attached to this owner's diary entry.
CREATE OR REPLACE FUNCTION public.diary_relay_upsert_entry(
    p_owner_id UUID,
    p_entry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    operation_id TEXT;
    revision_text TEXT;
    submitted_revision INTEGER;
    supplied_boat_text TEXT;
    supplied_boat_id UUID;
    canonical public.diary_entries%ROWTYPE;
    was_applied BOOLEAN := false;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Diary relay requires the service role' USING ERRCODE = '42501';
    END IF;
    IF p_owner_id IS NULL OR p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
        RAISE EXCEPTION 'A diary relay owner and object envelope are required'
            USING ERRCODE = '22023';
    END IF;

    operation_id := NULLIF(p_entry ->> 'client_operation_id', '');
    IF operation_id IS NULL OR operation_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
        RAISE EXCEPTION 'Invalid diary client operation id'
            USING ERRCODE = '22023';
    END IF;

    revision_text := p_entry ->> 'client_revision';
    IF revision_text IS NULL THEN
        submitted_revision := 1;
    ELSIF revision_text !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'Invalid diary client revision'
            USING ERRCODE = '22023';
    ELSE
        submitted_revision := revision_text::INTEGER;
    END IF;

    -- Missing/null boat ids are valid legacy envelopes. On a brand-new row
    -- the operational trigger will use the active owned vessel when there is
    -- one; on an existing row we preserve the original binding below rather
    -- than moving an old diary entry when the skipper later changes vessel.
    supplied_boat_text := NULLIF(BTRIM(p_entry ->> 'boat_id'), '');
    IF supplied_boat_text IS NOT NULL THEN
        IF supplied_boat_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid diary boat id' USING ERRCODE = '22023';
        END IF;
        supplied_boat_id := supplied_boat_text::UUID;
        IF NOT EXISTS (
            SELECT 1
             FROM public.boats AS boat
             WHERE boat.id = supplied_boat_id
               AND boat.owner_id = p_owner_id
        ) THEN
            RAISE EXCEPTION 'Diary boat is not owned by this relay owner'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('diary-relay:' || p_owner_id::TEXT || ':' || operation_id, 0)
    );

    IF EXISTS (
        SELECT 1
        FROM public.diary_relay_tombstones AS tombstone
        WHERE tombstone.owner_id = p_owner_id
          AND tombstone.client_operation_id = operation_id
    ) THEN
        RETURN jsonb_build_object('status', 'cancelled');
    END IF;

    INSERT INTO public.diary_entries (
        user_id,
        boat_id,
        client_operation_id,
        client_revision,
        title,
        body,
        mood,
        photos,
        audio_url,
        latitude,
        longitude,
        location_name,
        weather_summary,
        weather_data,
        voyage_id,
        tags,
        is_public,
        created_at
    )
    VALUES (
        p_owner_id,
        supplied_boat_id,
        operation_id,
        submitted_revision,
        COALESCE(p_entry ->> 'title', ''),
        COALESCE(p_entry ->> 'body', ''),
        COALESCE(NULLIF(p_entry ->> 'mood', ''), 'neutral'),
        CASE
            WHEN jsonb_typeof(p_entry -> 'photos') = 'array' THEN p_entry -> 'photos'
            ELSE '[]'::JSONB
        END,
        NULLIF(p_entry ->> 'audio_url', ''),
        NULLIF(p_entry ->> 'latitude', '')::DOUBLE PRECISION,
        NULLIF(p_entry ->> 'longitude', '')::DOUBLE PRECISION,
        COALESCE(p_entry ->> 'location_name', ''),
        COALESCE(p_entry ->> 'weather_summary', ''),
        NULLIF(p_entry -> 'weather_data', 'null'::JSONB),
        NULLIF(p_entry ->> 'voyage_id', ''),
        CASE
            WHEN jsonb_typeof(p_entry -> 'tags') = 'array' THEN p_entry -> 'tags'
            ELSE '[]'::JSONB
        END,
        CASE WHEN p_entry -> 'is_public' = 'true'::JSONB THEN true ELSE false END,
        COALESCE(NULLIF(p_entry ->> 'created_at', '')::TIMESTAMPTZ, now())
    )
    ON CONFLICT (user_id, client_operation_id) DO UPDATE
    SET
        -- Only a newer envelope that explicitly names an owned vessel can
        -- alter a prior binding. Legacy null envelopes cannot make an entry
        -- drift onto whichever yacht happens to be active at retry time.
        boat_id = CASE
            WHEN supplied_boat_id IS NOT NULL THEN EXCLUDED.boat_id
            ELSE public.diary_entries.boat_id
        END,
        client_revision = EXCLUDED.client_revision,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        mood = EXCLUDED.mood,
        photos = EXCLUDED.photos,
        audio_url = EXCLUDED.audio_url,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        location_name = EXCLUDED.location_name,
        weather_summary = EXCLUDED.weather_summary,
        weather_data = EXCLUDED.weather_data,
        voyage_id = EXCLUDED.voyage_id,
        tags = EXCLUDED.tags,
        is_public = EXCLUDED.is_public
    WHERE EXCLUDED.client_revision > public.diary_entries.client_revision
    RETURNING * INTO canonical;

    was_applied := FOUND;
    IF NOT was_applied THEN
        SELECT *
          INTO canonical
          FROM public.diary_entries
         WHERE user_id = p_owner_id
           AND client_operation_id = operation_id;
    END IF;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'cancelled');
    END IF;

    RETURN jsonb_build_object(
        'status', CASE WHEN was_applied THEN 'accepted' ELSE 'stale' END,
        'entry', to_jsonb(canonical)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.diary_relay_upsert_entry(UUID, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diary_relay_upsert_entry(UUID, JSONB) TO service_role;

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.boat_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_active_vessels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS boat_profiles_owner_manage ON public.boat_profiles;
CREATE POLICY boat_profiles_owner_manage
    ON public.boat_profiles FOR ALL TO authenticated
    USING (public.is_boat_owner(boat_id))
    WITH CHECK (public.is_boat_owner(boat_id));

DROP POLICY IF EXISTS boat_profiles_member_read ON public.boat_profiles;
CREATE POLICY boat_profiles_member_read
    ON public.boat_profiles FOR SELECT TO authenticated
    USING (public.is_boat_member(boat_id));

DROP POLICY IF EXISTS user_active_vessels_manage_own ON public.user_active_vessels;
CREATE POLICY user_active_vessels_manage_own
    ON public.user_active_vessels FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

REVOKE ALL ON TABLE public.boat_profiles FROM anon;
REVOKE ALL ON TABLE public.user_active_vessels FROM anon;
-- Read access supports crew-facing surfaces, but every mutation travels
-- through the RPCs below so profile validation, revisioning, selected-vessel
-- projection, and the five-vessel quota cannot be bypassed with raw REST.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.boat_profiles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.user_active_vessels FROM authenticated;
GRANT SELECT ON TABLE public.boat_profiles TO authenticated;
GRANT SELECT ON TABLE public.user_active_vessels TO authenticated;

-- ── Fleet RPCs ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_valid_vessel_profile_input(
    p_profile JSONB,
    p_vessel_units JSONB,
    p_comfort_params JSONB
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    vessel_name TEXT;
    vessel_type TEXT;
    vessel_model TEXT;
BEGIN
    IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
        RAISE EXCEPTION 'Vessel profile must be an object' USING ERRCODE = '22023';
    END IF;
    IF p_vessel_units IS NULL OR jsonb_typeof(p_vessel_units) <> 'object' THEN
        RAISE EXCEPTION 'Vessel units must be an object' USING ERRCODE = '22023';
    END IF;
    IF p_comfort_params IS NULL OR jsonb_typeof(p_comfort_params) <> 'object' THEN
        RAISE EXCEPTION 'Comfort parameters must be an object' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_profile -> 'name') <> 'string' THEN
        RAISE EXCEPTION 'Vessel profile name is required' USING ERRCODE = '22023';
    END IF;
    vessel_name := BTRIM(p_profile ->> 'name');
    IF vessel_name = '' OR char_length(vessel_name) > 160 THEN
        RAISE EXCEPTION 'Vessel profile name must be between 1 and 160 characters' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_profile -> 'type') <> 'string' THEN
        RAISE EXCEPTION 'Vessel profile type is required' USING ERRCODE = '22023';
    END IF;
    vessel_type := BTRIM(p_profile ->> 'type');
    IF vessel_type NOT IN ('sail', 'power', 'observer') THEN
        RAISE EXCEPTION 'Vessel profile type must be sail, power, or observer' USING ERRCODE = '22023';
    END IF;

    IF p_profile ? 'model' AND p_profile -> 'model' <> 'null'::JSONB THEN
        IF jsonb_typeof(p_profile -> 'model') <> 'string' THEN
            RAISE EXCEPTION 'Vessel model must be text when provided' USING ERRCODE = '22023';
        END IF;
        vessel_model := BTRIM(p_profile ->> 'model');
        IF char_length(vessel_model) > 255 THEN
            RAISE EXCEPTION 'Vessel model is too long' USING ERRCODE = '22023';
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._owned_vessel_fleet_rows(
    p_owner_id UUID,
    p_boat_id UUID DEFAULT NULL,
    p_include_archived BOOLEAN DEFAULT false
)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
    SELECT boat.id,
           boat.owner_id,
           boat.name,
           boat.vessel_type,
           boat.model,
           profile.profile,
           profile.vessel_units,
           profile.polar_data,
           profile.polar_boat_model,
           profile.polar_source_type,
           profile.comfort_params,
           profile.revision,
           profile.created_at,
           profile.updated_at,
           boat.archived_at,
           EXISTS (
               SELECT 1
                 FROM public.user_active_vessels AS active
                WHERE active.user_id = p_owner_id
                  AND active.boat_id = boat.id
           ) AS is_active
      FROM public.boats AS boat
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE boat.owner_id = p_owner_id
       AND (p_boat_id IS NULL OR boat.id = p_boat_id)
       AND (p_include_archived OR boat.archived_at IS NULL)
     ORDER BY CASE WHEN EXISTS (
                      SELECT 1
                        FROM public.user_active_vessels AS active
                       WHERE active.user_id = p_owner_id
                         AND active.boat_id = boat.id
                  ) THEN 0 ELSE 1 END,
              profile.updated_at DESC,
              boat.id;
$$;

CREATE OR REPLACE FUNCTION public.get_owned_vessel_fleet()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    selected_boat_id UUID;
    vessel_rows JSONB;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    -- Do not expose a crew-only personal selection as an active *owned*
    -- vessel. The explicit id also lets a new device recover the intended
    -- vessel without guessing from update timestamps.
    SELECT active.boat_id
      INTO selected_boat_id
      FROM public.user_active_vessels AS active
      JOIN public.boats AS boat
        ON boat.id = active.boat_id
       AND boat.owner_id = current_owner_id
       AND boat.archived_at IS NULL
     WHERE active.user_id = current_owner_id;

    SELECT COALESCE(
               jsonb_agg(
                   to_jsonb(fleet_row)
                   ORDER BY fleet_row.is_active DESC, fleet_row.updated_at DESC, fleet_row.id
               ),
               '[]'::JSONB
           )
      INTO vessel_rows
      FROM public._owned_vessel_fleet_rows(current_owner_id) AS fleet_row;

    RETURN jsonb_build_object(
        'vessels', vessel_rows,
        'active_boat_id', selected_boat_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_owned_vessel_profile(
    p_profile JSONB,
    p_vessel_units JSONB DEFAULT '{}'::JSONB,
    p_polar_data JSONB DEFAULT NULL,
    p_polar_boat_model TEXT DEFAULT NULL,
    p_polar_source_type TEXT DEFAULT NULL,
    p_comfort_params JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    new_boat_id UUID;
    vessel_name TEXT;
    vessel_type_value TEXT;
    vessel_model_value TEXT;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_polar_data IS NOT NULL AND jsonb_typeof(p_polar_data) <> 'object' AND jsonb_typeof(p_polar_data) <> 'array' THEN
        RAISE EXCEPTION 'Polar data must be an object or array when provided' USING ERRCODE = '22023';
    END IF;
    IF p_polar_source_type IS NOT NULL
       AND p_polar_source_type NOT IN ('database', 'file_import', 'manual') THEN
        RAISE EXCEPTION 'Unknown polar source type' USING ERRCODE = '22023';
    END IF;

    PERFORM public.assert_valid_vessel_profile_input(
        p_profile,
        COALESCE(p_vessel_units, '{}'::JSONB),
        COALESCE(p_comfort_params, '{}'::JSONB)
    );

    vessel_name := BTRIM(p_profile ->> 'name');
    vessel_type_value := BTRIM(p_profile ->> 'type');
    vessel_model_value := NULLIF(BTRIM(p_profile ->> 'model'), '');

    -- The trigger enforces this same limit for every insert path. Taking the
    -- advisory lock here makes the user-facing error deterministic before the
    -- insert and documents the atomic fleet-creation contract.
    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));
    IF (
        SELECT COUNT(*)
          FROM public.boats AS boat
         WHERE boat.owner_id = current_owner_id
           AND boat.archived_at IS NULL
    ) >= 5 THEN
        RAISE EXCEPTION 'A skipper may have at most five active vessels'
            USING ERRCODE = 'P0001',
                  DETAIL = 'Archive an existing vessel before creating another one.';
    END IF;

    INSERT INTO public.boats (owner_id, name, vessel_type, model)
    VALUES (current_owner_id, vessel_name, vessel_type_value, vessel_model_value)
    RETURNING id INTO new_boat_id;

    -- `boats_create_default_profile` has created the shell already. Replace it
    -- rather than relying on the caller to make a second request.
    UPDATE public.boat_profiles
       SET profile = p_profile,
           vessel_units = COALESCE(p_vessel_units, '{}'::JSONB),
           polar_data = p_polar_data,
           polar_boat_model = NULLIF(BTRIM(p_polar_boat_model), ''),
           polar_source_type = p_polar_source_type,
           comfort_params = COALESCE(p_comfort_params, '{}'::JSONB)
     WHERE boat_id = new_boat_id;

    INSERT INTO public.user_active_vessels (user_id, boat_id)
    VALUES (current_owner_id, new_boat_id)
    ON CONFLICT (user_id) DO UPDATE
        SET boat_id = EXCLUDED.boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, new_boat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.patch_owned_vessel_profile(
    p_boat_id UUID,
    p_profile_patch JSONB DEFAULT '{}'::JSONB,
    p_vessel_units_patch JSONB DEFAULT '{}'::JSONB,
    p_polar_data JSONB DEFAULT NULL,
    p_set_polar_data BOOLEAN DEFAULT false,
    p_polar_boat_model TEXT DEFAULT NULL,
    p_set_polar_boat_model BOOLEAN DEFAULT false,
    p_polar_source_type TEXT DEFAULT NULL,
    p_set_polar_source_type BOOLEAN DEFAULT false,
    p_comfort_params_patch JSONB DEFAULT '{}'::JSONB,
    p_expected_revision BIGINT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    current_profile JSONB;
    current_units JSONB;
    current_comfort JSONB;
    current_archived_at TIMESTAMPTZ;
    next_profile JSONB;
    next_units JSONB;
    next_comfort JSONB;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_boat_id IS NULL THEN
        RAISE EXCEPTION 'A vessel id is required' USING ERRCODE = '22023';
    END IF;
    IF COALESCE(jsonb_typeof(p_profile_patch), 'null') <> 'object'
       OR COALESCE(jsonb_typeof(p_vessel_units_patch), 'null') <> 'object'
       OR COALESCE(jsonb_typeof(p_comfort_params_patch), 'null') <> 'object' THEN
        RAISE EXCEPTION 'Vessel patches must be objects' USING ERRCODE = '22023';
    END IF;
    IF p_set_polar_data
       AND p_polar_data IS NOT NULL
       AND jsonb_typeof(p_polar_data) <> 'object'
       AND jsonb_typeof(p_polar_data) <> 'array' THEN
        RAISE EXCEPTION 'Polar data must be an object or array when provided' USING ERRCODE = '22023';
    END IF;
    IF p_set_polar_source_type
       AND p_polar_source_type IS NOT NULL
       AND p_polar_source_type NOT IN ('database', 'file_import', 'manual') THEN
        RAISE EXCEPTION 'Unknown polar source type' USING ERRCODE = '22023';
    END IF;

    SELECT profile.profile,
           profile.vessel_units,
           profile.comfort_params,
           boat.archived_at
      INTO current_profile,
           current_units,
           current_comfort,
           current_archived_at
      FROM public.boats AS boat
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE boat.id = p_boat_id
       AND boat.owner_id = current_owner_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vessel not found or not owned by current user' USING ERRCODE = '42501';
    END IF;
    IF current_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'Archived vessels cannot be edited' USING ERRCODE = '22023';
    END IF;
    -- Revisions are returned for diagnostics and UX, not a hard lock. A
    -- queued patch from device B must still merge into device A's newer row:
    -- JSONB `||` makes independent top-level fields converge, while a true
    -- same-field collision is intentionally last-writer-wins.

    -- JSON null is the explicit sparse-patch delete token. It lets a device
    -- clear a comfort threshold or optional unit without replacing unrelated
    -- fields from another device; JavaScript callers must normalise an
    -- `undefined` clear to null before RPC serialisation.
    next_profile := jsonb_strip_nulls(current_profile || COALESCE(p_profile_patch, '{}'::JSONB));
    next_units := jsonb_strip_nulls(current_units || COALESCE(p_vessel_units_patch, '{}'::JSONB));
    next_comfort := jsonb_strip_nulls(current_comfort || COALESCE(p_comfort_params_patch, '{}'::JSONB));
    PERFORM public.assert_valid_vessel_profile_input(next_profile, next_units, next_comfort);

    UPDATE public.boat_profiles
       SET profile = next_profile,
           vessel_units = next_units,
           polar_data = CASE WHEN p_set_polar_data THEN p_polar_data ELSE polar_data END,
           polar_boat_model = CASE
               WHEN p_set_polar_boat_model THEN NULLIF(BTRIM(p_polar_boat_model), '')
               ELSE polar_boat_model
           END,
           polar_source_type = CASE
               WHEN p_set_polar_source_type THEN p_polar_source_type
               ELSE polar_source_type
           END,
           comfort_params = next_comfort
     WHERE boat_id = p_boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, p_boat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_active_owned_vessel(p_boat_id UUID)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM public.boats AS boat
         WHERE boat.id = p_boat_id
           AND boat.owner_id = current_owner_id
           AND boat.archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Vessel not found or not owned by current user' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.user_active_vessels (user_id, boat_id)
    VALUES (current_owner_id, p_boat_id)
    ON CONFLICT (user_id) DO UPDATE
        SET boat_id = EXCLUDED.boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, p_boat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_owned_vessel(p_boat_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    replacement_boat_id UUID;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.boats
       SET archived_at = now()
     WHERE id = p_boat_id
       AND owner_id = current_owner_id
       AND archived_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vessel not found, already archived, or not owned by current user' USING ERRCODE = '42501';
    END IF;

    -- The archive trigger removes the selection only when this was the
    -- selected vessel. Do not let archiving an inactive delivery yacht
    -- silently switch the skipper away from the vessel they are using.
    IF NOT EXISTS (
        SELECT 1
          FROM public.user_active_vessels AS active
         WHERE active.user_id = current_owner_id
    ) THEN
        SELECT boat.id
          INTO replacement_boat_id
          FROM public.boats AS boat
         WHERE boat.owner_id = current_owner_id
           AND boat.archived_at IS NULL
         ORDER BY boat.updated_at DESC, boat.id
         LIMIT 1;

        IF replacement_boat_id IS NOT NULL THEN
            INSERT INTO public.user_active_vessels (user_id, boat_id)
            VALUES (current_owner_id, replacement_boat_id)
            ON CONFLICT (user_id) DO UPDATE
                SET boat_id = EXCLUDED.boat_id;
        END IF;
    END IF;

    RETURN true;
END;
$$;

-- Two freshly connected devices can both see an empty fleet before either
-- receives the other's first insert. Bootstrap is therefore a server-side
-- idempotent operation, not a client-side load-then-create guess.
CREATE OR REPLACE FUNCTION public.bootstrap_owned_vessel_profile(
    p_profile JSONB,
    p_vessel_units JSONB DEFAULT '{}'::JSONB,
    p_polar_data JSONB DEFAULT NULL,
    p_polar_boat_model TEXT DEFAULT NULL,
    p_polar_source_type TEXT DEFAULT NULL,
    p_comfort_params JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
    id UUID,
    owner_id UUID,
    name TEXT,
    vessel_type TEXT,
    model TEXT,
    profile JSONB,
    vessel_units JSONB,
    polar_data JSONB,
    polar_boat_model TEXT,
    polar_source_type TEXT,
    comfort_params JSONB,
    revision BIGINT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    existing_boat_id UUID;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));
    SELECT boat.id
      INTO existing_boat_id
      FROM public.boats AS boat
     WHERE boat.owner_id = current_owner_id
       AND boat.archived_at IS NULL
     ORDER BY boat.updated_at DESC, boat.id
     LIMIT 1;

    IF existing_boat_id IS NOT NULL THEN
        -- Repair a legacy owner whose active selector was absent without
        -- changing a deliberate existing selection.
        IF NOT EXISTS (
            SELECT 1
              FROM public.user_active_vessels AS active
              JOIN public.boats AS selected_boat
                ON selected_boat.id = active.boat_id
               AND selected_boat.owner_id = current_owner_id
               AND selected_boat.archived_at IS NULL
             WHERE active.user_id = current_owner_id
        ) THEN
            INSERT INTO public.user_active_vessels (user_id, boat_id)
            VALUES (current_owner_id, existing_boat_id)
            ON CONFLICT (user_id) DO UPDATE
                SET boat_id = EXCLUDED.boat_id;
        END IF;
        RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, existing_boat_id);
        RETURN;
    END IF;

    RETURN QUERY
    SELECT *
      FROM public.create_owned_vessel_profile(
          p_profile,
          p_vessel_units,
          p_polar_data,
          p_polar_boat_model,
          p_polar_source_type,
          p_comfort_params
      );
END;
$$;

-- Internal helpers are trigger/RPC implementation details. Public fleet RPCs
-- are authenticated-only; nothing is available to anon/public callers.
REVOKE ALL ON FUNCTION public.assert_valid_vessel_profile_input(JSONB, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._owned_vessel_fleet_rows(UUID, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_owned_vessel_fleet()
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_active_owned_vessel(UUID)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.archive_owned_vessel(UUID)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bootstrap_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_owned_vessel_fleet() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_owned_vessel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_owned_vessel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    TO authenticated;

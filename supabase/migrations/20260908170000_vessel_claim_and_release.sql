-- One hull, one skipper — MMSI claim + Release (Shane, 2026-09-08).
--
-- Shane's decision, 2026-09-08: "the only way a person can get access to the
-- same vessel as someone who has already claimed it, is via the invite part.
-- however we also need a way for a punter to release a vessel in case it has
-- been sold, or they were just doing a delivery." A hull is therefore CLAIMED
-- by its 9-digit MMSI on an active `boats` row (partial unique index
-- `boats_active_mmsi_claim`). The claim is refused HARD only at CREATE /
-- onboarding time (`create_owned_vessel_profile`, `bootstrap_owned_vessel_profile`
-- raise MMSI_CLAIMED, shore-side, with two client escapes: 'Enter crew code'
-- and 'Save without MMSI') and is ADVISORY on PATCH: an existing owner who types
-- a claimed MMSI later keeps the text in their profile for VHF/DSC but holds no
-- claim — never blocked, so AIS-squatting is a cosmetic loss, not a lockout.
-- Access to someone else's hull stays exactly today's invite path (`vessel_crew`
-- by email or manifest code); nothing else ever grants it, and no code path can
-- change `boats.owner_id`. Nothing here touches ship_logs, live_track,
-- diary_entries or voyages rows, and no gate here can fire at sea: the claim
-- runs on onboarding/profile writes only, and Release is refused by the CLIENT
-- while offline or while the tapping device is tracking.
--
-- Letting go is RELEASE: `release_owned_vessel(p_boat_id, p_reason)` archives
-- the boat under the SAME owner (every historical row keeps its boat_id grouping
-- and its user_id owner), removes the hull's crew landings, unpairs ONLY the Pi
-- relay rows matched to that hull (reporting unmatched legacy rows instead of
-- cutting them), clears the cloud instrument snapshot, darkens the public page,
-- frees the MMSI, and — on the owner's LAST active boat — ends their
-- account-wide crew, pending codes and the legacy `vessel_identity` projection.
-- `undo_vessel_release` is the 'oops' path (30 days; claim re-checked, never
-- forced); `get_released_vessels` lists what can still be undone. The AUTOMATIC
-- bootstrap refuses (VESSEL_RELEASED) to re-create a hull this account released,
-- so a seller's second phone cannot resurrect and re-claim a sold boat;
-- deliberate Add vessel and Undo are the sanctioned ways back. The bridge trigger
-- `sync_vessel_crew_to_boat_members` now lands crew on the owner's LIVE hull,
-- never an archived or released one.
--
-- Shane applies this with `supabase db push`. Run the duplicate-MMSI query FIRST
-- — where two ACTIVE boats share an MMSI the oldest `created_at` keeps the claim
-- and the others lose it with only a NOTICE (their profile text is untouched):
--
--     SELECT regexp_replace(p.profile->>'mmsi', '\D', '', 'g') AS mmsi,
--            count(*),
--            array_agg(b.name)
--       FROM public.boat_profiles p
--       JOIN public.boats b ON b.id = p.boat_id
--      WHERE b.archived_at IS NULL
--      GROUP BY 1
--     HAVING count(*) > 1;
--
-- Idempotent (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS). No RLS policy
-- changes and no publication changes: every write below runs inside SECURITY
-- DEFINER RPC or trigger code. Source bodies were copied from the LATEST
-- definitions — 20260727120000 (fleet), 20260728130000 (patch ambiguity fix,
-- kept), 20260728140000 (create ambiguity fix, kept) and 20260516150000 (the
-- bridge trigger's user_name_parts + byline-suffix body, which supersedes the
-- 20260516140000 version the design quoted) with 20260728150000's search_path
-- and REVOKE — and grep confirms no later migration redefines any of them.

-- ── 1. Columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.boats
    ADD COLUMN IF NOT EXISTS mmsi TEXT CHECK (mmsi IS NULL OR mmsi ~ '^[0-9]{9}$'),
    ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS release_reason TEXT
        CHECK (release_reason IS NULL OR release_reason IN ('sold', 'delivery_complete', 'other')),
    -- Release frees the claim (the partial index stops covering an archived
    -- row), so the bootstrap guard needs the MMSI as it stood at release to
    -- recognise the same hull after the buyer has claimed it.
    ADD COLUMN IF NOT EXISTS mmsi_at_release TEXT;

COMMENT ON COLUMN public.boats.mmsi IS
    'The CLAIM (2026-09-08): normalised 9-digit MMSI held by this boat while active; NULL when unclaimed or another active boat holds it. boat_profiles.profile->>''mmsi'' is what the skipper typed and is never touched.';
COMMENT ON COLUMN public.boats.released_at IS
    'Set by release_owned_vessel alongside archived_at; NULL for a plain archive. Cleared by undo_vessel_release.';
COMMENT ON COLUMN public.boats.release_reason IS
    'sold | delivery_complete | other — the reason picked in the Release dialog.';

ALTER TABLE public.pi_diary_relays
    ADD COLUMN IF NOT EXISTS boat_id UUID REFERENCES public.boats(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pi_diary_relays_boat_idx
    ON public.pi_diary_relays (boat_id);

COMMENT ON COLUMN public.pi_diary_relays.boat_id IS
    'The hull this Pi is aboard (stamped by the diary-relay pair path; backfilled 2026-09-08 for owners with exactly one active boat). Release deletes only rows matched to the released boat.';

-- ── 2. Backfill ────────────────────────────────────────────────────────────
-- Oldest ACTIVE boat keeps a duplicated MMSI; the others get NULL and are
-- listed. Re-run safe: never overwrites a claim, never collides with a live
-- holder.

WITH candidates AS (
    SELECT boat.id,
           regexp_replace(COALESCE(profile.profile ->> 'mmsi', ''), '\D', '', 'g') AS norm,
           ROW_NUMBER() OVER (
               PARTITION BY regexp_replace(COALESCE(profile.profile ->> 'mmsi', ''), '\D', '', 'g')
               ORDER BY boat.created_at, boat.id
           ) AS rn
      FROM public.boats AS boat
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE boat.archived_at IS NULL
)
UPDATE public.boats AS boat
   SET mmsi = candidate.norm
  FROM candidates AS candidate
 WHERE candidate.id = boat.id
   AND candidate.norm ~ '^[0-9]{9}$'
   AND candidate.rn = 1
   AND boat.mmsi IS NULL
   AND NOT EXISTS (
       SELECT 1
         FROM public.boats AS holder
        WHERE holder.mmsi = candidate.norm
          AND holder.archived_at IS NULL
   );

DO $$
DECLARE
    loser RECORD;
BEGIN
    FOR loser IN
        SELECT boat.id,
               boat.name,
               regexp_replace(COALESCE(profile.profile ->> 'mmsi', ''), '\D', '', 'g') AS norm
          FROM public.boats AS boat
          JOIN public.boat_profiles AS profile
            ON profile.boat_id = boat.id
         WHERE boat.archived_at IS NULL
           AND boat.mmsi IS NULL
           AND regexp_replace(COALESCE(profile.profile ->> 'mmsi', ''), '\D', '', 'g') ~ '^[0-9]{9}$'
    LOOP
        RAISE NOTICE 'MMSI % on boat % (%) is held by an older active boat; no claim assigned',
            loser.norm, loser.id, loser.name;
    END LOOP;
END
$$;

-- Legacy relay rows have no boat. Stamp them only where the answer is certain:
-- the owner has exactly one active boat. Everything else stays NULL and is
-- REPORTED by Release, never cut (Shane's data decision, 2026-09-08).
WITH sole AS (
    SELECT boat.owner_id,
           (array_agg(boat.id))[1] AS boat_id
      FROM public.boats AS boat
     WHERE boat.archived_at IS NULL
     GROUP BY boat.owner_id
    HAVING COUNT(*) = 1
)
UPDATE public.pi_diary_relays AS relay
   SET boat_id = sole.boat_id
  FROM sole
 WHERE relay.owner_id = sole.owner_id
   AND relay.boat_id IS NULL;

-- ── 3. The claim itself ────────────────────────────────────────────────────
-- Partial: an archived (or released) row holds no claim, so Archive and
-- Release both free the MMSI without touching the column.

CREATE UNIQUE INDEX IF NOT EXISTS boats_active_mmsi_claim
    ON public.boats (mmsi)
    WHERE archived_at IS NULL AND mmsi IS NOT NULL;

-- ── 4. Summary trigger: claim only when free ───────────────────────────────
-- Extends 20260727120000's sync_boat_summary_from_profile. On the edit path
-- this is advisory — the profile keeps the typed text, the claim is simply
-- withheld — so a skipper is never blocked by a neighbour who typed their
-- MMSI first. The advisory lock makes check-then-set atomic across every claim
-- writer (create/bootstrap/undo take the same key), so a concurrent claim can
-- never turn a profile edit into a unique_violation; the partial index stays
-- the backstop.

CREATE OR REPLACE FUNCTION public.sync_boat_summary_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    profile_name TEXT;
    profile_type TEXT;
    wanted_mmsi TEXT;
    claimed_mmsi TEXT;
BEGIN
    profile_name := NULLIF(BTRIM(NEW.profile ->> 'name'), '');
    profile_type := NULLIF(BTRIM(NEW.profile ->> 'type'), '');

    wanted_mmsi := NULLIF(regexp_replace(COALESCE(NEW.profile ->> 'mmsi', ''), '\D', '', 'g'), '');
    IF wanted_mmsi IS NOT NULL AND wanted_mmsi ~ '^[0-9]{9}$' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));
        IF NOT EXISTS (
            SELECT 1
              FROM public.boats AS other
             WHERE other.mmsi = wanted_mmsi
               AND other.archived_at IS NULL
               AND other.id <> NEW.boat_id
        ) THEN
            claimed_mmsi := wanted_mmsi;
        END IF;
    END IF;

    IF profile_name IS NOT NULL AND profile_type IN ('sail', 'power', 'observer') THEN
        UPDATE public.boats AS boat
           SET name = profile_name,
               vessel_type = profile_type,
               model = NULLIF(BTRIM(NEW.profile ->> 'model'), ''),
               mmsi = claimed_mmsi
         WHERE boat.id = NEW.boat_id;
    ELSE
        -- The pre-2026-09-08 body skipped the row entirely here. Only the
        -- claim is written, and only when it changes, so this branch stays a
        -- no-op for the default-profile shell and for unchanged profiles.
        UPDATE public.boats AS boat
           SET mmsi = claimed_mmsi
         WHERE boat.id = NEW.boat_id
           AND boat.mmsi IS DISTINCT FROM claimed_mmsi;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_boat_summary_from_profile() FROM PUBLIC, anon, authenticated;

-- ── 5. Hard check, used ONLY by create/bootstrap (onboarding) ──────────────
-- DETAIL names the claiming boat (name + MMSI are already broadcast on AIS);
-- HINT carries the MMSI. The holder's account is never disclosed.

CREATE OR REPLACE FUNCTION public.assert_mmsi_unclaimed(p_mmsi TEXT, p_exclude_boat_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    holder_name TEXT;
BEGIN
    IF p_mmsi IS NULL OR p_mmsi !~ '^[0-9]{9}$' THEN
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || p_mmsi, 0));

    SELECT holder.name
      INTO holder_name
      FROM public.boats AS holder
     WHERE holder.mmsi = p_mmsi
       AND holder.archived_at IS NULL
       AND (p_exclude_boat_id IS NULL OR holder.id <> p_exclude_boat_id)
     ORDER BY holder.created_at, holder.id
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'MMSI_CLAIMED'
            USING ERRCODE = 'P0001',
                  DETAIL = holder_name,
                  HINT = p_mmsi;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_mmsi_unclaimed(TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ── 6. Fleet rows grow three columns ───────────────────────────────────────
-- CREATE OR REPLACE cannot change a function's return type, so every RETURNS
-- TABLE that mirrors the fleet row is dropped and recreated, dependents first.
-- get_owned_vessel_fleet returns JSONB via to_jsonb(fleet_row) and picks the
-- new columns up without redefinition; archive_owned_vessel returns BOOLEAN.

DROP FUNCTION IF EXISTS public.get_released_vessels();
DROP FUNCTION IF EXISTS public.bootstrap_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
);
DROP FUNCTION IF EXISTS public.set_active_owned_vessel(UUID);
DROP FUNCTION IF EXISTS public._owned_vessel_fleet_rows(UUID, UUID, BOOLEAN);

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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
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
           ) AS is_active,
           -- A claim exists only while the partial index covers the row: an
           -- archived or released boat holds none whatever boats.mmsi says.
           (boat.mmsi IS NOT NULL AND boat.archived_at IS NULL) AS mmsi_claimed,
           boat.released_at,
           boat.release_reason
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

-- Body from 20260728140000 (the `RETURNING boat.id` ambiguity fix is kept),
-- plus the MMSI claim: this is the deliberate Add-vessel / onboarding path.
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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
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
    wanted_mmsi TEXT;
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

    -- MMSI claim (2026-09-08 decision): a second account cannot create an
    -- ACTIVE boat whose 9-digit MMSI another active boat holds. Refused HARD
    -- here because this is the deliberate, shore-side Add/onboarding path; the
    -- client never queues this RPC, so the refusal is terminal by construction
    -- and can never poison the fleet outbox. Lock order everywhere is owner
    -- lock first, then MMSI lock.
    wanted_mmsi := NULLIF(regexp_replace(COALESCE(p_profile ->> 'mmsi', ''), '\D', '', 'g'), '');
    IF wanted_mmsi ~ '^[0-9]{9}$' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));
        PERFORM public.assert_mmsi_unclaimed(wanted_mmsi, NULL);
    END IF;

    INSERT INTO public.boats AS boat (owner_id, name, vessel_type, model)
    VALUES (current_owner_id, vessel_name, vessel_type_value, vessel_model_value)
    RETURNING boat.id INTO new_boat_id;

    -- `boats_create_default_profile` has created the shell already. Replace it
    -- rather than relying on the caller to make a second request. The summary
    -- trigger writes the claim from this profile under the lock taken above.
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

-- Body from 20260728130000 verbatim (the `target.` qualification fix is kept).
-- PATCH is the ADVISORY claim path by design (2026-09-08): no hard MMSI check
-- runs here. The profile is written as typed and the summary trigger simply
-- withholds the claim when another active boat holds that MMSI; the fleet row's
-- mmsi_claimed tells the client to show its amber line. This is what keeps a
-- claim conflict out of the queued-patch outbox.
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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
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

    UPDATE public.boat_profiles AS target
       SET profile = next_profile,
           vessel_units = next_units,
           polar_data = CASE WHEN p_set_polar_data THEN p_polar_data ELSE target.polar_data END,
           polar_boat_model = CASE
               WHEN p_set_polar_boat_model THEN NULLIF(BTRIM(p_polar_boat_model), '')
               ELSE target.polar_boat_model
           END,
           polar_source_type = CASE
               WHEN p_set_polar_source_type THEN p_polar_source_type
               ELSE target.polar_source_type
           END,
           comfort_params = next_comfort
     WHERE target.boat_id = p_boat_id;

    RETURN QUERY SELECT * FROM public._owned_vessel_fleet_rows(current_owner_id, p_boat_id);
END;
$$;

-- Body from 20260727120000 verbatim; only the returned row shape changes.
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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
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

-- Body from 20260727120000 plus the released-hull guard. Two freshly connected
-- devices can both see an empty fleet before either receives the other's first
-- insert, so bootstrap is a server-side idempotent operation — which is exactly
-- why it must never resurrect a released hull.
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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    existing_boat_id UUID;
    wanted_mmsi TEXT;
    wanted_name TEXT;
    released_name TEXT;
    released_when TIMESTAMPTZ;
    released_why TEXT;
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

    -- Released-hull guard (2026-09-08 decision; closes the seller's-second-phone
    -- hole). We only get here when this account has NO active boat. This is the
    -- AUTOMATIC path a phone takes on sign-in with whatever stale local profile
    -- it still holds, so if this account RELEASED a boat matching the profile's
    -- MMSI (as it stood at release) or name, refuse rather than resurrect and
    -- re-claim a hull that was sold or handed back. The store treats
    -- VESSEL_RELEASED as terminal (placeholder profile, no retry). Deliberate
    -- Add vessel (create_owned_vessel_profile) and 'Undo release' carry no such
    -- guard and are the sanctioned ways back. DETAIL = the released boat's
    -- name; HINT = released_at|reason. Column references are alias-qualified
    -- because released_at/release_reason/name are also OUT columns here.
    wanted_mmsi := NULLIF(regexp_replace(COALESCE(p_profile ->> 'mmsi', ''), '\D', '', 'g'), '');
    IF wanted_mmsi !~ '^[0-9]{9}$' THEN
        wanted_mmsi := NULL;
    END IF;
    wanted_name := NULLIF(lower(BTRIM(p_profile ->> 'name')), '');

    IF wanted_mmsi IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));
    END IF;

    SELECT released.name,
           released.released_at,
           released.release_reason
      INTO released_name,
           released_when,
           released_why
      FROM public.boats AS released
     WHERE released.owner_id = current_owner_id
       AND released.released_at IS NOT NULL
       AND (
           (wanted_mmsi IS NOT NULL AND released.mmsi_at_release = wanted_mmsi)
           OR (wanted_name IS NOT NULL AND lower(released.name) = wanted_name)
       )
     ORDER BY released.released_at DESC, released.id
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'VESSEL_RELEASED'
            USING ERRCODE = 'P0001',
                  DETAIL = released_name,
                  HINT = released_when::TEXT || '|' || COALESCE(released_why, 'other');
    END IF;

    -- create_owned_vessel_profile takes the same MMSI lock (re-entrant within
    -- this transaction) and runs the hard claim check.
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

-- ── 7. Release ─────────────────────────────────────────────────────────────
-- The boat stays with the SAME owner (archived + released marker), so every
-- historical row keeps its boat_id grouping and its user_id owner: the seller
-- keeps their logbook, track and diary. Nothing here touches those tables.

CREATE OR REPLACE FUNCTION public.release_owned_vessel(p_boat_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    remaining INTEGER := 0;
    replacement_boat_id UUID;
    crew_removed INTEGER := 0;
    invites_revoked INTEGER := 0;
    relays_removed INTEGER := 0;
    relays_unmatched INTEGER := 0;
    telemetry_cleared INTEGER := 0;
    pages_disabled INTEGER := 0;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_boat_id IS NULL THEN
        RAISE EXCEPTION 'A vessel id is required' USING ERRCODE = '22023';
    END IF;
    IF p_reason IS NULL OR p_reason NOT IN ('sold', 'delivery_complete', 'other') THEN
        RAISE EXCEPTION 'Unknown release reason' USING ERRCODE = '22023';
    END IF;

    -- Same per-owner critical section as the other fleet RPCs.
    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));

    -- Archive under the same owner. boats_clear_active_vessel_on_archive drops
    -- the selection for this boat; the partial index stops covering the row,
    -- which is what frees the MMSI for the next skipper. The claim as it stood
    -- is kept in mmsi_at_release so bootstrap can recognise this hull later.
    UPDATE public.boats AS boat
       SET archived_at = now(),
           released_at = now(),
           release_reason = p_reason,
           mmsi_at_release = boat.mmsi
     WHERE boat.id = p_boat_id
       AND boat.owner_id = current_owner_id
       AND boat.archived_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vessel not found, already archived, or not owned by current user' USING ERRCODE = '42501';
    END IF;

    -- Replacement selection, copied from archive_owned_vessel (20260727120000):
    -- only when the released boat WAS the selected one, so releasing an
    -- inactive delivery yacht never switches the skipper away from the vessel
    -- they are using. The insert trigger re-projects vessel_identity.
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

    -- Crew of THIS hull lose their landing on it (the owner's own row stays
    -- with the archived boat as history).
    DELETE FROM public.boat_members AS member
     WHERE member.boat_id = p_boat_id
       AND member.role = 'crew';
    GET DIAGNOSTICS crew_removed = ROW_COUNT;

    SELECT COUNT(*)
      INTO remaining
      FROM public.boats AS boat
     WHERE boat.owner_id = current_owner_id
       AND boat.archived_at IS NULL;

    IF remaining = 0 THEN
        -- Last active boat: the account has nothing left to crew for.
        -- vessel_crew is owner-keyed (no boat_id — deferred), so it can only be
        -- ended wholesale, and only here. The bridge trigger removes the rest
        -- of the boat_members rows.
        DELETE FROM public.vessel_crew AS membership
         WHERE membership.owner_id = current_owner_id;

        -- A code handed out before the sale must not be redeemable against a
        -- released hull.
        UPDATE public.manifest_invites AS invite
           SET status = 'revoked'
         WHERE invite.owner_id = current_owner_id
           AND invite.status = 'pending';
        GET DIAGNOSTICS invites_revoked = ROW_COUNT;

        -- Ends the legacy skipper projection (usePermissions.isSkipper) for an
        -- account that owns no boat — correct for someone with no boat, and
        -- they may still hold whatever crew role someone has given them.
        DELETE FROM public.vessel_identity AS legacy_identity
         WHERE legacy_identity.owner_id = current_owner_id;
    ELSE
        -- Keep the compatibility row pointing at the vessel now selected.
        PERFORM public.project_selected_boat_to_vessel_identity(current_owner_id);
    END IF;

    -- Cut ONLY the Pi relay rows matched to this hull (pi_anchor_sessions
    -- cascade). A legacy row with no boat_id is REPORTED as relays_unmatched,
    -- never deleted — it may be a different boat's Pi (Shane's data decision,
    -- 2026-09-08). DELETE rather than enabled = false on purpose: a disabled
    -- row answers the next skipper 409 'reset it before pairing again' with no
    -- reset path, while a missing row lets pairRelay do its atomic first-claim
    -- insert and mint the new skipper a fresh token.
    DELETE FROM public.pi_diary_relays AS relay
     WHERE relay.owner_id = current_owner_id
       AND relay.boat_id = p_boat_id;
    GET DIAGNOSTICS relays_removed = ROW_COUNT;

    SELECT COUNT(*)
      INTO relays_unmatched
      FROM public.pi_diary_relays AS relay
     WHERE relay.owner_id = current_owner_id
       AND relay.boat_id IS NULL;

    -- The cloud instrument snapshot for this hull goes; a snapshot with no
    -- boat goes only when nothing is left to own it.
    DELETE FROM public.vessel_telemetry AS telemetry
     WHERE telemetry.owner_id = current_owner_id
       AND (
           telemetry.boat_id = p_boat_id
           OR (telemetry.boat_id IS NULL AND remaining = 0)
       );
    GET DIAGNOSTICS telemetry_cleared = ROW_COUNT;

    -- The public page goes dark. The handle stays the seller's (freeing or
    -- transferring it is deferred); re-enabling later shows history only, and
    -- the AIS/instrument flags stay off because that MMSI is now someone
    -- else's hull. trg_voyage_log_updated bumps updated_at.
    UPDATE public.voyage_log_configs AS config
       SET enabled = false,
           public_ais_enabled = false,
           public_instruments_enabled = false
     WHERE config.owner_id = current_owner_id
       AND config.boat_id = p_boat_id;
    GET DIAGNOSTICS pages_disabled = ROW_COUNT;

    RETURN jsonb_build_object(
        'released', true,
        'boat_id', p_boat_id,
        'remaining_active_boats', remaining,
        'next_active_boat_id', replacement_boat_id,
        'crew_removed', crew_removed,
        'invites_revoked', invites_revoked,
        'relays_removed', relays_removed,
        'relays_unmatched', relays_unmatched,
        'telemetry_cleared', telemetry_cleared,
        'public_pages_disabled', pages_disabled
    );
END;
$$;

REVOKE ALL ON FUNCTION public.release_owned_vessel(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_owned_vessel(UUID, TEXT) TO authenticated;

-- ── 8. Undo release ('oops' path) ──────────────────────────────────────────
-- Restores the boat to the fleet within 30 days. It does NOT restore crew,
-- relay rows or the public page — those were deleted/disabled by design and
-- need the owner's action again (re-invite, re-pair on the LAN, re-enable).
-- The claim is re-checked under the MMSI lock, never forced: if the buyer has
-- claimed the MMSI meanwhile the boat comes back unclaimed (claim_lost) and
-- the profile keeps its typed MMSI, so the advisory line shows. Choosing the
-- claim under the lock replaces the design's catch-unique_violation retry —
-- every claim writer takes this lock, so the collision cannot occur.

CREATE OR REPLACE FUNCTION public.undo_vessel_release(p_boat_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
    wanted_mmsi TEXT;
    claimed_mmsi TEXT;
    claim_lost BOOLEAN := false;
    restored_rows INTEGER := 0;
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;
    IF p_boat_id IS NULL THEN
        RAISE EXCEPTION 'A vessel id is required' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:owned-boat-limit:' || current_owner_id::TEXT, 0));

    -- Which MMSI would she claim on the way back? The one held at release,
    -- else the profile's typed value.
    SELECT COALESCE(
               boat.mmsi_at_release,
               NULLIF(regexp_replace(COALESCE(profile.profile ->> 'mmsi', ''), '\D', '', 'g'), '')
           )
      INTO wanted_mmsi
      FROM public.boats AS boat
      JOIN public.boat_profiles AS profile
        ON profile.boat_id = boat.id
     WHERE boat.id = p_boat_id
       AND boat.owner_id = current_owner_id
       AND boat.released_at IS NOT NULL
       AND boat.released_at > now() - interval '30 days'
     FOR UPDATE OF boat;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vessel not found or not released by current user in the last 30 days' USING ERRCODE = '42501';
    END IF;

    IF wanted_mmsi !~ '^[0-9]{9}$' THEN
        wanted_mmsi := NULL;
    END IF;

    IF wanted_mmsi IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('thalassa:mmsi-claim:' || wanted_mmsi, 0));
        IF NOT EXISTS (
            SELECT 1
              FROM public.boats AS other
             WHERE other.mmsi = wanted_mmsi
               AND other.archived_at IS NULL
               AND other.id <> p_boat_id
        ) THEN
            claimed_mmsi := wanted_mmsi;
        ELSE
            claim_lost := true;
        END IF;
    END IF;

    -- enforce_owned_boat_limit fires BEFORE UPDATE OF archived_at, so the same
    -- five-boat quota text as Add vessel applies here.
    UPDATE public.boats AS boat
       SET archived_at = NULL,
           released_at = NULL,
           release_reason = NULL,
           mmsi = claimed_mmsi,
           mmsi_at_release = NULL
     WHERE boat.id = p_boat_id
       AND boat.owner_id = current_owner_id
       AND boat.released_at IS NOT NULL;
    GET DIAGNOSTICS restored_rows = ROW_COUNT;

    IF restored_rows = 0 THEN
        RAISE EXCEPTION 'Vessel not found or not released by current user' USING ERRCODE = '42501';
    END IF;

    -- Re-select only when the skipper has no active vessel; the insert trigger
    -- re-projects vessel_identity. A deliberate existing selection is kept.
    IF NOT EXISTS (
        SELECT 1
          FROM public.user_active_vessels AS active
         WHERE active.user_id = current_owner_id
    ) THEN
        INSERT INTO public.user_active_vessels (user_id, boat_id)
        VALUES (current_owner_id, p_boat_id)
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    PERFORM public.project_selected_boat_to_vessel_identity(current_owner_id);

    RETURN jsonb_build_object(
        'restored', true,
        'boat_id', p_boat_id,
        'claim_lost', claim_lost,
        'mmsi_claimed', claimed_mmsi IS NOT NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.undo_vessel_release(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_vessel_release(UUID) TO authenticated;

-- ── 9. Released vessels still within the undo window ───────────────────────
-- Fleet-row shape so the client reuses normaliseFleetRow. released_at is an
-- OUT column here, hence the alias-qualified references.

CREATE OR REPLACE FUNCTION public.get_released_vessels()
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
    is_active BOOLEAN,
    mmsi_claimed BOOLEAN,
    released_at TIMESTAMPTZ,
    release_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
DECLARE
    current_owner_id UUID := auth.uid();
BEGIN
    IF current_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT fleet_row.*
      FROM public._owned_vessel_fleet_rows(current_owner_id, NULL, true) AS fleet_row
     WHERE fleet_row.released_at IS NOT NULL
       AND fleet_row.released_at > now() - interval '30 days'
     ORDER BY fleet_row.released_at DESC, fleet_row.id;
END;
$$;

-- ── 10. Grants for the recreated and new fleet RPCs ────────────────────────
-- DROP FUNCTION discarded the ACLs, so the 20260727120000 posture is restated:
-- internal helpers reachable by nobody, client RPCs authenticated-only.

REVOKE ALL ON FUNCTION public._owned_vessel_fleet_rows(UUID, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_active_owned_vessel(UUID)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bootstrap_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_released_vessels()
    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.patch_owned_vessel_profile(
    UUID, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN, TEXT, BOOLEAN, JSONB, BIGINT
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_owned_vessel(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_owned_vessel_profile(JSONB, JSONB, JSONB, TEXT, TEXT, JSONB)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_released_vessels() TO authenticated;

-- ── 11. Crew land on the live hull, never an archived one ──────────────────
-- Body from 20260516150000 (user_name_parts + byline-suffix retry loop — the
-- LATEST definition, which supersedes the 20260516140000 version), with two
-- changes for the 2026-09-08 decision: the boat is chosen with an ORDER BY
-- (active selection first, then most recently updated ACTIVE boat) instead of
-- a bare LIMIT 1 that could land crew on a sold boat; and leaving/declining
-- removes the crew's landing on EVERY boat this owner has, so an active-boat
-- switch between accept and leave cannot strand a row. search_path and the
-- REVOKE from 20260728150000 are kept. The trigger binding
-- trg_vessel_crew_to_boat_members (20260516130000) is unchanged.

CREATE OR REPLACE FUNCTION public.sync_vessel_crew_to_boat_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    captain_boat_id UUID;
    target_owner_id UUID;
    target_crew_id  UUID;
    parts RECORD;
    candidate_first TEXT;
    suffix INT := 1;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_owner_id := OLD.owner_id;
        target_crew_id  := OLD.crew_user_id;
    ELSE
        target_owner_id := NEW.owner_id;
        target_crew_id  := NEW.crew_user_id;
    END IF;

    IF target_crew_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'accepted' THEN
        -- The owner's LIVE hull: their active selection first, then the most
        -- recently updated active boat; never an archived or released one. If
        -- the owner has no active boat there is nothing to land on —
        -- vessel_crew still carries the shared registers.
        SELECT boat.id
          INTO captain_boat_id
          FROM public.boats AS boat
          LEFT JOIN public.user_active_vessels AS active
            ON active.user_id = boat.owner_id
           AND active.boat_id = boat.id
         WHERE boat.owner_id = target_owner_id
           AND boat.archived_at IS NULL
         ORDER BY (active.boat_id IS NOT NULL) DESC, boat.updated_at DESC, boat.id
         LIMIT 1;

        IF captain_boat_id IS NULL THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        SELECT * INTO parts FROM public.user_name_parts(target_crew_id);
        candidate_first := parts.first_name;

        -- Retry loop: on byline-collision, suffix first_name and try again.
        -- The (boat_id, user_id) primary key collision is a no-op (idempotent
        -- re-accept); the display_name unique index is the one we suffix for.
        LOOP
            BEGIN
                INSERT INTO public.boat_members
                    (boat_id, user_id, prefix, first_name, last_name, nickname, role)
                VALUES
                    (captain_boat_id, target_crew_id,
                     parts.prefix, candidate_first, parts.last_name, parts.nickname,
                     'crew')
                ON CONFLICT (boat_id, user_id) DO NOTHING;
                EXIT;  -- success
            EXCEPTION WHEN unique_violation THEN
                suffix := suffix + 1;
                candidate_first := parts.first_name || ' ' || suffix;
                IF suffix > 99 THEN
                    -- Sanity bail-out — 99 same-named crew is a different problem.
                    EXIT;
                END IF;
            END;
        END LOOP;

    ELSIF TG_OP = 'DELETE'
       OR (TG_OP = 'UPDATE' AND NEW.status = 'declined') THEN
        DELETE FROM public.boat_members AS member
         USING public.boats AS boat
         WHERE boat.id = member.boat_id
           AND boat.owner_id = target_owner_id
           AND member.user_id = target_crew_id
           AND member.role = 'crew';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_vessel_crew_to_boat_members() FROM PUBLIC, anon, authenticated;

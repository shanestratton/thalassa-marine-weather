-- The punter's own chart library survived their account deletion — and the
-- deletion said it hadn't.
--
-- Personal ENC cells live in the `enc-cells` bucket under `u/<uid>/…` (see
-- 20260807093000_personal_enc_cells.sql): the skipper's imported S-63 charts,
-- up to 16 MB each, hundreds of them, with their auth uid in the object path.
-- The Cloud Data section of Settings offers this to them as chart backup.
--
-- account_deletion_storage_inventory() enumerates objects three ways: by
-- storage owner_id, a chat-avatars special case, and a list of six buckets
-- matched on the FIRST path segment. `enc-cells` is in none of them, and could
-- not be fixed by adding it to the list, because its uid sits at segment TWO
-- behind the literal 'u'. The personal prefix was created on 2026-08-07 — one
-- day after the inventory was written. It is the same story as every other gap
-- the 2026-08-28 audit found: a store added after the sweep that has to know
-- about it.
--
-- What makes this one worth a migration of its own is the verification.
-- verify_account_deletion_storage_empty() re-runs THIS SAME function and
-- declares storage clean when it returns no rows. So a bucket the inventory
-- cannot see is not merely missed — it is certified empty. The flow would
-- report a clean, verified deletion with the punter's charts still sitting
-- there under their own uid. Telling someone their data is gone when it is not
-- is the exact failure this whole feature exists to avoid.
--
-- In practice today the objects ARE removed, because personalCellSync uploads
-- with the punter's own session so storage owner_id is populated and the first
-- branch catches them. That is one undocumented column standing between a
-- correct deletion and a false all-clear, with no path-based backstop and a
-- verifier that cannot notice the difference. This adds the backstop.
--
-- The same six-bucket list appears in block_tombstoned_storage_write(), so a
-- tombstoned account could still write chart objects back. Both are extended
-- here. Bodies are otherwise byte-for-byte the originals.

CREATE OR REPLACE FUNCTION public.account_deletion_storage_inventory(p_user_id UUID)
RETURNS TABLE (bucket_id TEXT, object_name TEXT, source TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, storage
AS $$
    SELECT DISTINCT
        object.bucket_id::TEXT,
        object.name::TEXT,
        CASE
            WHEN object.owner_id::TEXT = p_user_id::TEXT THEN 'storage-owner'
            WHEN object.bucket_id = 'recipe-photos'
             AND object.name IN (
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.recipes AS recipe
                 WHERE recipe.user_id = p_user_id
                 UNION
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.community_recipes AS recipe
                 WHERE recipe.user_id = p_user_id
             ) THEN 'legacy-recipe-row'
            ELSE 'owner-path'
        END AS source
    FROM storage.objects AS object
    WHERE object.owner_id::TEXT = p_user_id::TEXT
       OR (
            object.bucket_id = 'chat-avatars'
            AND (
                split_part(object.name, '/', 1) = p_user_id::TEXT
                OR (
                    split_part(object.name, '/', 1) IN ('dating', 'crew')
                    AND split_part(object.name, '/', 2) = p_user_id::TEXT
                )
            )
       )
       OR (
            -- The skipper's OWN imported chart cells. Personal cells live at
            -- u/<uid>/… so the uid is at segment 2, behind the literal 'u';
            -- the bucket-list branch above matches segment 1 and could never
            -- have found them even if 'enc-cells' were added to it.
            object.bucket_id = 'enc-cells'
            AND split_part(object.name, '/', 1) = 'u'
            AND split_part(object.name, '/', 2) = p_user_id::TEXT
       )
       OR (
            object.bucket_id IN (
                'crew-list-photos',
                'diary-photos',
                'diary-audio',
                'vessel_vault',
                'marketplace-images',
                'recipe-photos'
            )
            AND split_part(object.name, '/', 1) = p_user_id::TEXT
       )
       OR (
            object.bucket_id = 'recipe-photos'
            AND object.name IN (
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.recipes AS recipe
                WHERE recipe.user_id = p_user_id
                UNION
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.community_recipes AS recipe
                WHERE recipe.user_id = p_user_id
            )
       );
$$;

CREATE OR REPLACE FUNCTION public.block_tombstoned_storage_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    candidate UUID;
    candidates UUID[] := ARRAY[]::UUID[];
    owner_path TEXT;
BEGIN
    IF NEW.owner_id::TEXT ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, NEW.owner_id::TEXT::UUID);
    END IF;

    owner_path := CASE
        WHEN NEW.bucket_id = 'enc-cells'
         AND split_part(NEW.name, '/', 1) = 'u'
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id = 'chat-avatars'
         AND split_part(NEW.name, '/', 1) IN ('dating', 'crew')
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id IN (
            'chat-avatars',
            'crew-list-photos',
            'diary-photos',
            'diary-audio',
            'vessel_vault',
            'marketplace-images',
            'recipe-photos'
        ) THEN split_part(NEW.name, '/', 1)
        ELSE NULL
    END;
    IF owner_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, owner_path::UUID);
    END IF;

    FOR candidate IN
        SELECT DISTINCT expanded.candidate_value
        FROM unnest(candidates) AS expanded(candidate_value)
        ORDER BY expanded.candidate_value
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate::TEXT, 20260806));
        IF EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate) THEN
            RAISE EXCEPTION 'Account Storage is permanently write-fenced' USING ERRCODE = '55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

-- Definer hygiene (added 2026-09-01, flagged by the migration audit):
-- the inventory takes an arbitrary user id and reads storage.objects, so
-- only the service-role deletion path may call it; the tombstone guard is
-- a trigger and nothing calls it directly.
REVOKE ALL ON FUNCTION public.account_deletion_storage_inventory(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_tombstoned_storage_write() FROM PUBLIC, anon, authenticated;

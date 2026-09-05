-- Diary VIDEO was outside the deletion reach.
--
-- account_deletion_storage_inventory() is what the deletion flow trusts: it
-- declares storage clean when it returns no rows. Its path-based bucket list
-- was crew-list-photos, diary-photos, diary-audio, vessel_vault,
-- marketplace-images and recipe-photos — written before diary-video existed
-- (20260831120000), and never revisited when it did. The same six-bucket list
-- gates block_tombstoned_storage_write(), so a tombstoned account could also
-- write a clip back after deletion.
--
-- The owner_id branch caught clips the phone uploaded itself. It cannot catch a
-- clip the PI uploaded on the phone's behalf (DiaryService._parkVideoOnPi):
-- that lands with the Pi's credentials, owner_id null, under the punter's uid
-- at path segment 1 — exactly the shape this list exists to catch, in exactly
-- the bucket missing from it. So a deletion could report a clean, verified
-- result with the punter's videos still sitting there.
--
-- Both function bodies below are the LIVE production definitions pulled via
-- pg_get_functiondef on 2026-09-05 with one line added to each list, so this
-- cannot regress a change a later migration made to either function.

CREATE OR REPLACE FUNCTION public.account_deletion_storage_inventory(p_user_id uuid)
 RETURNS TABLE(bucket_id text, object_name text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, public, storage
AS $function$
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
                'diary-video',
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
$function$;

CREATE OR REPLACE FUNCTION public.block_tombstoned_storage_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public
AS $function$
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
            'diary-video',
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
$function$;

-- Privileges restated so this migration is self-evidently safe on its own — CREATE OR
-- REPLACE preserves existing grants, but the audit (scripts/audit-supabase-migrations.mjs)
-- and the next reader should not have to know that. Verbatim from 20260901130000.
REVOKE ALL ON FUNCTION public.account_deletion_storage_inventory(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_tombstoned_storage_write() FROM PUBLIC, anon, authenticated;

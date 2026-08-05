-- Assert the live public-beta Storage boundary after the recipe/vault and
-- legacy Crew-avatar repairs. These checks intentionally persist as migration
-- history: a deployment must stop instead of accepting an unexpected policy
-- catalogue whose permissive OR semantics reopen another bucket.

DO $storage_beta_boundary$
DECLARE
    unbounded_policies TEXT;
    recipe_policy_count INTEGER;
BEGIN
    SELECT string_agg(policyname, ', ' ORDER BY policyname)
    INTO unbounded_policies
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (
          (cmd = 'INSERT' AND with_check IS NULL)
          OR (cmd IN ('UPDATE', 'DELETE', 'ALL') AND qual IS NULL)
      );

    IF unbounded_policies IS NOT NULL THEN
        RAISE EXCEPTION 'Public-beta Storage has unbounded write policies: %', unbounded_policies;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND policyname = 'Users can update own vault files'
          AND cmd = 'UPDATE'
          AND 'authenticated' = ANY(roles)
          AND 'public' <> ALL(roles)
          AND qual ILIKE '%vessel_vault%'
          AND qual ILIKE '%auth.uid%'
          AND with_check ILIKE '%vessel_vault%'
          AND with_check ILIKE '%auth.uid%'
    ) THEN
        RAISE EXCEPTION 'Owner-scoped vessel_vault UPDATE policy is missing or malformed';
    END IF;

    SELECT count(*)
    INTO recipe_policy_count
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN (
          'Recipe photos public read',
          'Recipe photos owner upload',
          'Recipe photos owner update',
          'Recipe photos owner delete'
      );

    IF recipe_policy_count <> 4 THEN
        RAISE EXCEPTION 'Expected four recipe-photo policies, found %', recipe_policy_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND (
              COALESCE(qual, '') ILIKE '%chat-avatars%'
              OR COALESCE(with_check, '') ILIKE '%chat-avatars%'
          )
          AND (
              COALESCE(qual, '') ILIKE '%crew%'
              OR COALESCE(with_check, '') ILIKE '%crew%'
          )
    ) THEN
        RAISE EXCEPTION 'A legacy public chat-avatars/crew write path remains';
    END IF;
END;
$storage_beta_boundary$;

-- Public-beta recipe photo boundary.
--
-- Community Galley photos remain intentionally public, but writes and deletes
-- are owner-scoped by an authenticated UUID folder. Private recipe photos are
-- blocked in the client until they have a separate private-bucket/signed-URL
-- design. The temporary legacy-delete branch lets an owner retire old
-- root-level `<recipe-id>.jpg` objects without opening arbitrary bucket access.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'recipe-photos',
    'recipe-photos',
    true,
    5242880,
    ARRAY['image/jpeg']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies are OR-combined. Remove any earlier/manual recipe-photo
-- policy before installing the complete boundary below; otherwise a permissive
-- dashboard-created policy could silently bypass the owner folder check.
DO $policy_cleanup$
DECLARE
    existing_policy RECORD;
BEGIN
    FOR existing_policy IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND (
              COALESCE(qual, '') ILIKE '%recipe-photos%'
              OR COALESCE(with_check, '') ILIKE '%recipe-photos%'
          )
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', existing_policy.policyname);
    END LOOP;
END;
$policy_cleanup$;

-- The live beta project inherited this policy without either USING or
-- WITH CHECK, which makes UPDATE permissive across every Storage bucket.
-- Repair it before adding another public bucket: PostgreSQL combines
-- permissive policies with OR, so the recipe-specific owner policy alone
-- cannot compensate for a global write policy.
DROP POLICY IF EXISTS "Users can update own vault files" ON storage.objects;
CREATE POLICY "Users can update own vault files"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'vessel_vault'
        AND auth.uid()::TEXT = (storage.foldername(name))[1]
    )
    WITH CHECK (
        bucket_id = 'vessel_vault'
        AND auth.uid()::TEXT = (storage.foldername(name))[1]
    );

-- Refuse to install the bucket if another trivially unbounded write policy
-- exists. This keeps an unexpected dashboard/manual policy from silently
-- overriding the owner-scoped rules below.
DO $global_storage_write_guard$
DECLARE
    unbounded_policies TEXT;
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
        RAISE EXCEPTION 'Unbounded storage write policies must be repaired first: %', unbounded_policies;
    END IF;
END;
$global_storage_write_guard$;

CREATE POLICY "Recipe photos public read"
    ON storage.objects FOR SELECT TO public
    USING (bucket_id = 'recipe-photos');

CREATE POLICY "Recipe photos owner upload"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'recipe-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
        AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$'
    );

CREATE POLICY "Recipe photos owner update"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'recipe-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
    )
    WITH CHECK (
        bucket_id = 'recipe-photos'
        AND split_part(name, '/', 1) = auth.uid()::TEXT
        AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$'
    );

CREATE POLICY "Recipe photos owner delete"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'recipe-photos'
        AND (
            (
                split_part(name, '/', 1) = auth.uid()::TEXT
                AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$'
            )
            OR (
                name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$'
                AND (
                    EXISTS (
                        SELECT 1
                        FROM public.community_recipes AS community_recipe
                        WHERE community_recipe.user_id = auth.uid()
                          AND community_recipe.id::TEXT || '.jpg' = name
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM public.recipes AS recipe
                        WHERE recipe.user_id = auth.uid()
                          AND recipe.id::TEXT || '.jpg' = name
                    )
                )
            )
        )
    );

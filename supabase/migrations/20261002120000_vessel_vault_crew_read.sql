-- Crew can OPEN the files behind a skipper's shared Documents and Equipment
-- (shared binders, 2026-10-02).
--
-- The binder rows (ship_documents, equipment_register) are already readable
-- by accepted crew through can_access_vessel_register, but every vessel_vault
-- storage policy is owner-folder-only, so a crew member saw the skipper's
-- document list and could not open one file in it.
--
-- READ ONLY. Uploads, replacements and deletes stay owner-folder-only (the
-- four existing "own vault" policies are unchanged), so crew never attach to
-- or remove from a skipper's vault. The grant mirrors the table rows exactly:
-- the same can_access_vessel_register(owner, register, false) check, where
-- the path's second segment ('documents' | 'equipment') is the register name.
-- Path convention: {owner_uuid}/{documents|equipment}/{record}.{ext}
--
-- Per FILE, not per folder: the object must also be the attachment of a row
-- the crew member can see (ship_documents.file_uri, or for 'equipment'
-- equipment_register.manual_uri), as the canonical
-- 'supabase-storage://vessel_vault/<path>' reference or a legacy URL whose
-- path ends in '/vessel_vault/<path>'. Files no row points at (orphans left
-- by replaced or deleted records) stay the owner's alone. The subqueries run
-- under the reader's own row-level security, so they see exactly the rows
-- the app shows them.
--
-- The uuid cast sits inside CASE so a path whose first segment is not a uuid
-- yields false instead of an invalid-input error for the whole query.

DROP POLICY IF EXISTS "Crew read shared vault files" ON storage.objects;
CREATE POLICY "Crew read shared vault files"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'vessel_vault'
        AND CASE
            WHEN split_part(objects.name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                AND split_part(objects.name, '/', 2) IN ('documents', 'equipment')
            THEN public.can_access_vessel_register(
                split_part(objects.name, '/', 1)::uuid,
                split_part(objects.name, '/', 2),
                false
            )
            AND (
                (
                    split_part(objects.name, '/', 2) = 'documents'
                    AND EXISTS (
                        SELECT 1
                        FROM public.ship_documents d
                        WHERE d.user_id = split_part(objects.name, '/', 1)::uuid
                          AND (
                              d.file_uri = 'supabase-storage://vessel_vault/' || objects.name
                              OR (
                                  d.file_uri LIKE 'http%'
                                  AND right(
                                      split_part(d.file_uri, '?', 1),
                                      char_length('/vessel_vault/' || objects.name)
                                  ) = '/vessel_vault/' || objects.name
                              )
                          )
                    )
                )
                OR (
                    split_part(objects.name, '/', 2) = 'equipment'
                    AND EXISTS (
                        SELECT 1
                        FROM public.equipment_register e
                        WHERE e.user_id = split_part(objects.name, '/', 1)::uuid
                          AND (
                              e.manual_uri = 'supabase-storage://vessel_vault/' || objects.name
                              OR (
                                  e.manual_uri LIKE 'http%'
                                  AND right(
                                      split_part(e.manual_uri, '?', 1),
                                      char_length('/vessel_vault/' || objects.name)
                                  ) = '/vessel_vault/' || objects.name
                              )
                          )
                    )
                )
            )
            ELSE false
        END
    );

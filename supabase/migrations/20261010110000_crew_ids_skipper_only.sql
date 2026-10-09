-- Crew IDs stay with the skipper (2026-10-10, build 126, plan 126-B4,
-- binder audit DOC-3).
--
-- Not pushed with this commit: it waits for Shane's yes. It is safe to push
-- before build 126 reaches anyone (see "Older builds").
--
-- Why
-- ───
-- Sharing Documents with crew is meant to share the boat's papers:
-- registration, insurance, radio and customs. ship_documents had one read
-- policy, "Register members read documents" (20260723100000):
-- can_access_vessel_register(user_id, 'documents', false), with no category
-- term. So every accepted crew member the skipper shared Documents with read
-- every paper in the binder, other crew members' passports and IDs
-- ('Crew Visas/IDs') included. "Crew read shared vault files"
-- (20261002120000, live) then let them open the scans.
--
-- What changes
-- ────────────
-- 1. ship_documents, read: the owner sees all of their papers; crew with
--    Documents shared see every category except 'Crew Visas/IDs'.
-- 2. ship_documents, update: the rows crew may change get the same term
--    (USING only). An update that filters on a column, as every app update
--    does (the outbox filters on id), already meets the read policy; an
--    UPDATE with no WHERE does not, and the rolled-back replay on live showed
--    one re-filing a hidden passport as 'Registration'. PostgREST cannot send
--    one today only because safeupdate is preloaded for its login role; the
--    policy should not depend on that. WITH CHECK is unchanged, so no edit
--    the app makes today is refused that was allowed before.
--    INSERT and DELETE are unchanged. A crew insert is return=minimal (the
--    outbox upserts with ignoreDuplicates and no .select()), so no read check
--    applies to it: a crew member's own passport that crew_rewrite_user_id
--    moves into the skipper's binder still lands, now for the skipper's eyes
--    only. A category check on INSERT would make that a 42501 the outbox
--    retries forever.
-- 3. "Crew read shared vault files" (storage.objects): crew open a documents
--    file only when the visible row that points at it is that file's own
--    record, {owner}/documents/{row id}.{ext}, the name the app gives every
--    upload (SyncService uploadFileIfNeeded). Before, any visible row that
--    pointed at a file opened it, so a crew member who had the path of a
--    passport scan (cached on their phone from before this file) could file
--    a Registration paper pointing at it, or point a paper they can see at
--    it, and read the scan (both measured in the replay). The rows the
--    reader can see are still decided by the reader's own row-level
--    security, so item 1 carries through to the files. The equipment branch
--    is unchanged.
--
-- Older builds (102-125)
-- ──────────────────────
-- Crew stop seeing Crew IDs papers; the next deletion sweep removes them from
-- crew phones. One edge: a crew member on an older build who moves a paper
-- INTO Crew IDs. The outbox sends that as UPDATE ... RETURNING
-- (.select('id')), Postgres cannot return a row the writer can no longer
-- read, refuses it with 42501, and the queue retries it. Build 126 does not
-- offer Crew IDs to crew.
--
-- Not in this file: anon's leftover table privileges on ship_documents. All
-- four policies are TO authenticated, so RLS gives anon nothing; 126-13(b)
-- removes anon's table rights everywhere.
--
-- The one residual: an orphan scan. The record-file tie matches a file to
-- its row by id, and the id is the primary key, so while a passport's row
-- exists nobody else can point a row at its file. If the row is deleted but
-- the file outlives it (the app deletes both and retries the file until it
-- goes, so this needs a retry that never finished: the skipper signed out or
-- reinstalled first), a crew member with Documents write who cached the old
-- id could INSERT a visible row reusing it and open the scan: INSERT checks
-- only can_access_vessel_register(..., true). The later fix is a trigger
-- refusing a crew-authored write (auth.uid() <> user_id) that sets file_uri
-- to anything but NULL or its old value; crew never attach files to a
-- skipper's papers. Live held 0 ship_documents rows on 2026-10-10.
--
-- Undo
-- ────
-- Recreate the two ship_documents policies as 20260723100000 wrote them, and
-- the vault policy as 20261002120000 wrote it.
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back replay runs
-- it twice to prove a re-run is a no-op. lock_timeout is set for the session
-- and reset at the end.

SET lock_timeout = '5s';

DROP POLICY IF EXISTS "Register members read documents" ON public.ship_documents;
CREATE POLICY "Register members read documents"
    ON public.ship_documents FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR (
            category <> 'Crew Visas/IDs'
            AND public.can_access_vessel_register(user_id, 'documents', false)
        )
    );

DROP POLICY IF EXISTS "Register editors update documents" ON public.ship_documents;
CREATE POLICY "Register editors update documents"
    ON public.ship_documents FOR UPDATE TO authenticated
    USING (
        user_id = auth.uid()
        OR (
            category <> 'Crew Visas/IDs'
            AND public.can_access_vessel_register(user_id, 'documents', true)
        )
    )
    WITH CHECK (public.can_access_vessel_register(user_id, 'documents', true));

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
                          AND split_part(split_part(objects.name, '/', 3), '.', 1) = d.id::text
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

-- Fail the push unless ship_documents has exactly its four policies (one per
-- command, none open), the read and update policies carry the Crew IDs
-- term, the vault read carries the record-file tie, and nothing else reads
-- vessel_vault. Permissive policies are OR'd, and the 2026-10-09 sweep found
-- live policies no migration made.
DO $check$
DECLARE
    actual JSONB;
    open_policies TEXT;
    read_qual TEXT;
    update_qual TEXT;
    vault_qual TEXT;
    vault_readers JSONB;
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ship_documents'::regclass) THEN
        RAISE EXCEPTION 'crew ids skipper only: RLS is off on public.ship_documents';
    END IF;

    SELECT COALESCE(jsonb_object_agg(policyname::text, cmd), '{}'::jsonb)
    INTO actual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ship_documents';
    IF actual IS DISTINCT FROM
       '{"Document owners delete": "DELETE", "Register editors create documents": "INSERT", "Register editors update documents": "UPDATE", "Register members read documents": "SELECT"}'::jsonb THEN
        RAISE EXCEPTION 'crew ids skipper only: ship_documents has policies %', actual;
    END IF;

    SELECT string_agg(policyname, ', ')
    INTO open_policies
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ship_documents'
      AND (
          cmd = 'ALL'
          OR qual = 'true'
          OR with_check = 'true'
          OR roles && ARRAY['public', 'anon']::name[]
      );
    IF open_policies IS NOT NULL THEN
        RAISE EXCEPTION 'crew ids skipper only: open policies on ship_documents: %', open_policies;
    END IF;

    SELECT qual INTO read_qual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ship_documents' AND policyname = 'Register members read documents';
    IF read_qual NOT LIKE '%(user_id = auth.uid())%'
       OR read_qual NOT LIKE '%(category <> ''Crew Visas/IDs''::text)%' THEN
        RAISE EXCEPTION 'crew ids skipper only: crew ids term missing from the read policy';
    END IF;

    SELECT qual INTO update_qual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ship_documents' AND policyname = 'Register editors update documents';
    IF update_qual NOT LIKE '%(user_id = auth.uid())%'
       OR update_qual NOT LIKE '%(category <> ''Crew Visas/IDs''::text)%' THEN
        RAISE EXCEPTION 'crew ids skipper only: crew ids term missing from the update policy';
    END IF;

    SELECT qual INTO vault_qual
    FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Crew read shared vault files'
      AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[];
    IF vault_qual IS NULL OR vault_qual NOT LIKE '%= (d.id)::text%' THEN
        RAISE EXCEPTION 'crew ids skipper only: record-file tie missing from crew read shared vault files';
    END IF;

    SELECT COALESCE(jsonb_agg(policyname::text ORDER BY policyname::text COLLATE "C"), '[]'::jsonb)
    INTO vault_readers
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL')
      AND permissive = 'PERMISSIVE'
      AND (COALESCE(qual, '') LIKE '%vessel_vault%' OR COALESCE(qual, '') NOT LIKE '%bucket_id = %');
    IF vault_readers IS DISTINCT FROM '["Crew read shared vault files", "Users can view own vault files"]'::jsonb THEN
        RAISE EXCEPTION 'crew ids skipper only: vessel_vault readers are %', vault_readers;
    END IF;
END;
$check$;

RESET lock_timeout;

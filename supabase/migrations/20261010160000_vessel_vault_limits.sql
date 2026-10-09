-- ═══════════════════════════════════════════════════════════════════
-- vessel_vault: a 25 MiB cap and the Documents form's own file types
-- (126-B3a, binder audit 2026-10-09, DOC-2)
-- ═══════════════════════════════════════════════════════════════════
--
-- Not pushed: Shane says yes first, and only AFTER build 126 is on his phone
-- and iPad. 126 drains every attachment an older build kept inline (base64 in
-- the binder table and its outbox) to a file on the phone; one over 25 MiB is
-- kept on that phone only and its queued upload is dropped. Pushed earlier,
-- an old build's queued 30 MB upload would be refused at this limit on every
-- sync, forever.
--
-- The cap: file_size_limit 26214400 bytes (25 MiB), the app's own
-- (services/vessel/vaultFiles.ts MAX_ATTACHMENT_BYTES). Every upload crosses
-- the native bridge as base64 (CapacitorHttp is on), so ~33 MiB of string,
-- once; a larger cap waits for a streaming upload. Every other user bucket
-- already has a limit (chat, diary, recipe photos, seabed, sightings); this one
-- was created without (20260220070000_equipment_documents_vault.sql).
--
-- The types: exactly what DocumentForm accepts (.pdf .jpg .jpeg .png .heic
-- .doc .docx), with image/heif beside image/heic. Equipment manuals share the
-- bucket (<uid>/equipment/); they have no attach UI today and take the same
-- types if one is added.
--
-- Limits apply to uploads only: objects already stored stay readable, whatever
-- their size or type. Storage enforces them in the Storage API, not in
-- Postgres, so the refusal itself is proven on the device, never by SQL.
--
-- An UPDATE, not INSERT ... ON CONFLICT: the bucket exists live. The guard
-- raises if no row was updated (a project without the bucket), so the push
-- stops rather than recording a migration that changed nothing.
--
-- Rehearsal before the push (always rolled back):
--   begin; <this file>; select file_size_limit, allowed_mime_types
--   from storage.buckets where id = 'vessel_vault'; rollback;

DO $$
DECLARE
    updated integer;
BEGIN
    UPDATE storage.buckets
       SET file_size_limit = 26214400,
           allowed_mime_types = ARRAY[
               'application/pdf',
               'image/jpeg',
               'image/png',
               'image/heic',
               'image/heif',
               'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
           ]::TEXT[]
     WHERE id = 'vessel_vault';
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated <> 1 THEN
        RAISE EXCEPTION 'vessel_vault bucket not found: % rows updated', updated;
    END IF;
END
$$;

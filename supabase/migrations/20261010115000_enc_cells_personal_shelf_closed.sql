-- ═══════════════════════════════════════════════════════════════════
-- Close the personal chart shelf (enc-cells/u/<uid>/) for every build
-- ═══════════════════════════════════════════════════════════════════
--
-- Why
-- ───
-- o-charts (Roberto, 2026-10-10, replying to Shane's 2026-10-09 flow
-- diagram) on point 4b, the owner-only cloud copy of decrypted chart cells:
--   "Storing unencrypted data on any medium, and especially in the cloud,
--    is strictly prohibited by the terms of the licenses signed with the
--    chart providers."
-- The 2026-10-10 audit (counts only) found 1,025 decrypted o-charts cells and
-- 2 ChartWorld S-63 cells as plain GeoJSON under u/<owner>/, uploaded by
-- services/enc/personalCellSync.ts since 2026-08-07. Build 125 and earlier
-- keep uploading after every Pi sync while Auto-publish is on, and read the
-- folder back on every device at map mount and sign-in.
--
-- What changes
-- ────────────
-- * The owner READ, INSERT and UPDATE policies on u/<uid>/ go, so no
--   installed build can add to the folder or read it back.
-- * The owner DELETE policy stays, so a device can still remove its own
--   objects, and the shared NOAA-only root read (20261009070000) stays:
--   NOAA ENCs are public domain.
-- * Nothing is deleted here. The objects themselves are removed separately
--   through the Storage API (Shane runs it), after this is live.
--
-- Not pushed: Shane says yes first. It is pushed early, on its own, from the
-- encshelfpush worktree, and the same file is merged into b126 so the 126
-- release push sees it as already applied.
--
-- Undo: re-create the three policies exactly as in
-- 20260807093000_personal_enc_cells.sql (lines 41-71).

SET lock_timeout = '5s';

drop policy if exists "enc cells owner read" on storage.objects;
drop policy if exists "enc cells owner insert" on storage.objects;
drop policy if exists "enc cells owner update" on storage.objects;

DO $check$
DECLARE
    remaining integer;
BEGIN
    SELECT count(*) INTO remaining
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname IN ('enc cells owner read', 'enc cells owner insert', 'enc cells owner update');
    IF remaining <> 0 THEN
        RAISE EXCEPTION 'personal chart shelf still open: % owner policies remain', remaining;
    END IF;
    -- Anything else that still lets a signed-in client read or write enc-cells
    -- must be the NOAA-only root read or the owner delete, nothing more.
    SELECT count(*) INTO remaining
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%enc-cells%'
       AND policyname NOT IN ('enc cells owner delete', 'enc cells shared read noaa');
    IF remaining <> 0 THEN
        RAISE EXCEPTION 'unexpected enc-cells policies remain: %', remaining;
    END IF;
END
$check$;

RESET lock_timeout;

-- The shared ENC shelf serves only public-domain NOAA cells.
--
-- Why
-- ───
-- 20260807093000 left one blanket read on the bucket root: any signed-in
-- account could read every object not under `u/`. An audit on 2026-10-09
-- (counts only, nothing listed by name) found the root holds 351 GeoJSON
-- extracts from the owner's licensed o-charts set (412 MB, uploaded
-- 2026-07-08..17 for the desktop passage builder), one NOAA cell and the
-- manifest. services/enc/cloudCellSync.ts says it plainly: "the extracts are
-- licensed". A licence that covers the owner's own devices does not cover
-- every other Thalassa account, so the blanket read was redistribution.
--
-- The owner loses nothing: the same set lives in his personal prefix
-- (`u/<uid>/`, owner-only since 20260807093000) and reaches his second device
-- through personalCellSync. Nothing is deleted here; the objects stay put and
-- simply stop being readable by other accounts.
--
-- What changes
-- ────────────
-- * The shared read now matches only NOAA ENC cell files at the root
--   (US + usage band digit + 5 alphanumerics + .json). NOAA ENCs are public
--   domain. The o-charts extracts and manifest.json are no longer readable by
--   other accounts; cloudCellSync treats an unreadable manifest as "no cloud
--   charts" (it logs and returns null) — the honest outcome.
-- * Owner policies on `u/<uid>/` are untouched.
-- * Copies already downloaded to other devices before today cannot be
--   recalled by a policy; this stops further reads.

drop policy if exists "enc cells shared read" on storage.objects;
drop policy if exists "enc cells shared read noaa" on storage.objects;
create policy "enc cells shared read noaa"
    on storage.objects for select to authenticated
    using (
        bucket_id = 'enc-cells'
        and name not like 'u/%'
        and name ~ '^US[0-9][A-Z0-9]{5}\.json$'
    );

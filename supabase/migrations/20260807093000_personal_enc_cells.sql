-- Personal ENC cell store — the skipper's OWN cells, scoped to their account.
--
-- Why this exists
-- ───────────────
-- Shane, 2026-08-07: his two S-63 cells (FR466870 Nouméa, GB501494 Port Vila)
-- imported fine on the phone but never appeared on thalassawx.app/plan, while
-- the AU cells did. That was not a bug: /plan reads the CURATED `enc-cells`
-- bucket that was uploaded once in July, and there has never been a device →
-- cloud path at all. His charts were on the boat; the browser was looking at
-- somebody else's shelf.
--
-- The licensing line
-- ──────────────────
-- The ENC page promises "Thalassa never uploads or redistributes them", and
-- S-63 is encrypted precisely because redistribution is controlled. A cell
-- readable ONLY by the account that imported it is not redistribution — it is
-- the same licensee reaching their own chart from their own second device.
-- That distinction lives or dies on these policies, so they are the security
-- boundary for the whole feature, not bookkeeping.
--
-- Layout: personal objects live under `u/<auth.uid()>/`, curated cells stay at
-- the bucket root. The prefix is what every policy below keys on.

-- ── 1. Stop the blanket read from covering the personal prefix ────────────
-- The 2026-07-08 policy was `bucket_id = 'enc-cells'` with no path predicate:
-- ANY authenticated user could read ANY object. Harmless while the bucket held
-- only curated extracts; it would have made every skipper's private charts
-- world-readable to every other signed-in account the moment we started
-- uploading. Replaced, not added to.
drop policy if exists "enc cells authenticated read" on storage.objects;
drop policy if exists "enc cells shared read" on storage.objects;
create policy "enc cells shared read"
    on storage.objects for select to authenticated
    using (bucket_id = 'enc-cells' and name not like 'u/%');

-- ── 2. Owner-only access to u/<uid>/… ─────────────────────────────────────
-- storage.foldername('u/<uid>/AU5PTL01.json') = {u, <uid>}; a root object
-- yields {}, so subscripting it is NULL and these policies cannot match one.
-- Both USING and WITH CHECK are spelled out on update: USING alone would let a
-- caller move an object OUT of their own folder.
drop policy if exists "enc cells owner read" on storage.objects;
create policy "enc cells owner read"
    on storage.objects for select to authenticated
    using (
        bucket_id = 'enc-cells'
        and (storage.foldername(name))[1] = 'u'
        and (storage.foldername(name))[2] = auth.uid()::text
    );

drop policy if exists "enc cells owner insert" on storage.objects;
create policy "enc cells owner insert"
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'enc-cells'
        and (storage.foldername(name))[1] = 'u'
        and (storage.foldername(name))[2] = auth.uid()::text
    );

drop policy if exists "enc cells owner update" on storage.objects;
create policy "enc cells owner update"
    on storage.objects for update to authenticated
    using (
        bucket_id = 'enc-cells'
        and (storage.foldername(name))[1] = 'u'
        and (storage.foldername(name))[2] = auth.uid()::text
    )
    with check (
        bucket_id = 'enc-cells'
        and (storage.foldername(name))[1] = 'u'
        and (storage.foldername(name))[2] = auth.uid()::text
    );

drop policy if exists "enc cells owner delete" on storage.objects;
create policy "enc cells owner delete"
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'enc-cells'
        and (storage.foldername(name))[1] = 'u'
        and (storage.foldername(name))[2] = auth.uid()::text
    );

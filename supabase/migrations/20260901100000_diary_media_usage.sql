-- ═══════════════════════════════════════════════════════════════
-- Diary media usage — the measuring half of the quota system.
--
-- Media will be quota'd at 5 GB per PAYING punter once the paywall
-- exists (agreed 2026-09-01); photos stay free and limited. This is
-- deliberately NOT a ledger table: storage.objects already knows every
-- object's size, so usage is computed from the source of truth on
-- demand — nothing to drift, nothing to backfill, deletes and orphan
-- sweeps automatically accounted. Enforcement later is one comparison
-- against this at the two upload chokepoints (the Pi relay's
-- signed-URL mint and the direct upload path).
--
-- Owner scoping: paths in all three diary buckets are minted as
-- <user-id>/<file> by the app and validated server-side
-- (ownedStorageRef), so the name prefix is the ownership truth. The
-- storage.objects owner column is NOT reliable here — relay uploads
-- arrive via service-minted signed URLs.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.diary_media_usage()
returns table (bucket text, bytes bigint, objects bigint)
language sql
stable
security definer
set search_path = ''
as $$
    select
        o.bucket_id::text as bucket,
        coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint as bytes,
        count(*)::bigint as objects
    from storage.objects o
    where o.bucket_id in ('diary-photos', 'diary-audio', 'diary-video')
      -- auth.uid() is null for anon: null || '/%' is null, and LIKE null
      -- matches nothing — an unauthenticated caller sees an empty result.
      and o.name like auth.uid()::text || '/%'
    group by o.bucket_id
$$;

-- Callable by signed-in punters only; each sees only their own bytes.
revoke all on function public.diary_media_usage() from public;
revoke all on function public.diary_media_usage() from anon;
grant execute on function public.diary_media_usage() to authenticated;

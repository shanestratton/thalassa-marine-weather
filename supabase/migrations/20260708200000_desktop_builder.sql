-- Desktop Passage Builder (masterplan Phase 5, Shane 2026-07-08: "we should
-- also be able to use a public facing page to do the route on, and it will
-- get saved to the punters device").
--
-- Three cloud pieces the web build needs (the browser can't reach the Pi):
--   1. `enc-cells` storage bucket — the Pi's extracted ENC GeoJSON, gated to
--      signed-in users (the extracts are licensed; no anonymous serving).
--   2. `osm_overlay_cache` — server-side cache behind the osm-overlay edge
--      function (same 7-day tile semantics as the pi-cache).
--   3. `saved_routes` — account-synced tracer routes: build on the desktop,
--      sail on the phone.

-- ── 1. ENC cells bucket (private; authenticated read) ─────────────────────
insert into storage.buckets (id, name, public)
values ('enc-cells', 'enc-cells', false)
on conflict (id) do nothing;

drop policy if exists "enc cells authenticated read" on storage.objects;
create policy "enc cells authenticated read"
    on storage.objects for select to authenticated
    using (bucket_id = 'enc-cells');

-- ── 2. OSM overlay cache (edge function's backing store) ──────────────────
create table if not exists public.osm_overlay_cache (
    tile_key text primary key,
    payload jsonb not null,
    fetched_at timestamptz not null default now()
);
alter table public.osm_overlay_cache enable row level security;
-- No client policies: only the edge function (service role) touches it.

-- ── 3. Account-synced tracer routes ────────────────────────────────────────
create table if not exists public.saved_routes (
    id text primary key, -- client-generated (trace-xxxx) so offline saves merge
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    name text not null,
    points jsonb not null, -- [[lat, lon], ...]
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted boolean not null default false, -- tombstone so deletes sync too
    constraint saved_routes_points_sane check (
        jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 2 and 200
    )
);

create index if not exists saved_routes_user_idx on public.saved_routes (user_id, updated_at desc);

alter table public.saved_routes enable row level security;

drop policy if exists saved_routes_own on public.saved_routes;
create policy saved_routes_own on public.saved_routes
    for all to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- Route Tracer community flywheel (masterplan Phase 4.1/4.2, Shane 2026-07-08).
--
-- Punters SUBMIT a validated trace (explicit consent tap — never automatic);
-- nothing publishes until the harbourmaster (Shane) approves it. Approved
-- routes surface to everyone as proven-lane ghosts via an identity-stripped
-- RPC, and every consumer re-grades the line against THEIR OWN keel on load.
--
-- Identity: submitted_by is stored for dedup/abuse handling but NEVER leaves
-- the database — the public read path is the security-definer RPC below,
-- which selects only (id, name, points, draft_m).

create table if not exists public.traced_routes (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 80),
    -- [[lat, lon], ...] — 2..120 pins, matching the tracer's own shape.
    points jsonb not null,
    -- The keel the submitter's verdicts were graded against (metres).
    draft_m numeric,
    -- Flat bbox columns so the area query needs no jsonb gymnastics.
    bbox_w double precision not null,
    bbox_s double precision not null,
    bbox_e double precision not null,
    bbox_n double precision not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    submitted_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
    submitted_at timestamptz not null default now(),
    reviewed_at timestamptz,
    review_note text,
    constraint traced_routes_points_sane check (
        jsonb_typeof(points) = 'array'
        and jsonb_array_length(points) between 2 and 120
    )
);

create index if not exists traced_routes_status_idx on public.traced_routes (status);

alter table public.traced_routes enable row level security;

-- Submit: any signed-in user, own uid only, always lands as pending.
drop policy if exists traced_routes_insert on public.traced_routes;
create policy traced_routes_insert on public.traced_routes
    for insert to authenticated
    with check (submitted_by = auth.uid() and status = 'pending');

-- Submitters can watch their own submission's status.
drop policy if exists traced_routes_own_select on public.traced_routes;
create policy traced_routes_own_select on public.traced_routes
    for select to authenticated
    using (submitted_by = auth.uid());

-- Harbourmaster: full visibility + review updates. Keyed on the owner's
-- login email (shane.stratton@gmail.com) — if the app account ever changes,
-- update these two policies.
drop policy if exists traced_routes_admin_select on public.traced_routes;
create policy traced_routes_admin_select on public.traced_routes
    for select to authenticated
    using ((auth.jwt() ->> 'email') = 'shane.stratton@gmail.com');

drop policy if exists traced_routes_admin_update on public.traced_routes;
create policy traced_routes_admin_update on public.traced_routes
    for update to authenticated
    using ((auth.jwt() ->> 'email') = 'shane.stratton@gmail.com')
    with check ((auth.jwt() ->> 'email') = 'shane.stratton@gmail.com');

-- Public consumption: approved rows only, identity stripped, bbox-limited.
-- SECURITY DEFINER so anon punters read through RLS without a select policy
-- ever exposing submitted_by.
create or replace function public.traced_routes_near(
    w double precision,
    s double precision,
    e double precision,
    n double precision
)
returns table (id uuid, name text, points jsonb, draft_m numeric)
language sql
security definer
set search_path = public
stable
as $$
    select id, name, points, draft_m
    from public.traced_routes
    where status = 'approved'
      and bbox_w <= e and bbox_e >= w
      and bbox_s <= n and bbox_n >= s
    order by reviewed_at desc nulls last
    limit 20;
$$;

grant execute on function public.traced_routes_near to anon, authenticated;

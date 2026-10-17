-- Minimal disposable auth/storage host, never run against a Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
grant usage on schema auth,storage to anon,authenticated,service_role;
create table auth.users(id uuid primary key,is_anonymous boolean not null default false);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('sub',auth.uid(),'role',auth.role()) $$;
create table public.account_deletion_jobs(user_id uuid primary key);
create table public.recipes(id uuid,user_id uuid);
create table public.community_recipes(id uuid,user_id uuid);
create table public.chat_roles(user_id uuid primary key,role text,is_blocked boolean default false);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text,unique(bucket_id,name));
alter table storage.objects enable row level security;
-- Deliberately broad legacy policy: the new restrictive policy must still deny this bucket.
grant all on storage.objects to authenticated,service_role;
create policy fixture_legacy_owner_access on storage.objects for all to authenticated using(true) with check(true);
create publication supabase_realtime;


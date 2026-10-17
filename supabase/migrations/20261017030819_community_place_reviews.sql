-- 140-02: community notes only. No chart, depth, clearance or routing authority.
-- RPC-only projection: raw tables and photo paths never enter the Data API/Realtime.
create schema if not exists community_private;
revoke all on schema community_private from public, anon, authenticated;
grant usage on schema community_private to service_role;

create table community_private.place_reviews (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 place_id text not null check (place_id ~ '^(osm-(node|way|relation)[1-9][0-9]{0,15}|noaa:[a-fA-F0-9]{16}|gbrmpa-[A-Za-z0-9]{1,80})$'),
 kind text not null check (kind in ('anchorage','designated_anchorage','marina')),
 holding text not null check (holding in ('unknown','poor','mixed','good')),
 protection text[] not null default '{}' check (cardinality(protection)<=8 and protection <@ array['N','NE','E','SE','S','SW','W','NW']::text[]),
 swell text not null check (swell in ('unknown','calm','some','exposed')),
 facilities text[] not null default '{}' check (cardinality(facilities)<=8 and facilities <@ array['water','fuel','toilets','showers','laundry','provisions','rubbish','repairs']::text[]),
 notes text not null check (length(notes) between 1 and 1200),
 visited date check (visited between date '2000-01-01' and date '2100-01-01'),
 revision uuid not null default gen_random_uuid(),
 status text not null default 'visible' check (status in ('visible','held','removed')),
 reviewed boolean not null default false,
 terms_version text not null check (terms_version='2026-10-17'),
 consent_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(owner_id,place_id)
);
create index place_reviews_public_place on community_private.place_reviews(place_id,updated_at desc) where status='visible';
create table community_private.review_photos (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 review_id uuid references community_private.place_reviews(id) on delete set null,
 review_revision uuid not null,
 status text not null default 'uploading' check (status in ('uploading','pending','approved','removed')),
 object_path text not null unique,
 bytes integer check (bytes between 1 and 1048576),
 digest text check (digest ~ '^[a-f0-9]{64}$'),
 revision uuid not null default gen_random_uuid(),
 created_at timestamptz not null default now(),
 check (object_path=owner_id::text||'/'||id::text||'.jpg')
);
create index review_photos_review on community_private.review_photos(review_id);
create table community_private.review_reports (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 review_id uuid not null references community_private.place_reviews(id) on delete cascade,
 reason text not null check (reason in ('unsafe','abuse','privacy','copyright','spam')),
 created_at timestamptz not null default now(),
 unique(owner_id,review_id)
);
create table community_private.review_blocks (
 owner_id uuid not null references auth.users(id) on delete cascade,
 blocked_id uuid not null references auth.users(id) on delete cascade,
 primary key(owner_id,blocked_id), check(owner_id<>blocked_id)
);
create table community_private.review_bans (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table community_private.review_moderation (
 review_id uuid primary key references community_private.place_reviews(id) on delete cascade,
 revision uuid not null,
 reason text not null check (reason in ('new','edit','report','filter')),
 created_at timestamptz not null default now()
);
create table community_private.review_write_quota (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 day date not null,
 operations integer not null check(operations between 1 and 40)
);
do $$
declare t text;
begin
 foreach t in array array['place_reviews','review_photos','review_reports','review_blocks','review_bans','review_moderation','review_write_quota'] loop
  execute format('alter table community_private.%I enable row level security',t);
  execute format('revoke all on community_private.%I from public,anon,authenticated',t);
  execute format('grant all on community_private.%I to service_role',t);
 end loop;
 foreach t in array array['place_reviews','review_photos','review_reports','review_blocks','review_bans','review_write_quota'] loop
  execute format('create trigger account_deletion_write_fence before insert or update on community_private.%I for each row execute function public.block_tombstoned_account_write(''owner_id'')',t);
 end loop;
 -- A block also references another account. Fence both deletion reaches.
 create trigger blocked_account_deletion_write_fence before insert or update on community_private.review_blocks
 for each row execute function public.block_tombstoned_account_write('blocked_id');
 -- Never publish private UGC, paths, pending metadata or report identities.
 if exists(select 1 from pg_publication p where p.pubname='supabase_realtime' and
  (p.puballtables or exists(select 1 from pg_publication_namespace n where n.pnpubid=p.oid and n.pnnspid='community_private'::regnamespace))) then
  raise exception 'Review deployment requires an explicit-table Realtime publication';
 end if;
end $$;

-- No direct Storage read/write/signed URL can bypass current review moderation.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('community-review-photos','community-review-photos',false,1048576,array['image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=1048576,allowed_mime_types=array['image/jpeg'];
create policy community_photos_server_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'community-review-photos') with check(bucket_id<>'community-review-photos');

-- Deliberately privileged projection/mutations: no client table grants, no caller-supplied owner.
create or replace function public.community_reviews(p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 u uuid:=auth.uid(); r community_private.place_reviews; ph community_private.review_photos;
 rid uuid; pid text; n text; rev uuid; out jsonb; is_mod boolean:=false; target uuid;
begin
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>16000 then raise exception 'Invalid review request' using errcode='22023'; end if;
 -- Deleted/tombstoned tokens must not resurrect access or public/private content.
 if u is not null and (not exists(select 1 from auth.users where id=u) or exists(select 1 from public.account_deletion_jobs where user_id=u)) then
  raise exception 'Account unavailable' using errcode='42501';
 end if;
 if p_action='list' then
  pid:=p_input->>'place_id';
  if pid is null or length(pid)>120 then raise exception 'Invalid place'; end if;
  select coalesce(jsonb_agg(x.body order by x.updated_at desc),'[]') into out from (
   select jsonb_build_object('id',q.id,'holding',q.holding,'protection',q.protection,'swell',q.swell,
    'facilities',q.facilities,'notes',q.notes,'visited',q.visited,'updated_at',q.updated_at,
    'reviewed',q.reviewed,'photo_id',(select id from community_private.review_photos f
       where f.review_id=q.id and f.status='approved' and f.review_revision=q.revision limit 1)) body,q.updated_at
   from community_private.place_reviews q where q.place_id=pid and q.status='visible'
    and not exists(select 1 from public.account_deletion_jobs d where d.user_id=q.owner_id)
    and not exists(select 1 from community_private.review_bans b where b.owner_id=q.owner_id)
    and not exists(select 1 from community_private.review_blocks b where b.owner_id=u and b.blocked_id=q.owner_id)
   order by q.updated_at desc limit 12
  ) x;
  return jsonb_build_object('reviews',out,'community',true,'limited',true);
 end if;
 if u is null or exists(select 1 from auth.users where id=u and is_anonymous) then raise exception 'Sign in required' using errcode='42501'; end if;
 is_mod:=public.is_chat_moderator(u);
 if p_action='queue' then
  if not is_mod then raise exception 'Moderator required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(x.body),'[]') into out from (
   select jsonb_build_object('id',q.id,'place_id',q.place_id,'revision',q.revision,'notes',q.notes,
    'status',q.status,'reason',m.reason,'photo_id',f.id,'photo_revision',f.revision) body
   from community_private.place_reviews q
   left join community_private.review_moderation m on m.review_id=q.id
   left join lateral(select id,revision from community_private.review_photos p where p.review_id=q.id and p.status='pending' order by created_at limit 1) f on true
   where q.status<>'removed' and (m.review_id is not null or f.id is not null)
   order by coalesce(m.created_at,q.created_at) limit 50
  ) x;
  return jsonb_build_object('queue',out);
 end if;
 -- Per-account fence before content locks; same advisory seed as account deletion.
 perform pg_advisory_xact_lock(hashtextextended(u::text,20260806));
 if exists(select 1 from public.account_deletion_jobs where user_id=u) then raise exception 'Account unavailable' using errcode='42501'; end if;
 is_mod:=public.is_chat_moderator(u);
 if not is_mod and p_action in('save','report','block') then
  insert into community_private.review_write_quota(owner_id,day,operations)
   values(u,(clock_timestamp() at time zone 'UTC')::date,1)
  on conflict(owner_id) do update set day=excluded.day,
   operations=case when community_private.review_write_quota.day=excluded.day then community_private.review_write_quota.operations+1 else 1 end;
 end if;
 if p_action='mine' then
  select * into r from community_private.place_reviews where owner_id=u and place_id=p_input->>'place_id';
  if r.id is null then return 'null'; end if;
  return to_jsonb(r)-'owner_id'-'consent_at'||jsonb_build_object('photo_id',(select id from community_private.review_photos where review_id=r.id and status in('pending','approved') order by created_at desc limit 1));
 end if;
 if p_action='save' then
  if exists(select 1 from community_private.review_bans where owner_id=u) then raise exception 'Posting is suspended' using errcode='42501'; end if;
  if p_input->>'terms_version'<>'2026-10-17' or p_input->>'terms_version' is null then raise exception 'Accept user content terms'; end if;
  pid:=p_input->>'place_id'; n:=btrim(p_input->>'notes');
  select * into r from community_private.place_reviews where owner_id=u and place_id=pid for update;
  if r.id is not null and r.revision::text is distinct from p_input->>'revision' then raise exception 'Review changed; reload' using errcode='40001'; end if;
  if r.id is null and (select count(*) from community_private.place_reviews where owner_id=u)>=200 then raise exception 'Review limit reached'; end if;
  if r.id is not null and r.updated_at>clock_timestamp()-interval '5 seconds' then raise exception 'Please wait before editing'; end if;
  if (select count(*) from community_private.place_reviews where owner_id=u and updated_at>now()-interval '1 day')>=20 then raise exception 'Daily posting limit reached'; end if;
  -- Early hold for obvious threats/slurs/spam; all ordinary text is post-moderated.
  if n is null or length(n) not between 1 and 1200 or translate(n,chr(9)||chr(10)||chr(13),'') ~ '[[:cntrl:]]' then raise exception 'Use 1–1200 plain text characters'; end if;
  insert into community_private.place_reviews(owner_id,place_id,kind,holding,protection,swell,facilities,notes,visited,terms_version,status)
  values(u,pid,p_input->>'kind',p_input->>'holding',array(select jsonb_array_elements_text(p_input->'protection')),
   p_input->>'swell',array(select jsonb_array_elements_text(p_input->'facilities')),n,nullif(p_input->>'visited','')::date,'2026-10-17',
   case when n ~* '(kill yourself|heil hitler|buy now|https?://|www\.)' then 'held' else 'visible' end)
  on conflict(owner_id,place_id) do update set holding=excluded.holding,protection=excluded.protection,swell=excluded.swell,
   facilities=excluded.facilities,notes=excluded.notes,visited=excluded.visited,revision=gen_random_uuid(),reviewed=false,
   status=case when community_private.place_reviews.status in ('held','removed') then 'held' else excluded.status end,updated_at=clock_timestamp(),
   terms_version=excluded.terms_version,consent_at=clock_timestamp()
  returning * into r;
  update community_private.review_photos set status='removed',revision=gen_random_uuid() where review_id=r.id;
  insert into community_private.review_moderation(review_id,revision,reason) values(r.id,r.revision,case when r.status='held' then 'filter' else 'edit' end)
   on conflict(review_id) do update set revision=excluded.revision,reason=excluded.reason,created_at=now();
  return jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status);
 end if;
 rid:=(p_input->>'id')::uuid;
 select * into r from community_private.place_reviews where id=rid;
 if r.id is null then raise exception 'Review unavailable' using errcode='P0002'; end if;
 -- Cross-owner moderator/report paths acquire target deletion fence before row lock.
 -- Deterministic UUID order for two-owner operations avoids opposing block/report deadlocks.
 if r.owner_id<>u then
  -- Caller fence was taken first: use a nonblocking target fence and ask caller to retry.
  if not pg_try_advisory_xact_lock(hashtextextended(r.owner_id::text,20260806)) then raise exception 'Review busy; retry' using errcode='40001'; end if;
 end if;
 select * into r from community_private.place_reviews where id=rid for update;
 if r.id is null or exists(select 1 from public.account_deletion_jobs where user_id=r.owner_id) then raise exception 'Review unavailable'; end if;
 if p_action='report' then
  if r.owner_id=u or r.status='removed' then raise exception 'Review unavailable'; end if;
  if (select count(*) from community_private.review_reports where owner_id=u and created_at>now()-interval '1 day')>=20 then raise exception 'Report limit reached'; end if;
  insert into community_private.review_reports(owner_id,review_id,reason) values(u,r.id,p_input->>'reason') on conflict do nothing;
  update community_private.place_reviews set status='held',revision=gen_random_uuid(),reviewed=false where id=r.id returning * into r;
  update community_private.review_photos set status=case when status='approved' then 'pending' else status end,revision=gen_random_uuid() where review_id=r.id;
  insert into community_private.review_moderation(review_id,revision,reason) values(r.id,r.revision,'report')
   on conflict(review_id) do update set revision=excluded.revision,reason='report',created_at=now();
 elsif p_action='block' then
  if r.owner_id=u then raise exception 'Cannot block yourself'; end if;
  if (select count(*) from community_private.review_blocks where owner_id=u)>=500 then raise exception 'Block limit reached'; end if;
  insert into community_private.review_blocks values(u,r.owner_id) on conflict do nothing;
 elsif p_action='delete' then
  if r.owner_id<>u then raise exception 'Owner required' using errcode='42501'; end if;
  delete from community_private.place_reviews where id=r.id;
 elsif p_action='moderate' then
  if not public.is_chat_moderator(u) then raise exception 'Moderator required' using errcode='42501'; end if;
  if r.revision::text is distinct from p_input->>'revision' then raise exception 'Review changed; reload queue' using errcode='40001'; end if;
  if p_input->>'decision'='ban' then
   insert into community_private.review_bans(owner_id) values(r.owner_id) on conflict do nothing;
   update community_private.place_reviews set status='removed',revision=gen_random_uuid() where owner_id=r.owner_id;
   update community_private.review_photos set status='removed',revision=gen_random_uuid() where owner_id=r.owner_id;
   delete from community_private.review_moderation where review_id in(select id from community_private.place_reviews where owner_id=r.owner_id);
  elsif p_input->>'decision' in ('approve','remove') then
   update community_private.place_reviews set status=case when p_input->>'decision'='approve' then 'visible' else 'removed' end,reviewed=true where id=r.id;
   if p_input->>'decision'='remove' then update community_private.review_photos set status='removed',revision=gen_random_uuid() where review_id=r.id; end if;
   delete from community_private.review_moderation where review_id=r.id;
  elsif p_input->>'decision' in ('approve-photo','remove-photo') then
   select * into ph from community_private.review_photos where id=(p_input->>'photo_id')::uuid and review_id=r.id for update;
   if ph.id is null or ph.status<>'pending' or ph.revision::text is distinct from p_input->>'photo_revision' then raise exception 'Photo changed; reload queue' using errcode='40001'; end if;
   update community_private.review_photos set status=case when p_input->>'decision'='approve-photo' then 'approved' else 'removed' end,
    review_revision=r.revision,revision=gen_random_uuid() where id=ph.id;
  else raise exception 'Invalid moderation decision'; end if;
 else raise exception 'Invalid review action'; end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.community_reviews(text,jsonb) from public;
grant execute on function public.community_reviews(text,jsonb) to anon,authenticated;

-- Service-only image protocol. getUser() in the Edge authenticates p_user; caller cannot set moderation.
create or replace function public.community_review_photo(p_action text,p_user uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare r community_private.place_reviews; ph community_private.review_photos; mod boolean; pid uuid;
begin
 if p_user is null or not exists(select 1 from auth.users where id=p_user and not coalesce(is_anonymous,false)) or exists(select 1 from public.account_deletion_jobs where user_id=p_user)
  then raise exception 'Account unavailable' using errcode='42501'; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>2000 then raise exception 'Invalid photo request'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,20260806));
 if not exists(select 1 from auth.users where id=p_user and not coalesce(is_anonymous,false)) or exists(select 1 from public.account_deletion_jobs where user_id=p_user) then
  raise exception 'Account unavailable' using errcode='42501';
 end if;
 if p_action='reserve' then
  select * into r from community_private.place_reviews where id=(p_input->>'review_id')::uuid and owner_id=p_user for update;
  if r.id is null or r.status='removed' or r.revision::text is distinct from p_input->>'revision' or exists(select 1 from community_private.review_bans where owner_id=p_user) then raise exception 'Review unavailable'; end if;
  -- Includes retired/orphaned uploads until operator cleanup; cannot cycle deletion to evade quota.
  if (select count(*) from community_private.review_photos where owner_id=p_user)>=40 then raise exception 'Photo quota reached; contact support'; end if;
  update community_private.review_photos set status='removed',revision=gen_random_uuid() where review_id=r.id;
  pid:=gen_random_uuid();
  insert into community_private.review_photos(id,owner_id,review_id,review_revision,object_path)
   values(pid,p_user,r.id,r.revision,p_user::text||'/'||pid::text||'.jpg') returning * into ph;
 elsif p_action in ('finish','access') then
  select * into ph from community_private.review_photos where id=(p_input->>'id')::uuid;
  select * into r from community_private.place_reviews where id=ph.review_id;
  if ph.id is null or r.id is null or r.status='removed' or exists(select 1 from public.account_deletion_jobs where user_id=r.owner_id)
   or exists(select 1 from community_private.review_bans where owner_id=r.owner_id) then raise exception 'Photo unavailable' using errcode='42501'; end if;
  if p_action='finish' then
   if ph.owner_id<>p_user then raise exception 'Owner required' using errcode='42501'; end if;
   select * into r from community_private.place_reviews where id=ph.review_id for update;
   select * into ph from community_private.review_photos where id=ph.id for update;
   if r.id is null or ph.review_id is null or ph.status<>'uploading' or ph.review_revision<>r.revision or r.status='removed' then raise exception 'Upload retired'; end if;
   update community_private.review_photos set status='pending',bytes=(p_input->>'bytes')::integer,digest=p_input->>'digest',revision=gen_random_uuid() where id=ph.id returning * into ph;
  else
   mod:=public.is_chat_moderator(p_user);
   if not (ph.owner_id=p_user or mod or (ph.status='approved' and r.status='visible' and ph.review_revision=r.revision))
    or ph.status not in ('pending','approved') or ph.bytes is null
    or (not mod and ph.owner_id<>p_user and exists(select 1 from community_private.review_blocks where owner_id=p_user and blocked_id=ph.owner_id))
    then raise exception 'Photo unavailable' using errcode='42501'; end if;
  end if;
 else raise exception 'Invalid photo action'; end if;
 return jsonb_build_object('id',ph.id,'path',ph.object_path,'revision',ph.revision,'review_revision',r.revision,'status',ph.status,'bytes',ph.bytes,'digest',ph.digest);
end $$;
revoke all on function public.community_review_photo(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.community_review_photo(text,uuid,jsonb) to service_role;

-- Extend the actual current deletion reach bodies, preserving every existing bucket.
CREATE OR REPLACE FUNCTION public.account_deletion_storage_inventory(p_user_id uuid)
 RETURNS TABLE(bucket_id text, object_name text, source text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'storage'
AS $function$
    SELECT DISTINCT
        object.bucket_id::TEXT,
        object.name::TEXT,
        CASE
            WHEN object.owner_id::TEXT = p_user_id::TEXT THEN 'storage-owner'
            WHEN object.bucket_id = 'recipe-photos'
             AND object.name IN (
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.recipes AS recipe
                 WHERE recipe.user_id = p_user_id
                 UNION
                 SELECT recipe.id::TEXT || '.jpg'
                 FROM public.community_recipes AS recipe
                 WHERE recipe.user_id = p_user_id
             ) THEN 'legacy-recipe-row'
            ELSE 'owner-path'
        END AS source
    FROM storage.objects AS object
    WHERE object.owner_id::TEXT = p_user_id::TEXT
       OR (
            object.bucket_id = 'chat-avatars'
            AND (
                split_part(object.name, '/', 1) = p_user_id::TEXT
                OR (
                    split_part(object.name, '/', 1) IN ('dating', 'crew')
                    AND split_part(object.name, '/', 2) = p_user_id::TEXT
                )
            )
       )
       OR (
            -- The skipper's OWN imported chart cells. Personal cells live at
            -- u/<uid>/… so the uid is at segment 2, behind the literal 'u';
            -- the bucket-list branch above matches segment 1 and could never
            -- have found them even if 'enc-cells' were added to it.
            object.bucket_id = 'enc-cells'
            AND split_part(object.name, '/', 1) = 'u'
            AND split_part(object.name, '/', 2) = p_user_id::TEXT
       )
       OR (
            object.bucket_id IN (
                'crew-list-photos',
                'diary-photos',
                'diary-audio',
                'diary-video',
                'vessel_vault',
                'marketplace-images',
                'recipe-photos',
                'sighting-photos',
                'seabed-soundings',
                'community-review-photos'
            )
            AND split_part(object.name, '/', 1) = p_user_id::TEXT
       )
       OR (
            object.bucket_id = 'recipe-photos'
            AND object.name IN (
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.recipes AS recipe
                WHERE recipe.user_id = p_user_id
                UNION
                SELECT recipe.id::TEXT || '.jpg'
                FROM public.community_recipes AS recipe
                WHERE recipe.user_id = p_user_id
            )
       );
$function$
;
CREATE OR REPLACE FUNCTION public.block_tombstoned_storage_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    candidate UUID;
    candidates UUID[] := ARRAY[]::UUID[];
    owner_path TEXT;
BEGIN
    IF NEW.owner_id::TEXT ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, NEW.owner_id::TEXT::UUID);
    END IF;

    owner_path := CASE
        WHEN NEW.bucket_id = 'enc-cells'
         AND split_part(NEW.name, '/', 1) = 'u'
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id = 'chat-avatars'
         AND split_part(NEW.name, '/', 1) IN ('dating', 'crew')
            THEN split_part(NEW.name, '/', 2)
        WHEN NEW.bucket_id IN (
            'chat-avatars',
            'crew-list-photos',
            'diary-photos',
            'diary-audio',
            'diary-video',
            'vessel_vault',
            'marketplace-images',
            'recipe-photos',
            'sighting-photos',
            'seabed-soundings',
                'community-review-photos'
        ) THEN split_part(NEW.name, '/', 1)
        ELSE NULL
    END;
    IF owner_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        candidates := array_append(candidates, owner_path::UUID);
    END IF;

    FOR candidate IN
        SELECT DISTINCT expanded.candidate_value
        FROM unnest(candidates) AS expanded(candidate_value)
        ORDER BY expanded.candidate_value
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate::TEXT, 20260806));
        IF EXISTS (SELECT 1 FROM public.account_deletion_jobs WHERE user_id = candidate) THEN
            RAISE EXCEPTION 'Account Storage is permanently write-fenced' USING ERRCODE = '55000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$function$
;
revoke all on function public.account_deletion_storage_inventory(uuid) from public,anon,authenticated;
grant execute on function public.account_deletion_storage_inventory(uuid) to service_role;
revoke all on function public.block_tombstoned_storage_write() from public,anon,authenticated;
grant execute on function public.block_tombstoned_storage_write() to service_role;



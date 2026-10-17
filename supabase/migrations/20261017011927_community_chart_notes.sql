-- 140-03: unofficial observations only. No route/watch/depth/clearance authority.
-- Requires canonical community_place_reviews. No Realtime/public raw grants.
create table community_private.chart_notes (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 revision uuid not null default gen_random_uuid(),
 kind text not null check(kind in('moved-mark','new-mooring','hazard','other')),
 latitude double precision not null check(latitude between -85 and 85),
 longitude double precision not null check(longitude between -180 and 180),
 message text not null check(length(message) between 1 and 1200),
 observed_date date not null check(observed_date between date '2000-01-01' and date '2100-01-01'),
 expires_at timestamptz not null,
 status text not null default 'visible' check(status in('visible','held','removed')),
 reviewed boolean not null default false,
 terms_version text not null check(terms_version='2026-10-17'),
 public_consent text not null check(public_consent='publish-pin-and-note-v1'),
 consent_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(expires_at=((observed_date+30)::timestamp at time zone 'UTC'))
);
create index chart_notes_window on community_private.chart_notes(latitude,longitude,created_at desc) where status='visible';
create index chart_notes_owner on community_private.chart_notes(owner_id,updated_at desc);
create table community_private.chart_note_votes (
 owner_id uuid not null references auth.users(id) on delete cascade,
 note_id uuid not null references community_private.chart_notes(id) on delete cascade,
 revision uuid not null,
 choice text not null check(choice in('confirm','deny')),
 updated_at timestamptz not null default now(),
 primary key(owner_id,note_id)
);
create index chart_note_vote_count on community_private.chart_note_votes(note_id,revision,choice);
create table community_private.chart_note_reports (
 owner_id uuid not null references auth.users(id) on delete cascade,
 note_id uuid not null references community_private.chart_notes(id) on delete cascade,
 reason text not null check(reason in('unsafe','abuse','privacy','copyright','spam')),
 created_at timestamptz not null default now(),
 primary key(owner_id,note_id)
);
create table community_private.chart_note_moderation (
 note_id uuid primary key references community_private.chart_notes(id) on delete cascade,
 revision uuid not null,
 reason text not null check(reason in('edit','report','filter')),
 created_at timestamptz not null default now()
);
create table community_private.chart_vote_quota (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 day date not null,
 operations integer not null check(operations between 1 and 100)
);
-- Existing private bucket, owner prefix, write fence, deletion inventory and 40 total reservations are shared.
-- Orphan rows remain charged and inaccessible. Neither API may guess the other kind.
alter table community_private.review_photos add column chart_note_id uuid references community_private.chart_notes(id) on delete set null;
alter table community_private.review_photos add constraint community_photo_single_subject check(review_id is null or chart_note_id is null);
create index chart_note_photos on community_private.review_photos(chart_note_id);
do $$
declare t text;
begin
 foreach t in array array['chart_notes','chart_note_votes','chart_note_reports','chart_note_moderation','chart_vote_quota'] loop
  execute format('alter table community_private.%I enable row level security',t);
  execute format('revoke all on community_private.%I from public,anon,authenticated',t);
  execute format('grant all on community_private.%I to service_role',t);
 end loop;
 foreach t in array array['chart_notes','chart_note_votes','chart_note_reports','chart_vote_quota'] loop
  execute format('create trigger account_deletion_write_fence before insert or update on community_private.%I for each row execute function public.block_tombstoned_account_write(''owner_id'')',t);
 end loop;
 if exists(select 1 from pg_publication p where p.pubname='supabase_realtime' and
  (p.puballtables or exists(select 1 from pg_publication_namespace n where n.pnpubid=p.oid and n.pnnspid='community_private'::regnamespace))) then
  raise exception 'Community notes require an explicit-table Realtime publication';
 end if;
end $$;

-- Unexposed helper. Outer RPC supplies actual selected IDs and actual auth.uid().
create function community_private.chart_note_public(p_id uuid,p_viewer uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public
as $$
 select jsonb_build_object('id',n.id,'revision',n.revision,'kind',n.kind,'latitude',n.latitude,'longitude',n.longitude,
  'message',n.message,'observed_date',n.observed_date,'expires_at',n.expires_at,
  'confirms',(select count(*) from community_private.chart_note_votes v where v.note_id=n.id and v.revision=n.revision and v.choice='confirm'
   and not exists(select 1 from public.account_deletion_jobs d where d.user_id=v.owner_id)
   and not exists(select 1 from community_private.review_bans b where b.owner_id=v.owner_id)),
  'denies',(select count(*) from community_private.chart_note_votes v where v.note_id=n.id and v.revision=n.revision and v.choice='deny'
   and not exists(select 1 from public.account_deletion_jobs d where d.user_id=v.owner_id)
   and not exists(select 1 from community_private.review_bans b where b.owner_id=v.owner_id)),
  'my_vote',(select choice from community_private.chart_note_votes v where v.note_id=n.id and v.owner_id=p_viewer and v.revision=n.revision),
  'mine',coalesce(n.owner_id=p_viewer,false),'reviewed',n.reviewed,
  'photo_id',(select f.id from community_private.review_photos f where f.chart_note_id=n.id and f.review_id is null and f.status='approved' and f.review_revision=n.revision limit 1))
 from community_private.chart_notes n where n.id=p_id;
$$;
revoke all on function community_private.chart_note_public(uuid,uuid) from public,anon,authenticated,service_role;

create function public.community_chart_notes(p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
 u uuid:=auth.uid(); n community_private.chart_notes; f community_private.review_photos;
 is_mod boolean; nid uuid; observed date; body_text text; today date:=(clock_timestamp() at time zone 'UTC')::date;
 west double precision;east double precision;south double precision;north double precision;result_body jsonb;
begin
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>16000 then raise exception 'Invalid community note request'; end if;
 if u is not null and (not exists(select 1 from auth.users where id=u) or exists(select 1 from public.account_deletion_jobs where user_id=u)) then
  raise exception 'Account unavailable' using errcode='42501';
 end if;
 if p_action='list' then
  if jsonb_typeof(p_input->'bbox')<>'array' or jsonb_array_length(p_input->'bbox')<>4 then raise exception 'Choose a bounded view'; end if;
  west:=(p_input->'bbox'->>0)::double precision;south:=(p_input->'bbox'->>1)::double precision;
  east:=(p_input->'bbox'->>2)::double precision;north:=(p_input->'bbox'->>3)::double precision;
  if west is null or east is null or south is null or north is null or west not between -180 and 180 or east not between -180 and 180
   or south not between -85 and 85 or north not between -85 and 85 or east<=west or north<=south or east-west>4 or north-south>4 then
   raise exception 'Zoom in for community notes';
  end if;
  with candidates as materialized(
   select q.id,q.created_at from community_private.chart_notes q
   where q.status='visible' and q.expires_at>clock_timestamp() and q.public_consent='publish-pin-and-note-v1'
    and q.latitude between south and north and q.longitude between west and east
    and not exists(select 1 from public.account_deletion_jobs d where d.user_id=q.owner_id)
    and not exists(select 1 from community_private.review_bans b where b.owner_id=q.owner_id)
    and not exists(select 1 from community_private.review_blocks b where b.owner_id=u and b.blocked_id=q.owner_id)
   order by q.created_at desc,q.id limit 151
  ), shown as(select * from candidates order by created_at desc,id limit 150)
  select jsonb_build_object('notes',coalesce((select jsonb_agg(community_private.chart_note_public(s.id,u) order by s.created_at desc,s.id) from shown s),'[]'::jsonb),
   'truncated',(select count(*)>150 from candidates),'server_now',clock_timestamp()) into result_body;
  return result_body;
 end if;
 if u is null or exists(select 1 from auth.users where id=u and is_anonymous) then raise exception 'Sign in required' using errcode='42501'; end if;
 is_mod:=public.is_chat_moderator(u);
 if p_action='queue' then
  if not is_mod then raise exception 'Moderator required' using errcode='42501'; end if;
  select jsonb_build_object('queue',coalesce(jsonb_agg(x.body),'[]'::jsonb),'server_now',clock_timestamp()) into result_body from(
   select jsonb_build_object('id',q.id,'revision',q.revision,'kind',q.kind,'message',q.message,'latitude',q.latitude,'longitude',q.longitude,
    'observed_date',q.observed_date,'expires_at',q.expires_at,'status',q.status,'reason',m.reason,'photo_id',p.id,'photo_revision',p.revision) body
   from community_private.chart_notes q
   left join community_private.chart_note_moderation m on m.note_id=q.id
   left join lateral(select f.id,f.revision from community_private.review_photos f where f.chart_note_id=q.id and f.review_id is null and f.status='pending' order by f.created_at limit 1)p on true
   where q.status<>'removed' and q.expires_at>clock_timestamp()
    and not exists(select 1 from public.account_deletion_jobs d where d.user_id=q.owner_id)
    and not exists(select 1 from community_private.review_bans b where b.owner_id=q.owner_id)
    and(m.note_id is not null or p.id is not null)
   order by coalesce(m.created_at,q.created_at) limit 50
  )x;
  return result_body;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,20260806));
 if not exists(select 1 from auth.users where id=u and not coalesce(is_anonymous,false)) or exists(select 1 from public.account_deletion_jobs where user_id=u) then raise exception 'Account unavailable' using errcode='42501'; end if;
 is_mod:=public.is_chat_moderator(u);
 if p_action='owned' then
  select jsonb_build_object('notes',coalesce(jsonb_agg(x.body),'[]'::jsonb),'server_now',clock_timestamp()) into result_body from(
   select to_jsonb(q)-'owner_id'-'consent_at' body from community_private.chart_notes q where q.owner_id=u order by q.created_at desc limit 50
  )x;
  return result_body;
 end if;
 if p_action='mine' then
  select * into n from community_private.chart_notes where id=(p_input->>'id')::uuid and owner_id=u;
  if n.id is null then return 'null'; end if;
  return jsonb_build_object('note',to_jsonb(n)-'owner_id'-'consent_at'||jsonb_build_object('photo_id',(select id from community_private.review_photos where chart_note_id=n.id and review_id is null and status in('pending','approved') order by created_at desc limit 1)),'server_now',clock_timestamp());
 end if;
 if not is_mod and p_action in('save','report','block') then
  insert into community_private.review_write_quota(owner_id,day,operations) values(u,today,1)
   on conflict(owner_id) do update set day=excluded.day,operations=case when community_private.review_write_quota.day=excluded.day then community_private.review_write_quota.operations+1 else 1 end;
 end if;
 if p_action in('save','vote') and exists(select 1 from community_private.review_bans where owner_id=u) then raise exception 'Posting is suspended' using errcode='42501'; end if;
 if p_action='save' then
  if p_input->>'terms_version' is distinct from '2026-10-17' or p_input->>'public_consent' is distinct from 'publish-pin-and-note-v1' then raise exception 'Explicit consent to publish the pin and note is required'; end if;
  observed:=(p_input->>'observed_date')::date;body_text:=btrim(p_input->>'message');
  if observed is null or observed>today or observed<=today-30 then raise exception 'Choose an observation date in the last 30 days'; end if;
  if body_text is null or length(body_text) not between 1 and 1200 or translate(body_text,chr(9)||chr(10)||chr(13),'')~'[[:cntrl:]]' then raise exception 'Use 1–1200 plain text characters'; end if;
  nid:=nullif(p_input->>'id','')::uuid;
  if nid is null then
   if(select count(*) from community_private.chart_notes where owner_id=u)>=200 then raise exception 'Community note limit reached'; end if;
   insert into community_private.chart_notes(owner_id,kind,latitude,longitude,message,observed_date,expires_at,terms_version,public_consent,status)
   values(u,p_input->>'kind',round((p_input->>'latitude')::numeric,5),round((p_input->>'longitude')::numeric,5),body_text,observed,
    (observed+30)::timestamp at time zone 'UTC','2026-10-17','publish-pin-and-note-v1',case when body_text~*'(kill yourself|heil hitler|buy now|https?://|www\.)' then 'held' else 'visible' end)
   returning * into n;
  else
   select * into n from community_private.chart_notes where id=nid and owner_id=u for update;
   if n.id is null then raise exception 'Owner required' using errcode='42501'; end if;
   if n.revision::text is distinct from p_input->>'revision' then raise exception 'Note changed; reload' using errcode='40001'; end if;
   if n.updated_at>clock_timestamp()-interval '5 seconds' then raise exception 'Please wait before editing'; end if;
   update community_private.chart_notes set kind=p_input->>'kind',latitude=round((p_input->>'latitude')::numeric,5),longitude=round((p_input->>'longitude')::numeric,5),
    message=body_text,observed_date=observed,expires_at=(observed+30)::timestamp at time zone 'UTC',revision=gen_random_uuid(),reviewed=false,
    status=case when status in('held','removed') or body_text~*'(kill yourself|heil hitler|buy now|https?://|www\.)' then 'held' else 'visible' end,
    consent_at=clock_timestamp(),updated_at=clock_timestamp() where id=n.id returning * into n;
   update community_private.review_photos set status='removed',revision=gen_random_uuid() where chart_note_id=n.id;
  end if;
  insert into community_private.chart_note_moderation(note_id,revision,reason) values(n.id,n.revision,case when n.status='held' then 'filter' else 'edit' end)
   on conflict(note_id) do update set revision=excluded.revision,reason=excluded.reason,created_at=now();
  return jsonb_build_object('id',n.id,'revision',n.revision,'status',n.status,'expires_at',n.expires_at,'server_now',clock_timestamp());
 end if;
 nid:=(p_input->>'id')::uuid;
 select * into n from community_private.chart_notes where id=nid;
 if n.id is null then raise exception 'Community note unavailable' using errcode='P0002'; end if;
 if n.owner_id<>u and not pg_try_advisory_xact_lock(hashtextextended(n.owner_id::text,20260806)) then raise exception 'Community note busy; retry' using errcode='40001'; end if;
 select * into n from community_private.chart_notes where id=nid for update;
 if n.id is null or exists(select 1 from public.account_deletion_jobs where user_id=n.owner_id) then raise exception 'Community note unavailable'; end if;
 if p_action='delete' then
  if n.owner_id<>u then raise exception 'Owner required' using errcode='42501'; end if;
  delete from community_private.chart_notes where id=n.id;
  return jsonb_build_object('ok',true,'server_now',clock_timestamp());
 end if;
 if n.status='removed' or n.expires_at<=clock_timestamp() or exists(select 1 from community_private.review_bans where owner_id=n.owner_id) then raise exception 'Community note unavailable'; end if;
 if p_action='vote' then
  if n.owner_id=u or n.status<>'visible' or exists(select 1 from community_private.review_blocks where owner_id=u and blocked_id=n.owner_id) then raise exception 'Voting unavailable'; end if;
  if n.revision::text is distinct from p_input->>'revision' then raise exception 'Note changed; reload' using errcode='40001'; end if;
  if not is_mod then
   insert into community_private.chart_vote_quota(owner_id,day,operations) values(u,today,1)
    on conflict(owner_id) do update set day=excluded.day,operations=case when community_private.chart_vote_quota.day=excluded.day then community_private.chart_vote_quota.operations+1 else 1 end;
  end if;
  if p_input->>'choice'='withdraw' then delete from community_private.chart_note_votes where owner_id=u and note_id=n.id;
  elsif p_input->>'choice' in('confirm','deny') then
   if not exists(select 1 from community_private.chart_note_votes where owner_id=u and note_id=n.id)
    and(select count(*) from community_private.chart_note_votes where note_id=n.id)>=2000 then raise exception 'This note has reached its voting limit'; end if;
   insert into community_private.chart_note_votes(owner_id,note_id,revision,choice) values(u,n.id,n.revision,p_input->>'choice')
    on conflict(owner_id,note_id) do update set revision=excluded.revision,choice=excluded.choice,updated_at=clock_timestamp();
  else raise exception 'Choose confirm, deny or withdraw'; end if;
 elsif p_action='report' then
  if n.owner_id=u then raise exception 'Report unavailable'; end if;
  if(select count(*) from community_private.chart_note_reports where owner_id=u and created_at>now()-interval '1 day')>=20 then raise exception 'Daily report limit reached'; end if;
  insert into community_private.chart_note_reports(owner_id,note_id,reason) values(u,n.id,p_input->>'reason') on conflict do nothing;
  update community_private.chart_notes set status='held',revision=gen_random_uuid(),reviewed=false where id=n.id returning * into n;
  update community_private.review_photos set status=case when status='approved' then 'pending' else status end,revision=gen_random_uuid() where chart_note_id=n.id;
  insert into community_private.chart_note_moderation values(n.id,n.revision,'report',now())
   on conflict(note_id) do update set revision=excluded.revision,reason='report',created_at=now();
 elsif p_action='block' then
  if n.owner_id=u then raise exception 'Cannot block yourself'; end if;
  if(select count(*) from community_private.review_blocks where owner_id=u)>=500 then raise exception 'Block limit reached'; end if;
  insert into community_private.review_blocks values(u,n.owner_id) on conflict do nothing;
 elsif p_action='moderate' then
  if not public.is_chat_moderator(u) then raise exception 'Moderator required' using errcode='42501'; end if;
  if n.revision::text is distinct from p_input->>'revision' then raise exception 'Note changed; reload queue' using errcode='40001'; end if;
  if p_input->>'decision'='ban' then
   insert into community_private.review_bans(owner_id) values(n.owner_id) on conflict do nothing;
   update community_private.chart_notes set status='removed',revision=gen_random_uuid() where owner_id=n.owner_id;
   update community_private.place_reviews set status='removed',revision=gen_random_uuid() where owner_id=n.owner_id;
   update community_private.review_photos set status='removed',revision=gen_random_uuid() where owner_id=n.owner_id;
   delete from community_private.chart_note_moderation where note_id in(select id from community_private.chart_notes where owner_id=n.owner_id);
   delete from community_private.review_moderation where review_id in(select id from community_private.place_reviews where owner_id=n.owner_id);
  elsif p_input->>'decision' in('approve','remove') then
   update community_private.chart_notes set status=case when p_input->>'decision'='approve' then 'visible' else 'removed' end,reviewed=true where id=n.id;
   if p_input->>'decision'='remove' then update community_private.review_photos set status='removed',revision=gen_random_uuid() where chart_note_id=n.id;end if;
   delete from community_private.chart_note_moderation where note_id=n.id;
  elsif p_input->>'decision' in('approve-photo','remove-photo') then
   select * into f from community_private.review_photos where id=(p_input->>'photo_id')::uuid and chart_note_id=n.id and review_id is null for update;
   if f.id is null or f.status<>'pending' or f.revision::text is distinct from p_input->>'photo_revision' then raise exception 'Photo changed; reload queue' using errcode='40001'; end if;
   update community_private.review_photos set status=case when p_input->>'decision'='approve-photo' then 'approved' else 'removed' end,review_revision=n.revision,revision=gen_random_uuid() where id=f.id;
  else raise exception 'Invalid moderation decision';end if;
 else raise exception 'Invalid community note action';end if;
 return jsonb_build_object('ok',true,'server_now',clock_timestamp());
end $$;
revoke all on function public.community_chart_notes(text,jsonb) from public;
grant execute on function public.community_chart_notes(text,jsonb) to anon,authenticated;

create function public.community_chart_photo(p_action text,p_user uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare n community_private.chart_notes;f community_private.review_photos;pid uuid;is_mod boolean;
begin
 if p_user is null or not exists(select 1 from auth.users where id=p_user and not coalesce(is_anonymous,false))
  or exists(select 1 from public.account_deletion_jobs where user_id=p_user) then raise exception 'Account unavailable' using errcode='42501';end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>2000 then raise exception 'Invalid photo request';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,20260806));
 if not exists(select 1 from auth.users where id=p_user and not coalesce(is_anonymous,false))
  or exists(select 1 from public.account_deletion_jobs where user_id=p_user) then raise exception 'Account unavailable' using errcode='42501';end if;
 if p_action='reserve' then
  select * into n from community_private.chart_notes where id=(p_input->>'note_id')::uuid and owner_id=p_user for update;
  if n.id is null or n.status='removed' or n.expires_at<=clock_timestamp() or n.revision::text is distinct from p_input->>'revision'
   or exists(select 1 from community_private.review_bans where owner_id=p_user) then raise exception 'Community note unavailable';end if;
  if(select count(*) from community_private.review_photos where owner_id=p_user)>=40 then raise exception 'Photo quota reached; contact support';end if;
  update community_private.review_photos set status='removed',revision=gen_random_uuid() where chart_note_id=n.id;
  pid:=gen_random_uuid();
  insert into community_private.review_photos(id,owner_id,chart_note_id,review_revision,object_path)values(pid,p_user,n.id,n.revision,p_user::text||'/'||pid::text||'.jpg')returning * into f;
 elsif p_action in('finish','access') then
  select * into f from community_private.review_photos where id=(p_input->>'id')::uuid and review_id is null and chart_note_id is not null;
  select * into n from community_private.chart_notes where id=f.chart_note_id;
  if f.id is null or n.id is null or n.status='removed' or exists(select 1 from public.account_deletion_jobs where user_id=n.owner_id)
   or exists(select 1 from community_private.review_bans where owner_id=n.owner_id)then raise exception 'Photo unavailable' using errcode='42501';end if;
  if p_action='finish' then
   if f.owner_id<>p_user then raise exception 'Owner required' using errcode='42501';end if;
   select * into n from community_private.chart_notes where id=f.chart_note_id for update;
   select * into f from community_private.review_photos where id=f.id and review_id is null and chart_note_id=n.id for update;
   if f.id is null or n.id is null or f.status<>'uploading' or f.review_revision<>n.revision or n.status='removed' or n.expires_at<=clock_timestamp()then raise exception 'Upload retired';end if;
   if (p_input->>'bytes') is null or (p_input->>'bytes')::integer not between 1 and 1048576 or coalesce(p_input->>'digest','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid photo metadata';end if;
   update community_private.review_photos set status='pending',bytes=(p_input->>'bytes')::integer,digest=p_input->>'digest',revision=gen_random_uuid() where id=f.id returning * into f;
  else
   is_mod:=public.is_chat_moderator(p_user);
   if not(f.owner_id=p_user or is_mod or(f.status='approved' and n.status='visible' and n.expires_at>clock_timestamp() and f.review_revision=n.revision))
    or f.status not in('pending','approved') or f.bytes is null
    or(not is_mod and f.owner_id<>p_user and exists(select 1 from community_private.review_blocks where owner_id=p_user and blocked_id=f.owner_id))
    then raise exception 'Photo unavailable' using errcode='42501';end if;
  end if;
 else raise exception 'Invalid photo action';end if;
 return jsonb_build_object('id',f.id,'path',f.object_path,'revision',f.revision,'note_revision',n.revision,'status',f.status,'bytes',f.bytes,'digest',f.digest);
end $$;
revoke all on function public.community_chart_photo(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.community_chart_photo(text,uuid,jsonb) to service_role;


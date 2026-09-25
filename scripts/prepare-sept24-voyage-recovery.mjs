// Prepare only. The generated rollback/apply SQL must be reviewed separately.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
assert.ok(dir?.includes('/thalassa-sept24-recovery-'));
const save=(name,data)=>writeFileSync(join(dir,name),typeof data==='string'?data:JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
const read=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const owner='a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const boat='8b364a98-86f6-4a5c-9f9a-5793d1a8ee39';
const originals=['voyage_1790198654824_u3f2yihih','voyage_1790206946135_uowiwphxt'];
const recovered='voyage_recovered_pi_20260924_butterfly_daydream';
const lit=s=>`'${String(s).replaceAll("'","''")}'`;
const ids=originals.map(lit).join(',');
const scoped=`user_id='${owner}' AND boat_id='${boat}' AND voyage_id IN (${ids})`;
const q=sql=>{const out=execFileSync('/opt/homebrew/bin/supabase',['db','query','--linked',sql,'--output','json'],{encoding:'utf8',maxBuffer:32*1024*1024});return JSON.parse(out.slice(out.indexOf('{'))).rows;};
const digest=`(SELECT md5(string_agg((to_jsonb(s)-'archived')::text,'' ORDER BY id)) FROM public.ship_logs s WHERE ${scoped})`;
const otherDigest=`(SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE user_id='${owner}' AND voyage_id NOT IN (${ids},'${recovered}'))`;
const before=q(`BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SELECT ${digest} AS digest, ${otherDigest} AS other_digest,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY timestamp,id) FROM public.ship_logs s WHERE ${scoped}) AS logs,
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM public.live_track l WHERE ${scoped}) AS live_tail,
 (SELECT count(*) FROM public.voyage_log_hidden_voyages WHERE user_id='${owner}' AND voyage_id IN (${ids})) AS hidden,
 (SELECT count(*) FROM public.live_track_retirements WHERE user_id='${owner}' AND voyage_id IN (${ids},'${recovered}')) AS retired,
 (SELECT count(*) FROM public.voyage_plan_links WHERE user_id='${owner}' AND voyage_id IN (${ids})) AS links,
 (SELECT count(*) FROM public.log_passage_memberships WHERE user_id='${owner}' AND voyage_id IN (${ids})) AS memberships,
 (SELECT count(*) FROM public.diary_entries WHERE user_id='${owner}' AND voyage_id IN (${ids})) AS diaries,
 (SELECT count(*) FROM public.ship_logs WHERE user_id='${owner}' AND voyage_id='${recovered}') AS existing; COMMIT;`)[0];
assert.deepEqual(before.logs,read('cloud-before.json').logs,'Source records changed: audit again');
for(const key of ['hidden','retired','links','memberships','diaries','existing'])assert.equal(before[key],0,key);
assert.equal(before.logs.length,3560);
assert.ok(before.logs.every(x=>x.archived===false&&x.user_id===owner&&x.boat_id===boat&&!x.linked_plan_id&&!x.saved_route_id));
for(const id of originals){const logs=before.logs.filter(x=>x.voyage_id===id);assert.equal(logs.at(-1).waypoint_name,'Voyage End');}
save('verified-cloud-before.json',before);
const pi=read('pi-original-samples.json');
const hash=createHash('sha256').update(readFileSync(join(dir,'pi-original-samples.json'))).digest('hex');
const start=Date.parse('2026-09-23T22:43:30Z'),end=Date.parse('2026-09-24T01:24:00Z');
const fixes=pi.filter(p=>p.at_ms>=start&&p.at_ms<=end).map(p=>({timestamp:new Date(p.at_ms).toISOString(),latitude:p.lat,longitude:p.lon,speed_kts:p.sog_kts,course_deg:p.cog_deg,wind_speed:p.tws_kts,wind_direction:Number.isFinite(p.twd_deg)?['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(((p.twd_deg%360+360)%360)/22.5)%16]:null,water_temp:p.water_temp_c,pressure:p.pressure_hpa,client_operation_id:`recover_pi_20260924_row_${p.source_rowid}`}));
assert.equal(fixes.length,797);
const lastMoving=fixes.at(-2),last=fixes.at(-1);
assert.equal(new Date(lastMoving.timestamp).toISOString().slice(11,16),'01:22');
assert.equal(new Date(last.timestamp).toISOString().slice(11,16),'01:23');
const supplemental=before.logs.filter(p=>p.entry_type==='auto'&&Date.parse(p.timestamp)>Date.parse(lastMoving.timestamp)&&Date.parse(p.timestamp)<Date.parse(last.timestamp));
assert.ok(supplemental.length>=15&&supplemental.length<=30);
for(const p of supplemental)fixes.push({timestamp:p.timestamp,latitude:p.latitude,longitude:p.longitude,speed_kts:p.speed_kts,course_deg:p.course_deg,wind_speed:p.wind_speed,wind_direction:p.wind_direction,water_temp:p.water_temp,pressure:p.pressure,client_operation_id:`recover_app_20260924_${p.id}`});
fixes.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
assert.equal(new Set(fixes.map(p=>Date.parse(p.timestamp))).size,fixes.length);
const rad=n=>n*Math.PI/180;
const nm=(a,b)=>3440.065*2*Math.asin(Math.sqrt(Math.min(1,Math.sin(rad(b.latitude-a.latitude)/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(rad(b.longitude-a.longitude)/2)**2)));
let distance=0,maxGap=0,maxSpeed=0;
const provenance=`Recovered Butterfly Bay → Daydream Island on 24 September 2026 from original onboard Pi observations, with ${supplemental.length} original app GPS fixes filling the final berthing interval. No positions or timestamps interpolated. Departure/arrival are GPS-estimated boundaries, not manually logged events. Pi source SHA256 ${hash}. Supersedes archived recordings ${originals.join(' and ')}; originals retained unchanged except archive status. Distances derived between recorded fixes.`;
const rows=fixes.map((p,i)=>{assert.ok(Number.isFinite(p.latitude)&&Number.isFinite(p.longitude));const prev=fixes[i-1];const leg=prev?nm(prev,p):0;const gap=prev?Date.parse(p.timestamp)-Date.parse(prev.timestamp):0;maxGap=Math.max(maxGap,gap);if(gap)maxSpeed=Math.max(maxSpeed,leg/(gap/3600000));distance+=leg;return{...p,distance_nm:leg,cumulative_distance_nm:distance,entry_type:i===0||i===fixes.length-1?'waypoint':'auto',waypoint_name:i===0?'Butterfly Bay · recovered departure':i===fixes.length-1?'Daydream Island · recovered arrival':null,notes:i===0?provenance:null};});
assert.ok(distance>15&&distance<16);assert.ok(maxGap<=45000);assert.ok(maxSpeed<12);
const manifest={owner,boat,recovered,originals,sourceSha256:hash,piCount:797,appCount:supplemental.length,count:rows.length,start:rows[0].timestamp,end:rows.at(-1).timestamp,distanceNm:distance,maxGapMs:maxGap,maxDerivedSpeedKts:maxSpeed,provenance};
save('recovered-samples.json',rows);save('manifest.json',manifest);
const sql=`BEGIN;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';
CREATE TEMP TABLE recovered_samples ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(${lit(JSON.stringify(rows))}::jsonb) AS x(timestamp timestamptz,latitude double precision,longitude double precision,speed_kts double precision,course_deg double precision,wind_speed double precision,wind_direction text,water_temp double precision,pressure double precision,client_operation_id text,distance_nm double precision,cumulative_distance_nm double precision,entry_type text,waypoint_name text,notes text);
GRANT SELECT ON recovered_samples TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub='${owner}'; SET LOCAL request.jwt.claim.role='authenticated';
DO $preflight$ BEGIN
 IF auth.uid() IS DISTINCT FROM '${owner}'::uuid THEN RAISE EXCEPTION 'Owner mismatch'; END IF;
 PERFORM id FROM public.ship_logs WHERE ${scoped} FOR UPDATE;
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scoped})<>3560 OR ${digest} IS DISTINCT FROM '${before.digest}' OR EXISTS(SELECT 1 FROM public.ship_logs WHERE ${scoped} AND archived IS DISTINCT FROM false) THEN RAISE EXCEPTION 'Originals changed since backup'; END IF;
 IF ${otherDigest} IS DISTINCT FROM '${before.other_digest}' THEN RAISE EXCEPTION 'Other voyage history changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.ship_logs WHERE user_id='${owner}' AND voyage_id='${recovered}') THEN RAISE EXCEPTION 'Already recovered: verify instead of reapply'; END IF;
 IF EXISTS(SELECT 1 FROM public.live_track_retirements WHERE user_id='${owner}' AND voyage_id IN (${ids},'${recovered}')) OR EXISTS(SELECT 1 FROM public.voyage_log_hidden_voyages WHERE user_id='${owner}' AND voyage_id IN (${ids})) THEN RAISE EXCEPTION 'Privacy/retirement changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.diary_entries WHERE user_id='${owner}' AND voyage_id IN (${ids})) OR EXISTS(SELECT 1 FROM public.voyage_plan_links WHERE user_id='${owner}' AND voyage_id IN (${ids})) OR EXISTS(SELECT 1 FROM public.log_passage_memberships WHERE user_id='${owner}' AND voyage_id IN (${ids})) THEN RAISE EXCEPTION 'Original links changed'; END IF;
END $preflight$;
INSERT INTO public.ship_logs(user_id,boat_id,voyage_id,timestamp,latitude,longitude,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,client_operation_id,distance_nm,cumulative_distance_nm,entry_type,waypoint_name,notes,source,archived,is_on_water)
SELECT '${owner}'::uuid,'${boat}'::uuid,'${recovered}',timestamp,latitude,longitude,speed_kts,course_deg,wind_speed,wind_direction,water_temp,pressure,client_operation_id,distance_nm,cumulative_distance_nm,entry_type,waypoint_name,notes,'device',false,NULL FROM recovered_samples ORDER BY timestamp
ON CONFLICT(user_id,client_operation_id) DO NOTHING;
UPDATE public.ship_logs SET archived=true WHERE ${scoped} AND archived=false;
DO $verify$ BEGIN
 IF (SELECT count(*) FROM public.ship_logs WHERE user_id='${owner}' AND boat_id='${boat}' AND voyage_id='${recovered}')<>${rows.length} THEN RAISE EXCEPTION 'Recovery count mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM recovered_samples r LEFT JOIN public.ship_logs s ON s.user_id='${owner}' AND s.client_operation_id=r.client_operation_id WHERE s.id IS NULL OR s.voyage_id IS DISTINCT FROM '${recovered}' OR s.timestamp IS DISTINCT FROM r.timestamp OR s.latitude IS DISTINCT FROM r.latitude OR s.longitude IS DISTINCT FROM r.longitude OR abs(s.cumulative_distance_nm-r.cumulative_distance_nm)>0.00001) THEN RAISE EXCEPTION 'Recovered measurements mismatch'; END IF;
 IF (SELECT count(*) FROM public.ship_logs WHERE ${scoped} AND archived=true)<>3560 OR ${digest} IS DISTINCT FROM '${before.digest}' THEN RAISE EXCEPTION 'Original records were not preserved'; END IF;
 IF ${otherDigest} IS DISTINCT FROM '${before.other_digest}' THEN RAISE EXCEPTION 'Unrelated history changed'; END IF;
 IF (SELECT count(*) FROM public.live_track_retirements WHERE user_id='${owner}' AND voyage_id IN (${ids}) AND reason='archived')<>2 THEN RAISE EXCEPTION 'Original public tails not retired'; END IF;
 IF EXISTS(SELECT 1 FROM public.live_track WHERE ${scoped}) THEN RAISE EXCEPTION 'Original live tails remain'; END IF;
END $verify$;
SELECT * FROM public.get_voyage_summaries(false) WHERE voyage_id='${recovered}';
RESET ROLE;
`;
save('dry-run.sql',sql+'ROLLBACK;\n');save('apply.sql',sql+'COMMIT;\n');
console.log(JSON.stringify(manifest,null,2));

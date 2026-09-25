// Read-only investigation and private backups for the requested Sep 24 recovery.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'thalassa-sept24-recovery-'));
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value), {mode:0o600,flag:'wx'});
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const remote = `const D=require('better-sqlite3');const db=new D('cache/track/track.db',{readonly:true,fileMustExist:true});db.pragma('query_only=ON');console.log(JSON.stringify(db.prepare('SELECT rowid AS source_rowid,* FROM track_points WHERE at_ms>=? ORDER BY at_ms,rowid').all(Date.parse('2026-09-23T14:00:00Z'))));db.close();`;
const pi=JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=12','shanes@100.86.90.84',`cd /opt/thalassa-pi-cache && node -e ${quote(remote)}`],{encoding:'utf8',maxBuffer:32*1024*1024}));
save('pi-original-samples.json',pi);
const owner='a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const sql=`BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SELECT
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY timestamp,id) FROM public.ship_logs s WHERE user_id='${owner}' AND voyage_id IN ('voyage_1790198654824_u3f2yihih','voyage_1790206946135_uowiwphxt')) AS logs,
 (SELECT jsonb_agg(to_jsonb(r)) FROM public.live_track_retirements r WHERE user_id='${owner}') AS retirements,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'voyage_id',voyage_id)) FROM public.diary_entries WHERE user_id='${owner}' AND voyage_id IN ('voyage_1790198654824_u3f2yihih','voyage_1790206946135_uowiwphxt')) AS diaries; COMMIT;`;
const raw=execFileSync('/opt/homebrew/bin/supabase',['db','query','--linked',sql,'--output','json'],{encoding:'utf8',maxBuffer:32*1024*1024});
const cloud=JSON.parse(raw.slice(raw.indexOf('{'))).rows[0];
save('cloud-before.json',cloud);
const local=ms=>new Date(Number(ms)+10*3600000).toISOString().slice(0,19);
const pick=p=>({time:local(p.at_ms),lat:p.lat,lon:p.lon,sog:p.sog_kts});
const hours={};
for(const p of pi){const h=local(p.at_ms).slice(0,13);const b=hours[h]??={n:0,first:pick(p),last:null,maxSpeed:0};b.n++;b.last=pick(p);b.maxSpeed=Math.max(b.maxSpeed,p.sog_kts??0);}
const voyages={};
for(const p of cloud.logs){const b=voyages[p.voyage_id]??={n:0,first:p,last:null,waypoints:[]};b.n++;b.last=p;if(p.entry_type==='waypoint')b.waypoints.push({time:p.timestamp,name:p.waypoint_name,notes:p.notes,lat:p.latitude,lon:p.longitude});}
const brief=p=>({id:p.id,time:p.timestamp,lat:p.latitude,lon:p.longitude,speed:p.speed_kts,source:p.source,nm:p.cumulative_distance_nm,archived:p.archived});
console.log(JSON.stringify({directory:dir,piCount:pi.length,hours,voyages:Object.fromEntries(Object.entries(voyages).map(([k,v])=>[k,{...v,first:brief(v.first),last:brief(v.last)}])),retirements:cloud.retirements?.filter(r=>r.voyage_id in voyages),diaries:cloud.diaries},null,2));

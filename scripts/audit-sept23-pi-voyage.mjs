// Read-only audit and private backups for the requested Tongue Bay departure recovery.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'thalassa-sept23-recovery-'));
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const owner = 'a4dbb302-d4ab-43a5-881f-737e9c56d50c';
const boat = '8b364a98-86f6-4a5c-9f9a-5793d1a8ee39';
const voyage = 'voyage_1790124398484_ykoyqfm54';
const scope = `user_id='${owner}' AND boat_id='${boat}' AND voyage_id='${voyage}'`;
const remote = `const D=require('better-sqlite3');const db=new D('cache/track/track.db',{readonly:true,fileMustExist:true});db.pragma('query_only=ON');console.log(JSON.stringify(db.prepare('SELECT rowid AS source_rowid,* FROM track_points WHERE at_ms>=? AND at_ms<? ORDER BY at_ms,rowid').all(Date.parse('2026-09-22T14:00:00Z'),Date.parse('2026-09-23T14:00:00Z'))));db.close();`;
const pi = JSON.parse(
    execFileSync(
        'ssh',
        [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=12',
            'shanes@100.86.90.84',
            `cd /opt/thalassa-pi-cache && node -e ${quote(remote)}`,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ),
);
save('pi-original-samples.json', pi);
const sql = `BEGIN READ ONLY; SET LOCAL statement_timeout='60s'; SELECT
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY timestamp,id) FROM public.ship_logs s WHERE ${scope}) AS logs,
 (SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE ${scope}) AS digest,
 (SELECT md5(string_agg(to_jsonb(s)::text,'' ORDER BY id)) FROM public.ship_logs s WHERE user_id='${owner}' AND voyage_id IS DISTINCT FROM '${voyage}') AS other_digest,
 (SELECT jsonb_agg(to_jsonb(r)) FROM public.live_track_retirements r WHERE user_id='${owner}' AND voyage_id='${voyage}') AS retirements,
 (SELECT jsonb_agg(to_jsonb(l)) FROM public.live_track l WHERE ${scope}) AS live_tail,
 (SELECT jsonb_agg(to_jsonb(h)) FROM public.voyage_log_hidden_voyages h WHERE user_id='${owner}' AND voyage_id='${voyage}') AS hidden,
 (SELECT jsonb_agg(to_jsonb(l)) FROM public.voyage_plan_links l WHERE user_id='${owner}' AND voyage_id='${voyage}') AS links,
 (SELECT jsonb_agg(to_jsonb(m)) FROM public.log_passage_memberships m WHERE user_id='${owner}' AND voyage_id='${voyage}') AS memberships,
 (SELECT jsonb_agg(to_jsonb(d)) FROM public.diary_entries d WHERE user_id='${owner}' AND voyage_id='${voyage}') AS diaries; COMMIT;`;
const raw = execFileSync('/opt/homebrew/bin/supabase', ['db', 'query', '--linked', sql, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
});
const cloud = JSON.parse(raw.slice(raw.indexOf('{'))).rows[0];
save('cloud-before.json', cloud);
const local = (ms) => new Date(Number(ms) + 10 * 3600000).toISOString().slice(0, 19);
const brief = (p) => ({ time: local(p.at_ms), lat: p.lat, lon: p.lon, sog: p.sog_kts });
const hours = {};
for (const p of pi) {
    const h = local(p.at_ms).slice(0, 13);
    const bucket = (hours[h] ??= { n: 0, first: brief(p), last: null, maxSpeed: 0 });
    bucket.n += 1;
    bucket.last = brief(p);
    bucket.maxSpeed = Math.max(bucket.maxSpeed, p.sog_kts ?? 0);
}
console.log(
    JSON.stringify(
        {
            directory: dir,
            owner,
            boat,
            voyage,
            piCount: pi.length,
            piHash: createHash('sha256').update(JSON.stringify(pi)).digest('hex'),
            hours,
            cloud: {
                count: cloud.logs?.length,
                first: cloud.logs?.[0],
                last: cloud.logs?.at(-1),
                retirements: cloud.retirements,
                hidden: cloud.hidden,
                links: cloud.links,
                memberships: cloud.memberships,
                diaryCount: cloud.diaries?.length ?? 0,
            },
        },
        null,
        2,
    ),
);

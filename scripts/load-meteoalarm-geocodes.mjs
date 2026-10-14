/**
 * Load MeteoAlarm's EMMA_ID outlines into official_alert_zones (129-05b), so
 * a European warning that names areas, not a polygon, can be placed.
 *
 * The outlines are the Redistribution Hub's Geocodes JSON
 * (https://meteoalarm.org/en/live/page/redistribution-hub), 33 MB: too big for
 * an edge function, so this runs on a computer with the service key. It reads
 * the file, simplifies each outline to about 100 m
 * (supabase/functions/_shared/official-alerts/geocodes.ts), and calls
 * official_alert_zones_sync() for each country: an outline that changed is
 * written, one the file no longer lists is removed, a new one is added. It
 * refuses to remove more than half of a country's outlines unless
 * --allow-removal is given (the hub's change log removes whole countries now
 * and then; a truncated download must never look like that).
 *
 * The outlines are EUMETNET's "Content": they place warnings only, are
 * credited "Areas: EUMETNET – MeteoAlarm" in the app, and are never copied
 * into this repository.
 *
 * Shane, after the held 20261014150000 migration is released and pushed:
 *   1. Download the hub's newest Geocodes JSON (the "Geocodes (in .json
 *      format)" link; 2026-10-14: MeteoAlarm_Geocodes_2026_07_31.json).
 *   2. node scripts/load-meteoalarm-geocodes.mjs --file <that file> --dry-run
 *   3. SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *        node scripts/load-meteoalarm-geocodes.mjs --file <that file>
 * When the hub's change log moves:
 *      node scripts/load-meteoalarm-geocodes.mjs --check
 *   says whether the hub lists a newer file than the one loaded; then 1-3 again
 *   with that file (and --allow-removal only when the change log says outlines
 *   were removed).
 * Node 22.18 or newer (it imports the shared TypeScript, types stripped).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
    METEOALARM_GEOCODES_FILE,
    meteoAlarmGeocodeZones,
    planZoneSync,
    zoneSyncCalls,
} from '../supabase/functions/_shared/official-alerts/geocodes.ts';

const HUB = 'https://cms-visualization.meteoalarm.org/api/v1/content-pages/redistribution-hub?locale=en';
const RAW = 'https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/';
const USER_AGENT = 'Thalassa official warnings (+https://thalassawx.com)';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};

/** The newest Geocodes JSON the hub's page links to, by the date in its name. */
async function newestOnHub() {
    const res = await fetch(HUB, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`the hub answered HTTP ${res.status}`);
    const names = [...(await res.text()).matchAll(/MeteoAlarm_Geocodes_\d{4}_\d{2}_\d{2}\.json/g)].map((m) => m[0]);
    if (names.length === 0) throw new Error('the hub lists no Geocodes JSON');
    return names.sort().at(-1);
}

async function rest(path, init = {}) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run).');
    const res = await fetch(new URL(path, url), {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
}

/** Each MeteoAlarm provider's EMMA_ID codes in official_alert_zones now, a page at a time. */
async function currentZones() {
    const out = new Map();
    for (const p of await rest('/rest/v1/official_alert_providers?select=id&adapter=eq.meteoalarm')) {
        out.set(p.id, new Set());
    }
    for (let from = 0; ; from += 1000) {
        const rows = await rest(
            `/rest/v1/official_alert_zones?select=provider_id,code&code=like.EMMA_ID:*&order=provider_id,code&offset=${from}&limit=1000`,
        );
        for (const r of rows) out.get(r.provider_id)?.add(r.code);
        if (rows.length < 1000) return out;
    }
}

if (flag('--check')) {
    const newest = await newestOnHub();
    console.log(`Loaded with 129-05b: ${METEOALARM_GEOCODES_FILE}. Newest on the hub: ${newest}.`);
    if (newest > METEOALARM_GEOCODES_FILE) {
        console.log('The hub has a newer file: load it, and update METEOALARM_GEOCODES_FILE in geocodes.ts.');
        process.exit(2);
    }
    process.exit(0);
}

const file = option('--file');
if (!file) {
    console.error(
        'Usage: node scripts/load-meteoalarm-geocodes.mjs --file <MeteoAlarm_Geocodes_YYYY_MM_DD.json> [--dry-run] [--allow-removal] | --check',
    );
    process.exit(64);
}
const name = basename(file);
if (!/^MeteoAlarm_Geocodes_\d{4}_\d{2}_\d{2}\.json$/.test(name)) {
    throw new Error(`${name} is not named as the hub names its Geocodes JSON (MeteoAlarm_Geocodes_YYYY_MM_DD.json)`);
}
const loaded = meteoAlarmGeocodeZones(JSON.parse(await readFile(file, 'utf8')), `${RAW}${name}`);
if (!loaded) throw new Error(`${name} is not a GeoJSON FeatureCollection`);
const dryRun = flag('--dry-run');
// A dry run with no database named plans against an empty table.
const offline = dryRun && !process.env.SUPABASE_URL;
const current = offline ? new Map() : await currentZones();
const plan = planZoneSync(current, loaded.byProvider, { allowRemoval: flag('--allow-removal') });

let vertices = 0;
for (const p of plan) {
    const v = p.zones.reduce((s, z) => s + z.geometry.flat(2).length, 0);
    vertices += v;
    const known = offline || current.has(p.provider) ? '' : '  (no such provider: skipped)';
    console.log(
        `${p.provider.padEnd(16)} ${String(p.zones.length).padStart(4)} outlines, ${String(v).padStart(6)} vertices, ` +
            `${p.remove.length} to remove${p.refuse ? `  REFUSED: ${p.refuse}` : ''}${known}`,
    );
}
console.log(
    `${name}: ${plan.length} providers, ${vertices} vertices after simplifying, ${loaded.skipped} features skipped.`,
);
if (plan.some((p) => p.refuse)) {
    console.error('Nothing loaded: a country would lose more than half its outlines (see REFUSED above).');
    process.exit(1);
}
if (dryRun) process.exit(0);

let written = 0;
let removed = 0;
for (const p of plan) {
    if (!current.has(p.provider)) continue;
    for (const call of zoneSyncCalls(p.provider, p.zones)) {
        const r = await rest('/rest/v1/rpc/official_alert_zones_sync', { method: 'POST', body: JSON.stringify(call) });
        written += r.zones ?? 0;
        removed += r.removed ?? 0;
    }
}
console.log(`Done: ${written} outlines written (new or changed), ${removed} removed.`);

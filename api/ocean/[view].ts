/**
 * /api/ocean/{summary,rows} — the public read behind ocean.thalassawx.app.
 *
 * WHY AN EDGE FUNCTION and not the page calling PostgREST itself: Vercel's
 * CDN caches the answer (s-maxage=120), so a busy day costs the database a
 * handful of reads, not one per visitor; and the summary itself is a one-row
 * snapshot pg_cron refreshes every 5 minutes, so even a cache miss is one
 * indexed read. Caching can only make the data LATER, never earlier, so the
 * 3-hour public delay still holds. A deleted or newly private sighting
 * leaves the page within about 10 minutes (5 min snapshot + 2 min fresh + 2
 * min stale-while-revalidate + 1 min in the browser).
 *
 * ONE HOST: only ocean.thalassawx.app (and local previews, and Vercel's own
 * deployment hosts) may ask. Every boat's <handle>.thalassawx.app reaches
 * /api too, so without this a loop over random labels would get a fresh CDN
 * cache key, and a database call, every time.
 *
 * WHAT IT MAY SAY: only what get_ocean_summary / get_ocean_sightings return
 * (supabase/migrations/20261006120000_ocean_public_read.sql), which is never
 * more than get_public_sightings shows a signed-in stranger (3 h late, on a
 * 1 km grid, no fish, no photos, notes, observer, boat or voyage), and less
 * for blurred rows: they are never individual records here, only counts. On
 * top of that this function WHITELISTS every key it passes on, and drops any
 * blurred row it is handed, so a future SQL change cannot widen the public
 * payload without a code change here.
 *
 * Same-origin only (no CORS header). GET and HEAD only. Unknown query keys,
 * long queries and boxes over 10 degrees are refused before the database is
 * asked. The key is the PUBLISHABLE one, checked by shape; a secret key is
 * never sent.
 */

export const config = { runtime: 'edge' };

const OK_CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=120';
const NOT_READY_CACHE = 'public, max-age=30, s-maxage=60';
const SUMMARY_MAX_BYTES = 4 * 1024 * 1024;
const ROWS_MAX_BYTES = 512 * 1024;
const ROWS_PAGE = 200;
const MAX_QUERY_CHARS = 200;
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Taxon groups the public may see. Fish are never public (a CHECK says so too). */
export const PUBLIC_GROUPS = Object.freeze(['whale', 'dolphin', 'dugong', 'turtle', 'seabird', 'shark_ray', 'other']);
const GROUPS = new Set(PUBLIC_GROUPS);

export const SUMMARY_KEYS = Object.freeze([
    'v',
    'status',
    'generated_at',
    'delay_hours',
    'grid',
    'totals',
    'groups',
    'cells',
    'cells_truncated',
    'species',
    'recent',
]);
export const ROW_KEYS = Object.freeze([
    'id',
    'group',
    'sci',
    'name',
    'rank',
    'count',
    'calf',
    'time',
    'lat',
    'lon',
    'uncertainty_m',
    'generalised',
    'credit',
]);
const TOTAL_KEYS = ['sightings', 'animals', 'species', 'boats', 'boats_min_shown', 'first_time', 'last_time'];
const GRID_KEYS = ['fine_deg', 'coarse_deg', 'cell_deg'];
const SPECIES_KEYS = ['sci', 'name', 'group', 'generalised', 'n', 'animals', 'months', 'hours', 'years', 'sst'];
const ROWS_QUERY_KEYS = new Set(['s', 'w', 'n', 'e', 'before', 'before_id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT = /^-?\d{1,3}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** At least 3 boats before a count is shown, so one boat can't be counted out. */
const BOATS_MIN_SHOWN = 3;

/**
 * Hosts that may ask: the page's own, local previews (vite dev/preview and
 * the Playwright run), and Vercel's deployment hosts (finite, not wildcard).
 */
export function allowedHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return (
        host === 'ocean.thalassawx.app' ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        /^[a-z0-9-]+\.vercel\.app$/.test(host)
    );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Env = Record<string, string | undefined>;

function json(body: unknown, status: number, cache: string, head = false): Response {
    return new Response(head ? null : JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': cache,
            'x-content-type-options': 'nosniff',
        },
    });
}

const refuse = (message: string, status = 400, head = false) => json({ error: message }, status, 'no-store', head);

function processEnv(): Env {
    const g = globalThis as { process?: { env?: Env } };
    return g.process?.env ?? {};
}

/**
 * The publishable key, or null. A new-format key is sb_publishable_…; a
 * legacy key is a JWT whose role is anon. Anything else (a secret key, a
 * service-role JWT, a typo) is refused, so this function can never act with
 * more than the public's rights.
 */
export function publishableKey(raw: string | undefined): string | null {
    const key = String(raw ?? '').trim();
    if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return key;
    const parts = key.split('.');
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { role?: unknown };
        return payload?.role === 'anon' ? key : null;
    } catch {
        return null;
    }
}

export function upstreamConfig(env: Env = processEnv()): { url: string; key: string } | null {
    const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '')
        .trim()
        .replace(/\/+$/, '');
    const key = publishableKey(env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_KEY);
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) return null;
    return { url, key };
}

export interface RowsQuery {
    p_south: number;
    p_west: number;
    p_north: number;
    p_east: number;
    p_before: string | null;
    p_before_id: string | null;
}

/** Parse and bound a rows query, or say why not. Whole degrees, at most 10 each way. */
export function parseRowsQuery(params: URLSearchParams): RowsQuery | string {
    for (const key of params.keys()) if (!ROWS_QUERY_KEYS.has(key)) return `unknown parameter ${key}`;
    const ints: number[] = [];
    for (const key of ['s', 'w', 'n', 'e']) {
        const raw = params.get(key);
        if (raw === null || !INT.test(raw)) return `${key} must be a whole number of degrees`;
        ints.push(Number(raw));
    }
    const [s, w, n, e] = ints;
    if (s < -90 || n > 90 || s >= n) return 'need -90 <= s < n <= 90';
    if (w < -180 || e > 180 || w >= e) return 'need -180 <= w < e <= 180 (split a box at the dateline)';
    if (n - s > 10 || e - w > 10) return 'a box is at most 10 degrees each way';
    const before = params.get('before');
    const beforeId = params.get('before_id');
    if (before !== null) {
        const t = Date.parse(before);
        if (!ISO_TIME.test(before) || !Number.isFinite(t) || t % 600_000 !== 0) {
            return 'before must be a time from a previous page';
        }
    }
    if (beforeId !== null && (before === null || !UUID.test(beforeId)))
        return 'before_id must be an id from a previous page';
    return { p_south: s, p_west: w, p_north: n, p_east: e, p_before: before, p_before_id: beforeId };
}

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function pick(source: Record<string, Json>, keys: readonly string[]): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];
    return out;
}

/** A histogram object of small integer keys to counts, or null. */
function histogram(v: unknown, maxKeys: number): Record<string, number> | null {
    if (!isObj(v)) return null;
    const out: Record<string, number> = {};
    let n = 0;
    for (const [k, c] of Object.entries(v)) {
        if (!/^-?\d{1,4}$/.test(k) || num(c) === null || ++n > maxKeys) continue;
        out[k] = c as number;
    }
    return out;
}

/** One public row, in the short public keys, or null if it is malformed or not public. */
export function publicRow(source: unknown): Record<string, Json> | null {
    if (!isObj(source)) return null;
    // PostgREST names the columns; the summary's recent list already uses the short keys.
    const r: Record<string, Json> = Object.hasOwn(source, 'sighting_id')
        ? {
              id: source.sighting_id,
              group: source.taxon_group,
              sci: source.scientific_name,
              name: source.vernacular_name,
              rank: source.taxon_rank,
              count: source.individual_count,
              calf: source.has_calf,
              time: source.event_time,
              lat: source.latitude,
              lon: source.longitude,
              uncertainty_m: source.uncertainty_m,
              generalised: source.generalised,
              credit: source.credit,
          }
        : pick(source, ROW_KEYS);
    const group = str(r.group);
    if (!group || !GROUPS.has(group) || !UUID.test(String(r.id ?? ''))) return null;
    if (num(r.lat) === null || num(r.lon) === null || !str(r.time)) return null;
    // A blurred row is never an individual public record on this page: its
    // floored hour plus a boat's public voyage-log track would place a
    // threatened animal far better than its 10 km cell (the SQL says so;
    // so do we).
    if (r.generalised !== false) return null;
    const credit = str(r.credit);
    return {
        ...pick(r, ROW_KEYS),
        generalised: false,
        credit: credit && HANDLE.test(credit) ? credit : null,
    };
}

/** The whitelisted summary. Anything unexpected is dropped, not passed on. */
export function publicSummary(source: unknown): Record<string, Json> | null {
    if (!isObj(source) || source.v !== 1) return null;
    const out = pick(source, SUMMARY_KEYS);
    out.status = 'ok';
    out.grid = isObj(source.grid) ? pick(source.grid, GRID_KEYS) : {};
    const totals = isObj(source.totals) ? pick(source.totals, TOTAL_KEYS) : {};
    const boats = num(totals.boats);
    totals.boats = boats !== null && boats >= BOATS_MIN_SHOWN ? boats : null;
    totals.boats_min_shown = BOATS_MIN_SHOWN;
    out.totals = totals;
    const groups: Record<string, Json> = {};
    if (isObj(source.groups)) {
        for (const [group, pair] of Object.entries(source.groups)) {
            if (GROUPS.has(group) && Array.isArray(pair) && pair.length === 2 && pair.every((x) => num(x) !== null)) {
                groups[group] = pair;
            }
        }
    }
    out.groups = groups;
    out.cells_truncated = source.cells_truncated === true;
    out.cells = Array.isArray(source.cells)
        ? source.cells.filter(
              (c): c is Json[] =>
                  Array.isArray(c) &&
                  c.length === 9 &&
                  num(c[0]) !== null &&
                  num(c[1]) !== null &&
                  GROUPS.has(String(c[2])) &&
                  (c[3] === null || typeof c[3] === 'string') &&
                  typeof c[4] === 'boolean' &&
                  num(c[5]) !== null &&
                  num(c[6]) !== null &&
                  num(c[7]) !== null &&
                  num(c[8]) !== null,
          )
        : [];
    out.species = Array.isArray(source.species)
        ? source.species.filter(isObj).flatMap((s) => {
              if (!str(s.sci) || !GROUPS.has(String(s.group))) return [];
              const sp = pick(s, SPECIES_KEYS);
              sp.months = histogram(s.months, 12);
              sp.hours = histogram(s.hours, 24);
              sp.years = histogram(s.years, 200);
              sp.sst = histogram(s.sst, 50);
              return [sp];
          })
        : [];
    out.recent = Array.isArray(source.recent)
        ? source.recent.map(publicRow).filter((r): r is Record<string, Json> => r !== null)
        : [];
    return out;
}

/** Read at most maxBytes of a body, or throw. */
async function boundedText(response: Response, maxBytes: number): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('upstream response too large');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error('upstream response too large');
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return new TextDecoder().decode(all);
}

/** The functions are written but not pushed yet: the page shows its honest waiting state. */
const notReady = (body: string, status: number) =>
    (status === 404 && /PGRST202/.test(body)) || /"code"\s*:\s*"(?:PGRST202|42883)"/.test(body);

export async function handleOcean(request: Request, env: Env = processEnv()): Promise<Response> {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
        return new Response(JSON.stringify({ error: 'GET or HEAD only' }), {
            status: 405,
            headers: {
                allow: 'GET, HEAD',
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            },
        });
    }
    const url = new URL(request.url);
    if (!allowedHost(url.hostname)) return refuse('ask https://ocean.thalassawx.app', 404, head);
    if (url.search.length > MAX_QUERY_CHARS) return refuse('query too long', 400, head);
    const view = url.pathname.replace(/\/+$/, '').split('/').pop();
    if (view !== 'summary' && view !== 'rows') return refuse('unknown view', 404, head);
    // Vercel hands a dynamic route its segment as a query parameter too
    // (api/ocean/[view].ts sees /api/ocean/summary?view=summary). Drop only
    // that echo of the path; any other `view` is still an unknown parameter.
    // Found live on 2026-10-07: every summary call said 'summary takes no
    // parameters' while the unit tests, built without it, passed.
    const params = new URLSearchParams(url.searchParams);
    if (params.getAll('view').length === 1 && params.get('view') === view) params.delete('view');

    let rpc: string;
    let body: Record<string, Json>;
    if (view === 'summary') {
        if ([...params.keys()].length > 0) return refuse('summary takes no parameters', 400, head);
        rpc = 'get_ocean_summary';
        body = {};
    } else {
        const query = parseRowsQuery(params);
        if (typeof query === 'string') return refuse(query, 400, head);
        rpc = 'get_ocean_sightings';
        body = { ...query };
    }

    const upstream = upstreamConfig(env);
    if (!upstream) return refuse('not configured', 503, head);

    let response: Response;
    let text: string;
    try {
        response = await fetch(`${upstream.url}/rest/v1/rpc/${rpc}`, {
            method: 'POST',
            headers: {
                apikey: upstream.key,
                'content-type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        text = await boundedText(response, view === 'summary' ? SUMMARY_MAX_BYTES : ROWS_MAX_BYTES);
    } catch {
        return refuse('fleet data unreachable', 502, head);
    }

    if (!response.ok) {
        if (notReady(text, response.status)) return json({ v: 1, status: 'not-ready' }, 200, NOT_READY_CACHE, head);
        return refuse('fleet data unavailable', 502, head);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return refuse('fleet data unreadable', 502, head);
    }

    if (view === 'summary') {
        const summary = publicSummary(parsed);
        if (!summary) return refuse('fleet data unreadable', 502, head);
        return json(summary, 200, OK_CACHE, head);
    }
    if (!Array.isArray(parsed)) return refuse('fleet data unreadable', 502, head);
    const rows = parsed
        .slice(0, ROWS_PAGE)
        .map(publicRow)
        .filter((r): r is Record<string, Json> => r !== null);
    // The next page starts after the page's last row as the database sent
    // it, even when that row itself is not passed on.
    const lastRaw = parsed.length >= ROWS_PAGE ? parsed[ROWS_PAGE - 1] : null;
    const next =
        isObj(lastRaw) &&
        typeof lastRaw.sighting_id === 'string' &&
        UUID.test(lastRaw.sighting_id) &&
        typeof lastRaw.event_time === 'string' &&
        ISO_TIME.test(lastRaw.event_time)
            ? { before: lastRaw.event_time, before_id: lastRaw.sighting_id }
            : null;
    return json({ v: 1, status: 'ok', rows, next }, 200, OK_CACHE, head);
}

export default (request: Request): Promise<Response> => handleOcean(request);

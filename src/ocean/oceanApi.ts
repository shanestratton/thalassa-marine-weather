/**
 * oceanApi — the Thalassa Ocean page's data: the fleet's public summary and
 * rows (same-origin /api/ocean/*, see api/ocean/[view].ts) and the static
 * context file of historical public records (scripts/ocean/build-context.mjs).
 *
 * Every parser is defensive: a malformed row is dropped, never drawn, and so
 * is a blurred row (the server never sends one as a point; threatened
 * sightings are area counts only). Nothing here can make a position finer or
 * a time earlier than the server sent.
 */

export type Group = 'whale' | 'dolphin' | 'dugong' | 'turtle' | 'seabird' | 'shark_ray' | 'other';
export const GROUP_IDS: readonly Group[] = ['whale', 'dolphin', 'dugong', 'turtle', 'seabird', 'shark_ray', 'other'];
const GROUP_SET = new Set<string>(GROUP_IDS);
export const isGroup = (g: unknown): g is Group => typeof g === 'string' && GROUP_SET.has(g);

export interface FleetRow {
    id: string;
    group: Group;
    sci: string | null;
    name: string | null;
    count: number;
    calf: boolean;
    time: string;
    lat: number;
    lon: number;
    uncertaintyM: number;
    generalised: boolean;
    credit: string | null;
}

/** [lat, lon, group, sci, generalised, year, month, sightings, animals] — a 0.1° cell. */
export interface FleetCell {
    lat: number;
    lon: number;
    group: Group;
    sci: string | null;
    generalised: boolean;
    year: number;
    month: number;
    n: number;
    animals: number;
}

export type Histogram = Record<number, number>;

export interface FleetSpecies {
    sci: string;
    name: string;
    group: Group;
    generalised: boolean;
    n: number;
    animals: number;
    months: Histogram;
    hours: Histogram;
    years: Histogram;
    /** 1 °C bins from the boats' own sensors; null until 5 readings. */
    sst: Histogram | null;
}

export interface Summary {
    generatedAt: string;
    delayHours: number;
    totals: {
        sightings: number;
        animals: number;
        species: number;
        /** Only once at least boatsMinShown boats contribute; otherwise null. */
        boats: number | null;
        boatsMinShown: number;
        lastTime: string | null;
    };
    groups: Partial<Record<Group, [number, number]>>;
    cells: FleetCell[];
    /** The server kept only the 20,000 busiest cells; totals still count everything. */
    cellsTruncated: boolean;
    species: FleetSpecies[];
    recent: FleetRow[];
}

export type FleetState =
    | { status: 'loading' }
    | { status: 'ok'; summary: Summary }
    | { status: 'not-ready' }
    | { status: 'error' };

/** [lat, lon, record-days, months?] at the species' cell size. */
export type ContextCell = [number, number, number, number[]?];

export interface ContextSpecies {
    sci: string;
    name: string;
    group: Group;
    aphiaId: number;
    sensitive: boolean;
    cellDeg: number;
    records: number;
    recordDays: number;
    years: [number, number] | null;
    months: number[];
    cells: ContextCell[];
}

export interface ContextDataset {
    id: string;
    title: string;
    institutes: string[];
    licence: string;
    /** The licence deed (CC BY 4.0 or CC0 1.0 only). */
    licenceUrl: string;
    citation: string;
    url: string;
    records: number;
    species: string[];
}

export interface ContextFile {
    region: { id: string; name: string };
    built: string;
    minRecords: number;
    species: ContextSpecies[];
    dropped: Array<{ sci: string; name: string; records: number; reason: string }>;
    datasets: ContextDataset[];
    citation: string;
    /** Region-specific caveats (what is missing here and why), from the file, not the page. */
    notes: string[];
    /** How the records were changed from the originals (CC BY 4.0 asks us to say). */
    modification: string;
}

export type ContextState = { status: 'loading' } | { status: 'ok'; context: ContextFile } | { status: 'error' };

const API_BASE = '/api/ocean';
/** Same-origin today; the R2 bucket's ocean/ prefix when the layer goes global. */
export const DATA_BASE = String(import.meta.env.VITE_OCEAN_DATA_BASE || '/ocean-data').replace(/\/+$/, '');
export const SUMMARY_URL = `${API_BASE}/summary`;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The two licences the context layer may use, and their deeds. */
export const LICENCE_DEEDS: Readonly<Record<string, string>> = Object.freeze({
    'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function histogram(v: unknown): Histogram {
    const out: Histogram = {};
    if (!isObj(v)) return out;
    for (const [k, n] of Object.entries(v)) if (/^-?\d+$/.test(k) && fin(n)) out[Number(k)] = n;
    return out;
}

export function parseRow(v: unknown): FleetRow | null {
    if (!isObj(v) || !isGroup(v.group) || typeof v.id !== 'string') return null;
    if (!fin(v.lat) || !fin(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null;
    const time = text(v.time);
    if (!time || !Number.isFinite(Date.parse(time))) return null;
    // A blurred row is never a point on this page (see the file header).
    if (v.generalised !== false) return null;
    const credit = text(v.credit);
    return {
        id: v.id,
        group: v.group,
        sci: text(v.sci),
        name: text(v.name),
        count: fin(v.count) && v.count > 0 ? Math.round(v.count) : 1,
        calf: v.calf === true,
        time,
        lat: v.lat,
        lon: v.lon,
        uncertaintyM: fin(v.uncertainty_m) ? v.uncertainty_m : 790,
        generalised: false,
        credit: credit && HANDLE.test(credit) ? credit : null,
    };
}

function parseCell(v: unknown): FleetCell | null {
    if (!Array.isArray(v) || v.length !== 9) return null;
    const [lat, lon, group, sci, generalised, year, month, n, animals] = v;
    if (!fin(lat) || !fin(lon) || !isGroup(group) || !fin(year) || !fin(month) || !fin(n) || !fin(animals)) return null;
    if (month < 1 || month > 12 || n <= 0) return null;
    return { lat, lon, group, sci: text(sci), generalised: generalised === true, year, month, n, animals };
}

export function parseSummary(v: unknown): FleetState {
    if (!isObj(v) || v.v !== 1) return { status: 'error' };
    if (v.status === 'not-ready') return { status: 'not-ready' };
    if (v.status !== 'ok') return { status: 'error' };
    const t = isObj(v.totals) ? v.totals : {};
    const minShown = fin(t.boats_min_shown) ? Math.max(3, t.boats_min_shown) : 3;
    const groups: Summary['groups'] = {};
    if (isObj(v.groups)) {
        for (const [g, pair] of Object.entries(v.groups)) {
            if (isGroup(g) && Array.isArray(pair) && fin(pair[0]) && fin(pair[1])) groups[g] = [pair[0], pair[1]];
        }
    }
    const species: FleetSpecies[] = [];
    for (const s of Array.isArray(v.species) ? v.species : []) {
        if (!isObj(s) || !text(s.sci) || !isGroup(s.group)) continue;
        species.push({
            sci: s.sci as string,
            name: text(s.name) ?? (s.sci as string),
            group: s.group,
            generalised: s.generalised === true,
            n: fin(s.n) ? s.n : 0,
            animals: fin(s.animals) ? s.animals : 0,
            months: histogram(s.months),
            hours: histogram(s.hours),
            years: histogram(s.years),
            sst: isObj(s.sst) ? histogram(s.sst) : null,
        });
    }
    return {
        status: 'ok',
        summary: {
            generatedAt: text(v.generated_at) ?? new Date().toISOString(),
            delayHours: fin(v.delay_hours) ? Math.max(3, v.delay_hours) : 3,
            totals: {
                sightings: fin(t.sightings) ? t.sightings : 0,
                animals: fin(t.animals) ? t.animals : 0,
                species: fin(t.species) ? t.species : 0,
                boats: fin(t.boats) && t.boats >= minShown ? t.boats : null,
                boatsMinShown: minShown,
                lastTime: text(t.last_time),
            },
            groups,
            cells: (Array.isArray(v.cells) ? v.cells : []).map(parseCell).filter((c): c is FleetCell => c !== null),
            cellsTruncated: v.cells_truncated === true,
            species,
            recent: (Array.isArray(v.recent) ? v.recent : []).map(parseRow).filter((r): r is FleetRow => r !== null),
        },
    };
}

export function parseContext(v: unknown): ContextFile | null {
    if (!isObj(v) || v.schema !== 'thalassa-ocean-context' || v.v !== 1 || !isObj(v.region)) return null;
    const species: ContextSpecies[] = [];
    for (const s of Array.isArray(v.species) ? v.species : []) {
        if (!isObj(s) || !text(s.sci) || !isGroup(s.group) || !Array.isArray(s.cells)) continue;
        const cells = s.cells.filter(
            (c): c is ContextCell =>
                Array.isArray(c) &&
                fin(c[0]) &&
                fin(c[1]) &&
                fin(c[2]) &&
                (c[3] === undefined || (Array.isArray(c[3]) && c[3].length === 12 && c[3].every(fin))),
        );
        species.push({
            sci: s.sci as string,
            name: text(s.name) ?? (s.sci as string),
            group: s.group,
            aphiaId: fin(s.aphiaId) ? s.aphiaId : 0,
            // Fail closed: anything not explicitly non-sensitive is treated as threatened.
            sensitive: s.sensitive !== false,
            cellDeg: fin(s.cellDeg) ? s.cellDeg : 0.5,
            records: fin(s.records) ? s.records : 0,
            recordDays: fin(s.recordDays) ? s.recordDays : 0,
            years: Array.isArray(s.years) && fin(s.years[0]) && fin(s.years[1]) ? [s.years[0], s.years[1]] : null,
            months:
                Array.isArray(s.months) && s.months.length === 12 && s.months.every(fin) ? s.months : Array(12).fill(0),
            cells,
        });
    }
    const datasets: ContextDataset[] = [];
    for (const d of Array.isArray(v.datasets) ? v.datasets : []) {
        if (!isObj(d) || !text(d.id) || !text(d.licence)) continue;
        datasets.push({
            id: d.id as string,
            title: text(d.title) ?? (d.id as string),
            institutes: Array.isArray(d.institutes)
                ? d.institutes.filter((i): i is string => typeof i === 'string')
                : [],
            licence: d.licence as string,
            licenceUrl:
                Object.values(LICENCE_DEEDS).find((deed) => deed === d.licenceUrl) ??
                LICENCE_DEEDS[d.licence as string] ??
                '',
            citation: text(d.citation) ?? '',
            url:
                typeof d.url === 'string' && /^https:\/\/obis\.org\//.test(d.url)
                    ? d.url
                    : `https://obis.org/dataset/${d.id}`,
            records: fin(d.records) ? d.records : 0,
            species: Array.isArray(d.species) ? d.species.filter((x): x is string => typeof x === 'string') : [],
        });
    }
    const dropped = (Array.isArray(v.dropped) ? v.dropped : []).flatMap((d) =>
        isObj(d) && text(d.sci) && text(d.reason)
            ? [
                  {
                      sci: d.sci as string,
                      name: text(d.name) ?? (d.sci as string),
                      records: fin(d.records) ? d.records : 0,
                      reason: d.reason as string,
                  },
              ]
            : [],
    );
    return {
        region: { id: text(v.region.id) ?? 'region', name: text(v.region.name) ?? '' },
        built: text(v.built) ?? '',
        minRecords: fin(v.minRecords) ? v.minRecords : 50,
        species,
        dropped,
        datasets,
        citation: text(v.citation) ?? '',
        notes: (Array.isArray(v.notes) ? v.notes : []).filter((n): n is string => !!text(n)),
        modification: text(v.modification) ?? '',
    };
}

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown> {
    // Plain GET, no custom headers (a CORS-simple request, cacheable as is).
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // A static host answering a missing API with its HTML shell is "unreachable", not data.
    if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

export async function fetchSummary(): Promise<FleetState> {
    try {
        return parseSummary(await getJson(SUMMARY_URL));
    } catch {
        return { status: 'error' };
    }
}

type RowsPage = { rows: FleetRow[]; next: { before: string; before_id: string } | null };

/** One page of one whole-degree box, at most 10° each way (api/ocean/[view].ts refuses more). */
export async function fetchRows(
    box: readonly [number, number, number, number],
    after: RowsPage['next'] = null,
): Promise<RowsPage> {
    const [s, w, n, e] = box;
    const q = new URLSearchParams({ s: String(s), w: String(w), n: String(n), e: String(e) });
    if (after) {
        q.set('before', after.before);
        q.set('before_id', after.before_id);
    }
    const body = await getJson(`${API_BASE}/rows?${q}`);
    if (!isObj(body) || body.status !== 'ok' || !Array.isArray(body.rows)) return { rows: [], next: null };
    const next =
        isObj(body.next) && typeof body.next.before === 'string' && typeof body.next.before_id === 'string'
            ? { before: body.next.before, before_id: body.next.before_id }
            : null;
    return { rows: body.rows.map(parseRow).filter((r): r is FleetRow => r !== null), next };
}

/**
 * Every row of a box, newest first, following `next` up to `maxPages` pages
 * (200 rows each). complete is false when the box had more than that, so the
 * map can keep showing its counts there instead of an incomplete set of
 * points. null when the box could not be read at all.
 */
export async function fetchRowsAll(
    box: readonly [number, number, number, number],
    maxPages = 5,
): Promise<{ rows: FleetRow[]; complete: boolean } | null> {
    const rows: FleetRow[] = [];
    let next: RowsPage['next'] = null;
    try {
        for (let page = 0; page < maxPages; page += 1) {
            const got = await fetchRows(box, next);
            rows.push(...got.rows);
            next = got.next;
            if (!next) return { rows, complete: true };
        }
    } catch {
        return rows.length ? { rows, complete: false } : null;
    }
    return { rows, complete: false };
}

export async function fetchContext(regionId: string): Promise<ContextState> {
    try {
        const context = parseContext(
            await getJson(`${DATA_BASE}/context/${encodeURIComponent(regionId)}.v1.json`, 20_000),
        );
        return context ? { status: 'ok', context } : { status: 'error' };
    } catch {
        return { status: 'error' };
    }
}

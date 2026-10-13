/**
 * The cyclone feed, direct from the warning centres (129-09b): no Esri, no
 * knackwx. Pure and network-free: _shared/cyclone/sources.ts fetches, the
 * cyclone-feed function serves the result to the app and the Pi, and
 * cyclone-watch measures boats against it. NHC, CPHC and NCEP are public
 * domain per weather.gov/disclaimer (read 2026-10-14). JTWC is US military
 * work (17 U.S.C. 105); its notice page could not be read from here
 * (CloudFront 403). Every source is credited by name all the same.
 *
 *   The storm list, keyed by basin and number ("EP41", "SH37"):
 *     NHC     www.nhc.noaa.gov/CurrentStorms.json: AL, EP and CP storms, with
 *             the advisory and the office that wrote it (MIA is NHC, HFO is
 *             CPHC: productIssuer in centres.ts)
 *     JTWC    www.metoc.navy.mil/jtwc/rss/jtwc.rss: JTWC's warnings, with
 *             their products
 *     vitals  NCEP's TC vitals (nomads gfs.tCCz.syndata.tcvitals.tm00): every
 *             basin's storm, as NHC and JTWC reported it to the models;
 *             fixed-width, so read by column (a long name runs into the date)
 *   The tracks:
 *     NHC and CPHC: NOAA's NHC_tropical_weather MapServer (mapservices.
 *             weather.noaa.gov), each storm's slot (binNumber, "EP3"): the
 *             Forecast Points (GeoJSON, VALIDTIME in UTC), the Forecast Cone
 *             and the Past Points. Chosen over NHC's per-storm GIS zips and
 *             KMZs: it is GeoJSON with CORS, carries the advisory number and
 *             the office's own time zone, and had the same advisory as
 *             CurrentStorms.json when read (EP20 advisory 25 and EP21 advisory
 *             1, 2026-10-13 16:47 UTC), so nothing needs unzipping.
 *     JTWC    its JMV 3.0 file (.tcw: forecast taus, the warning-time
 *             position, the past track) and the 34 knot danger swath in its
 *             KMZ, read wherever NHC and CPHC are not advising (nhcAdvises:
 *             an East Pacific storm past 180° keeps its E id, and JTWC keeps
 *             warning on it under that id). Drawn only when the product
 *             answers; JTWC's own pages refuse automated requests, and
 *             nothing here works around that.
 *
 * A source that does not answer is said by name in `sources`; a storm whose
 * track source failed carries `forecastUnavailable`, never "no track"; a cone
 * that failed `coneUnavailable`, never "none published"; a JTWC warning whose
 * product did not come, placed by no other list, is named in `unplaced`,
 * never left out in silence.
 */
import { atcfLat, atcfLon } from './adeck.ts';
import { cycloneCentre, productIssuer, type TrackIssuer, validTimeNear } from './centres.ts';

export interface FeedPoint {
    lat: number;
    lon: number;
    /** ISO, UTC. */
    time: string;
    windKts: number | null;
    pressureMb: number | null;
}

/** A published polygon, as GeoJSON spells it (lon, lat). */
export type FeedPolygon =
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface FeedForecast {
    by: TrackIssuer;
    /** The advisory (NHC) or warning (JTWC) number, as the issuer writes it without leading zeros. */
    advisory: string;
    issued: string | null;
    /** tau 0 first. */
    points: FeedPoint[];
    /** The issuer's own past track. */
    past: FeedPoint[];
    /** NHC's cone or JTWC's 34 kt danger swath, as published. Never generated. */
    cone?: FeedPolygon;
    /** The cone was asked for and did not come: unavailable, not "none published". */
    coneUnavailable?: true;
}

export type FeedList = 'nhc' | 'jtwc' | 'vitals';

export interface FeedStorm {
    /** Basin and number: the a-deck and cyclone_watch_alerts key. */
    key: string;
    /** The ATCF id with its season: "ep412026", "sh372027". */
    sid: string;
    name: string;
    /** The storm id's letter (E, L, C, W, A, B, P, S), as the app names the basin. */
    basin: string;
    /** NHC's classification (HU, TS, TD, …), else ''. */
    nature: string;
    /** The newest position any list gave. */
    current: FeedPoint;
    /** Whose position `current` is. */
    positionBy: TrackIssuer;
    /** The lists that carry it. */
    from: FeedList[];
    forecast?: FeedForecast;
    /** The issuer's track was asked for and did not come. */
    forecastUnavailable?: true;
}

export type SourceStatus = 'ok' | 'unavailable' | 'none';

/** A JTWC warning whose product did not come, and that no other list places: no position, so no storm drawn. */
export interface UnplacedWarning {
    key: string;
    name: string;
    warning: string;
}

export interface CycloneFeed {
    generatedAt: string;
    storms: FeedStorm[];
    sources: {
        nhc: SourceStatus;
        jtwc: SourceStatus;
        vitals: SourceStatus;
        noaa: SourceStatus;
        jtwcTracks: SourceStatus;
    };
    /** Listed by JTWC, its product not read, in no other list: said by name, never dropped in silence. */
    unplaced: UnplacedWarning[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const iso = (ms: number) => new Date(ms).toISOString();
/** Leading zeros off an advisory number ("024" → "24", "024A" → "24A"). */
const advNum = (v: unknown) => String(v ?? '').trim().replace(/^0+(?=\d)/, '');
const kt = (v: number | null) => (v !== null && v > 0 ? v : null);
const mb = (v: number | null) => (v !== null && v > 0 && v < 9999 ? v : null);
/** -180..180, 3 decimals: the cone's precision, and a stable spelling across the antimeridian. */
const lonOf = (v: number) => Math.round(((((v + 180) % 360) + 360) % 360 - 180) * 1000) / 1000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The storm id's letter to the ATCF basin. */
const LETTER_BASIN: Record<string, string> = { L: 'AL', E: 'EP', C: 'CP', W: 'WP', A: 'IO', B: 'IO', P: 'SH', S: 'SH' };
const BASIN_LETTER: Record<string, string> = { AL: 'L', EP: 'E', CP: 'C' };

/** "SH" storms are numbered for the season's last year, which starts on 1 July. */
function seasonYear(basin: string, ms: number): number {
    const d = new Date(ms);
    return basin === 'SH' && d.getUTCMonth() >= 6 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

// ── NHC CurrentStorms.json ──────────────────────────────────

export interface NhcStorm {
    key: string;
    sid: string;
    name: string;
    basin: string;
    nature: string;
    current: FeedPoint;
    /** The MapServer slot, "EP3". */
    bin: string | null;
    advisory: string | null;
    issued: string | null;
    by: 'NHC' | 'CPHC';
}

/** The storms in CurrentStorms.json, or null when it is not that file. */
export function parseCurrentStorms(json: unknown): NhcStorm[] | null {
    const list = rec(json)?.activeStorms;
    if (!Array.isArray(list)) return null;
    const out: NhcStorm[] = [];
    for (const raw of list) {
        const s = rec(raw);
        const id = /^(al|ep|cp)(\d{2})(\d{4})$/i.exec(String(s?.id ?? '').trim());
        const lat = num(s?.latitudeNumeric);
        const lon = num(s?.longitudeNumeric);
        const t = Date.parse(String(s?.lastUpdate ?? ''));
        if (
            !s || !id || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
            !Number.isFinite(t)
        ) {
            continue;
        }
        if (Number(id[2]) >= 90) continue;
        const basin = id[1].toUpperCase();
        const fc = rec(s.forecastAdvisory);
        const pub = rec(s.publicAdvisory);
        const issued = Date.parse(String(fc?.issuance ?? ''));
        const bin = String(s.binNumber ?? '').trim().toUpperCase();
        out.push({
            key: `${basin}${id[2]}`,
            sid: `${id[1].toLowerCase()}${id[2]}${id[3]}`,
            name: String(s.name ?? '').trim().toUpperCase() || `${basin}${id[2]}`,
            basin: BASIN_LETTER[basin],
            nature: String(s.classification ?? '').trim().toUpperCase(),
            current: { lat, lon, time: iso(t), windKts: kt(num(s.intensity)), pressureMb: mb(num(s.pressure)) },
            bin: /^(AT|EP|CP)[1-5]$/.test(bin) ? bin : null,
            advisory: fc?.advNum != null ? advNum(fc.advNum) : null,
            issued: Number.isFinite(issued) ? iso(issued) : null,
            by: productIssuer([fc?.url, pub?.url], lat, lon),
        });
    }
    return out;
}

// ── NOAA's NHC_tropical_weather MapServer ───────────────────

/** A slot's forecast points, cone and past points, by layer name from the service's own list. */
export function noaaSlotLayers(service: unknown, bin: string): { points: number; cone: number; past: number } | null {
    const layers = rec(service)?.layers;
    if (!Array.isArray(layers)) return null;
    const id = (name: string) => {
        const l = layers.map(rec).find((x) => String(x?.name ?? '').trim() === `${bin} ${name}`);
        const n = num(l?.id);
        return n !== null && Number.isInteger(n) ? n : null;
    };
    const points = id('Forecast Points');
    const cone = id('Forecast Cone');
    const past = id('Past Points');
    return points === null || cone === null || past === null ? null : { points, cone, past };
}

/** US zones the NHC and CPHC write ADVDATE in, as hours from UTC. */
const ZONES: Record<string, number> = {
    UTC: 0,
    GMT: 0,
    AST: -4,
    ADT: -3,
    EST: -5,
    EDT: -4,
    CST: -6,
    CDT: -5,
    MST: -7,
    MDT: -6,
    PST: -8,
    PDT: -7,
    HST: -10,
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "800 AM MST Tue Oct 13 2026" → epoch ms, read in its own zone; a zone it does not know is null. */
export function parseAdvDate(label: unknown): number | null {
    const m = /^(\d{1,4})\s*(AM|PM)\s+([A-Z]{2,4})\s+[A-Z]{3}\s+([A-Z]{3})\s+(\d{1,2})\s+(\d{4})$/i.exec(
        String(label ?? '').trim(),
    );
    const zone = m ? ZONES[m[3].toUpperCase()] : undefined;
    const month = m ? MONTHS.indexOf(m[4].toUpperCase()) : -1;
    if (!m || zone === undefined || month < 0) return null;
    const hm = Number(m[1]);
    const h12 = Math.floor(hm / 100);
    const min = hm % 100;
    if (h12 < 1 || h12 > 12 || min > 59) return null;
    const h = (h12 % 12) + (m[2].toUpperCase() === 'PM' ? 12 : 0);
    return Date.UTC(Number(m[6]), month, Number(m[5]), h - zone, min);
}

/** This storm's features only: a slot can still hold its last storm's, or the next one's. */
function sameStorm(p: Rec | null, storm: NhcStorm): boolean {
    const n = num(p?.stormnum);
    const basin = String(p?.basin ?? '').trim().toUpperCase();
    return n === Number(storm.key.slice(2)) && (basin === '' || basin === storm.key.slice(0, 2));
}

const features = (geojson: unknown): Rec[] => {
    const f = rec(geojson)?.features;
    return Array.isArray(f) ? f.map(rec).filter((x): x is Rec => x !== null) : [];
};
const pointOf = (f: Rec): [number, number] | null => {
    const xy = rec(f.geometry)?.coordinates;
    const lon = Array.isArray(xy) ? num(xy[0]) : null;
    const lat = Array.isArray(xy) ? num(xy[1]) : null;
    return lon === null || lat === null || Math.abs(lat) > 90 ? null : [lonOf(lon), r3(lat)];
};

/** The storm's forecast points from its slot, or null when the slot has none of this storm's. */
export function parseNoaaPoints(geojson: unknown, storm: NhcStorm): FeedForecast | null {
    const mine = features(geojson).filter((f) => sameStorm(rec(f.properties), storm));
    if (mine.length === 0) return null;
    const p0 = rec(mine[0].properties)!;
    const own = parseAdvDate(p0.advdate);
    const advisory = advNum(p0.advisnum) || storm.advisory || '';
    const issued = own !== null ? iso(own) : advisory === storm.advisory ? storm.issued : null;
    const ref = own ?? Date.parse(storm.issued ?? storm.current.time);
    const points: FeedPoint[] = [];
    for (const f of mine) {
        const p = rec(f.properties)!;
        const at = pointOf(f);
        const time = validTimeNear(p.validtime, ref);
        if (!at || !time) continue;
        points.push({ lat: at[1], lon: at[0], time, windKts: kt(num(p.maxwind)), pressureMb: mb(num(p.mslp)) });
    }
    points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return points.length ? { by: storm.by, advisory, issued, points, past: [] } : null;
}

function polygonOf(g: unknown): FeedPolygon | null {
    const geom = rec(g);
    if (!geom || !Array.isArray(geom.coordinates)) return null;
    const ring = (r: unknown) =>
        Array.isArray(r)
            ? r
                .map((
                    q,
                ) => (Array.isArray(q) && num(q[0]) !== null && num(q[1]) !== null ? [lonOf(q[0]), r3(q[1])] : null))
                .filter((q): q is number[] => q !== null)
            : [];
    if (geom.type === 'Polygon') {
        const rings = geom.coordinates.map(ring).filter((r) => r.length >= 4);
        return rings.length ? { type: 'Polygon', coordinates: rings } : null;
    }
    if (geom.type === 'MultiPolygon') {
        const polys = geom.coordinates
            .map((p) => (Array.isArray(p) ? p.map(ring).filter((r) => r.length >= 4) : []))
            .filter((p) => p.length > 0);
        return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
    }
    return null;
}

/** The storm's cone from its slot, as published. */
export function parseNoaaCone(geojson: unknown, storm: NhcStorm): FeedPolygon | null {
    for (const f of features(geojson)) {
        const p = rec(f.properties);
        if (p && num(p.stormnum) !== null && !sameStorm(p, storm)) continue;
        const poly = polygonOf(f.geometry);
        if (poly) return poly;
    }
    return null;
}

/** "2026101306" → ms. */
function dtgMs(v: unknown): number | null {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
    return new Date(t).getUTCDate() === +m[3] && +m[4] < 24 ? t : null;
}

function byTime(points: FeedPoint[]): FeedPoint[] {
    const seen = new Map<string, FeedPoint>();
    for (const p of points) if (!seen.has(p.time)) seen.set(p.time, p);
    return [...seen.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/** The storm's past track from its slot (synoptic DTGs, UTC). */
export function parseNoaaPast(geojson: unknown, storm: NhcStorm): FeedPoint[] {
    const out: FeedPoint[] = [];
    for (const f of features(geojson)) {
        const p = rec(f.properties);
        const at = pointOf(f);
        const t = dtgMs(p?.dtg);
        if (!p || !at || t === null || !sameStorm(p, storm)) continue;
        out.push({ lat: at[1], lon: at[0], time: iso(t), windKts: kt(num(p.intensity)), pressureMb: mb(num(p.mslp)) });
    }
    return byTime(out);
}

// ── JTWC ────────────────────────────────────────────────────

export interface JtwcListing {
    /** "sh3727": basin, number and the season's two-digit year, as JTWC names its products. */
    product: string;
    key: string;
    sid: string;
    name: string;
    warning: string;
}

/** The ATCF ids for a product id ("sh3727" → SH37, sh372027). */
function productIds(product: string): { key: string; sid: string; basin2: string } | null {
    const m = /^([a-z]{2})(\d{2})(\d{2})$/.exec(product);
    if (!m) return null;
    const basin2 = m[1].toUpperCase();
    if (!['AL', 'EP', 'CP', 'WP', 'IO', 'SH'].includes(basin2)) return null;
    return { key: `${basin2}${m[2]}`, sid: `${m[1]}${m[2]}20${m[3]}`, basin2 };
}

/** Every warning in JTWC's RSS that links its JMV 3.0 file. */
export function parseJtwcRss(xml: string): JtwcListing[] {
    const out: JtwcListing[] = [];
    // The product link of this warning, never the next one's: the gap may not hold another "Warning #".
    const re =
        /(\d{2})([A-Z])\s*\(([^)<]*)\)\s*Warning\s*#\s*(\d+)(?:(?!Warning\s*#)[\s\S])*?\/jtwc\/products\/([a-z]{2}\d{4})\.tcw/gi;
    for (const m of String(xml ?? '').matchAll(re)) {
        const ids = productIds(m[5].toLowerCase());
        if (!ids || ids.key.slice(2) !== m[1] || LETTER_BASIN[m[2].toUpperCase()] !== ids.basin2) continue;
        if (out.some((o) => o.key === ids.key)) continue;
        out.push({
            product: m[5].toLowerCase(),
            key: ids.key,
            sid: ids.sid,
            name: m[3].trim().toUpperCase(),
            warning: advNum(m[4]),
        });
    }
    return out;
}

export interface JtwcStorm {
    key: string;
    sid: string;
    name: string;
    /** The id's letter from the file ("37P" → P). */
    basin: string;
    warning: string;
    issued: string | null;
    /** The warning-time position from REMARKS, else tau 0. */
    current: FeedPoint;
    points: FeedPoint[];
    past: FeedPoint[];
}

/** A JTWC JMV 3.0 (.tcw) warning file, or null when it is not this product's storm. */
export function parseJmv(text: string, product: string): JtwcStorm | null {
    const ids = productIds(product);
    const head = /^(\d{10})\s+(\d{2})([A-Z])\s+(\S+)\s+(\d{3})\b/m.exec(text);
    if (!ids || !head || head[2] !== ids.key.slice(2) || LETTER_BASIN[head[3]] !== ids.basin2) return null;
    const synoptic = dtgMs(head[1]);
    if (synoptic === null) return null;
    const points: FeedPoint[] = [];
    for (const m of text.matchAll(/^T(\d{3})\s+(\d{2,3}[NS])\s+(\d{3,4}[EW])\s+(\d{3})/gm)) {
        const lat = atcfLat(m[2]);
        const lon = atcfLon(m[3]);
        if (lat === null || lon === null) continue;
        points.push({
            lat,
            lon,
            time: iso(synoptic + Number(m[1]) * 3_600_000),
            windKts: kt(Number(m[4])),
            pressureMb: null,
        });
    }
    if (points.length === 0) return null;
    // "WTPS31 PGTW 130900": issued at DDHHMM, near the synoptic time.
    const wmo = /^W\w{5}\s+PGTW\s+(\d{2})(\d{4})/m.exec(text);
    const issued = wmo ? validTimeNear(`${wmo[1]}/${wmo[2]}`, synoptic) : null;
    // "130900Z POSITION NEAR 17.1S 179.0E."
    const near = /^(\d{2})(\d{4})Z POSITION NEAR\s+(\d{1,2}\.\d)([NS])\s+(\d{1,3}\.\d)([EW])/m.exec(text);
    const nearAt = near ? validTimeNear(`${near[1]}/${near[2]}`, synoptic) : null;
    const current: FeedPoint = near && nearAt
        ? {
            lat: Number(near[3]) * (near[4] === 'S' ? -1 : 1),
            lon: lonOf(Number(near[5]) * (near[6] === 'W' ? -1 : 1)),
            time: nearAt,
            windKts: points[0].windKts,
            pressureMb: null,
        }
        : points[0];
    const past: FeedPoint[] = [];
    const tail = text.slice(text.indexOf('\n//') + 1);
    for (
        const m of tail.matchAll(
            /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+(\d{1,3}[NS])\s*(\d{1,4}[EW])\s+(\d{1,3})\s*$/gm,
        )
    ) {
        if (m[1] !== head[2]) continue;
        const t = dtgMs(`20${m[2]}${m[3]}${m[4]}${m[5]}`);
        const lat = atcfLat(m[6]);
        const lon = atcfLon(m[7]);
        if (t === null || lat === null || lon === null || t > synoptic) continue;
        past.push({ lat, lon, time: iso(t), windKts: kt(Number(m[8])), pressureMb: null });
    }
    return {
        key: ids.key,
        sid: ids.sid,
        name: head[4].toUpperCase(),
        basin: head[3],
        warning: advNum(head[5]),
        issued,
        current,
        points,
        past: byTime(past),
    };
}

/**
 * The first KML entry in a KMZ (zip), from its local file headers: where its
 * data starts and ends and how it is stored; 'more' when the bytes so far
 * stop inside it; null when this is no zip, or the entry hides its size.
 */
export function findKmlEntry(bytes: Uint8Array): { start: number; end: number; method: number } | 'more' | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    for (let i = 0; i < 64; i++) {
        if (at + 4 <= bytes.length && view.getUint32(at, true) !== 0x04034b50) return null;
        if (at + 30 > bytes.length) return 'more';
        const flags = view.getUint16(at + 6, true);
        const method = view.getUint16(at + 8, true);
        const size = view.getUint32(at + 18, true);
        const nameLen = view.getUint16(at + 26, true);
        const extraLen = view.getUint16(at + 28, true);
        if (at + 30 + nameLen > bytes.length) return 'more';
        const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
        if ((flags & 8) !== 0 && size === 0) return null;
        const start = at + 30 + nameLen + extraLen;
        const end = start + size;
        if (/\.kml$/i.test(name) && (method === 0 || method === 8)) {
            return end > bytes.length ? 'more' : { start, end, method };
        }
        at = end;
    }
    return null;
}

/** JTWC's "34 knot Danger Swath" placemark, as published; null where the KML has none. */
export function kmlDangerArea(kml: string): FeedPolygon | null {
    const mark = /<Placemark>(?:(?!<\/Placemark>)[\s\S])*?<name>[^<]*Danger Swath[^<]*<\/name>([\s\S]*?)<\/Placemark>/i
        .exec(kml);
    if (!mark) return null;
    const rings: number[][][] = [];
    for (const m of mark[1].matchAll(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)) {
        const ring = m[1]
            .trim()
            .split(/\s+/)
            .map((t) => t.split(',').map(Number))
            .filter((q) => q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) && Math.abs(q[1]) <= 90)
            .map((q) => [lonOf(q[0]), r3(q[1])]);
        if (ring.length >= 4) rings.push(ring);
    }
    if (rings.length === 0) return null;
    return rings.length === 1
        ? { type: 'Polygon', coordinates: rings }
        : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };
}

/** A KMZ's danger swath: the first KML entry, inflated, read. */
export async function readKmzDangerArea(bytes: Uint8Array): Promise<FeedPolygon | null> {
    const entry = findKmlEntry(bytes);
    if (!entry || entry === 'more') return null;
    const data = bytes.slice(entry.start, entry.end);
    try {
        let text: string;
        if (entry.method === 0) {
            text = new TextDecoder().decode(data);
        } else {
            // The lib types take any BufferSource on the way in; these streams carry bytes.
            const inflate = new DecompressionStream('deflate-raw') as unknown as TransformStream<
                Uint8Array,
                Uint8Array
            >;
            const reader = new ReadableStream<Uint8Array>({
                start(c) {
                    c.enqueue(data);
                    c.close();
                },
            })
                .pipeThrough(inflate)
                .getReader();
            const decoder = new TextDecoder();
            text = '';
            for (let total = 0;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                // A swath is tens of KB of KML; a bomb is not read through.
                if (total > 20_000_000) {
                    await reader.cancel().catch(() => undefined);
                    return null;
                }
                text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
        }
        return kmlDangerArea(text);
    } catch {
        return null;
    }
}

// ── NCEP TC vitals ──────────────────────────────────────────

export interface VitalsStorm {
    centre: string;
    key: string;
    sid: string;
    name: string;
    basin: string;
    current: FeedPoint;
}

/**
 * NCEP's TC vitals, by column (1-based): centre 1-4, id 6-8, name 10-18,
 * date 20-27, HHMM 29-32, lat 34-37, lon 39-43, central pressure 53-56,
 * maximum wind 68-69 (m/s). Invests (90-99) are not storms.
 */
export function parseTcvitals(text: string): VitalsStorm[] {
    const latest = new Map<string, VitalsStorm>();
    for (const line of String(text ?? '').split('\n')) {
        if (line.length < 69) continue;
        const centre = line.slice(0, 4).trim();
        const id = /^(\d{2})([A-Z])$/.exec(line.slice(5, 8));
        const basin2 = id ? LETTER_BASIN[id[2]] : undefined;
        const t = dtgMs(`${line.slice(19, 27)}${line.slice(28, 30)}`);
        const minutes = /^[0-5]\d$/.test(line.slice(30, 32)) ? Number(line.slice(30, 32)) : null;
        const lat = atcfLat(line.slice(33, 37));
        const lon = atcfLon(line.slice(38, 43));
        if (!/^[A-Z]{3,4}$/.test(centre) || !id || !basin2 || t === null || minutes === null) continue;
        if (lat === null || lon === null || Number(id[1]) >= 90) continue;
        const ms = t + minutes * 60_000;
        const key = `${basin2}${id[1]}`;
        const vmax = num(line.slice(67, 69));
        const pres = num(line.slice(52, 56));
        const v: VitalsStorm = {
            centre,
            key,
            sid: `${basin2.toLowerCase()}${id[1]}${seasonYear(basin2, ms)}`,
            name: line.slice(9, 18).trim().toUpperCase() || key,
            basin: id[2],
            current: {
                lat,
                lon,
                time: iso(ms),
                windKts: kt(vmax === null ? null : Math.round(vmax * 1.94384)),
                pressureMb: mb(pres),
            },
        };
        const held = latest.get(key);
        if (!held || Date.parse(held.current.time) <= ms) latest.set(key, v);
    }
    return [...latest.values()];
}

// ── The union ───────────────────────────────────────────────

/** A JTWC basin: NHC and CPHC are never the official centre there. */
export const jtwcBasin = (key: string) => !['AL', 'EP', 'CP'].includes(key.slice(0, 2));

/**
 * NHC or CPHC advise on this storm, so their track is the one read. By NHC's
 * own list when it answered: an East Pacific or Central Pacific storm that
 * crosses 180° keeps its E or C id, NHC's list drops it, and JTWC keeps
 * warning on it under that id. With no list, by the basin letters, and for an
 * AL/EP/CP storm by where it is (cycloneCentre), when a list gives a position.
 */
export function nhcAdvises(key: string, nhc: NhcStorm[] | null, at?: { lat: number; lon: number }): boolean {
    if (nhc) return nhc.some((n) => n.key === key);
    if (jtwcBasin(key)) return false;
    if (!at) return true;
    const centre = cycloneCentre(at.lat, at.lon).id;
    return centre === 'nhc' || centre === 'cphc';
}

/** The JTWC warnings whose own track Thalassa reads: every listed storm NHC and CPHC do not advise on. */
export function jtwcTrackWanted(
    listed: JtwcListing[],
    nhc: NhcStorm[] | null,
    vitals: VitalsStorm[] | null,
): JtwcListing[] {
    const at = new Map((vitals ?? []).map((v) => [v.key, v.current]));
    return listed.filter((l) => !nhcAdvises(l.key, nhc, at.get(l.key)));
}

export interface FeedInput {
    /** CurrentStorms.json, or null when it did not answer. */
    nhc: NhcStorm[] | null;
    /** By key: NOAA's track (with its cone and past), 'unavailable', or null (no points for it). */
    noaa: Map<string, FeedForecast | 'unavailable' | null>;
    /**
     * JTWC: the RSS's warnings, the products read, the products that failed (or
     * that one run did not reach); null when the RSS did not answer. A wanted
     * warning not in `storms` is unavailable whether or not it is in `failed`.
     */
    jtwc:
        | {
            listed: JtwcListing[];
            storms: (JtwcStorm & { cone?: FeedPolygon; coneUnavailable?: true })[];
            failed: string[];
        }
        | null;
    vitals: VitalsStorm[] | null;
    nowMs: number;
}

/** One storm list, keyed by basin and number, each storm with the official track or JTWC's. */
export function buildCycloneFeed(input: FeedInput): CycloneFeed {
    // The name, id and basin from the most authoritative list; the position from the newest.
    type Held = FeedStorm & { rank: number; posRank: number };
    const storms = new Map<string, Held>();
    const RANK: Record<FeedList, number> = { nhc: 3, jtwc: 2, vitals: 1 };
    const add = (
        list: FeedList,
        s: { key: string; sid: string; name: string; basin: string; current: FeedPoint },
        by: TrackIssuer,
        nature = '',
    ) => {
        const r = RANK[list];
        const held = storms.get(s.key);
        if (!held) {
            const { key, sid, name, basin, current } = s;
            storms.set(key, {
                key,
                sid,
                name,
                basin,
                nature,
                current,
                positionBy: by,
                from: [list],
                rank: r,
                posRank: r,
            });
            return;
        }
        held.from.push(list);
        const newer = Date.parse(s.current.time) - Date.parse(held.current.time);
        if (newer > 0 || (newer === 0 && r > held.posRank)) {
            held.current = s.current;
            held.positionBy = by;
            held.posRank = r;
        }
        if (r > held.rank) Object.assign(held, { rank: r, name: s.name, sid: s.sid, basin: s.basin });
        if (nature) held.nature = nature;
    };
    for (const n of input.nhc ?? []) add('nhc', n, n.by, n.nature);
    const jtwcByKey = new Map((input.jtwc?.storms ?? []).map((j) => [j.key, j]));
    // JMV cuts names at 10 letters ("TWENTYEIGH"); the RSS has them whole.
    const listedName = new Map((input.jtwc?.listed ?? []).map((l) => [l.key, l.name]));
    for (const j of jtwcByKey.values()) {
        const whole = listedName.get(j.key);
        add(
            'jtwc',
            whole && whole.length > j.name.length && whole.startsWith(j.name) ? { ...j, name: whole } : j,
            'JTWC',
        );
    }
    for (const v of input.vitals ?? []) {
        const centre = cycloneCentre(v.current.lat, v.current.lon).id;
        add('vitals', v, v.centre === 'JTWC' ? 'JTWC' : centre === 'cphc' ? 'CPHC' : 'NHC');
    }
    // Listed by JTWC though its track was not read (an NHC basin, or a product that failed).
    for (const l of input.jtwc?.listed ?? []) storms.get(l.key)?.from.push('jtwc');

    let noaa: SourceStatus = 'none';
    let jtwcTracks: SourceStatus = input.jtwc ? 'ok' : 'unavailable';
    // Wanted from JTWC and not read: failed, or past the products one run reads.
    const unread = new Set(input.jtwc?.failed ?? []);
    for (const l of jtwcTrackWanted(input.jtwc?.listed ?? [], input.nhc, input.vitals)) {
        if (!jtwcByKey.has(l.key)) unread.add(l.key);
    }
    const nhcListed = new Set((input.nhc ?? []).map((n) => n.key));
    for (const s of storms.values()) {
        const j = jtwcByKey.get(s.key);
        if (nhcListed.has(s.key) || (!j && nhcAdvises(s.key, input.nhc, s.current))) {
            const f = input.noaa.get(s.key);
            if (f && f !== 'unavailable') {
                s.forecast = f;
                if (noaa === 'none') noaa = 'ok';
            } else {
                // NHC or CPHC publish a track for every storm they advise on: none read is a failure.
                s.forecastUnavailable = true;
                noaa = 'unavailable';
            }
            continue;
        }
        if (j) {
            s.forecast = {
                by: 'JTWC',
                advisory: j.warning,
                issued: j.issued,
                points: j.points,
                past: j.past,
                ...(j.cone ? { cone: j.cone } : {}),
                ...(j.coneUnavailable ? { coneUnavailable: true as const } : {}),
            };
        } else if (!input.jtwc || unread.has(s.key)) {
            s.forecastUnavailable = true;
            jtwcTracks = 'unavailable';
        }
    }
    // Listed by JTWC, its product not read, and in no other list: no position to draw it at.
    const unplaced: UnplacedWarning[] = (input.jtwc?.listed ?? [])
        .filter((l) => !storms.has(l.key))
        .map(({ key, name, warning }) => ({ key, name, warning }));
    if (unplaced.length) jtwcTracks = 'unavailable';
    const list = [...storms.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ rank: _rank, posRank: _posRank, ...s }) => ({ ...s, from: [...new Set(s.from)].sort() as FeedList[] }));
    return {
        generatedAt: iso(input.nowMs),
        storms: list,
        sources: {
            nhc: input.nhc ? 'ok' : 'unavailable',
            jtwc: input.jtwc ? 'ok' : 'unavailable',
            vitals: input.vitals ? 'ok' : 'unavailable',
            noaa,
            jtwcTracks,
        },
        unplaced,
    };
}

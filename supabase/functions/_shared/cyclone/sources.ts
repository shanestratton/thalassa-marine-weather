/**
 * The cyclone feeds, fetched by cyclone-feed, fetch-gfs-tracker and
 * cyclone-watch (129-09, 129-09b: direct from the warning centres; no Esri,
 * no knackwx). Each returns null when its source does not answer, so a caller
 * can say the data is unavailable instead of reporting no storms. NHC, CPHC
 * and NCEP are public domain per weather.gov/disclaimer (read 2026-10-14).
 * JTWC is US military work (17 U.S.C. 105); JTWC's notice page could not be
 * read (CloudFront 403). Each is credited by name.
 *
 *   NHC storm list    www.nhc.noaa.gov/CurrentStorms.json: AL, EP, CP
 *   NHC/CPHC tracks   NOAA's NHC_tropical_weather MapServer, each storm's slot
 *                     (forecast points, cone, past points; GeoJSON)
 *   JTWC              www.metoc.navy.mil/jtwc: the RSS, each warning's JMV 3.0
 *                     file and the danger swath in its KMZ, read wherever
 *                     NHC/CPHC are not advising. JTWC's HTML pages refuse
 *                     automated requests (CloudFront 403, 2026-10-14); the RSS
 *                     and products answered. Only what answers is drawn, and
 *                     nothing here works around a refusal.
 *   NCEP TC vitals    nomads gfs.tCCz.syndata.tcvitals.tm00: every basin
 *   NCEP GFS tracker  nomads ens_tracker/prod/gfs.YYYYMMDD/CC/tctrack/
 *                     avno.tCCz.cyclone.trackatcfunix, every basin (the old
 *                     gfs.tCCz.atcfunix.all under atmos/ answers 403 now; it
 *                     is still tried after the new path)
 *   NHC a-decks       ftp.nhc.noaa.gov/atcf/aid_public, the storms in
 *                     CurrentStorms.json: every model NHC receives, AL/EP/CP
 *                     only (third-party model tracks such as ECMWF's are
 *                     credited by producer)
 * Every request here carries an honest User-Agent (ASK), is bounded in time
 * and size, and the feed is kept 10 minutes per isolate so the centres are
 * not asked per user.
 */
import { fetchWithTimeout, readResponseTextLimited } from '../http-security.ts';
import { latestGfsCycles } from './adeck.ts';
import {
    buildCycloneFeed,
    type CycloneFeed,
    type FeedForecast,
    type FeedInput,
    type FeedPolygon,
    findKmlEntry,
    jtwcBasin,
    type JtwcListing,
    type JtwcStorm,
    jtwcTrackWanted,
    type NhcStorm,
    noaaSlotLayers,
    parseCurrentStorms,
    parseJmv,
    parseJtwcRss,
    parseNoaaCone,
    parseNoaaPast,
    parseNoaaPoints,
    parseTcvitals,
    readKmzDangerArea,
    type VitalsStorm,
} from './feed.ts';

export const NHC_CURRENT_STORMS = 'https://www.nhc.noaa.gov/CurrentStorms.json';
export const NOAA_MAPSERVER =
    'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
export const JTWC_RSS = 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss';
const JTWC_PRODUCTS = 'https://www.metoc.navy.mil/jtwc/products/';
const NOMADS_GFS = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/';
const NOMADS_TRACKER = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/';
/** Who is asking, plainly: every request to the centres, and fetch-gfs-tracker's to NOMADS. */
export const ASK = { headers: { 'User-Agent': 'Thalassa cyclone feed (+https://thalassawx.com)' } };

/** A bounded JSON object whatever the content type says (ArcGIS sends geo+json or text). */
async function readJson(resp: Response, maxBytes: number): Promise<Record<string, unknown> | null> {
    const text = await readResponseTextLimited(resp, maxBytes);
    try {
        const value: unknown = text ? JSON.parse(text) : null;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** A bounded text body, or null when the source did not answer with one. */
async function fetchText(url: string, maxBytes: number, timeoutMs = 10_000): Promise<string | null> {
    try {
        const resp = await fetchWithTimeout(url, ASK, timeoutMs);
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => undefined);
            return null;
        }
        return await readResponseTextLimited(resp, maxBytes);
    } catch {
        return null;
    }
}

/** The GFS tracker file's URLs for a cycle: ens_tracker's tctrack first, then the old atmos/ one. */
export function gfsTrackerUrls(date: string, cycle: string): string[] {
    return [
        `${NOMADS_TRACKER}gfs.${date}/${cycle}/tctrack/avno.t${cycle}z.cyclone.trackatcfunix`,
        `${NOMADS_GFS}gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.atcfunix.all`,
    ];
}

/** The newest GFS tracker file NOMADS has, or null. */
export async function fetchGfsAtcfunix(nowMs: number): Promise<{ text: string; cycle: string } | null> {
    for (const { date, cycle } of latestGfsCycles(nowMs)) {
        for (const url of gfsTrackerUrls(date, cycle)) {
            const text = await fetchText(url, 5_000_000);
            if (text !== null && text.trim().length > 10 && !text.includes('<!DOCTYPE')) {
                return { text, cycle: `${date}${cycle}` };
            }
        }
    }
    return null;
}

/**
 * The lines of a gzipped (or plain) a-deck from a cut-off cycle on. Streamed:
 * a long-lived storm's a-deck is tens of MB unzipped, and the newest cycles
 * are at its end, so it is read through rather than truncated.
 */
export async function adeckLinesSince(resp: Response, sinceCycle: string): Promise<string | null> {
    if (!resp.body) return null;
    const reader = resp.body.getReader();
    const head = await reader.read();
    if (head.done || !head.value) return null;
    const first = head.value;
    const restream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(first);
        },
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
        },
        cancel() {
            return reader.cancel();
        },
    });
    const gz = first[0] === 0x1f && first[1] === 0x8b;
    // The lib types take any BufferSource on the way in; these streams carry bytes.
    const gunzip = new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
    const decode = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>;
    const text = (gz ? restream.pipeThrough(gunzip) : restream).pipeThrough(decode);
    const lines = text.getReader();
    const kept: string[] = [];
    let partial = '';
    let total = 0;
    while (true) {
        const { done, value } = await lines.read();
        if (done) break;
        total += value.length;
        if (total > 300_000_000) {
            await lines.cancel().catch(() => undefined);
            return null;
        }
        const parts = (partial + value).split('\n');
        partial = parts.pop() ?? '';
        for (const line of parts) {
            if ((line.split(',', 3)[2] ?? '').trim() >= sinceCycle) kept.push(line);
        }
        if (kept.length > 40_000) kept.splice(0, kept.length - 40_000);
    }
    if ((partial.split(',', 3)[2] ?? '').trim() >= sinceCycle) kept.push(partial);
    return kept.join('\n');
}

/** NHC updates its a-decks a few times per cycle; a warm isolate reuses them for 20 min. */
let nhcCache: { at: number; value: { text: string; storms: number } } | null = null;

/** Every model track in NHC's public a-decks for its active storms (at most six), or null. */
export async function fetchNhcAdecks(nowMs: number): Promise<{ text: string; storms: number } | null> {
    if (nhcCache && nowMs - nhcCache.at < 20 * 60_000) return nhcCache.value;
    try {
        const list = await fetchWithTimeout(NHC_CURRENT_STORMS, ASK, 8_000);
        if (!list.ok) {
            await list.body?.cancel().catch(() => undefined);
            return null;
        }
        const json = await readJson(list, 1_000_000);
        const active = Array.isArray(json?.activeStorms) ? json.activeStorms : null;
        if (!active) return null;
        const ids = active
            .map((s) => String((s as { id?: unknown })?.id ?? '').toLowerCase())
            .filter((id) => /^(al|ep|cp)\d{6}$/.test(id))
            .slice(0, 6);
        const since = new Date(nowMs - 36 * 3_600_000).toISOString().replace(/\D/g, '').slice(0, 10);
        const texts: string[] = [];
        for (const id of ids) {
            try {
                const resp = await fetchWithTimeout(
                    `https://ftp.nhc.noaa.gov/atcf/aid_public/a${id}.dat.gz`,
                    ASK,
                    20_000,
                );
                if (!resp.ok) {
                    await resp.body?.cancel().catch(() => undefined);
                    continue;
                }
                const text = await adeckLinesSince(resp, since);
                if (text) texts.push(text);
            } catch {
                // one storm's a-deck missing does not lose the others
            }
        }
        const value = { text: texts.join('\n'), storms: texts.length };
        if (texts.length === ids.length) nhcCache = { at: nowMs, value };
        return value;
    } catch {
        return null;
    }
}

// ── The warning centres' feed (129-09b) ────────────────────

/** CurrentStorms.json's storms, or null when it does not answer. */
async function fetchNhcStorms(): Promise<NhcStorm[] | null> {
    try {
        const resp = await fetchWithTimeout(NHC_CURRENT_STORMS, ASK, 8_000);
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => undefined);
            return null;
        }
        return parseCurrentStorms(await readJson(resp, 1_000_000));
    } catch {
        return null;
    }
}

let layerCache: { at: number; value: Record<string, unknown> } | null = null;

/** The MapServer's layer list (names to ids), kept 6 h: the slots' numbering is the service's, not ours. */
async function noaaLayers(nowMs: number): Promise<Record<string, unknown> | null> {
    if (layerCache && nowMs - layerCache.at >= 0 && nowMs - layerCache.at < 6 * 3_600_000) return layerCache.value;
    try {
        const resp = await fetchWithTimeout(`${NOAA_MAPSERVER}?f=json`, ASK, 10_000);
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => undefined);
            return null;
        }
        const value = await readJson(resp, 2_000_000);
        if (value && Array.isArray(value.layers)) layerCache = { at: nowMs, value };
        return value && Array.isArray(value.layers) ? value : null;
    } catch {
        return null;
    }
}

/** One layer of the MapServer as GeoJSON, or null when it does not answer. */
async function noaaQuery(id: number, fields: string, extra = ''): Promise<Record<string, unknown> | null> {
    try {
        const url = `${NOAA_MAPSERVER}/${id}/query?where=1%3D1&outFields=${fields}${extra}&f=geojson`;
        const resp = await fetchWithTimeout(url, ASK, 10_000);
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => undefined);
            return null;
        }
        const json = await readJson(resp, 3_000_000);
        return json && Array.isArray(json.features) ? json : null;
    } catch {
        return null;
    }
}

/** Each NHC/CPHC storm's own track from its slot: its points, cone and past; 'unavailable' when they did not come. */
async function fetchNoaaTracks(storms: NhcStorm[], nowMs: number): Promise<FeedInput['noaa']> {
    const out: FeedInput['noaa'] = new Map();
    const service = storms.some((s) => s.bin) ? await noaaLayers(nowMs) : null;
    await Promise.all(
        storms.slice(0, 15).map(async (storm) => {
            const slot = storm.bin && service ? noaaSlotLayers(service, storm.bin) : null;
            if (!slot) {
                out.set(storm.key, 'unavailable');
                return;
            }
            const [points, cone, past] = await Promise.all([
                noaaQuery(slot.points, 'stormnum,basin,advisnum,advdate,validtime,tau,maxwind,mslp'),
                noaaQuery(slot.cone, 'stormnum,basin,advisnum', '&geometryPrecision=3'),
                noaaQuery(slot.past, 'stormnum,basin,dtg,intensity,mslp'),
            ]);
            const forecast: FeedForecast | null = points ? parseNoaaPoints(points, storm) : null;
            if (!forecast) {
                out.set(storm.key, 'unavailable');
                return;
            }
            const area = cone ? parseNoaaCone(cone, storm) : null;
            out.set(storm.key, {
                ...forecast,
                past: past ? parseNoaaPast(past, storm) : [],
                ...(area ? { cone: area } : {}),
                ...(cone ? {} : { coneUnavailable: true as const }),
            });
        }),
    );
    return out;
}

/**
 * A KMZ's danger swath, reading only as far as its first KML entry (JTWC's
 * doc.kml leads; the logos after it are most of the file); 'unavailable' when
 * the product did not come.
 */
async function fetchKmzArea(url: string): Promise<FeedPolygon | null | 'unavailable'> {
    try {
        const resp = await fetchWithTimeout(url, ASK, 15_000);
        if (!resp.ok || !resp.body) {
            await resp.body?.cancel().catch(() => undefined);
            return 'unavailable';
        }
        const reader = resp.body.getReader();
        let buf = new Uint8Array(0);
        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                const next = new Uint8Array(buf.length + value.length);
                next.set(buf);
                next.set(value, buf.length);
                buf = next;
            }
            const entry = findKmlEntry(buf);
            if (entry !== 'more' || done || buf.length > 3_000_000) {
                await reader.cancel().catch(() => undefined);
                return entry === null || entry === 'more' ? 'unavailable' : await readKmzDangerArea(buf);
            }
        }
    } catch {
        return 'unavailable';
    }
}

type JtwcRead = JtwcStorm & { cone?: FeedPolygon; coneUnavailable?: true };
/** Each JTWC product read, by product and warning number: a new warning is read again. */
const jtwcCache = new Map<string, { warning: string; storm: JtwcRead }>();
/** JTWC's products one run reads, at most: one after another, never a burst. */
const JTWC_PRODUCTS_PER_RUN = 10;

/** One warning's track and danger area, or null when its JMV file did not come. */
async function readJtwcProduct(l: JtwcListing): Promise<JtwcRead | null> {
    const held = jtwcCache.get(l.product);
    if (held && held.warning === l.warning) return held.storm;
    const text = await fetchText(`${JTWC_PRODUCTS}${l.product}.tcw`, 300_000);
    const jmv = text === null ? null : parseJmv(text, l.product);
    if (!jmv) return null;
    const area = await fetchKmzArea(`${JTWC_PRODUCTS}${l.product}.kmz`);
    const storm: JtwcRead = area === 'unavailable'
        ? { ...jmv, coneUnavailable: true }
        : area
        ? { ...jmv, cone: area }
        : jmv;
    if (area !== 'unavailable') jtwcCache.set(l.product, { warning: l.warning, storm });
    return storm;
}

/**
 * JTWC's warnings and the track and danger area of each one NHC and CPHC do
 * not advise on; null when the RSS does not answer. The JTWC basins are read
 * at once; an AL/EP/CP warning only once NHC's list (and the vitals) say NHC
 * is not advising on it: a storm past 180° keeps its E or C id. A wanted
 * warning past the products one run reads is listed in `failed`, so it is
 * said to be unavailable, never left out.
 */
async function fetchJtwc(
    nhcList: Promise<NhcStorm[] | null>,
    vitalsList: Promise<VitalsStorm[] | null>,
): Promise<FeedInput['jtwc']> {
    const rss = await fetchText(JTWC_RSS, 500_000);
    if (rss === null || !/<rss[\s>]/i.test(rss)) return null;
    const listed = parseJtwcRss(rss);
    const storms: JtwcRead[] = [];
    const failed: string[] = [];
    const read = async (wanted: JtwcListing[]) => {
        for (const l of wanted) {
            const storm = storms.length + failed.length < JTWC_PRODUCTS_PER_RUN ? await readJtwcProduct(l) : null;
            if (storm) storms.push(storm);
            else failed.push(l.key);
        }
    };
    await read(listed.filter((l) => jtwcBasin(l.key)));
    const [nhc, vitals] = await Promise.all([nhcList, vitalsList]);
    await read(jtwcTrackWanted(listed, nhc, vitals).filter((l) => !jtwcBasin(l.key)));
    return { listed, storms, failed };
}

/** The newest TC vitals NOMADS has (written at the cycle; up to the two before it), or null. */
async function fetchVitals(nowMs: number): Promise<VitalsStorm[] | null> {
    const latest = Math.floor((nowMs - 3 * 3_600_000) / 21_600_000) * 21_600_000;
    for (const t of [latest, latest - 21_600_000, latest - 43_200_000]) {
        const d = new Date(t).toISOString();
        const date = d.slice(0, 10).replace(/-/g, '');
        const cycle = d.slice(11, 13);
        const text = await fetchText(
            `${NOMADS_GFS}gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.syndata.tcvitals.tm00`,
            500_000,
        );
        if (text !== null && !text.includes('<')) return parseTcvitals(text);
    }
    return null;
}

let feedCache: { at: number; value: CycloneFeed | null } | null = null;

/** For tests: forget the isolate's copies. */
export function forgetCycloneFeedCache(): void {
    feedCache = null;
    layerCache = null;
    jtwcCache.clear();
}

/**
 * The storm list and each storm's issuer track, direct from the centres; null
 * when no storm list answered (the caller says "unavailable", never "no
 * storms"). Kept 10 min per isolate (a failure 1 min).
 */
export async function fetchCycloneFeed(nowMs: number): Promise<CycloneFeed | null> {
    if (feedCache && nowMs >= feedCache.at && nowMs - feedCache.at < (feedCache.value ? 10 : 1) * 60_000) {
        return feedCache.value;
    }
    const nhcList = fetchNhcStorms();
    const vitalsList = fetchVitals(nowMs);
    const [nhc, jtwc, vitals, noaa] = await Promise.all([
        nhcList,
        fetchJtwc(nhcList, vitalsList),
        vitalsList,
        nhcList.then((list) => (list ? fetchNoaaTracks(list, nowMs) : new Map())),
    ]);
    const value = nhc || jtwc || vitals ? buildCycloneFeed({ nhc, noaa, jtwc, vitals, nowMs }) : null;
    feedCache = { at: nowMs, value };
    return value;
}

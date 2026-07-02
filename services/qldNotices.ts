/**
 * qldNotices — LIVE Maritime Safety Queensland Notices to Mariners, the whole
 * QLD coast, each linked DIRECTLY to its PDF.
 *
 * MSQ publishes notices through the Queensland Government CKAN portal
 * (publications.qld.gov.au) as one dataset per pilotage region — 30 datasets
 * covering Brisbane to Thursday Island — and the CKAN JSON API exposes every
 * notice as a resource: `name` = "364 T of 2026", `description` =
 * "02/07/2026: Mooloolah River bar — shoaling and dredging", `url` = the PDF.
 * That description prefix gives us the LOCALITY, which a curated gazetteer
 * turns into chart coordinates — so the 📄 icon at Mooloolaba always opens the
 * CURRENT bar notice, not a stale hand-copied link.
 *
 * Fetch discipline: parallel-capped package_show calls, 12 h localStorage
 * cache of the PARSED form, fail-quiet per dataset (a broken region never
 * blanks the coast). Native Capacitor fetch has no CORS constraint; on web
 * dev the fetch may be CORS-blocked and the curated bundled notices remain
 * the fallback.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('qldNotices');

const CKAN_BASE = 'https://www.publications.qld.gov.au';
const DATASET_PAGE = (slug: string): string => `${CKAN_BASE}/dataset/${slug}`;
const API = (slug: string): string => `${CKAN_BASE}/api/3/action/package_show?id=${slug}`;

/** Every MSQ Notices-to-Mariners dataset on the QLD CKAN portal (2026-07). */
const DATASETS: { slug: string; region: string }[] = [
    { slug: 'brisbane-notices-to-mariners', region: 'Brisbane' },
    { slug: 'south-east-queensland-outside-pilotage-areas-notices-to-mariners', region: 'South East Queensland' },
    { slug: 'southport-notices-to-mariners', region: 'Southport / Gold Coast' },
    { slug: 'noosa-notices-to-mariners', region: 'Noosa' },
    { slug: 'maryborough-notices-to-mariners', region: 'Maryborough / Great Sandy' },
    { slug: 'bundaberg-notices-to-mariners', region: 'Bundaberg' },
    { slug: 'gladstone-notices-to-mariners', region: 'Gladstone' },
    { slug: 'rockhampton-notices-to-mariners', region: 'Rockhampton' },
    { slug: 'capricorn-coast-outside-pilotage-areas-notices-to-mariners', region: 'Capricorn Coast' },
    { slug: 'central-queensland-outside-pilotage-areas-notices-to-mariners', region: 'Central Queensland' },
    { slug: 'mackay-notices-to-mariners', region: 'Mackay' },
    { slug: 'hay-point-notices-to-mariners', region: 'Hay Point' },
    { slug: 'whitsundays-notices-to-mariners', region: 'Whitsundays' },
    { slug: 'abbot-point-notices-to-mariners', region: 'Abbot Point / Bowen' },
    { slug: 'townsville-notices-to-mariners', region: 'Townsville' },
    { slug: 'lucinda-notices-to-mariners', region: 'Lucinda' },
    { slug: 'mourilyan-notices-to-mariners', region: 'Mourilyan' },
    { slug: 'cairns-notices-to-mariners', region: 'Cairns' },
    { slug: 'daintree-river-and-port-douglas-pilotage-areas-notices-to-mariners', region: 'Port Douglas / Daintree' },
    { slug: 'cape-flattery-and-cooktown-notices-to-mariners', region: 'Cooktown / Cape Flattery' },
    { slug: 'north-queensland-outside-pilotage-areas-notices-to-mariners', region: 'North Queensland' },
    { slug: 'far-north-queensland-outside-pilotage-areas-notices-to-mariners', region: 'Far North Queensland' },
    { slug: 'weipa-notices-to-mariners', region: 'Weipa' },
    { slug: 'skardon-river-notices-to-mariners', region: 'Skardon River' },
    { slug: 'amrun-notices-to-mariners', region: 'Amrun' },
    { slug: 'thursday-island-notices-to-mariners', region: 'Thursday Island' },
    { slug: 'karumba-notices-to-mariners', region: 'Karumba' },
    { slug: 'notices-and-advice-to-mariners-affecting-multiple-areas-in-queensland', region: 'Multiple areas' },
];

/**
 * Locality gazetteer — keyword(s) in the notice description → chart position.
 * First match wins; keywords lowercase. Positions are icon anchors (approx
 * waterway mouths / reaches), NOT navigation data.
 */
const GAZETTEER: { keys: string[]; lat: number; lon: number; label: string }[] = [
    {
        keys: ['mooloolah river bar', 'mooloolah river', 'mooloolaba'],
        lat: -26.6862,
        lon: 153.134,
        label: 'Mooloolaba',
    },
    { keys: ['maroochy river', 'maroochydore'], lat: -26.643, lon: 153.105, label: 'Maroochy River' },
    { keys: ['noosa river', 'noosa bar', 'noosa'], lat: -26.381, lon: 153.092, label: 'Noosa' },
    { keys: ['caloundra'], lat: -26.806, lon: 153.142, label: 'Caloundra' },
    { keys: ['pumicestone'], lat: -27.06, lon: 153.13, label: 'Pumicestone Passage' },
    { keys: ['bribie'], lat: -27.07, lon: 153.15, label: 'Bribie Island' },
    { keys: ['town reach', 'brisbane river'], lat: -27.44, lon: 153.09, label: 'Brisbane River' },
    { keys: ['pinkenba', 'fisherman island', 'port of brisbane'], lat: -27.39, lon: 153.17, label: 'Port of Brisbane' },
    { keys: ['manly'], lat: -27.45, lon: 153.19, label: 'Manly' },
    { keys: ['scarborough', 'newport', 'redcliffe'], lat: -27.195, lon: 153.11, label: 'Redcliffe / Newport' },
    { keys: ['cabbage tree creek', 'shorncliffe'], lat: -27.32, lon: 153.08, label: 'Cabbage Tree Creek' },
    { keys: ['eprapah'], lat: -27.57, lon: 153.3, label: 'Eprapah Creek' },
    { keys: ['coochiemudlo'], lat: -27.57, lon: 153.33, label: 'Coochiemudlo' },
    { keys: ['russell island'], lat: -27.65, lon: 153.38, label: 'Russell Island' },
    { keys: ['macleay island'], lat: -27.61, lon: 153.36, label: 'Macleay Island' },
    { keys: ['redland bay'], lat: -27.61, lon: 153.32, label: 'Redland Bay' },
    { keys: ['canaipa'], lat: -27.7, lon: 153.35, label: 'Canaipa Passage' },
    { keys: ['jumpinpin'], lat: -27.73, lon: 153.43, label: 'Jumpinpin' },
    { keys: ['south passage', 'amity'], lat: -27.34, lon: 153.42, label: 'South Passage' },
    { keys: ['tangalooma', 'moreton island'], lat: -27.18, lon: 153.37, label: 'Moreton Island' },
    {
        keys: ['gold coast seaway', 'southport', 'broadwater', 'the spit'],
        lat: -27.94,
        lon: 153.43,
        label: 'Gold Coast Seaway',
    },
    { keys: ['nerang river', 'chevron island', 'surfers paradise'], lat: -27.97, lon: 153.42, label: 'Nerang River' },
    { keys: ['coomera'], lat: -27.86, lon: 153.35, label: 'Coomera River' },
    { keys: ['currumbin'], lat: -28.13, lon: 153.49, label: 'Currumbin Creek' },
    { keys: ['tallebudgera'], lat: -28.11, lon: 153.45, label: 'Tallebudgera Creek' },
    { keys: ['wide bay bar', 'inskip'], lat: -25.79, lon: 153.03, label: 'Wide Bay Bar' },
    { keys: ['tin can bay'], lat: -25.91, lon: 153.0, label: 'Tin Can Bay' },
    { keys: ['great sandy strait'], lat: -25.5, lon: 152.95, label: 'Great Sandy Strait' },
    { keys: ['mary river'], lat: -25.44, lon: 152.91, label: 'Mary River' },
    { keys: ['urangan', 'hervey bay'], lat: -25.29, lon: 152.91, label: 'Hervey Bay' },
    { keys: ['burrum'], lat: -25.19, lon: 152.61, label: 'Burrum River' },
    { keys: ['burnett river', 'bundaberg'], lat: -24.76, lon: 152.39, label: 'Burnett River' },
    { keys: ['round hill', '1770', 'seventeen seventy'], lat: -24.16, lon: 151.88, label: 'Round Hill Creek (1770)' },
    { keys: ['gladstone', 'auckland creek'], lat: -23.83, lon: 151.25, label: 'Gladstone' },
    { keys: ['boyne'], lat: -23.95, lon: 151.35, label: 'Boyne River' },
    { keys: ['rosslyn bay', 'keppel'], lat: -23.16, lon: 150.79, label: 'Rosslyn Bay / Keppel' },
    { keys: ['fitzroy river', 'rockhampton'], lat: -23.38, lon: 150.52, label: 'Fitzroy River' },
    { keys: ['mackay'], lat: -21.1, lon: 149.22, label: 'Mackay' },
    { keys: ['hay point'], lat: -21.28, lon: 149.3, label: 'Hay Point' },
    { keys: ['airlie', 'shute harbour', 'whitsunday'], lat: -20.28, lon: 148.75, label: 'Whitsundays' },
    { keys: ['bowen'], lat: -20.01, lon: 148.25, label: 'Bowen' },
    { keys: ['abbot point'], lat: -19.88, lon: 148.08, label: 'Abbot Point' },
    { keys: ['ross river', 'townsville'], lat: -19.25, lon: 146.83, label: 'Townsville' },
    { keys: ['magnetic island'], lat: -19.16, lon: 146.85, label: 'Magnetic Island' },
    { keys: ['hinchinbrook', 'lucinda'], lat: -18.52, lon: 146.33, label: 'Lucinda / Hinchinbrook' },
    { keys: ['cardwell'], lat: -18.27, lon: 146.03, label: 'Cardwell' },
    { keys: ['mourilyan'], lat: -17.6, lon: 146.12, label: 'Mourilyan' },
    { keys: ['johnstone river', 'innisfail'], lat: -17.51, lon: 146.07, label: 'Johnstone River' },
    { keys: ['trinity inlet', 'cairns'], lat: -16.92, lon: 145.78, label: 'Cairns' },
    { keys: ['port douglas', 'dickson inlet'], lat: -16.48, lon: 145.47, label: 'Port Douglas' },
    { keys: ['daintree'], lat: -16.28, lon: 145.45, label: 'Daintree River' },
    { keys: ['cooktown', 'endeavour river'], lat: -15.46, lon: 145.25, label: 'Cooktown' },
    { keys: ['cape flattery'], lat: -14.97, lon: 145.35, label: 'Cape Flattery' },
    { keys: ['weipa', 'embley'], lat: -12.67, lon: 141.87, label: 'Weipa' },
    { keys: ['skardon'], lat: -11.76, lon: 142.11, label: 'Skardon River' },
    { keys: ['amrun'], lat: -12.96, lon: 141.72, label: 'Amrun' },
    { keys: ['thursday island', 'torres strait'], lat: -10.58, lon: 142.22, label: 'Thursday Island' },
    { keys: ['karumba', 'norman river'], lat: -17.48, lon: 140.83, label: 'Karumba' },
];

export interface QldNotice {
    /** e.g. "364 T of 2026" */
    number: string;
    /** e.g. "Mooloolah River bar — shoaling and dredging" */
    subject: string;
    /** DD/MM/YYYY from the description prefix, verbatim. */
    dateStr: string;
    region: string;
    /** Direct PDF link — the thing that is "very difficult to find". */
    pdfUrl: string;
    /** The dataset (region) page as the always-valid fallback. */
    datasetUrl: string;
    /** Gazetteer match (absent = list-only, no chart icon). */
    lat?: number;
    lon?: number;
    localityLabel?: string;
    /** Epoch ms of the CKAN resource creation (recency sort). */
    createdMs: number;
}

const CACHE_KEY = 'thalassa_qld_ntm_v1';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CachePayload {
    fetchedAt: number;
    notices: QldNotice[];
}

function loadCache(): CachePayload | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachePayload;
        return Array.isArray(parsed?.notices) ? parsed : null;
    } catch {
        return null;
    }
}

function saveCache(p: CachePayload): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    } catch {
        /* quota — ignore */
    }
}

/** "02/07/2026: Mooloolah River bar — shoaling and dredging\n…" → parts. Exported for tests. */
export function parseDescription(desc: string): { dateStr: string; locality: string; subject: string } {
    const firstLine = (desc ?? '').split('\n')[0].trim();
    const m = /^(\d{2}\/\d{2}\/\d{4}):\s*(.*)$/.exec(firstLine);
    const body = m ? m[2] : firstLine;
    const dateStr = m ? m[1] : '';
    // Locality is the text before the em/en dash separator when present.
    const dash = body.search(/\s[—–-]\s/);
    const locality = dash > 0 ? body.slice(0, dash) : body;
    return { dateStr, locality, subject: body };
}

/** Exported for tests. */
export function gazetteerMatch(text: string): { lat: number; lon: number; label: string } | null {
    const t = text.toLowerCase();
    for (const g of GAZETTEER) {
        if (g.keys.some((k) => t.includes(k))) return { lat: g.lat, lon: g.lon, label: g.label };
    }
    return null;
}

/**
 * When the live feed was last successfully fetched (epoch ms), or null if
 * never. ntmRouting's fail-closed currency check keys off this: a routing
 * pack cannot be vouched by a cache older than its verify horizon.
 */
export function qldNoticesFetchedAt(): number | null {
    return loadCache()?.fetchedAt ?? null;
}

let inflight: Promise<QldNotice[]> | null = null;

/** All current QLD notices (cache-first, 12 h TTL). Fail-quiet per dataset. */
export async function loadQldNotices(force = false): Promise<QldNotice[]> {
    const cached = loadCache();
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.notices;
    if (inflight) return inflight;
    inflight = (async () => {
        const out: QldNotice[] = [];
        let okDatasets = 0;
        // Parallel-capped: 6 at a time keeps the portal happy.
        const queue = [...DATASETS];
        const worker = async (): Promise<void> => {
            for (;;) {
                const ds = queue.shift();
                if (!ds) return;
                try {
                    const res = await fetch(API(ds.slug));
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const body = (await res.json()) as {
                        success?: boolean;
                        result?: { resources?: Array<Record<string, unknown>> };
                    };
                    if (!body.success || !body.result?.resources) throw new Error('bad CKAN payload');
                    okDatasets++;
                    for (const r of body.result.resources) {
                        const url = typeof r.url === 'string' ? r.url : '';
                        if (!url) continue;
                        const { dateStr, locality, subject } = parseDescription(
                            typeof r.description === 'string' ? r.description : '',
                        );
                        const geo = gazetteerMatch(`${locality} ${subject}`);
                        const created = typeof r.created === 'string' ? Date.parse(r.created) : NaN;
                        out.push({
                            number: typeof r.name === 'string' ? r.name : 'Notice',
                            subject,
                            dateStr,
                            region: ds.region,
                            pdfUrl: url,
                            datasetUrl: DATASET_PAGE(ds.slug),
                            ...(geo ? { lat: geo.lat, lon: geo.lon, localityLabel: geo.label } : {}),
                            createdMs: Number.isFinite(created) ? created : 0,
                        });
                    }
                } catch (err) {
                    log.warn(`[qldNtm] ${ds.slug} failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (okDatasets === 0) {
            log.warn('[qldNtm] every dataset failed — serving stale cache if present');
            return cached?.notices ?? [];
        }
        out.sort((a, b) => b.createdMs - a.createdMs);
        saveCache({ fetchedAt: Date.now(), notices: out });
        const geocoded = out.filter((n) => n.lat !== undefined).length;
        log.warn(`[qldNtm] loaded ${out.length} notices across ${okDatasets} regions (${geocoded} geocoded)`);
        return out;
    })().finally(() => {
        inflight = null;
    });
    return inflight;
}

/** Geocoded notices grouped by anchor (one chart icon per locality). */
export function groupByAnchor(notices: readonly QldNotice[]): Map<string, QldNotice[]> {
    const groups = new Map<string, QldNotice[]>();
    for (const n of notices) {
        if (n.lat === undefined || n.lon === undefined) continue;
        const key = n.localityLabel ?? `${n.lat},${n.lon}`;
        const arr = groups.get(key);
        if (arr) arr.push(n);
        else groups.set(key, [n]);
    }
    return groups;
}

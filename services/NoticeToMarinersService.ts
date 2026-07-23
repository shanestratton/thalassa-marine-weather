/**
 * NoticeToMarinersService — multi-source navigational warning aggregator.
 *
 * Fetches active in-force warnings from each available national hydrographic
 * office, normalises every warning into the same `Notice` shape (parses
 * embedded coordinates out of the free-text body), and caches the merged
 * result in localStorage so the browse view is instant on subsequent opens.
 *
 * Sources (each contributes independently — one failing doesn't break the
 * others, see Promise.allSettled in refresh()):
 *   • NGA MSI broadcast-warn   — NAVAREA IV + XII, HYDROLANT/PAC/ARC
 *                                 (US-coordinated SafetyNET areas).
 *   • AMSA MSI bulletin scrape — NAVAREA X (AHO / JRCC AUSTRALIA),
 *                                 via the proxy-amsa-msi edge function.
 *   • UKHO MSI scrape          — NAVAREA I (NE Atlantic) + UK Coastal WZ,
 *                                 via the proxy-ukho-msi edge function.
 *   • LINZ / Maritime NZ       — NAVAREA XIV (South Pacific) + NZ coastal,
 *                                 via proxy-linz-msi. Maritime NZ sits
 *                                 behind a Cloudflare JS challenge that
 *                                 Deno fetch can't solve, so a GitHub
 *                                 Actions cron runs Playwright every 6h
 *                                 to populate the linz_warnings table —
 *                                 see scripts/linz-msi-scrape/.
 *
 * Coming soon: other national hydrographic offices (II France, III Spain,
 * V Brazil, …) behind the same shape.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('NoticeToMariners');

// ── Types ─────────────────────────────────────────────────────────────────

/** NAVAREA / HYDRO region code as returned by the API.
 *  NGA  publishes 4 / 12 / A / C / P.
 *  AMSA publishes X    — NAVAREA X (Australian-coordinated SafetyNET).
 *  UKHO publishes I, WZ — NAVAREA I (NE Atlantic) + UK Coastal Warnings.
 *  LINZ publishes XIV, NZC — NAVAREA XIV (South Pacific) + NZ Coastal.
 *  Future sources drop in as additional codes. */
export type NgaAreaCode = '4' | '12' | 'A' | 'C' | 'P' | 'X' | 'I' | 'WZ' | 'XIV' | 'NZC' | string;

export interface Notice {
    /** Stable id — `${navArea}-${msgYear}/${msgNumber}` (NGA cross-lists the same message across areas). */
    id: string;
    msgYear: number;
    msgNumber: number;
    /** Raw code from API (e.g. "4", "12", "C", "P", "A") */
    navArea: NgaAreaCode;
    /** Human label — "NAVAREA IV", "HYDROPAC", etc. */
    areaLabel: string;
    subregion: string;
    /** Raw issue date string from API — e.g. "022338Z SEP 2021" */
    issueDate: string;
    /** Best-effort parsed date; null if unparsable. */
    issueDateParsed: Date | null;
    authority: string;
    /** Full free-text body. */
    text: string;
    /** First meaningful line, capped — good for list preview. */
    title: string;
    /** Coordinates extracted from the text. */
    coordinates: Array<{ lat: number; lon: number }>;
    status: string;
}

// ── Endpoint ──────────────────────────────────────────────────────────────

// Native Capacitor has no CORS restrictions, so it can hit the real URL.
// Web uses the Vite dev proxy locally and the proxy-nga-msi Supabase edge
// function in production.
function isNative(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return !!(globalThis as any).Capacitor?.isNativePlatform?.();
    } catch {
        return false;
    }
}

// Edge-function endpoint resolver shared by every NHO source we scrape
// server-side. Returns null when no Supabase project is configured so
// each source's fetcher can no-op silently rather than throwing.
function edgeFunctionEndpoint(name: string): { url: string; headers: Record<string, string> } | null {
    const supabaseUrl =
        (typeof import.meta !== 'undefined' &&
            (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL) ||
        '';
    const supabaseAnonKey =
        (typeof import.meta !== 'undefined' &&
            (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY) ||
        '';
    if (!supabaseUrl || !supabaseAnonKey) return null;
    return {
        url: `${supabaseUrl}/functions/v1/${name}`,
        headers: {
            Authorization: `Bearer ${supabaseAnonKey}`,
            apikey: supabaseAnonKey,
        },
    };
}

function ngaEndpoint(): { url: string; headers?: Record<string, string> } {
    if (isNative()) {
        return { url: 'https://msi.nga.mil/api/publications/broadcast-warn?output=json' };
    }

    // Vite owns this same-origin path during local development. In deployed
    // web builds, use the edge function so NGA's lack of browser CORS headers
    // does not silently remove the largest warning source.
    return edgeFunctionEndpoint('proxy-nga-msi') ?? { url: '/api/nga-msi/broadcast-warn?output=json' };
}

// AMSA NAVAREA X proxy — scrapes the AMSA bulletin board.
function amsaEndpoint() {
    return edgeFunctionEndpoint('proxy-amsa-msi');
}
// UKHO NAVAREA I + UK Coastal WZ proxy — scrapes msi.admiralty.co.uk.
function ukhoEndpoint() {
    return edgeFunctionEndpoint('proxy-ukho-msi');
}
// LINZ NAVAREA XIV + NZ Coastal — reads the linz_warnings table that
// the GitHub Actions Playwright cron populates (Cloudflare workaround).
function linzEndpoint() {
    return edgeFunctionEndpoint('proxy-linz-msi');
}

// ── Area labels ───────────────────────────────────────────────────────────

const AREA_LABELS: Record<string, string> = {
    '4': 'NAVAREA IV',
    '12': 'NAVAREA XII',
    C: 'HYDROLANT',
    P: 'HYDROPAC',
    A: 'HYDROARC',
    X: 'NAVAREA X',
    I: 'NAVAREA I',
    WZ: 'UK Coastal',
    XIV: 'NAVAREA XIV',
    NZC: 'NZ Coastal',
};

export function labelFor(code: string): string {
    return AREA_LABELS[code] || `AREA ${code}`;
}

// Rough bounding boxes for each NGA-published region. Used for "notices
// near me" filtering. These are approximate — the real NAVAREA polygons
// are complex, but a bbox gets us close enough for relevance ranking.
// [west, south, east, north]
const AREA_BOUNDS: Record<string, [number, number, number, number]> = {
    '4': [-98, 7, -30, 67], // NAVAREA IV — Caribbean + N Atlantic W
    '12': [180 * -1, -5, -120, 67], // NAVAREA XII — E Pacific
    C: [-80, 7, 20, 85], // HYDROLANT — W/N Atlantic open ocean
    P: [120, -60, -80 + 360, 60], // HYDROPAC — Pacific (wraps dateline)
    A: [-180, 60, 180, 90], // HYDROARC — Arctic
    X: [80, -55, 175, 12], // NAVAREA X — AHO/JRCC AUSTRALIA (IO E + W Pacific + AU EEZ)
    I: [-35, 30, 30, 90], // NAVAREA I — NE Atlantic, UKHO coordinator
    WZ: [-10, 49, 5, 62], // UK Coastal — UKHO Warning Zones
    XIV: [140, -60, -120 + 360, 0], // NAVAREA XIV — Maritime NZ (S Pacific, wraps dateline)
    NZC: [160, -55, 180, -30], // NZ Coastal — Maritime NZ inshore (broadcasts on MF/VHF)
};

export function isAreaCoveringPoint(code: string, lat: number, lon: number): boolean {
    const b = AREA_BOUNDS[code];
    if (!b) return false;
    const [west, south, east, north] = b;
    if (lat < south || lat > north) return false;

    // Some bounds use ordinary -180..180 longitudes while Pacific areas use
    // a 0..360 east edge to span the antimeridian. Compare *everything* in a
    // single 0..360 domain; mixing the two previously excluded valid Pacific
    // positions such as 170°W from HYDROPAC/NAVAREA XIV.
    if (Math.abs(east - west) >= 360) return true;
    const normaliseLongitude = (value: number) => ((value % 360) + 360) % 360;
    const westNorm = normaliseLongitude(west);
    const eastNorm = normaliseLongitude(east);
    const lonNorm = normaliseLongitude(lon);

    return westNorm <= eastNorm
        ? lonNorm >= westNorm && lonNorm <= eastNorm
        : lonNorm >= westNorm || lonNorm <= eastNorm;
}

// ── Coordinate parsing ────────────────────────────────────────────────────

// NGA text uses "DD-MM.M N/S DDD-MM.M E/W" e.g. "19-23.0N 092-03.1W".
// Pairs appear right next to each other, sometimes with a space, sometimes
// with a comma or period between. The regex below is deliberately forgiving.
const COORD_PAIR = /(\d{1,2})-(\d{1,2}(?:\.\d+)?)\s*([NS])[,\s]+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/g;

export function extractCoords(text: string): Array<{ lat: number; lon: number }> {
    const out: Array<{ lat: number; lon: number }> = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(COORD_PAIR.source, 'g');
    while ((m = re.exec(text))) {
        const latDeg = Number(m[1]);
        const latMin = Number(m[2]);
        const latHem = m[3];
        const lonDeg = Number(m[4]);
        const lonMin = Number(m[5]);
        const lonHem = m[6];
        if (Number.isNaN(latDeg) || Number.isNaN(lonDeg)) continue;
        let lat = latDeg + latMin / 60;
        let lon = lonDeg + lonMin / 60;
        if (latHem === 'S') lat = -lat;
        if (lonHem === 'W') lon = -lon;
        // Sanity
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        out.push({ lat, lon });
    }
    return out;
}

// ── Issue-date parsing ────────────────────────────────────────────────────

// API returns strings like "022338Z SEP 2021" — DDHHMMZ MON YYYY.
const MONTHS: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
};

export function parseIssueDate(raw: string): Date | null {
    if (!raw) return null;
    const m = raw.match(/^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const hour = Number(m[2]);
    const min = Number(m[3]);
    const mon = MONTHS[m[4]];
    const year = Number(m[5]);
    if (mon === undefined || day < 1 || day > 31 || hour > 23 || min > 59) return null;
    const parsed = new Date(Date.UTC(year, mon, day, hour, min));
    // Date.UTC normalises invalid days (e.g. 31 April) rather than rejecting
    // them. Reject those malformed source values instead of silently moving a
    // warning to a different date in the UI.
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === mon && parsed.getUTCDate() === day
        ? parsed
        : null;
}

// ── Title extraction ──────────────────────────────────────────────────────

/** First non-trivial line from the body, capped. */
function buildTitle(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    // Skip chart reference lines like "DNC 22." or "CHART 12200."
    const first = lines.find((l) => !/^(DNC|CHART)\b/i.test(l)) ?? lines[0] ?? '';
    const clean = first.replace(/\.$/, '');
    return clean.length > 80 ? clean.slice(0, 77) + '…' : clean;
}

// ── Normalisation ─────────────────────────────────────────────────────────

interface RawBroadcastWarn {
    msgYear: number;
    msgNumber: number;
    navArea: string;
    subregion?: string;
    text: string;
    status?: string;
    issueDate?: string;
    authority?: string;
}

function normalise(raw: RawBroadcastWarn): Notice {
    const text = raw.text || '';
    return {
        id: `${raw.navArea}-${raw.msgYear}/${raw.msgNumber}`,
        msgYear: raw.msgYear,
        msgNumber: raw.msgNumber,
        navArea: raw.navArea,
        areaLabel: labelFor(raw.navArea),
        subregion: raw.subregion || '',
        issueDate: raw.issueDate || '',
        issueDateParsed: parseIssueDate(raw.issueDate || ''),
        authority: raw.authority || '',
        text,
        title: buildTitle(text),
        coordinates: extractCoords(text),
        status: raw.status || 'A',
    };
}

// ── Cache (localStorage) ──────────────────────────────────────────────────

const CACHE_KEY = 'thalassa_ntm_cache_v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CachePayload {
    fetchedAt: number;
    notices: Notice[];
}

function loadCache(): CachePayload | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachePayload;
        if (!parsed?.notices || !Array.isArray(parsed.notices)) return null;
        // JSON.parse turns Date fields back into strings — rehydrate so the
        // Notice type contract holds for consumers that call Date methods.
        for (const n of parsed.notices) {
            if (n.issueDateParsed && !(n.issueDateParsed instanceof Date)) {
                const d = new Date(n.issueDateParsed as unknown as string);
                n.issueDateParsed = Number.isNaN(d.getTime()) ? null : d;
            }
        }
        return parsed;
    } catch {
        return null;
    }
}

function saveCache(payload: CachePayload): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
        /* quota exceeded, ignore */
    }
}

// ── Source fetchers ───────────────────────────────────────────────────────

const NOTICE_REQUEST_TIMEOUT_MS = 15_000;

type NoticeEndpoint = { url: string; headers?: Record<string, string> };

async function fetchBroadcastWarnings(endpoint: NoticeEndpoint, source: string): Promise<RawBroadcastWarn[]> {
    // One stalled hydrographic source used to hold the complete parallel
    // refresh open indefinitely. Each source has its own deadline so a slow
    // bulletin degrades to the remaining authorities rather than freezing the
    // map's notices layer.
    const res = await fetch(endpoint.url, {
        headers: endpoint.headers,
        signal: AbortSignal.timeout(NOTICE_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${source} MSI returned ${res.status}`);
    const body = (await res.json()) as { 'broadcast-warn': RawBroadcastWarn[] };
    return Array.isArray(body['broadcast-warn']) ? body['broadcast-warn'] : [];
}

async function fetchNga(): Promise<RawBroadcastWarn[]> {
    return fetchBroadcastWarnings(ngaEndpoint(), 'NGA');
}

async function fetchAmsa(): Promise<RawBroadcastWarn[]> {
    const ep = amsaEndpoint();
    if (!ep) {
        // No Supabase URL configured — skip silently. The page still
        // works on NGA-only; AMSA is purely additive.
        return [];
    }
    return fetchBroadcastWarnings(ep, 'AMSA');
}

async function fetchUkho(): Promise<RawBroadcastWarn[]> {
    const ep = ukhoEndpoint();
    if (!ep) return [];
    return fetchBroadcastWarnings(ep, 'UKHO');
}

async function fetchLinz(): Promise<RawBroadcastWarn[]> {
    const ep = linzEndpoint();
    if (!ep) return [];
    return fetchBroadcastWarnings(ep, 'LINZ');
}

// ── Service ───────────────────────────────────────────────────────────────

type ChangeCallback = (notices: Notice[]) => void;

class NoticeToMarinersServiceClass {
    private notices: Notice[] = [];
    private lastFetchAt = 0;
    private inflight: Promise<Notice[]> | null = null;
    private listeners = new Set<ChangeCallback>();
    private loadedFromCache = false;

    /** Synchronously return whatever is cached in memory or localStorage. */
    getCached(): { notices: Notice[]; fetchedAt: number } {
        if (!this.loadedFromCache && this.notices.length === 0) {
            const cached = loadCache();
            if (cached) {
                this.notices = cached.notices;
                this.lastFetchAt = cached.fetchedAt;
            }
            this.loadedFromCache = true;
        }
        return { notices: [...this.notices], fetchedAt: this.lastFetchAt };
    }

    /** Fetch from the network, honouring the cache TTL unless `force`. */
    async refresh(force = false): Promise<Notice[]> {
        this.getCached();

        const fresh = Date.now() - this.lastFetchAt < CACHE_TTL_MS;
        if (!force && fresh && this.notices.length > 0) {
            return this.notices;
        }

        if (this.inflight) return this.inflight;

        this.inflight = (async () => {
            try {
                // Fetch all sources in parallel. Each source is independent —
                // if one fails (network blip, scraping breakage), the others
                // still contribute. Promise.allSettled lets us partial-merge.
                const sources = await Promise.allSettled([fetchNga(), fetchAmsa(), fetchUkho(), fetchLinz()]);
                const list: RawBroadcastWarn[] = [];
                let anySucceeded = false;
                for (const result of sources) {
                    if (result.status === 'fulfilled') {
                        list.push(...result.value);
                        anySucceeded = true;
                    } else {
                        log.warn(`Notice source failed: ${result.reason}`);
                    }
                }
                if (!anySucceeded) {
                    throw new Error('All notice sources failed');
                }
                const seen = new Set<string>();
                const notices = list
                    .map(normalise)
                    // Sources may overlap or each occasionally double-publish
                    // — dedupe by (navArea, msgYear, msgNumber) id.
                    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
                    // Newest first by msgYear/msgNumber
                    .sort((a, b) => b.msgYear - a.msgYear || b.msgNumber - a.msgNumber);

                this.notices = notices;
                this.lastFetchAt = Date.now();
                saveCache({ fetchedAt: this.lastFetchAt, notices });
                this.emit();
                log.info(
                    `Fetched ${notices.length} notices across ${sources.filter((s) => s.status === 'fulfilled').length} source(s)`,
                );
                return notices;
            } catch (e) {
                log.warn('Failed to fetch notices — falling back to cache', e);
                throw e;
            } finally {
                this.inflight = null;
            }
        })();

        return this.inflight;
    }

    onChange(cb: ChangeCallback): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private emit(): void {
        const snapshot = [...this.notices];
        for (const cb of this.listeners) cb(snapshot);
    }
}

export const NoticeToMarinersService = new NoticeToMarinersServiceClass();

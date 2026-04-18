/**
 * NoticeToMarinersService — NGA Maritime Safety Information broadcast warnings.
 *
 * Fetches active in-force warnings from the NGA MSI broadcast-warn endpoint
 * (NAVAREA IV + XII, HYDROLANT, HYDROPAC, HYDROARC), parses embedded
 * coordinates out of the free-text body, and caches the result in
 * localStorage so the browse view is instant on subsequent opens.
 *
 * The NGA publishes for US-assigned areas; warnings in other NAVAREAs come
 * from each country's own hydrographic office and are not included here.
 * Future sources (UKHO, AHS, LINZ, CHS) can be merged into the same shape.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('NoticeToMariners');

// ── Types ─────────────────────────────────────────────────────────────────

/** NGA-issued NAVAREA/HYDRO region code as returned by the API. */
export type NgaAreaCode = '4' | '12' | 'A' | 'C' | 'P' | string;

export interface Notice {
    /** Stable id — `${msgYear}/${msgNumber}` */
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
// Web uses the Vite dev proxy (see vite.config.ts) or a Supabase edge
// function proxy (TODO: proxy-nga-msi for web production).
function isNative(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return !!(globalThis as any).Capacitor?.isNativePlatform?.();
    } catch {
        return false;
    }
}

function endpoint(): string {
    return isNative()
        ? 'https://msi.nga.mil/api/publications/broadcast-warn?output=json'
        : '/api/nga-msi/broadcast-warn?output=json';
}

// ── Area labels ───────────────────────────────────────────────────────────

const AREA_LABELS: Record<string, string> = {
    '4': 'NAVAREA IV',
    '12': 'NAVAREA XII',
    C: 'HYDROLANT',
    P: 'HYDROPAC',
    A: 'HYDROARC',
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
};

export function isAreaCoveringPoint(code: string, lat: number, lon: number): boolean {
    const b = AREA_BOUNDS[code];
    if (!b) return false;
    // Handle simple non-wrapping case
    if (b[0] <= b[2]) {
        return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
    }
    // Wrapping (e.g. HYDROPAC spans the antimeridian)
    const lonNorm = lon < 0 ? lon + 360 : lon;
    return lonNorm >= b[0] + 360 && lonNorm <= b[2] + 360 && lat >= b[1] && lat <= b[3];
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
    if (mon === undefined) return null;
    return new Date(Date.UTC(year, mon, day, hour, min));
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
        id: `${raw.msgYear}/${raw.msgNumber}`,
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
                const res = await fetch(endpoint());
                if (!res.ok) {
                    throw new Error(`NGA MSI returned ${res.status}`);
                }
                const body = (await res.json()) as { 'broadcast-warn': RawBroadcastWarn[] };
                const list = Array.isArray(body['broadcast-warn']) ? body['broadcast-warn'] : [];
                const notices = list
                    .map(normalise)
                    // Newest first by msgYear/msgNumber
                    .sort((a, b) => b.msgYear - a.msgYear || b.msgNumber - a.msgNumber);

                this.notices = notices;
                this.lastFetchAt = Date.now();
                saveCache({ fetchedAt: this.lastFetchAt, notices });
                this.emit();
                log.info(`Fetched ${notices.length} notices from NGA MSI`);
                return notices;
            } catch (e) {
                log.warn('Failed to fetch NGA MSI — falling back to cache', e);
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

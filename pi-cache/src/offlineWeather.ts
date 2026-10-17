/** Public official weather kept aboard. Routes only read this cache; the
 * scheduler alone downloads, while the boat's internet policy permits it. */
import type { Cache } from './cache.js';
import {
    SAT_IR_CAPABILITIES_URL,
    parseGmgsiFrames,
    satIrFrames,
    satIrImageUrl,
} from './offlineWeather/satelliteSource.js';
import { chartsForPoint, chartCredit, JMA_CHART_INDEX, jmaChartUrl } from './offlineWeather/synopticCharts.js';
import { MARINE_BULLETIN_SOURCES } from './offlineWeather/marineBulletins.js';

type WeatherCache = Pick<Cache, 'get' | 'set'>;
const DAY = 86_400_000;
const KEEP = 7 * DAY;
const SATELLITE_KEY = 'offline-weather:satellite';
const BULLETIN_KEY = 'offline-weather:bulletins';
export interface SatelliteSnapshot {
    schema: 1;
    fetchedAt: number;
    frames: { iso: string; timeMs: number; dataUrl: string }[];
}
export interface AnalysisSnapshot {
    schema: 1;
    id: string;
    fetchedAt: number;
    dataUrl: string;
    sourceUrl: string;
    attribution: string;
}
export interface MarineBulletin {
    id: string;
    title: string;
    text: string;
    issuedAt: string;
    fetchedAt: number;
    sourceUrl: string;
    attribution: string;
}
export interface BulletinSnapshot {
    schema: 1;
    coverage: string;
    bulletins: MarineBulletin[];
}
export class OfflineWeatherStore {
    constructor(private cache: WeatherCache) {}
    satellite(): SatelliteSnapshot | null {
        return this.cache.get<SatelliteSnapshot>(SATELLITE_KEY)?.data ?? null;
    }
    analysis(id: string): AnalysisSnapshot | null {
        return /^[a-z0-9-]{1,40}$/.test(id)
            ? (this.cache.get<AnalysisSnapshot>('offline-weather:analysis:' + id)?.data ?? null)
            : null;
    }
    bulletins(): BulletinSnapshot {
        return (
            this.cache.get<BulletinSnapshot>(BULLETIN_KEY)?.data ?? {
                schema: 1,
                coverage:
                    'No selected NOAA marine bulletin has been received aboard. Coverage is limited; consult the official service for this area.',
                bulletins: [],
            }
        );
    }
    capabilities(): { schema: 1; satellite: boolean; analysis: boolean; marineBulletins: boolean } {
        return {
            schema: 1,
            satellite: !!this.satellite()?.frames.length,
            analysis: !!this.cache.get('offline-weather:analysis-ready'),
            marineBulletins: this.bulletins().bulletins.length > 0,
        };
    }
}
/** WMO UTC issue header, cross-checked against the printed full calendar date.
 * Never relabel an old file from the same day-of-month as a fresh forecast. */
export function marineIssueTime(text: string, now: number): string | null {
    const header = /^FZ[A-Z0-9]{4}\s+[A-Z]{4}\s+(\d{2})(\d{2})(\d{2})\b/m.exec(text.slice(0, 2000));
    const calendar = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})\s+(20\d{2})\b/i.exec(
        text.slice(0, 2000),
    );
    if (!header || !calendar || Number(header[2]) > 23 || Number(header[3]) > 59) return null;
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(
        calendar[1].toUpperCase(),
    );
    const printed = Date.UTC(Number(calendar[3]), month, Number(calendar[2]));
    const base = new Date(printed);
    const candidates = [-1, 0, 1]
        .map((shift) =>
            Date.UTC(
                base.getUTCFullYear(),
                base.getUTCMonth() + shift,
                Number(header[1]),
                Number(header[2]),
                Number(header[3]),
            ),
        )
        .filter((at) => Math.abs(at - printed) <= 2 * DAY && at <= now + 10 * 60_000 && now - at <= DAY);
    return candidates.length
        ? new Date(candidates.sort((a, b) => Math.abs(now - a) - Math.abs(now - b))[0]).toISOString()
        : null;
}

interface RefreshOptions {
    internetAllowed: () => boolean;
    fetchImpl?: typeof fetch;
    now?: () => number;
}
async function bytes(url: string, limit: number, options: RefreshOptions): Promise<{ bytes: Buffer; type: string }> {
    if (!options.internetAllowed()) throw new Error('Boat internet policy blocks weather downloads');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'error', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Official weather unavailable');
        if (Number(response.headers.get('content-length')) > limit)
            throw new Error('Official weather response too large');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > limit || !options.internetAllowed()) {
                await reader.cancel();
                throw new Error('Weather response exceeds policy or byte bound');
            }
            chunks.push(part.value);
        }
        return { bytes: Buffer.concat(chunks), type: response.headers.get('content-type') ?? '' };
    } finally {
        clearTimeout(timeout);
    }
}
function image(data: Buffer, mime: string): string {
    const valid =
        mime === 'image/jpeg'
            ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
            : mime === 'image/png'
              ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
                data.subarray(0, 6).toString('ascii') === 'GIF89a';
    if (!valid) throw new Error('Official weather image signature mismatch');
    return 'data:' + mime + ';base64,' + data.toString('base64');
}

export async function refreshOfflineWeather(
    cache: WeatherCache,
    position: { lat: number; lon: number },
    options: RefreshOptions,
): Promise<void> {
    if (
        !options.internetAllowed() ||
        !Number.isFinite(position.lat) ||
        !Number.isFinite(position.lon) ||
        Math.abs(position.lat) > 90 ||
        Math.abs(position.lon) > 180
    )
        return;
    const now = options.now ?? Date.now;
    const store = new OfflineWeatherStore(cache);
    // Individual lanes fail independently; an outage never discards the last dated copy.
    try {
        const capabilities = await bytes(SAT_IR_CAPABILITIES_URL, 1_000_000, options);
        const listed = satIrFrames(parseGmgsiFrames(capabilities.bytes.toString('utf8')) ?? [], now());
        const kept = new Map(store.satellite()?.frames.map((frame) => [frame.iso, frame]) ?? []);
        const frames: SatelliteSnapshot['frames'] = [];
        for (const frame of listed) {
            try {
                const previous = kept.get(frame.iso);
                if (previous) {
                    frames.push(previous);
                    continue;
                }
                const result = await bytes(satIrImageUrl(frame), 1_000_000, options);
                if (!result.type.startsWith('image/jpeg')) throw new Error('Wrong satellite content type');
                frames.push({ ...frame, dataUrl: image(result.bytes, 'image/jpeg') });
            } catch {
                /* A partial refresh keeps only successfully received frames. */
            }
        }
        if (frames.length)
            cache.set<SatelliteSnapshot>(
                SATELLITE_KEY,
                { schema: 1, fetchedAt: now(), frames: frames.slice(-6) },
                KEEP,
                'NOAA/NESDIS GMGSI full global belt',
            );
    } catch {
        /* Retain dated prior frames. */
    }
    let jmaIndex: unknown;
    for (const chart of chartsForPoint(position.lat, position.lon)) {
        if (!options.internetAllowed()) return;
        if (now() - (store.analysis(chart.id)?.fetchedAt ?? 0) < 3 * 3_600_000) continue;
        try {
            if (chart.jmaSlot && !jmaIndex)
                jmaIndex = JSON.parse((await bytes(JMA_CHART_INDEX, 64_000, options)).bytes.toString('utf8'));
            const url = chart.url ?? (chart.jmaSlot ? jmaChartUrl(jmaIndex, chart.jmaSlot) : null);
            if (!url) continue;
            const result = await bytes(url, 2 * 1024 * 1024, options);
            if (!result.type.startsWith(chart.mime)) throw new Error('Wrong analysis content type');
            cache.set<AnalysisSnapshot>(
                'offline-weather:analysis:' + chart.id,
                {
                    schema: 1,
                    id: chart.id,
                    fetchedAt: now(),
                    dataUrl: image(result.bytes, chart.mime),
                    sourceUrl: url,
                    attribution: chartCredit(chart),
                },
                KEEP,
                chart.issuer,
            );
            cache.set('offline-weather:analysis-ready', true, KEEP, 'official analysis');
        } catch {
            /* Retain prior chart with its actual received time. */
        }
    }
    const bulletins: MarineBulletin[] = [];
    const prior = new Map(store.bulletins().bulletins.map((item) => [item.id, item]));
    for (const source of MARINE_BULLETIN_SOURCES.filter((s) => s.area(position.lat, position.lon))) {
        try {
            const result = await bytes(source.file, 100_000, options);
            if (!result.type.startsWith('text/plain')) throw new Error('Marine bulletin is not plain text');
            const text = result.bytes.toString('utf8');
            const issuedAt = marineIssueTime(text, now());
            if (!issuedAt || /<\/?(?:html|script|body)\b/i.test(text))
                throw new Error('Marine bulletin has no current verifiable issue date');
            bulletins.push({
                id: source.id,
                title: source.title,
                text,
                issuedAt,
                fetchedAt: now(),
                sourceUrl: source.file,
                attribution:
                    'NOAA/NWS official marine forecast · public domain. Read the product area and validity in its original text.',
            });
        } catch {
            const old = prior.get(source.id);
            if (old) bulletins.push(old);
        }
    }
    if (options.internetAllowed())
        cache.set<BulletinSnapshot>(
            BULLETIN_KEY,
            {
                schema: 1,
                coverage:
                    'Selected NOAA high-seas products and south Florida coastal zones only. Selection is regional; read the exact area and validity in each product. Other services remain link-only until permission is established.',
                bulletins,
            },
            KEEP,
            'NOAA/NWS',
        );
}

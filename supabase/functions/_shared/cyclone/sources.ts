/**
 * The cyclone feeds, fetched by fetch-gfs-tracker and cyclone-watch (129-09).
 * Each returns null when its source does not answer, so a caller can say the
 * data is unavailable instead of reporting no storms.
 *
 *   NCEP GFS tracker  nomads.ncep.noaa.gov gfs.tCCz.atcfunix.all, every basin
 *                     (NOAA, public domain)
 *   NHC a-decks       ftp.nhc.noaa.gov/atcf/aid_public, the storms in
 *                     www.nhc.noaa.gov/CurrentStorms.json: every model NHC
 *                     receives, AL/EP/CP only (NOAA; third-party model tracks
 *                     such as ECMWF's are credited by producer)
 *   Esri forecast     the Active Hurricanes feed's forecast positions: NHC/CPHC
 *                     official points, JTWC advisory points elsewhere (the
 *                     data the app's storm layer already draws). NHC's and
 *                     JTWC's data, on Esri's Living Atlas item, which Esri
 *                     licenses under its Master License Agreement and credits
 *                     "NHC, JTWC, Esri": see centres.ts on that access
 */
import { fetchWithTimeout, readResponseTextLimited } from '../http-security.ts';
import { latestGfsCycles } from './adeck.ts';
import { type EsriForecastStorm, parseEsriForecast } from './esri.ts';

export const ESRI_FORECAST_URL =
    'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Active_Hurricanes_v1/FeatureServer/0/query?where=1%3D1&outFields=STORMNAME,BASIN,STORMNUM,ADVISNUM,ADVDATE,VALIDTIME,FLDATELBL,MAXWIND,MSLP&f=geojson&resultRecordCount=500';

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

/** The newest GFS tracker file NOMADS has, or null. */
export async function fetchGfsAtcfunix(nowMs: number): Promise<{ text: string; cycle: string } | null> {
    for (const { date, cycle } of latestGfsCycles(nowMs)) {
        const url = `https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.${date}/${cycle}/atmos/` +
            `gfs.t${cycle}z.atcfunix.all`;
        try {
            const resp = await fetchWithTimeout(url, {}, 10_000);
            if (!resp.ok) {
                await resp.body?.cancel().catch(() => undefined);
                continue;
            }
            const text = await readResponseTextLimited(resp, 5_000_000);
            if (text !== null && text.trim().length > 10 && !text.includes('<!DOCTYPE')) {
                return { text, cycle: `${date}${cycle}` };
            }
        } catch {
            // the previous cycle next
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
        const list = await fetchWithTimeout('https://www.nhc.noaa.gov/CurrentStorms.json', {}, 8_000);
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
                    {},
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

/** The Esri feed's forecast storms, or null when it does not answer. */
export async function fetchEsriForecast(): Promise<EsriForecastStorm[] | null> {
    try {
        const resp = await fetchWithTimeout(ESRI_FORECAST_URL, {}, 15_000);
        if (!resp.ok) {
            await resp.body?.cancel().catch(() => undefined);
            return null;
        }
        const json = await readJson(resp, 4_000_000);
        if (!json || !Array.isArray(json.features)) return null;
        return parseEsriForecast(json);
    } catch {
        return null;
    }
}

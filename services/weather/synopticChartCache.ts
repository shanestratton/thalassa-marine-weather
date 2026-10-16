import { loadLargeData, saveLargeDataImmediate } from '../nativeStorage';
import { readPiAnalysis } from '../PiOfflineWeatherService';
import { API_BASE } from '../native/apiBase';
import { satelliteModeBlocks } from '../networkPolicy';
import { JMA_CHART_INDEX, jmaChartUrl, synopticChart, type SynopticChart } from './synopticCharts';
import { readChartBytes, SYNOPTIC_MAX_ASSET_BYTES } from './synopticChartBytes';

export const SYNOPTIC_CACHE_KEY = 'thalassa_synoptic_charts_v1';
export const SYNOPTIC_CACHE_BYTES = 3 * 1024 * 1024;
export const SYNOPTIC_CACHE_ENTRIES = 4;
export interface SavedSynopticChart {
    id: string;
    dataUrl: string;
    downloadedAt: number;
    bytes: number;
}
let loaded: Promise<SavedSynopticChart[]> | undefined;
let writes: Promise<void> = Promise.resolve();
const pending = new Map<string, Promise<{ chart: SavedSynopticChart; offlineSaved: boolean }>>();

/** Public images only, bounded to 3 MiB including JSON/base64. No private chart-vault content. */
export function boundedSavedCharts(value: unknown): SavedSynopticChart[] {
    if (!Array.isArray(value)) return [];
    const accepted: SavedSynopticChart[] = [];

    const ids = new Set<string>();
    for (const raw of value.slice(0, 30).sort((a, b) => Number(b?.downloadedAt) - Number(a?.downloadedAt))) {
        const r = raw as SavedSynopticChart;
        const spec = synopticChart(r?.id);
        if (
            !spec ||
            ids.has(r.id) ||
            !Number.isFinite(r.downloadedAt) ||
            r.downloadedAt <= 0 ||
            r.downloadedAt > Date.now() + 300000 ||
            typeof r.dataUrl !== 'string' ||
            r.dataUrl.length > Math.ceil(SYNOPTIC_MAX_ASSET_BYTES / 3) * 4 + 30
        )
            continue;
        const prefix = `data:${spec.mime};base64,`;
        if (!r.dataUrl.startsWith(prefix)) continue;
        const base64 = r.dataUrl.slice(prefix.length);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) continue;
        const bytes = (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        if (
            bytes < 8 ||
            bytes > SYNOPTIC_MAX_ASSET_BYTES ||
            bytes !== r.bytes ||
            accepted.length >= SYNOPTIC_CACHE_ENTRIES
        )
            continue;
        const head = atob(base64.slice(0, 16));
        if (
            spec.mime === 'image/gif'
                ? !/^GIF8[79]a/.test(head)
                : ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => head.charCodeAt(i) === v)
        )
            continue;
        const entry = { id: r.id, dataUrl: r.dataUrl, downloadedAt: r.downloadedAt, bytes };
        if (new TextEncoder().encode(JSON.stringify([...accepted, entry])).byteLength > SYNOPTIC_CACHE_BYTES) continue;
        accepted.push(entry);
        ids.add(r.id);
    }
    return accepted;
}
function readSaved(): Promise<SavedSynopticChart[]> {
    return (loaded ??= loadLargeData(SYNOPTIC_CACHE_KEY)
        .then(boundedSavedCharts)
        .catch(() => []));
}
async function fromBoatCache(id: string): Promise<SavedSynopticChart | null> {
    const asset = await readPiAnalysis(id).catch(() => null);
    if (!asset || asset.id !== id) return null;
    const encoded = asset.dataUrl.split(',')[1] ?? '';
    const bytes = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    return boundedSavedCharts([{ id, dataUrl: asset.dataUrl, downloadedAt: asset.fetchedAt, bytes }])[0] ?? null;
}
async function persistChart(entry: SavedSynopticChart): Promise<boolean> {
    let saved = false;
    const persist = writes
        .catch(() => undefined)
        .then(async () => {
            const next = boundedSavedCharts([entry, ...(await readSaved()).filter((r) => r.id !== entry.id)]);
            await saveLargeDataImmediate(SYNOPTIC_CACHE_KEY, next);
            const verified = boundedSavedCharts(await loadLargeData(SYNOPTIC_CACHE_KEY));
            saved = verified.some(
                (r) => r.id === entry.id && r.downloadedAt === entry.downloadedAt && r.dataUrl === entry.dataUrl,
            );
            if (saved) loaded = Promise.resolve(verified);
        });
    writes = persist;
    await persist.catch(() => undefined);
    return saved;
}
export async function savedSynopticChart(id: string): Promise<SavedSynopticChart | null> {
    const saved = (await readSaved()).find((r) => r.id === id);
    if (saved) return saved;
    const boat = await fromBoatCache(id);
    return boat && (await persistChart(boat)) ? boat : null;
}
function dataUrl(bytes: Uint8Array, mime: string): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:${mime};base64,${btoa(binary)}`;
}
async function sourceUrl(chart: SynopticChart, signal: AbortSignal): Promise<string> {
    if (chart.url) return chart.direct ? chart.url : `${API_BASE}/synoptic-chart?id=${encodeURIComponent(chart.id)}`;
    const response = await fetch(JMA_CHART_INDEX, { signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
        throw new Error('JMA chart index unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('JMA chart index unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 128 * 1024) {
                await reader.cancel();
                throw new Error('JMA chart index too large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
    }
    const url = jmaChartUrl(JSON.parse(new TextDecoder().decode(bytes)), chart.jmaSlot!);
    if (!url) throw new Error('JMA chart filename changed');
    return url;
}
export async function downloadSynopticChart(
    chart: SynopticChart,
    options: { explicit?: boolean } = {},
): Promise<{ chart: SavedSynopticChart; offlineSaved: boolean }> {
    const spec = synopticChart(chart.id);
    if (!spec || spec !== chart) throw new Error('Unknown official chart');
    const current = pending.get(chart.id);
    if (current) return current;
    const run = (async () => {
        // A paired boat-LAN cache read uses no metered WAN; try it first.
        const boat = await fromBoatCache(chart.id);
        if (boat) return { chart: boat, offlineSaved: await persistChart(boat) };
        if (!options.explicit && (satelliteModeBlocks('raster') || satelliteModeBlocks('offline-download')))
            throw new Error('Satellite Mode: tap Download chart to use data');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let entry: SavedSynopticChart;
        try {
            const url = await sourceUrl(chart, controller.signal);
            const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
            const bytes = await readChartBytes(response, chart.mime);
            entry = {
                id: chart.id,
                dataUrl: dataUrl(bytes, chart.mime),
                bytes: bytes.length,
                downloadedAt: Date.now(),
            };
        } finally {
            clearTimeout(timer);
        }
        return { chart: entry, offlineSaved: await persistChart(entry) };
    })().finally(() => pending.delete(chart.id));
    pending.set(chart.id, run);
    return run;
}
export function resetSynopticCacheForTests() {
    loaded = undefined;
    writes = Promise.resolve();
    pending.clear();
}

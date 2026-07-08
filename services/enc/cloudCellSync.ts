/**
 * Cloud ENC cell sync — the DESKTOP PASSAGE BUILDER's chart source
 * (masterplan Phase 5.2).
 *
 * On the boat, ENC cells arrive from the Pi (calypso.local). A browser on
 * the beach can't reach the Pi — so the Pi's extracted cell GeoJSON lives in
 * the private `enc-cells` Supabase Storage bucket (uploaded 2026-07-08:
 * 20 cells, ~55 MB, plus manifest.json) and this module mirrors them into
 * the SAME local stores the Pi sync fills:
 *   • manifest → EncCellMetadata.putCell()  (cell registry, localStorage)
 *   • blobs    → EncCellStore.saveCellGeoJSON() (Filesystem; IndexedDB on web)
 * Everything downstream (router, tracer, ENC render) is source-agnostic.
 *
 * GATED: the bucket is authenticated-read (the extracts are licensed) — a
 * signed-out browser simply gets no charts, and the tracer says so honestly.
 * Blobs download ON DEMAND (loadCellGeoJSON miss → fetch), so opening the
 * builder doesn't pull 55 MB up front.
 */
import { supabase, isSupabaseConfigured } from '../supabase';
import { listCells, putCell } from './EncCellMetadata';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('cloudCellSync');

const BUCKET = 'enc-cells';

interface CloudManifest {
    version: number;
    cells: Array<{ cellId: string; bbox: [number, number, number, number] }>;
}

let manifestPromise: Promise<CloudManifest | null> | null = null;
const inflightCells = new Map<string, Promise<boolean>>();

async function fetchManifest(): Promise<CloudManifest | null> {
    if (!isSupabaseConfigured() || !supabase) return null;
    try {
        const { data, error } = await supabase.storage.from(BUCKET).download('manifest.json');
        if (error || !data) return null;
        return JSON.parse(await data.text()) as CloudManifest;
    } catch (err) {
        log.warn(`manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/**
 * Register every cloud cell in the local metadata registry (idempotent —
 * cells already present, e.g. from a Pi sync, are left alone). Returns how
 * many NEW cells were registered. Safe to call opportunistically; requires
 * a signed-in user or quietly does nothing.
 */
export async function registerCloudCells(): Promise<number> {
    manifestPromise = manifestPromise ?? fetchManifest();
    const manifest = await manifestPromise;
    if (!manifest) return 0;
    const known = new Set(listCells().map((c) => c.id));
    let added = 0;
    for (const c of manifest.cells) {
        if (known.has(c.cellId)) continue;
        putCell({
            id: c.cellId,
            sourceHO: 'cloud',
            edition: 0,
            issued: '',
            importedAt: new Date().toISOString(),
            bbox: c.bbox,
            // The registry path convention — the blob itself downloads on
            // demand the first time loadCellGeoJSON misses.
            geojsonPath: `enc-cells/${c.cellId}.geojson`,
            hazardCount: 0,
        });
        added++;
    }
    if (added > 0) log.warn(`registered ${added} cloud ENC cells (of ${manifest.cells.length})`);
    return added;
}

/**
 * Download one cell blob from the bucket into the local store. Deduped per
 * cell. Returns true when the blob is saved locally.
 */
export async function downloadCloudCell(cellId: string): Promise<boolean> {
    if (!isSupabaseConfigured() || !supabase) return false;
    const existing = inflightCells.get(cellId);
    if (existing) return existing;
    const p = (async () => {
        try {
            const { data, error } = await supabase!.storage.from(BUCKET).download(`${cellId}.json`);
            if (error || !data) return false;
            const text = await data.text();
            // The Pi endpoint wraps cells as { cells: [RawCell] }; the local
            // store expects the EncConversionResult shape ({ cellId, layers }).
            const parsed = JSON.parse(text) as {
                cells?: Array<{ cellId: string; layers: unknown }>;
                cellId?: string;
                layers?: unknown;
            };
            const cell = parsed.cells?.find((c) => c.cellId === cellId) ?? parsed.cells?.[0] ?? parsed;
            if (!cell || !('layers' in cell) || !cell.layers) return false;
            const { saveCellGeoJSON } = await import('./EncCellStore');
            await saveCellGeoJSON(cellId, cell as never);
            log.warn(`cloud cell ${cellId} downloaded (${(text.length / 1024 / 1024).toFixed(1)} MB)`);
            return true;
        } catch (err) {
            log.warn(`cloud cell ${cellId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inflightCells.delete(cellId);
        }
    })();
    inflightCells.set(cellId, p);
    return p;
}

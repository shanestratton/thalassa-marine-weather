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

/** Last manifest version whose blobs this browser downloaded. When the
 *  bucket is re-uploaded under a bumped version (extractor output
 *  changed — e.g. the 2026-07 sounding explosion), every cached cloud
 *  blob is silently stale FOREVER without this: blobs only download on
 *  a local miss, so a returning browser kept rendering pre-sounding
 *  cells while a fresh one got the new data (Shane 2026-07-12: "we
 *  need more depth numbers??" — Mooloolaba's 200 in-view soundings were
 *  in the bucket, not in his IndexedDB). */
const MANIFEST_VERSION_KEY = 'thalassa_enc_cloud_manifest_version';

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
    if (!manifest) {
        // Don't memoize failure: a signed-OUT fetch caches null for the
        // session, and the punter who signs in on the page would never
        // get charts (the map-mount + auth-change retries would all hit
        // this cache). Failed fetches retry on the next call instead.
        manifestPromise = null;
        return 0;
    }
    await refreshStaleCloudBlobs(manifest.version);
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
 * Manifest-version blob invalidation. When the stored version differs
 * from the bucket's (including the never-stored first run under this
 * code — exactly the browsers that cached pre-sounding blobs), delete
 * every CLOUD-MANAGED blob so the background hydrator re-downloads
 * fresh ones. Cloud-managed = registry geojsonPath under 'enc-cells/';
 * Pi-synced and imported cells live under the local GeoJSON dir and are
 * never touched — the boat's charts don't get wiped by a bucket bump.
 * Registry entries stay put (bboxes still render as loading extents);
 * only blobs go, and each re-download notifies the debounced merge.
 */
async function refreshStaleCloudBlobs(manifestVersion: number): Promise<void> {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem(MANIFEST_VERSION_KEY);
    } catch {
        return; // storage unavailable — nothing persisted to go stale
    }
    if (stored === String(manifestVersion)) return;
    const cloudCells = listCells().filter((c) => c.geojsonPath.startsWith(`${BUCKET}/`));
    if (cloudCells.length > 0) {
        const { deleteCellGeoJSON } = await import('./EncCellStore');
        for (const c of cloudCells) {
            await deleteCellGeoJSON(c.id);
        }
        // One registry touch: bump the version counter so the debounced
        // ENC merge re-runs, finds the missing blobs, and hydrates.
        putCell(cloudCells[0]);
        log.warn(
            `manifest v${stored ?? 'none'} → v${manifestVersion}: wiped ${cloudCells.length} cloud blobs for re-download`,
        );
    }
    try {
        localStorage.setItem(MANIFEST_VERSION_KEY, String(manifestVersion));
    } catch {
        /* unavailable — we'll harmlessly re-wipe next boot */
    }
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
            // The registry entry was seeded from the manifest with the
            // 'cloud' placeholder — now the blob is in hand, patch the REAL
            // provenance in. sourceHO drives IALA region (red/green sides);
            // the placeholder must never linger once truth is available.
            const real = cell as { sourceHO?: string; edition?: number; issued?: string };
            const existing = listCells().find((c) => c.id === cellId);
            if (existing && typeof real.sourceHO === 'string' && real.sourceHO.length === 2) {
                putCell({
                    ...existing,
                    sourceHO: real.sourceHO,
                    edition: typeof real.edition === 'number' ? real.edition : existing.edition,
                    issued: typeof real.issued === 'string' ? real.issued : existing.issued,
                });
            }
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

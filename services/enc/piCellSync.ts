/**
 * piCellSync — pull ONE cell's blob from the boat's Pi, on demand.
 *
 * The route-time rung between the device store and the cloud bucket
 * (Shane 2026-07-16: "if the tiles are sitting on the Pi, will it auto-pull
 * what it needs to build a route?" — previously no: the on-demand ladder went
 * device → cloud only, so offline-with-Pi routing starved). The ladder is now
 * device → Pi → cloud (see EncCellStore.loadCellGeoJSON).
 *
 * Fetch shape mirrors syncEncFromPi's per-cell pull: GET
 * /api/enc/installed/:cellId/data → { cells: [EncConversionResult] } →
 * EncHazardService.importCell (which persists the blob, registers the cell
 * with its REAL hazardCount, and warms the parse cache). Fails fast + silent
 * when the Pi isn't reachable (away from the boat / HTTPS web page where the
 * Pi's http origin is blocked) — the caller just falls through to the cloud.
 */

import { CapacitorHttp } from '@capacitor/core';
import { piCache } from '../PiCacheService';
import type { EncConversionBatch } from './types';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';

const log = createLogger('piCellSync');

/** JS-side bound on one cell pull — CapacitorHttp's own readTimeout applies
 *  natively, but the web fetch fallback needs a deadline too. A detail cell is
 *  a few MB over boat wifi; 30 s is generous without hanging a route forever. */
const PI_PULL_DEADLINE_MS = 30_000;

const inflight = new Map<string, Promise<boolean>>();

/**
 * Download one cell from the Pi into the local store. Deduped per cell.
 * Returns true when the blob is saved locally (importCell succeeded).
 */
export async function downloadPiCell(cellId: string): Promise<boolean> {
    if (!piCache.isAvailable()) return false;
    const existing = inflight.get(cellId);
    if (existing) return existing;
    const p = (async () => {
        try {
            const res = await CapacitorHttp.get({
                url: `${piCache.baseUrl}/api/enc/installed/${encodeURIComponent(cellId)}/data`,
                connectTimeout: 5_000,
                readTimeout: PI_PULL_DEADLINE_MS,
                responseType: 'json',
            });
            if (res.status < 200 || res.status >= 300) return false;
            const blob = res.data as EncConversionBatch;
            if (!blob || !Array.isArray(blob.cells) || blob.cells.length === 0) return false;
            // Dynamic import breaks the would-be cycle EncCellStore → piCellSync
            // → EncHazardService → EncCellStore (same pattern as the cloud rung).
            const { importCell } = await import('./EncHazardService');
            for (const conversion of blob.cells) {
                await importCell(conversion);
            }
            log.warn(`pi cell ${cellId} pulled on demand (${blob.cells.length} conversion(s))`);
            return true;
        } catch (err) {
            log.warn(`pi cell ${cellId} pull failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inflight.delete(cellId);
        }
    })();
    const bounded = withTimeout(p, false, PI_PULL_DEADLINE_MS + 5_000);
    inflight.set(cellId, bounded);
    return bounded;
}

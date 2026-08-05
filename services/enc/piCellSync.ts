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

import { piCache } from '../PiCacheService';
import { fetchVerifiedFromPi } from '../PiPairingService';
import { canonicalEncCellId, ENC_CELL_BLOB_MAX_BYTES, ENC_CELL_ID_PATTERN, encCellStorageIdentity } from './types';
import type { EncConversionBatch } from './types';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';
import { PI_INTEGRATION_ENABLED } from '../piPublicBetaBoundary';

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
    if (!PI_INTEGRATION_ENABLED || !piCache.isAvailable()) return false;
    const canonicalId = canonicalEncCellId(cellId);
    if (!ENC_CELL_ID_PATTERN.test(canonicalId)) return false;
    const identity = encCellStorageIdentity(canonicalId);
    const existing = inflight.get(identity);
    if (existing) return existing;
    const p = (async () => {
        try {
            // Signature-verified: this blob is imported straight into the
            // hazard model and routed over. The connect-time identity
            // challenge does NOT cover response bytes — an on-path attacker
            // can relay it and still tamper — so per-payload verification is
            // the defence. See PiPairingService.fetchVerifiedFromPi.
            const blob = await fetchVerifiedFromPi<EncConversionBatch>({
                url: `${piCache.baseUrl}/api/enc/installed/${encodeURIComponent(canonicalId)}/data`,
                connectTimeout: 5_000,
                readTimeout: PI_PULL_DEADLINE_MS,
                maxResponseBytes: ENC_CELL_BLOB_MAX_BYTES + 1024 * 1024,
            });
            if (!blob || !Array.isArray(blob.cells) || blob.cells.length !== 1) return false;
            const { validateLocalEncPack } = await import('./localEncPackImport');
            const validated = validateLocalEncPack(blob).cells;
            if (validated.length !== 1 || encCellStorageIdentity(validated[0].cellId) !== identity) {
                log.warn(`pi cell ${canonicalId}: response identity did not match the requested path`);
                return false;
            }
            // Dynamic import breaks the would-be cycle EncCellStore → piCellSync
            // → EncHazardService → EncCellStore (same pattern as the cloud rung).
            const { importCell } = await import('./EncHazardService');
            await importCell(validated[0]);
            log.warn(`pi cell ${canonicalId} pulled on demand`);
            return true;
        } catch (err) {
            log.warn(`pi cell ${canonicalId} pull failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inflight.delete(identity);
        }
    })();
    const bounded = withTimeout(p, false, PI_PULL_DEADLINE_MS + 5_000);
    inflight.set(identity, bounded);
    return bounded;
}

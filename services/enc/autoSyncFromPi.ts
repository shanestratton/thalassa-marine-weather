/**
 * Auto-sync ENC cells from the user's Bosun Pi on app launch.
 *
 * Runs once per session, in the background, no UI required. If the Pi is
 * reachable and has cells the device doesn't already have at the same
 * edition, they're pulled and `importCell()`d. The user just sees more cells
 * appear in the layer FAB count and the chart rendering.
 *
 * If the Pi is unreachable (away from the boat, on cellular, offline), the
 * function fails silently — never blocks the app's startup. Manual sync via
 * Settings → Vessel → ENC Cells stays as a fallback for re-triggering.
 *
 * This is the "wanker-proof" half of the chart distribution story: buy
 * charts in o-charts, OpenCPN downloads them on the Pi, Pi's filesystem
 * watcher decrypts them (separate work item), the phone picks them up on
 * next launch without anyone tapping anything.
 */
import { createLogger } from '../../utils/createLogger';
import { syncEncFromPi } from '../EncImportService';
import { piCache } from '../PiCacheService';

const log = createLogger('autoSyncFromPi');

// In-process guard so multiple MapHub mounts in one session don't redundantly
// hit the Pi. localStorage flag would persist across launches, which is wrong —
// we want to re-check every launch in case the Pi has new cells.
let attempted = false;

export async function autoSyncFromPiIfPossible(): Promise<void> {
    if (attempted) return;
    attempted = true;

    try {
        if (!piCache.isAvailable()) {
            log.warn('auto-sync skipped — Pi not reachable (probe failed or disabled)');
            return;
        }

        log.warn('auto-sync starting — Pi reachable, checking for new cells');
        const result = await syncEncFromPi((p) => {
            // Bubble up only meaningful phase changes — not every per-cell pulse.
            if (p.phase === 'fetching' && p.cellId) {
                log.warn(`  pulling ${p.cellId} (${p.cellsDone ?? 0}/${p.cellCount ?? 0})`);
            } else if (p.phase === 'error') {
                log.warn(`  error: ${p.error}`);
            }
        });

        if (result.cells.length > 0) {
            log.warn(
                `auto-sync complete: imported ${result.cells.length} new cell(s) — ${result.cells.map((c) => c.id).join(', ')}`,
            );
        } else if (result.skipped.length > 0) {
            log.warn(`auto-sync complete: no new cells (already in sync, ${result.skipped.length} cells)`);
        } else {
            log.warn('auto-sync complete: nothing to pull');
        }
    } catch (err) {
        // Never block app startup on a sync failure. Manual retry path still
        // exists via Settings → Vessel → ENC Cells.
        log.warn(`auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

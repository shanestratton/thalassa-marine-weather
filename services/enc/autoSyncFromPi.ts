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
import { GpsService } from '../GpsService';

const log = createLogger('autoSyncFromPi');

// In-process guard so multiple MapHub mounts in one session don't redundantly
// hit the Pi. localStorage flag would persist across launches, which is wrong —
// we want to re-check every launch in case the Pi has new cells.
let attempted = false;

/**
 * Cells pulled per auto-sync run. A typical AU fleet has 900+ decrypted
 * cells; pulling all of them on first launch is minutes of wifi + ~600 MB
 * of storage. We cap at 20 nearest-to-user — enough to cover a cruising
 * region of a few hundred nautical miles — and let later launches /
 * manual syncs pull the rest.
 */
const AUTO_SYNC_MAX_CELLS = 20;

export async function autoSyncFromPiIfPossible(): Promise<void> {
    if (attempted) return;
    attempted = true;

    try {
        if (!piCache.isAvailable()) {
            log.warn('auto-sync skipped — Pi not reachable (probe failed or disabled)');
            return;
        }

        // Locate the punter — drives nearest-first pull ordering. If GPS is
        // off or hasn't fixed yet, we still sync but without prioritisation
        // (the Pi's alphabetical order is essentially random across the chart
        // set, but the cap at AUTO_SYNC_MAX_CELLS keeps the run bounded).
        const pos = await GpsService.getCurrentPosition().catch(() => null);
        const priorityCenter = pos ? { lat: pos.latitude, lon: pos.longitude } : undefined;
        if (priorityCenter) {
            log.warn(
                `auto-sync starting — Pi reachable, priority centre (${priorityCenter.lat.toFixed(3)}, ${priorityCenter.lon.toFixed(3)})`,
            );
        } else {
            log.warn('auto-sync starting — Pi reachable, no GPS fix (alphabetical order)');
        }

        const result = await syncEncFromPi(
            (p) => {
                // Bubble up only meaningful phase changes — not every per-cell pulse.
                if (p.phase === 'fetching' && p.cellId) {
                    log.warn(`  pulling ${p.cellId} (${p.cellsDone ?? 0}/${p.cellCount ?? 0})`);
                } else if (p.phase === 'error') {
                    log.warn(`  error: ${p.error}`);
                }
            },
            { priorityCenter, maxCells: AUTO_SYNC_MAX_CELLS },
        );

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

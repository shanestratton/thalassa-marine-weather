/**
 * Auto-sync ENC cells from the user's Bosun Pi — runs on app mount AND
 * periodically (every 10 min while the app is foregrounded), in the
 * background, no UI required. If the Pi is reachable and has cells the
 * device doesn't already have at the same edition + sizeBytes, they're
 * pulled and `importCell()`d. The user just sees more cells appear in
 * the layer FAB count and the chart rendering.
 *
 * If the Pi is unreachable (away from the boat, on cellular, offline),
 * the function fails silently — never blocks the app. Manual sync via
 * Settings → Vessel → ENC Cells stays as a fallback for explicit re-trigger.
 *
 * The polling means a user who buys a chart at the marina cafe and
 * walks back to the boat will have the Pi auto-decrypt (via the
 * filesystem watcher) and within 10 minutes the phone pulls it
 * automatically. Zero taps.
 */
import { createLogger } from '../../utils/createLogger';
import { syncEncFromPi } from '../EncImportService';
import { piCache } from '../PiCacheService';
import { GpsService } from '../GpsService';

const log = createLogger('autoSyncFromPi');

/**
 * Cells pulled per auto-sync run. A typical AU fleet has 900+ decrypted
 * cells; pulling all of them on first launch is minutes of wifi + ~600 MB
 * of storage. We cap at 20 nearest-to-user — enough to cover a cruising
 * region of a few hundred nautical miles — and let later polls fill out.
 */
const AUTO_SYNC_MAX_CELLS = 20;

/** Minimum gap between auto-sync attempts. Throttles repeated mounts
 *  + the periodic poll so we don't hammer the Pi. */
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Periodic re-poll interval while app foregrounded. */
const AUTO_SYNC_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let lastAttemptMs = 0;
let inFlight: Promise<void> | null = null;
let pollHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Kick off auto-sync now AND set up a periodic poll. Idempotent — calling
 * twice (MapHub re-mounts, app resume) just reuses the existing poller.
 * Capacitor pauses JS timers when backgrounded, so the poll naturally
 * pauses and resumes with the app lifecycle.
 */
export function startAutoSyncPolling(): void {
    // DEFERRED ~10 s (z10-boot audit #8): the immediate kick ran its Pi probe
    // + native GPS fix + potential multi-MB pulls right inside the boot
    // window, competing with the first chart merge for main thread + wifi.
    // Ten seconds later the chart is up and the sync runs in calm water; the
    // 10-minute poll cadence is otherwise unchanged.
    setTimeout(() => void autoSyncFromPiIfPossible(), 10_000);
    if (!pollHandle) {
        pollHandle = setInterval(() => {
            void autoSyncFromPiIfPossible();
        }, AUTO_SYNC_POLL_INTERVAL_MS);
    }
}

export async function autoSyncFromPiIfPossible(): Promise<void> {
    // Coalesce concurrent calls
    if (inFlight) return inFlight;
    // Throttle: skip if we ran very recently
    const now = Date.now();
    if (now - lastAttemptMs < AUTO_SYNC_MIN_INTERVAL_MS) return;
    lastAttemptMs = now;

    inFlight = runAutoSyncOnce().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

async function runAutoSyncOnce(): Promise<void> {
    try {
        if (!piCache.isAvailable()) {
            log.info('auto-sync skipped — Pi not reachable (probe failed or disabled)');
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
        log.warn(`auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

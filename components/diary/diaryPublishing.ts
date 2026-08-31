/**
 * Confirmed Voyage Log publishing for Diary entries.
 *
 * A public Diary flag is meaningful only once both sides of the public page
 * are ready: the Voyage Log must be enabled and the Diary row must be
 * confirmed on the server. Keep that ordering in one place so every Diary
 * surface tells the punter the same, truthful story.
 */

import { DiaryService } from '../../services/DiaryService';
import { type VoyageLogConfig, VoyageLogService } from '../../services/VoyageLogService';

export type DiaryPublishFailure = 'voyage-log' | 'entry';

export type DiaryPublishResult =
    | { ok: true; config: VoyageLogConfig; deferred?: boolean }
    | { ok: false; reason: DiaryPublishFailure };

/**
 * Record the skipper's publication choice before doing any cloud-only Voyage
 * Log setup. That leaves a durable private-but-pending intent if the boat is
 * offline: the device/Pi relay can publish the entry once the existing public
 * log is reachable, rather than silently discarding the tap.
 */
export const publishDiaryEntryToVoyageLog = async (entryId: string): Promise<DiaryPublishResult> => {
    // The entry and the public-page config travel on different durable paths.
    // Record both intents before any network work so a Pi-only diary upload
    // cannot leave a first-time Voyage Log permanently unavailable.
    VoyageLogService.markEnableRequested(entryId);

    let published: boolean | 'deferred' = false;
    try {
        published = await DiaryService.setEntryPublished(entryId, true);
    } catch {
        // A local offline entry still writes its intent before returning false;
        // retain the ordinary failure flow below for a genuine service error.
    }

    // The first attempt after the app wakes rides a cold radio and a token
    // refresh, and failing once then succeeding on the very next tap was a
    // reliable ritual (Shane, 2026-08-31: "when i press publish again, it
    // goes straight through and tells me everything is ok"). The app now
    // presses the second time itself; everything underneath is idempotent —
    // the pending-enable list only clears on success.
    let config: VoyageLogConfig | null = null;
    for (let attempt = 0; attempt < 2 && !config; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));
        try {
            config = await VoyageLogService.ensurePendingEnabled();
        } catch {
            config = null;
        }
    }
    if (!config) return { ok: false, reason: 'voyage-log' };

    if (!published) return { ok: false, reason: 'entry' };

    // Deferred: the intent is durable and rides the entry's first server
    // write — publishing an entry whose video is still draining is the
    // ORDINARY flow, not an error (Shane hit the scary toast doing exactly
    // that, 2026-08-31).
    if (published === 'deferred') return { ok: true, config, deferred: true };

    return { ok: true, config };
};

/** A false result means the public state was not confirmed as changed. */
export const unpublishDiaryEntryFromVoyageLog = async (entryId: string): Promise<boolean> => {
    try {
        // Unpublishing can never defer ('deferred' is publish-only), so
        // anything short of a confirmed server row is an honest false.
        const unpublished = (await DiaryService.setEntryPublished(entryId, false)) === true;
        if (unpublished) VoyageLogService.clearEnableRequest(entryId);
        return unpublished;
    } catch {
        return false;
    }
};

export const diaryPublishFailureMessage = (reason: DiaryPublishFailure): string => {
    if (reason === 'voyage-log') {
        return "We couldn't prepare your Voyage Log. This entry is still private — check your connection and try again.";
    }
    return "Thalassa could not confirm this entry online, so it has not been published. It may still be syncing — keep the app open, then try again when you're connected.";
};

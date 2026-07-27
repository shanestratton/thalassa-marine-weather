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

export type DiaryPublishResult = { ok: true; config: VoyageLogConfig } | { ok: false; reason: DiaryPublishFailure };

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

    let published = false;
    try {
        published = await DiaryService.setEntryPublished(entryId, true);
    } catch {
        // A local offline entry still writes its intent before returning false;
        // retain the ordinary failure flow below for a genuine service error.
    }

    let config: VoyageLogConfig | null;
    try {
        config = await VoyageLogService.ensurePendingEnabled();
    } catch {
        return { ok: false, reason: 'voyage-log' };
    }
    if (!config) return { ok: false, reason: 'voyage-log' };

    if (!published) return { ok: false, reason: 'entry' };

    return { ok: true, config };
};

/** A false result means the public state was not confirmed as changed. */
export const unpublishDiaryEntryFromVoyageLog = async (entryId: string): Promise<boolean> => {
    try {
        const unpublished = await DiaryService.setEntryPublished(entryId, false);
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

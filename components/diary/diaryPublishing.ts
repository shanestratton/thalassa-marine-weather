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
 * Enable the public Voyage Log before changing the entry. `true` from
 * DiaryService means the row was confirmed by Supabase; a queued local entry
 * deliberately returns `false` and remains private until it has synced.
 */
export const publishDiaryEntryToVoyageLog = async (entryId: string): Promise<DiaryPublishResult> => {
    let config: VoyageLogConfig | null;
    try {
        config = await VoyageLogService.ensureEnabled();
    } catch {
        return { ok: false, reason: 'voyage-log' };
    }
    if (!config) return { ok: false, reason: 'voyage-log' };

    try {
        const published = await DiaryService.setEntryPublished(entryId, true);
        if (!published) return { ok: false, reason: 'entry' };
    } catch {
        return { ok: false, reason: 'entry' };
    }

    return { ok: true, config };
};

/** A false result means the public state was not confirmed as changed. */
export const unpublishDiaryEntryFromVoyageLog = async (entryId: string): Promise<boolean> => {
    try {
        return await DiaryService.setEntryPublished(entryId, false);
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

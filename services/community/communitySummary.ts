/** Tiny RAM-only descriptor. Never used as a suitability, routing or depth input. */
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../authIdentityScope';
const entries = new Map<string, { generation: number; at: number; count: number }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const COMMUNITY_NOTES_CHANGED = 'thalassa:community-notes-changed';
const changed = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMMUNITY_NOTES_CHANGED));
};
subscribeAuthIdentityScope(() => {
    entries.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    changed();
});
export function recordCommunityNotes(id: string, count: number, now = Date.now()) {
    if (!Number.isInteger(count) || count < 0 || count > 12) return;
    clearTimeout(timers.get(id));
    entries.delete(id);
    const entry = { generation: getAuthIdentityScope().generation, at: now, count };
    entries.set(id, entry);
    timers.set(
        id,
        setTimeout(() => {
            if (entries.get(id) === entry) {
                entries.delete(id);
                timers.delete(id);
                changed();
            }
        }, 15000),
    );
    while (entries.size > 128) {
        const oldest = entries.keys().next().value!;
        clearTimeout(timers.get(oldest));
        timers.delete(oldest);
        entries.delete(oldest);
    }
    changed();
}
export function currentCommunityNote(id: string, now = Date.now()): string | undefined {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const entry = entries.get(id);
    if (!entry || entry.generation !== getAuthIdentityScope().generation || now < entry.at || now - entry.at >= 15000) {
        entries.delete(id);
        clearTimeout(timers.get(id));
        timers.delete(id);
        return;
    }
    return entry.count
        ? 'Community skipper notes available (latest limited view): indicative observations only; verify locally. They do not change this weather verdict.'
        : 'No community notes in the latest limited view; this does not establish suitability.';
}
export function retireCommunityNotes(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (entries.delete(id)) changed();
}

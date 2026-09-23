import type { DiaryEntry } from './DiaryService';

type ResolveDiaryId = (id: string) => string | null;

/**
 * A save keeps its operation id when its temporary device id becomes a cloud
 * id. Never compare title/body/time: two deliberately identical posts are
 * still two posts. Ownership is part of every identity, including legacy ids.
 *
 * Inputs are in source-priority order. Keep the newest revision of a logical
 * entry, with the first source winning ties (pending before cached, for example).
 * This is display reconciliation only; it never deletes durable outbox rows.
 */
export function reconcileDiaryEntries(entries: readonly DiaryEntry[], resolveServerId?: ResolveDiaryId): DiaryEntry[] {
    const parents = entries.map((_, index) => index);
    const find = (index: number): number => {
        while (parents[index] !== index) {
            parents[index] = parents[parents[index]];
            index = parents[index];
        }
        return index;
    };
    const aliases = new Map<string, number>();
    entries.forEach((entry, index) => {
        const owner = entry.owner_user_id ?? entry.user_id;
        const keys = [JSON.stringify([owner, 'id', entry.id])];
        const mapped = entry.id.startsWith('offline-') ? resolveServerId?.(entry.id) : null;
        if (mapped) keys.push(JSON.stringify([owner, 'id', mapped]));
        if (entry.client_operation_id) keys.push(JSON.stringify([owner, 'operation', entry.client_operation_id]));
        for (const key of keys) {
            const previous = aliases.get(key);
            if (previous !== undefined) parents[find(index)] = find(previous);
            else aliases.set(key, index);
        }
    });
    const revision = (entry: DiaryEntry): number =>
        Number.isSafeInteger(entry.client_revision) && (entry.client_revision ?? 0) > 0 ? entry.client_revision! : 1;
    const winners = new Map<number, DiaryEntry>();
    entries.forEach((entry, index) => {
        const identity = find(index);
        const existing = winners.get(identity);
        if (!existing || revision(entry) > revision(existing)) winners.set(identity, entry);
    });
    return [...winners.values()];
}

/** Polls retain unsynced local saves without retaining their cloud twin too. */
export function reconcileDiaryRefresh(
    fresh: readonly DiaryEntry[],
    previous: readonly DiaryEntry[],
    resolveServerId?: ResolveDiaryId,
): DiaryEntry[] {
    return reconcileDiaryEntries(
        [...fresh, ...previous.filter((entry) => entry.id.startsWith('offline-'))],
        resolveServerId,
    ).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

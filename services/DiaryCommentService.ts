import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';

export interface DiaryGuestComment {
    id: string;
    entry_id: string;
    guest_name: string;
    body: string;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
}

const commentChangeListeners = new Set<() => void>();
export function subscribeDiaryCommentChanges(listener: () => void): () => void {
    commentChangeListeners.add(listener);
    return () => {
        commentChangeListeners.delete(listener);
    };
}

/** One metadata-only batch per page of entry IDs, not a body fetch per card.
 * RLS restricts rows to the current public-log owner. Prior-owner approvals
 * need reviewing again, exactly as they do in the entry's moderation panel.
 */
export async function listPendingDiaryCommentCounts(
    entryIds: readonly string[],
    signal: AbortSignal,
): Promise<Record<string, number>> {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !supabase) throw new Error('Sign in to review comments.');
    const ids = [...new Set(entryIds.filter((id) => id && !id.startsWith('offline-')))];
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const pageSize = 500;
    for (let start = 0; start < ids.length; start += 100) {
        const batch = ids.slice(start, start + 100);
        for (let offset = 0; ; offset += pageSize) {
            if (signal.aborted) throw new Error('Comment check cancelled.');
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed. Reload comments.');
            const { data, error } = await supabase
                .from('diary_guest_comments')
                .select('id, entry_id')
                .in('entry_id', batch)
                .in('status', ['pending', 'approved'])
                .or(`status.eq.pending,reviewed_by.is.null,reviewed_by.neq.${scope.userId}`)
                .order('id', { ascending: true })
                .abortSignal(signal)
                .range(offset, offset + pageSize - 1);
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed. Reload comments.');
            if (signal.aborted) throw new Error('Comment check cancelled.');
            if (error) throw new Error('Comment checks unavailable. Try again when connected.');
            for (const row of data ?? []) {
                if (!batch.includes(row.entry_id) || seen.has(row.id)) continue;
                seen.add(row.id);
                counts.set(row.entry_id, (counts.get(row.entry_id) ?? 0) + 1);
            }
            if ((data?.length ?? 0) < pageSize) break;
        }
    }
    return Object.fromEntries(counts);
}
export async function listDiaryGuestComments(entryId: string): Promise<DiaryGuestComment[]> {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !supabase) throw new Error('Sign in to review comments.');
    const { data, error } = await supabase
        .from('diary_guest_comments')
        .select('id, entry_id, guest_name, body, status, created_at, reviewed_by')
        .eq('entry_id', entryId)
        .in('status', ['pending', 'approved'])
        .order('status', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200);
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed. Reload comments.');
    if (error) throw new Error('Comments could not be loaded. Try again when connected.');
    // A transferred public log needs its new skipper's approval, including
    // comments approved by the previous owner but no longer exposed publicly.
    return (data ?? []).map((row) => ({
        ...row,
        status: row.status === 'approved' && row.reviewed_by !== scope.userId ? 'pending' : row.status,
    })) as DiaryGuestComment[];
}
export async function moderateDiaryGuestComment(commentId: string, action: 'approve' | 'reject'): Promise<void> {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !supabase) throw new Error('Sign in to review comments.');
    const { data, error } = await supabase.rpc('moderate_diary_guest_comment', {
        p_comment_id: commentId,
        p_action: action,
    });
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed. Reload comments.');
    if (error || data !== true)
        throw new Error('That comment could not be changed. Only the public-log owner can review it.');
    for (const listener of commentChangeListeners) {
        try {
            listener();
        } catch {
            /* A UI subscriber must not undo confirmed moderation. */
        }
    }
}

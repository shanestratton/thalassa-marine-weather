export interface PublicDiaryComment {
    id: string;
    guest_name: string;
    body: string;
    created_at: string;
}
export interface PublicCommentSubmission {
    handle: string;
    entry_id: string;
    submission_id: string;
    guest_name: string;
    body: string;
    website: string;
}
const endpoint = () => `${(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/u, '')}/functions/v1/diary-comments`;

async function request(path: string, options: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!import.meta.env.VITE_SUPABASE_URL) throw new Error('Comments are temporarily unavailable.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 15_000);
    try {
        const response = await fetch(endpoint() + path, {
            ...options,
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
        });
        const value = await response.json().catch(() => null);
        if (!response.ok)
            throw new Error(
                response.status === 429
                    ? 'Please wait before sending another comment.'
                    : response.status === 404
                      ? 'This diary entry is not currently public.'
                      : response.status === 400
                        ? 'Please use a name and comment without links or markup.'
                        : 'Comments are temporarily unavailable. Please try again.',
            );
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Comments are temporarily unavailable.');
        return value as Record<string, unknown>;
    } catch (error) {
        if (controller.signal.aborted && !signal.aborted) throw new Error('Comments timed out. Please try again.');
        throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}
export async function readPublicDiaryComments(
    handle: string,
    entryId: string,
    signal: AbortSignal,
): Promise<PublicDiaryComment[]> {
    const value = await request(`?${new URLSearchParams({ handle, entry_id: entryId })}`, { method: 'GET' }, signal);
    if (!Array.isArray(value.comments)) throw new Error('Comments are temporarily unavailable.');
    return value.comments
        .slice(0, 100)
        .filter(
            (row): row is PublicDiaryComment =>
                !!row &&
                typeof row === 'object' &&
                typeof row.id === 'string' &&
                typeof row.guest_name === 'string' &&
                row.guest_name.length <= 120 &&
                typeof row.body === 'string' &&
                row.body.length <= 4000 &&
                typeof row.created_at === 'string' &&
                Number.isFinite(Date.parse(row.created_at)),
        );
}
export async function submitPublicDiaryComment(input: PublicCommentSubmission, signal: AbortSignal): Promise<void> {
    const value = await request(
        '',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
        signal,
    );
    if (value.ok !== true || value.status !== 'pending')
        throw new Error('Your comment could not be confirmed. Please try again.');
}

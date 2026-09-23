import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    listDiaryGuestComments,
    moderateDiaryGuestComment,
    type DiaryGuestComment,
} from '../../services/DiaryCommentService';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';

/** Owners only: the database checks current public-log ownership for every row/action. */
export function DiaryCommentModeration({ entryId }: { entryId: string }) {
    // This mounts only for the diary entry being read, never for every list card.
    // Show its review queue immediately instead of hiding approval behind a tap.
    const [open, setOpen] = useState(true);
    const [comments, setComments] = useState<DiaryGuestComment[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const refresh = useCallback(async () => {
        if (entryId.startsWith('offline-')) return;
        const version = ++generation.current;
        setLoading(true);
        setError('');
        try {
            const rows = await listDiaryGuestComments(entryId);
            if (generation.current === version) setComments(rows);
        } catch (cause) {
            if (generation.current === version)
                setError(cause instanceof Error ? cause.message : 'Comments unavailable.');
        } finally {
            if (generation.current === version) setLoading(false);
        }
    }, [entryId]);
    useEffect(() => {
        generation.current++;
        setComments([]);
        setBusy(null);
        setError('');
        if (open) void refresh();
        return () => {
            // This is an async request fence, not a DOM ref snapshot.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            generation.current++;
        };
    }, [entryId, open, refresh]);
    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                generation.current++;
                setComments([]);
                setOpen(false);
                setBusy(null);
                setLoading(false);
                setError('');
            }),
        [],
    );
    const review = async (id: string, action: 'approve' | 'reject') => {
        if (busy) return;
        const version = generation.current;
        setBusy(id);
        setError('');
        try {
            await moderateDiaryGuestComment(id, action);
            if (version !== generation.current) return;
            setComments((rows) =>
                action === 'reject'
                    ? rows.filter((row) => row.id !== id)
                    : rows.map((row) => (row.id === id ? { ...row, status: 'approved' } : row)),
            );
        } catch (cause) {
            if (version === generation.current)
                setError(cause instanceof Error ? cause.message : 'Could not update comment.');
        } finally {
            if (version === generation.current) setBusy(null);
        }
    };
    if (entryId.startsWith('offline-')) return null;
    return (
        <section
            aria-label="Guest comment approval"
            className="rounded-2xl border border-white/10 bg-slate-900/60 overflow-hidden"
        >
            <button
                type="button"
                className="flex w-full items-center justify-between p-4 text-left text-sm font-bold text-sky-300"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span>
                    Guest comments
                    {open && comments.some((row) => row.status === 'pending')
                        ? ` · ${comments.filter((row) => row.status === 'pending').length} to review`
                        : ''}
                </span>
                <span aria-hidden>{open ? '▴' : '▾'}</span>
            </button>
            {open && (
                <div className="space-y-3 px-4 pb-4">
                    <p className="text-xs text-slate-400">
                        Approve or reject comments for this entry. Only approved comments can appear on your public
                        diary.
                    </p>
                    <button
                        type="button"
                        className="min-h-10 text-sm text-sky-300"
                        onClick={() => void refresh()}
                        disabled={loading || !!busy}
                    >
                        Refresh comments
                    </button>
                    {loading && (
                        <p role="status" className="text-sm text-slate-400">
                            Loading comments…
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-amber-300">
                            {error}
                        </p>
                    )}
                    {!loading && !error && !comments.length && (
                        <p className="text-sm text-slate-400">No comments to review yet.</p>
                    )}
                    {comments.map((comment) => (
                        <article key={comment.id} className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                            <div className="flex items-start justify-between gap-2">
                                <strong className="text-sm break-words">{comment.guest_name}</strong>
                                <span className="text-xs text-slate-400">
                                    {comment.status === 'pending' ? 'Awaiting approval' : 'Approved'}
                                </span>
                            </div>
                            <p className="whitespace-pre-wrap break-words py-3 text-sm text-slate-200">
                                {comment.body}
                            </p>
                            <div className="flex gap-2">
                                {comment.status === 'pending' && (
                                    <button
                                        type="button"
                                        disabled={loading || !!busy}
                                        onClick={() => void review(comment.id, 'approve')}
                                        className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white"
                                    >
                                        {busy === comment.id ? 'Saving…' : 'Approve'}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    disabled={loading || !!busy}
                                    onClick={() => void review(comment.id, 'reject')}
                                    className="min-h-11 rounded-xl border border-rose-400/30 px-4 text-sm text-rose-300"
                                >
                                    {comment.status === 'pending' ? 'Reject' : 'Remove from public page'}
                                </button>
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}

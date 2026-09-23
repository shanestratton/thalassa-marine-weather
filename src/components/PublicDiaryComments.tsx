import React, { useEffect, useRef, useState } from 'react';
import { readPublicDiaryComments, submitPublicDiaryComment, type PublicDiaryComment } from '../diaryCommentsApi';

/** Guest comments never optimistically appear in the public thread. */
export function PublicDiaryComments({ handle, entryId }: { handle: string; entryId: string }) {
    const [comments, setComments] = useState<PublicDiaryComment[]>([]);
    const [name, setName] = useState('');
    const [body, setBody] = useState('');
    const [website, setWebsite] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [sent, setSent] = useState(false);
    const [reload, setReload] = useState(0);
    const submission = useRef<{ text: string; id: string } | null>(null);
    const generation = useRef(0);
    const sendController = useRef<AbortController | null>(null);
    useEffect(() => {
        generation.current++;
        setComments([]);
        setError('');
        setSent(false);
        setBusy(false);
        setName('');
        setBody('');
        setWebsite('');
        submission.current = null;
        return () => {
            // This is an async request fence, not a DOM ref snapshot.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            generation.current++;
            sendController.current?.abort();
            sendController.current = null;
        };
    }, [handle, entryId]);
    useEffect(() => {
        const controller = new AbortController();
        const current = generation.current;
        setLoading(true);
        setError('');
        void readPublicDiaryComments(handle, entryId, controller.signal)
            .then((rows) => {
                if (!controller.signal.aborted && current === generation.current) setComments(rows);
            })
            .catch((cause) => {
                if (!controller.signal.aborted && current === generation.current)
                    setError(cause instanceof Error ? cause.message : 'Comments unavailable.');
            })
            .finally(() => {
                if (!controller.signal.aborted && current === generation.current) setLoading(false);
            });
        return () => controller.abort();
    }, [handle, entryId, reload]);
    const send = async (event: React.FormEvent) => {
        event.preventDefault();
        if (sendController.current) return;
        const guestName = name.trim(),
            commentBody = body.trim();
        if (
            !guestName ||
            !commentBody ||
            [...guestName].length > 60 ||
            [...commentBody].length > 2000 ||
            /[<>]|https?:\/\/|www\.|javascript:|data:/iu.test(`${guestName}\n${commentBody}`)
        ) {
            setError('Please use a name and comment without links or markup.');
            return;
        }
        const text = JSON.stringify([guestName, commentBody]);
        if (!submission.current || submission.current.text !== text)
            submission.current = { text, id: crypto.randomUUID() };
        const controller = new AbortController();
        sendController.current = controller;
        const current = generation.current;
        setBusy(true);
        setError('');
        setSent(false);
        try {
            await submitPublicDiaryComment(
                {
                    handle,
                    entry_id: entryId,
                    submission_id: submission.current.id,
                    guest_name: guestName,
                    body: commentBody,
                    website,
                },
                controller.signal,
            );
            if (current !== generation.current) return;
            setSent(true);
            setBody('');
            submission.current = null;
        } catch (cause) {
            if (!controller.signal.aborted && current === generation.current)
                setError(cause instanceof Error ? cause.message : 'Your comment could not be sent.');
        } finally {
            if (current === generation.current) {
                setBusy(false);
                sendController.current = null;
            }
        }
    };
    return (
        <section className="mt-6 border-t border-white/10 pt-5" aria-label="Guest comments">
            <h3 className="text-base font-bold text-slate-100">Comments</h3>
            <p className="mt-1 text-xs text-slate-400">
                Leave the crew a message. The skipper approves comments before they appear here.
            </p>
            {loading && (
                <p role="status" className="mt-3 text-sm text-slate-400">
                    Loading comments…
                </p>
            )}
            {comments.map((comment) => (
                <article key={comment.id} className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <strong className="break-words text-sm text-teal-200">{comment.guest_name}</strong>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">{comment.body}</p>
                </article>
            ))}
            <form onSubmit={(event) => void send(event)} className="mt-4 space-y-3">
                <label className="block text-sm text-slate-300">
                    Your name
                    <input
                        name="guest_name"
                        autoComplete="nickname"
                        maxLength={60}
                        required
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                        className="mt-1 block min-h-11 w-full rounded-xl border border-white/15 bg-slate-900 px-3 text-base text-white"
                    />
                </label>
                <label className="block text-sm text-slate-300">
                    Your comment
                    <textarea
                        name="comment"
                        maxLength={2000}
                        rows={3}
                        required
                        value={body}
                        disabled={busy}
                        onChange={(event) => setBody(event.target.value)}
                        className="mt-1 block w-full resize-y rounded-xl border border-white/15 bg-slate-900 p-3 text-base text-white"
                    />
                </label>
                <div
                    style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}
                    aria-hidden="true"
                >
                    <label>
                        Website
                        <input
                            name="website"
                            tabIndex={-1}
                            autoComplete="off"
                            value={website}
                            onChange={(event) => setWebsite(event.target.value)}
                        />
                    </label>
                </div>
                {error && (
                    <p role="alert" className="text-sm text-amber-300">
                        {error}{' '}
                        <button type="button" onClick={() => setReload((value) => value + 1)} className="underline">
                            Reload comments
                        </button>
                    </p>
                )}
                {sent && (
                    <p role="status" className="text-sm text-teal-200">
                        Thanks! Your comment is waiting for the skipper’s approval.
                    </p>
                )}
                <button
                    type="submit"
                    disabled={busy || !name.trim() || !body.trim()}
                    className="min-h-11 rounded-xl bg-teal-600 px-4 text-sm font-bold text-white disabled:opacity-50"
                >
                    {busy ? 'Sending…' : 'Send for approval'}
                </button>
            </form>
        </section>
    );
}

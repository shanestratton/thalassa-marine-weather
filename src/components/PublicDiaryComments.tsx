import React, { useEffect, useId, useRef, useState } from 'react';
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
    const noteId = useId();
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
    const canSend = !!name.trim() && !!body.trim();
    return (
        <section className="pv-comments flex flex-col gap-3" aria-label="Guest comments">
            <h3 className="pv-comments__title">Comments</h3>
            <p className="pv-comments__intro">
                Leave the crew a message. The skipper approves comments before they appear here.
            </p>
            {loading && (
                <p role="status" className="pv-comments__intro">
                    Loading comments…
                </p>
            )}
            {comments.map((comment) => (
                <article key={comment.id} className="pv-comment">
                    <strong>{comment.guest_name}</strong>
                    <p className="mt-1">{comment.body}</p>
                </article>
            ))}
            <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
                <label className="pv-field block">
                    Your name
                    <input
                        name="guest_name"
                        autoComplete="nickname"
                        maxLength={60}
                        required
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                        className="pv-input mt-1.5 block"
                    />
                </label>
                <label className="pv-field block">
                    Your comment
                    <textarea
                        name="comment"
                        maxLength={2000}
                        rows={3}
                        required
                        value={body}
                        disabled={busy}
                        onChange={(event) => setBody(event.target.value)}
                        className="pv-input mt-1.5 block"
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
                    <p role="alert" className="pv-form-error">
                        {error}{' '}
                        <button type="button" onClick={() => setReload((value) => value + 1)} className="pv-link">
                            Reload comments
                        </button>
                    </p>
                )}
                {sent && (
                    <p role="status" className="pv-form-ok">
                        Thanks! Your comment is waiting for the skipper’s approval.
                    </p>
                )}
                {/* Disabled is outlined by .pv-btn:disabled, not a faded teal slab;
                    the note says why it cannot be pressed yet. */}
                <button
                    type="submit"
                    disabled={busy || !canSend}
                    aria-describedby={!busy && !canSend ? noteId : undefined}
                    className="pv-btn pv-btn--primary self-start"
                >
                    {busy ? 'Sending…' : 'Send for approval'}
                </button>
                {!busy && !canSend && (
                    <p id={noteId} className="pv-form-note">
                        Add your name and a comment to send.
                    </p>
                )}
            </form>
        </section>
    );
}

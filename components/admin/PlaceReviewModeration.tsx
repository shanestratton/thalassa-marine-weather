import React from 'react';
import { reviewsRequest, type ReviewQueueItem } from '../../services/community/PlaceReviewsService';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { ReviewPhoto } from '../community/ReviewPhoto';
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
export default function PlaceReviewModeration() {
    const [rows, setRows] = React.useState<ReviewQueueItem[]>([]),
        [message, setMessage] = React.useState('Loading moderation queue…'),
        [busy, setBusy] = React.useState(false);
    const ctl = React.useRef<AbortController | null>(null),
        live = React.useRef(true);
    async function load() {
        ctl.current?.abort();
        const next = new AbortController();
        ctl.current = next;
        setRows([]);
        try {
            const data = await reviewsRequest('queue', {}, next.signal);
            if (!next.signal.aborted) {
                setRows(Array.isArray(data?.queue) ? (data.queue.slice(0, 50) as ReviewQueueItem[]) : []);
                setMessage('Up to 50 current items. Approve only after reviewing the exact text or photo.');
            }
        } catch {
            if (!next.signal.aborted) setMessage('Queue unavailable or moderator access required.');
        }
    }
    React.useEffect(() => {
        live.current = true;
        void load();
        const timer = setInterval(() => void load(), 15000);
        const unsubscribe = subscribeAuthIdentityScope(() => {
            ctl.current?.abort();
            setRows([]);
            setMessage('Account changed; reopen moderation.');
        });
        return () => {
            live.current = false;
            ctl.current?.abort();
            clearInterval(timer);
            unsubscribe();
        };
    }, []);
    async function decide(row: ReviewQueueItem, decision: string) {
        ctl.current?.abort();
        const next = new AbortController();
        ctl.current = next;
        setBusy(true);
        setRows([]);
        try {
            await reviewsRequest(
                'moderate',
                {
                    id: row.id,
                    revision: row.revision,
                    photo_id: row.photo_id,
                    photo_revision: row.photo_revision,
                    decision,
                },
                next.signal,
            );
            if (!next.signal.aborted) await load();
        } catch {
            if (!next.signal.aborted) setMessage('Decision refused. Refresh the queue; the content may have changed.');
        } finally {
            if (live.current) setBusy(false);
        }
    }
    return (
        <div className="space-y-4 p-4 text-sm text-slate-200">
            <h3>Place notes moderation</h3>
            <p role="status">{message}</p>
            <button className={button} disabled={busy} onClick={() => void load()}>
                Refresh queue
            </button>
            {rows.map((r) => (
                <article
                    key={r.id + ':' + r.revision + ':' + r.photo_revision}
                    className="space-y-3 rounded-lg border border-white/20 p-3"
                >
                    <p>
                        {r.place_id} · {r.status} · {r.reason || 'Photo review'}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{r.notes}</p>
                    {r.photo_id && <ReviewPhoto id={r.photo_id} />}
                    <div className="flex flex-wrap gap-2">
                        {[
                            ['approve', 'Approve text'],
                            ['remove', 'Remove note'],
                            ['ban', 'Suspend contributor'],
                            ...(r.photo_id
                                ? [
                                      ['approve-photo', 'Approve photo'],
                                      ['remove-photo', 'Remove photo'],
                                  ]
                                : []),
                        ].map(([action, label]) => (
                            <button
                                key={action}
                                className={button}
                                disabled={busy}
                                onClick={() => void decide(r, action)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </article>
            ))}
        </div>
    );
}

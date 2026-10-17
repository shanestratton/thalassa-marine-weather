import React from 'react';
import { chartNotesRequest, CHART_NOTES_CHANGED } from '../../services/community/ChartNotesService';
import { parseChartNotes, isChartNoteId, type ChartNote } from '../../services/community/chartNotesModel';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { ReviewPhoto } from '../community/ReviewPhoto';
type Item = ChartNote & { photo_revision: string | null; status: string; reason: string | null };
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
export default function ChartNoteModeration() {
    const [rows, setRows] = React.useState<Item[]>([]),
        [message, setMessage] = React.useState('Refresh to review current chart-note content.'),
        [busy, setBusy] = React.useState(false);
    const ctl = React.useRef<AbortController | null>(null),
        timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
        live = React.useRef(true);
    React.useEffect(() => {
        live.current = true;
        const clear = () => setRows([]);
        const unsubscribe = subscribeAuthIdentityScope(() => {
            ctl.current?.abort();
            clear();
            setMessage('Account changed; reopen moderation.');
        });
        window.addEventListener(CHART_NOTES_CHANGED, clear);
        window.addEventListener('offline', clear);
        return () => {
            live.current = false;
            ctl.current?.abort();
            clearTimeout(timer.current);
            unsubscribe();
            window.removeEventListener(CHART_NOTES_CHANGED, clear);
            window.removeEventListener('offline', clear);
        };
    }, []);
    async function load() {
        ctl.current?.abort();
        clearTimeout(timer.current);
        const c = new AbortController();
        ctl.current = c;
        setRows([]);
        setBusy(true);
        const start = performance.now();
        timer.current = setTimeout(() => {
            c.abort();
            setRows([]);
            setMessage('Queue read retired. Refresh to recheck.');
        }, 15000);
        try {
            const data = await chartNotesRequest('queue', {}, c.signal);
            if (!Array.isArray(data?.queue) || data.queue.length > 50) throw Error('Invalid moderation queue.');
            const publicRows = parseChartNotes({
                notes: data.queue.map((r) => ({
                    ...r,
                    confirms: 0,
                    denies: 0,
                    my_vote: null,
                    mine: false,
                    reviewed: false,
                })),
                truncated: false,
                server_now: data.server_now,
            });
            const items = publicRows.notes.map((n) => {
                const raw = (data.queue as Record<string, unknown>[]).find((r) => r.id === n.id)!;
                if (
                    !['held', 'visible'].includes(raw.status as string) ||
                    !(raw.reason === null || ['edit', 'report', 'filter'].includes(raw.reason as string)) ||
                    !(raw.photo_revision === null || isChartNoteId(raw.photo_revision))
                )
                    throw Error('Invalid queue revision.');
                return {
                    ...n,
                    status: raw.status as string,
                    reason: raw.reason as string | null,
                    photo_revision: raw.photo_revision as string | null,
                };
            });
            const elapsed = Math.max(0, performance.now() - start),
                remaining = Math.min(
                    15000 - elapsed,
                    ...items.map((n) => Date.parse(n.expires_at) - publicRows.serverNow - elapsed),
                );
            if (c.signal.aborted || remaining <= 0) throw Error('Queue read retired.');
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
                c.abort();
                setRows([]);
                setMessage('Queue read retired. Refresh to recheck.');
            }, remaining);
            setRows(items);
            setMessage('Up to 50 current items. Content approval does not verify the observation.');
        } catch (e) {
            if (!c.signal.aborted)
                setMessage(e instanceof Error ? e.message : 'Queue unavailable or moderator access required.');
        } finally {
            if (live.current) setBusy(false);
        }
    }
    async function decide(r: Item, decision: string) {
        ctl.current?.abort();
        const c = new AbortController();
        ctl.current = c;
        setRows([]);
        setBusy(true);
        try {
            await chartNotesRequest(
                'moderate',
                { id: r.id, revision: r.revision, photo_id: r.photo_id, photo_revision: r.photo_revision, decision },
                c.signal,
            );
            if (!c.signal.aborted) await load();
        } catch {
            if (!c.signal.aborted) setMessage('Decision refused. Refresh; the note or permissions may have changed.');
        } finally {
            if (live.current) setBusy(false);
        }
    }
    return (
        <div className="min-w-0 space-y-4 p-4 text-sm text-slate-200">
            <h3>Unofficial chart notes moderation</h3>
            <p role="status">{message}</p>
            <button className={button} disabled={busy} onClick={() => void load()}>
                Refresh chart queue
            </button>
            {rows.map((r) => (
                <article
                    key={r.id + ':' + r.revision + ':' + r.photo_revision}
                    className="space-y-3 rounded-lg border border-violet-300/30 p-3"
                >
                    <p>
                        {r.kind} · {r.status} · {r.reason || 'Photo review'}
                    </p>
                    <p>
                        {r.observed_date} · {r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{r.message}</p>
                    {r.photo_id && <ReviewPhoto kind="chart" id={r.photo_id} />}
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

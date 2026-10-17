import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    CHART_NOTE_TYPES,
    CHART_PIN_CONSENT,
    validateChartNote,
    isChartNoteId,
    type ChartNote,
    type ChartNoteDraft,
} from '../../services/community/chartNotesModel';
import { chartNotesRequest, chartPhotoRequest, CHART_NOTES_CHANGED } from '../../services/community/ChartNotesService';
import { prepareReviewPhoto } from '../../services/community/PlaceReviewsService';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { HYDROGRAPHIC_REPORTING } from '../../services/community/hydrographicReporting';
import { ReviewPhoto } from './ReviewPhoto';
const button =
    'min-h-[44px] rounded-lg border border-violet-300/30 px-3 py-2 text-sm text-violet-100 disabled:opacity-40';
const field = 'w-full min-w-0 rounded-lg border border-white/20 bg-slate-900 p-3 text-base';
const label = (s: string) => s.replaceAll('-', ' ');
type OwnNote = ChartNoteDraft & { id: string; revision: string; status: string };
export default function ChartNoteSheet({
    note,
    pin,
    retired = false,
    onClose,
}: {
    note?: ChartNote;
    pin: { lat: number; lon: number };
    retired?: boolean;
    onClose: () => void;
}) {
    const [loaded, setShown] = React.useState(note);
    const shown = note && loaded?.revision === note.revision ? loaded : undefined;
    const [editing, setEditing] = React.useState(!note && !retired);
    const [own, setOwn] = React.useState<OwnNote | null>(null);
    const [owned, setOwned] = React.useState<OwnNote[]>([]);
    const [draft, setDraft] = React.useState<ChartNoteDraft>({
        kind: 'other',
        latitude: pin.lat,
        longitude: pin.lon,
        message: '',
        observed_date: new Date().toISOString().slice(0, 10),
        terms_version: '',
        public_consent: '',
    });
    const [photo, setPhoto] = React.useState<File | null>(null);
    const [busy, setBusy] = React.useState(false),
        [message, setMessage] = React.useState('Text is post-moderated. Photos stay private until approved.');
    const ctl = React.useRef<AbortController | null>(null),
        live = React.useRef(true);
    const ownedTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => {
        live.current = true;
        const retired = () => {
            setShown(undefined);
            setOwned([]);
        };
        const timer = setTimeout(retired, 15000);
        const unsubscribe = subscribeAuthIdentityScope(() => {
            ctl.current?.abort();
            setShown(undefined);
            setOwned([]);
            setOwn(null);
            setPhoto(null);
            onClose();
        });
        window.addEventListener(CHART_NOTES_CHANGED, retired);
        window.addEventListener('offline', retired);
        return () => {
            live.current = false;
            ctl.current?.abort();
            clearTimeout(timer);
            clearTimeout(ownedTimer.current);
            unsubscribe();
            window.removeEventListener(CHART_NOTES_CHANGED, retired);
            window.removeEventListener('offline', retired);
        };
    }, [onClose]);
    React.useEffect(() => {
        setShown(note);
    }, [note]);
    function controller() {
        ctl.current?.abort();
        const c = new AbortController();
        ctl.current = c;
        setBusy(true);
        return c;
    }
    function error(e: unknown) {
        if (live.current && !ctl.current?.signal.aborted)
            setMessage(e instanceof Error ? e.message : 'Community notes unavailable.');
    }
    async function act(action: string, choice?: string) {
        if (!shown) return;
        const current = shown,
            c = controller();
        try {
            await chartNotesRequest(
                action,
                {
                    id: current.id,
                    revision: current.revision,
                    ...(action === 'vote' ? { choice } : action === 'report' ? { reason: choice } : {}),
                },
                c.signal,
            );
            if (!c.signal.aborted) {
                setShown(undefined);
                setMessage('Saved. Refresh the map to load the current public notes.');
            }
        } catch (e) {
            error(e);
        } finally {
            if (live.current) setBusy(false);
        }
    }
    async function edit(id: string) {
        const c = controller();
        setShown(undefined);
        setOwned([]);
        try {
            const data = await chartNotesRequest('mine', { id }, c.signal),
                n = data?.note as OwnNote | undefined;
            if (
                !n ||
                !isChartNoteId(n.id) ||
                !isChartNoteId(n.revision) ||
                typeof n.message !== 'string' ||
                n.message.length > 2400
            )
                throw Error('Owned note unavailable.');
            if (!c.signal.aborted) {
                setOwn(n);
                setDraft({
                    kind: n.kind,
                    latitude: n.latitude,
                    longitude: n.longitude,
                    message: n.message,
                    observed_date: n.observed_date,
                    terms_version: '',
                    public_consent: '',
                });
                setEditing(true);
                setMessage('Edits need fresh consent. Held notes still need moderation.');
            }
        } catch (e) {
            error(e);
        } finally {
            if (live.current) setBusy(false);
        }
    }
    async function loadOwned() {
        const c = controller();
        clearTimeout(ownedTimer.current);
        ownedTimer.current = setTimeout(() => {
            c.abort();
            setOwned([]);
            setMessage('Owned-note read retired. Reopen to recheck.');
        }, 15000);
        setOwned([]);
        setEditing(false);
        setShown(undefined);
        try {
            const data = await chartNotesRequest('owned', {}, c.signal);
            if (!Array.isArray(data?.notes) || data.notes.length > 50) throw Error('Owned notes unavailable.');
            if (!c.signal.aborted) setOwned(data.notes as OwnNote[]);
        } catch (e) {
            error(e);
        } finally {
            if (live.current) setBusy(false);
        }
    }
    async function save() {
        const issue = validateChartNote(draft, new Date().toISOString().slice(0, 10));
        if (issue) {
            setMessage(issue);
            return;
        }
        const c = controller();
        try {
            const saved = await chartNotesRequest('save', { ...draft, id: own?.id, revision: own?.revision }, c.signal);
            if (!saved || !isChartNoteId(saved.id) || !isChartNoteId(saved.revision)) throw Error('Save unavailable.');
            if (photo && !c.signal.aborted) {
                try {
                    const blob = await prepareReviewPhoto(photo);
                    if (c.signal.aborted) return;
                    await chartPhotoRequest(saved.id, c.signal, { blob, revision: saved.revision });
                } catch {
                    if (!c.signal.aborted) {
                        setPhoto(null);
                        setEditing(false);
                        setMessage('Note saved. Photo was not accepted; reopen your note to retry.');
                        return;
                    }
                }
            }
            if (!c.signal.aborted) {
                setPhoto(null);
                setEditing(false);
                setOwn(null);
                setMessage('Note saved. Photos remain private until approved. Refresh the map to view public notes.');
            }
        } catch (e) {
            error(e);
        } finally {
            if (live.current) setBusy(false);
        }
    }
    async function deleteOwn() {
        if (!own) return;
        const c = controller();
        try {
            await chartNotesRequest('delete', { id: own.id }, c.signal);
            if (!c.signal.aborted) {
                setEditing(false);
                setOwn(null);
                setMessage('Note removed. Its photo is no longer accessible.');
            }
        } catch (e) {
            error(e);
        } finally {
            if (live.current) setBusy(false);
        }
    }
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title="Unofficial chart notes"
            maxWidth="max-w-lg"
            footer={
                editing ? (
                    <button className={button + ' w-full'} disabled={busy} onClick={() => void save()}>
                        {busy ? 'Saving…' : 'Publish pin and note'}
                    </button>
                ) : undefined
            }
        >
            <div className="min-w-0 space-y-4 text-sm text-slate-200">
                <p className="rounded-lg border border-violet-300/30 p-3 text-violet-200">
                    Community observations can be wrong. They do not update official charts or guide routing, depth
                    clearance or alarms.
                </p>
                <p role="status">{message}</p>
                {shown && (
                    <article className="space-y-3">
                        <p className="font-semibold capitalize">
                            {label(shown.kind)} · {shown.observed_date} UTC
                        </p>
                        <p>
                            {shown.latitude.toFixed(5)}, {shown.longitude.toFixed(5)} · expires{' '}
                            {shown.expires_at.slice(0, 10)}
                        </p>
                        <p className="whitespace-pre-wrap break-words">{shown.message}</p>
                        <p>
                            {shown.confirms} confirm · {shown.denies} deny ·{' '}
                            {shown.reviewed ? 'Content reviewed, observation unverified' : 'Awaiting content review'}
                        </p>
                        {shown.photo_id && <ReviewPhoto kind="chart" id={shown.photo_id} />}
                        {shown.mine ? (
                            <button className={button} disabled={busy} onClick={() => void edit(shown.id)}>
                                Edit / remove my note
                            </button>
                        ) : (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    {(['confirm', 'deny', 'withdraw'] as const).map((v) => (
                                        <button
                                            key={v}
                                            className={button}
                                            disabled={busy || !getAuthIdentityScope().userId}
                                            onClick={() => void act('vote', v)}
                                        >
                                            {v === 'withdraw' ? 'Withdraw vote' : label(v)}
                                            {shown.my_vote === v ? ' ✓' : ''}
                                        </button>
                                    ))}
                                </div>
                                <details>
                                    <summary className="min-h-[44px] cursor-pointer py-3">Report / block</summary>
                                    <div className="flex flex-wrap gap-2">
                                        {['unsafe', 'abuse', 'privacy', 'copyright', 'spam'].map((r) => (
                                            <button
                                                className={button}
                                                disabled={busy}
                                                key={r}
                                                onClick={() => void act('report', r)}
                                            >
                                                Report {r}
                                            </button>
                                        ))}
                                        <button className={button} disabled={busy} onClick={() => void act('block')}>
                                            Hide this contributor
                                        </button>
                                    </div>
                                </details>
                            </>
                        )}
                    </article>
                )}
                {getAuthIdentityScope().userId && (
                    <button className={button} disabled={busy} onClick={() => void loadOwned()}>
                        My latest 50 notes
                    </button>
                )}
                {owned.map((n) => (
                    <button
                        key={n.id}
                        className={button + ' block w-full text-left'}
                        disabled={busy}
                        onClick={() => void edit(n.id)}
                    >
                        {n.observed_date} · {label(n.kind)} · {n.status}
                    </button>
                ))}
                {editing && (
                    <div className="min-w-0 space-y-3">
                        <p>
                            Public pin: {draft.latitude.toFixed(5)}, {draft.longitude.toFixed(5)}.{' '}
                            {own
                                ? 'Existing note location.'
                                : 'Chosen map centre; move the map and reopen to change it.'}
                        </p>
                        <label className="block">
                            Observation type
                            <select
                                className={field}
                                value={draft.kind}
                                onChange={(e) =>
                                    setDraft((d) => ({ ...d, kind: e.target.value as ChartNoteDraft['kind'] }))
                                }
                            >
                                {CHART_NOTE_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                        {label(t)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="block">
                            Observed date (UTC)
                            <input
                                type="date"
                                className={field}
                                value={draft.observed_date}
                                onChange={(e) => setDraft((d) => ({ ...d, observed_date: e.target.value }))}
                            />
                        </label>
                        <label className="block">
                            Observation
                            <textarea
                                className={field + ' min-h-28'}
                                maxLength={2400}
                                value={draft.message}
                                onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
                            />
                        </label>
                        <p className="text-xs">
                            Up to 1200 characters. Omit names, contacts, vessel positions and other private details.
                            Notes fade after 7 days and expire 30 days after the observation date; votes do not renew
                            them.
                        </p>
                        <label className="block">
                            Optional JPEG photo
                            <input
                                className={field}
                                type="file"
                                accept="image/jpeg"
                                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                            />
                        </label>
                        <p className="text-xs">
                            Photos require approval. GPS/EXIF metadata is removed before storage. Maximum 40 photo
                            reservations shared with place reviews; retired photos still count.
                        </p>
                        <label className="flex gap-3">
                            <input
                                className="mt-1 h-5 w-5 shrink-0"
                                type="checkbox"
                                checked={draft.public_consent === CHART_PIN_CONSENT}
                                onChange={(e) =>
                                    setDraft((d) => ({
                                        ...d,
                                        public_consent: e.target.checked ? CHART_PIN_CONSENT : '',
                                        terms_version: e.target.checked ? '2026-10-17' : '',
                                    }))
                                }
                            />
                            <span>
                                I choose to publish this pin, text and any approved photo publicly. I have the rights
                                and consent required by the{' '}
                                <a
                                    href="https://thalassawx.app/terms.html"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline"
                                >
                                    content terms
                                </a>
                                .
                            </span>
                        </label>
                        {own && (
                            <button className={button} disabled={busy} onClick={() => void deleteOwn()}>
                                Remove my note
                            </button>
                        )}
                    </div>
                )}
                <details>
                    <summary className="min-h-[44px] cursor-pointer py-3">
                        Report a chart discrepancy to an official office
                    </summary>
                    <p className="mb-2">
                        Posting here does not notify an authority. Use the relevant office’s form; urgent hazards need
                        the appropriate local authority.
                    </p>
                    <ul className="space-y-2">
                        {HYDROGRAPHIC_REPORTING.map((h) => (
                            <li key={h.id}>
                                <a className="underline" href={h.url} target="_blank" rel="noopener noreferrer">
                                    {h.label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </details>
            </div>
        </ModalSheet>
    );
}

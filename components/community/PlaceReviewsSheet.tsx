import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    DIRECTIONS,
    FACILITIES,
    HOLDING,
    SWELL,
    REVIEW_TERMS,
    blankReview,
    type ReviewDraft,
    type PlaceReview,
    type ReviewPlace,
} from '../../services/community/placeReviewsModel';
import {
    listPlaceReviews,
    reviewsRequest,
    savePlaceReview,
    prepareReviewPhoto,
    photoRequest,
} from '../../services/community/PlaceReviewsService';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { retireCommunityNotes } from '../../services/community/communitySummary';
import { ReviewPhoto } from './ReviewPhoto';
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm text-sky-200 disabled:opacity-40';
export default function PlaceReviewsSheet({ place, onClose }: { place: ReviewPlace; onClose: () => void }) {
    const [reviews, setReviews] = React.useState<PlaceReview[]>([]),
        [mine, setMine] = React.useState<PlaceReview | null>(null);
    const [draft, setDraft] = React.useState<ReviewDraft>(blankReview),
        [editing, setEditing] = React.useState(false),
        [photo, setPhoto] = React.useState<File | null>(null);
    const [message, setMessage] = React.useState('Loading community notes…'),
        [busy, setBusy] = React.useState(false),
        [epoch, setEpoch] = React.useState(0);
    const request = React.useRef<AbortController | null>(null),
        live = React.useRef(true);
    const owner = !!getAuthIdentityScope().userId;
    React.useEffect(() => {
        live.current = true;
        return () => {
            live.current = false;
            request.current?.abort();
        };
    }, [place.id]);
    React.useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                request.current?.abort();
                setReviews([]);
                setMine(null);
                setDraft(blankReview());
                setPhoto(null);
                onClose();
            }),
        [onClose],
    );
    React.useEffect(() => {
        const ctl = new AbortController();
        request.current?.abort();
        request.current = ctl;
        setReviews([]);
        setMine(null);
        let timer: ReturnType<typeof setTimeout>;
        void Promise.all([
            listPlaceReviews(place, ctl.signal),
            owner ? reviewsRequest('mine', { place_id: place.id }, ctl.signal) : Promise.resolve(null),
        ])
            .then(([rows, own]) => {
                if (ctl.signal.aborted) return;
                setReviews(rows);
                setMine(own as unknown as PlaceReview | null);
                setMessage('Latest 12 notes at most. Text is post-moderated; photos require approval.');
            })
            .catch((e) => {
                if (!ctl.signal.aborted) {
                    retireCommunityNotes(place.id);
                    setMessage(e instanceof Error ? e.message : 'Community notes unavailable.');
                }
            })
            .finally(() => {
                if (!ctl.signal.aborted)
                    timer = setTimeout(() => {
                        ctl.abort();
                        setReviews([]);
                        setMine(null);
                        retireCommunityNotes(place.id);
                        setEpoch((x) => x + 1);
                    }, 15000);
            });
        return () => {
            ctl.abort();
            clearTimeout(timer);
        };
    }, [place, owner, epoch]);
    const refresh = () => {
        request.current?.abort();
        setBusy(false);
        setReviews([]);
        setMine(null);
        retireCommunityNotes(place.id);
        setEpoch((x) => x + 1);
    };
    async function act(action: string, input: Record<string, unknown>) {
        request.current?.abort();
        const ctl = new AbortController();
        request.current = ctl;
        setBusy(true);
        setReviews([]);
        retireCommunityNotes(place.id);
        try {
            await reviewsRequest(action, input, ctl.signal);
            if (!ctl.signal.aborted) {
                setEditing(false);
                setPhoto(null);
                refresh();
            }
        } catch (e) {
            if (!ctl.signal.aborted) setMessage(e instanceof Error ? e.message : 'Request failed.');
        } finally {
            if (live.current && !ctl.signal.aborted) setBusy(false);
        }
    }
    async function submit() {
        request.current?.abort();
        const ctl = new AbortController();
        request.current = ctl;
        setBusy(true);
        setReviews([]);
        retireCommunityNotes(place.id);
        try {
            const saved = await savePlaceReview(place, draft, mine?.revision, ctl.signal);
            if (photo && saved) {
                const blob = await prepareReviewPhoto(photo);
                if (ctl.signal.aborted) return;
                await photoRequest(String(saved.id), ctl.signal, { blob, revision: String(saved.revision) });
            }
            if (!ctl.signal.aborted) {
                setEditing(false);
                setPhoto(null);
                setMessage('Saved. Photos stay private until approved.');
                refresh();
            }
        } catch (e) {
            if (!ctl.signal.aborted) setMessage(e instanceof Error ? e.message : 'Could not save.');
        } finally {
            if (live.current && !ctl.signal.aborted) setBusy(false);
        }
    }
    const toggle = (key: 'protection' | 'facilities', value: string) =>
        setDraft((d) => ({
            ...d,
            [key]: d[key].includes(value) ? d[key].filter((x) => x !== value) : [...d[key], value],
        }));
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title={'Skipper notes · ' + place.name}
            maxWidth="max-w-lg"
            zIndex="z-10080"
        >
            <div className="min-w-0 space-y-4 text-sm text-slate-200">
                <p className="text-amber-200">
                    Community observations are indicative and may be old or incomplete. They do not establish holding,
                    shelter, depth, permission or a safe route.
                </p>
                <p role="status">{message}</p>
                <button className={button} disabled={busy} onClick={refresh}>
                    Refresh notes
                </button>
                {owner ? (
                    <button
                        className={button}
                        disabled={busy}
                        onClick={() => {
                            setDraft(
                                mine ? { ...mine, visited: mine.visited ?? '', terms_version: '' } : blankReview(),
                            );
                            setEditing(true);
                        }}
                    >
                        {' '}
                        {mine ? 'Edit my note' : 'Add my note'}
                    </button>
                ) : (
                    <p>Sign in to contribute, report, block contributors or view photos.</p>
                )}
                {editing && (
                    <form
                        className="space-y-3"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void submit();
                        }}
                    >
                        <label className="block">
                            Holding observed
                            <select
                                className="thalassa-select appearance-none block w-full bg-slate-900 p-3 pr-10 text-slate-200"
                                value={draft.holding}
                                onChange={(e) =>
                                    setDraft({ ...draft, holding: e.target.value as ReviewDraft['holding'] })
                                }
                            >
                                {HOLDING.map((x) => (
                                    <option key={x}>{x}</option>
                                ))}
                            </select>
                        </label>
                        <fieldset>
                            <legend>Protection observed with wind FROM</legend>
                            <div className="flex flex-wrap gap-2">
                                {DIRECTIONS.map((x) => (
                                    <label key={x} className={button}>
                                        <input
                                            type="checkbox"
                                            checked={draft.protection.includes(x)}
                                            onChange={() => toggle('protection', x)}
                                        />{' '}
                                        {x}
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <label className="block">
                            Swell observed
                            <select
                                className="thalassa-select appearance-none block w-full bg-slate-900 p-3 pr-10 text-slate-200"
                                value={draft.swell}
                                onChange={(e) => setDraft({ ...draft, swell: e.target.value as ReviewDraft['swell'] })}
                            >
                                {SWELL.map((x) => (
                                    <option key={x}>{x}</option>
                                ))}
                            </select>
                        </label>
                        <fieldset>
                            <legend>Facilities observed</legend>
                            <div className="flex flex-wrap gap-2">
                                {FACILITIES.map((x) => (
                                    <label key={x} className={button}>
                                        <input
                                            type="checkbox"
                                            checked={draft.facilities.includes(x)}
                                            onChange={() => toggle('facilities', x)}
                                        />{' '}
                                        {x}
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <label className="block">
                            Visit date (optional)
                            <input
                                className="appearance-none block w-full bg-slate-900 p-3 text-slate-200"
                                type="date"
                                min="2000-01-01"
                                max="2100-01-01"
                                value={draft.visited}
                                onChange={(e) => setDraft({ ...draft, visited: e.target.value })}
                            />
                        </label>
                        <label className="block">
                            Your observations
                            <textarea
                                className="block w-full min-h-28 bg-slate-900 p-3"
                                maxLength={2400}
                                value={draft.notes}
                                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                            />
                        </label>
                        <label className="block">
                            Optional JPEG, up to 12 MB
                            <input
                                className="block w-full min-w-0 py-3"
                                type="file"
                                accept="image/jpeg"
                                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                            />
                        </label>
                        <p className="text-xs">
                            One photo per note; up to 40 stored uploads, including retired uploads until maintenance.
                            Contact support if that limit is reached. Photos are resized and stripped of embedded
                            metadata on the server. The picture itself can reveal a location or person. Only upload your
                            own suitable photo; no chart images. Editing a note retires its earlier photo.
                        </p>
                        <label className="flex min-h-[44px] items-start gap-2">
                            <input
                                type="checkbox"
                                checked={draft.terms_version === REVIEW_TERMS}
                                onChange={(e) =>
                                    setDraft({ ...draft, terms_version: e.target.checked ? REVIEW_TERMS : '' })
                                }
                            />
                            <span>
                                I own or have permission to share this content and accept the{' '}
                                <a className="underline" href="/terms.html" target="_blank" rel="noopener noreferrer">
                                    user content terms
                                </a>
                                .
                            </span>
                        </label>
                        <button className={button} disabled={busy || draft.terms_version !== REVIEW_TERMS}>
                            Save note
                        </button>
                        <button
                            type="button"
                            className={button}
                            disabled={busy}
                            onClick={() => {
                                setEditing(false);
                                setPhoto(null);
                            }}
                        >
                            Cancel edit
                        </button>
                    </form>
                )}
                {mine && (
                    <section className="rounded-lg border border-white/20 p-3">
                        <h4>My note · {mine.status}</h4>
                        <p className="whitespace-pre-wrap break-words">{mine.notes}</p>
                        {mine.photo_id && <ReviewPhoto key={mine.photo_id + epoch} id={mine.photo_id} />}
                        <button className={button} disabled={busy} onClick={() => void act('delete', { id: mine.id })}>
                            Delete my note
                        </button>
                    </section>
                )}
                {reviews.map((r) => (
                    <article key={r.id + epoch} className="space-y-2 rounded-lg border border-white/15 p-3">
                        <p>
                            Skipper observation · {r.visited || 'Visit date unknown'} ·{' '}
                            {r.reviewed ? 'Reviewed' : 'Not yet reviewed'}
                        </p>
                        <p>
                            Holding: {r.holding} · Swell: {r.swell}
                        </p>
                        <p>Wind protection observed: {r.protection.join(', ') || 'unknown'}</p>
                        <p>Facilities: {r.facilities.join(', ') || 'none recorded'}</p>
                        <p className="whitespace-pre-wrap break-words">{r.notes}</p>
                        {r.photo_id && <ReviewPhoto id={r.photo_id} />}
                        {owner && r.id !== mine?.id && (
                            <>
                                <label className="block">
                                    Report this note
                                    <select
                                        className="thalassa-select appearance-none block w-full bg-slate-900 p-3 pr-10 text-slate-200"
                                        defaultValue=""
                                        disabled={busy}
                                        onChange={(e) => {
                                            if (e.target.value)
                                                void act('report', { id: r.id, reason: e.target.value });
                                        }}
                                    >
                                        <option value="">Choose reason…</option>
                                        {['unsafe', 'abuse', 'privacy', 'copyright', 'spam'].map((x) => (
                                            <option key={x}>{x}</option>
                                        ))}
                                    </select>
                                </label>
                                <button
                                    className={button}
                                    disabled={busy}
                                    onClick={() => void act('block', { id: r.id })}
                                >
                                    Hide this contributor’s notes
                                </button>
                            </>
                        )}
                    </article>
                ))}
                <p className="text-xs">
                    Reports hide a note and its public photo while moderators review it. Contact{' '}
                    <a className="underline" href="mailto:privacy@thalassawx.com">
                        privacy@thalassawx.com
                    </a>{' '}
                    for urgent content concerns.
                </p>
            </div>
        </ModalSheet>
    );
}

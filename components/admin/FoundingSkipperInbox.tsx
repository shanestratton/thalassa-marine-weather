import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FoundingSkipperAdminError, FoundingSkipperAdminService } from '../../services/FoundingSkipperAdminService';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import {
    FOUNDING_SKIPPER_STATUSES,
    type FoundingSkipperApplicationRecord,
    type FoundingSkipperCursor,
    type FoundingSkipperPage,
    type FoundingSkipperStatus,
} from '../../types/foundingSkippers';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { RetryCard } from '../ui/RetryCard';
import { ShimmerBlock } from '../ui/ShimmerBlock';
import { toast } from '../Toast';

export interface FoundingSkipperInboxService {
    canReview(): Promise<boolean>;
    list(options?: {
        status?: FoundingSkipperStatus | null;
        cursor?: FoundingSkipperCursor | null;
        limit?: number;
    }): Promise<FoundingSkipperPage>;
    review(applicationId: string, expectedStatus: FoundingSkipperStatus, status: FoundingSkipperStatus): Promise<void>;
}

interface FoundingSkipperInboxProps {
    service?: FoundingSkipperInboxService;
}

const STATUS_LABELS: Record<FoundingSkipperStatus, string> = {
    new: 'New',
    contacted: 'Contacted',
    accepted: 'Accepted',
    declined: 'Declined',
    withdrawn: 'Withdrawn',
};

const STATUS_STYLES: Record<FoundingSkipperStatus, string> = {
    new: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300',
    contacted: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    accepted: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    declined: 'border-red-400/30 bg-red-400/10 text-red-300',
    withdrawn: 'border-slate-400/30 bg-slate-400/10 text-slate-300',
};

const STATUS_TRANSITIONS: Record<FoundingSkipperStatus, readonly FoundingSkipperStatus[]> = {
    new: ['contacted', 'accepted', 'declined', 'withdrawn'],
    contacted: ['new', 'accepted', 'declined', 'withdrawn'],
    accepted: ['new', 'contacted', 'declined', 'withdrawn'],
    declined: ['new'],
    withdrawn: [],
};

const BOAT_LABELS: Record<FoundingSkipperApplicationRecord['boat_type'], string> = {
    sail_monohull: 'Sailing monohull',
    sail_multihull: 'Sailing multihull',
    power: 'Power boat',
    trailer_boat: 'Trailer boat',
    other: 'Other boat',
};

const DEVICE_LABELS: Record<FoundingSkipperApplicationRecord['apple_device'], string> = {
    iphone: 'iPhone',
    ipad: 'iPad',
    iphone_and_ipad: 'iPhone and iPad',
};

const FREQUENCY_LABELS: Record<FoundingSkipperApplicationRecord['boating_frequency'], string> = {
    weekly_plus: 'Weekly or more',
    fortnightly: 'Every couple of weeks',
    monthly: 'About monthly',
    less_often: 'Less often / seasonal',
};

const INTEREST_LABELS: Record<string, string> = {
    marine_weather: 'Marine weather',
    passage_planning: 'Passage planning',
    float_plans: 'Float plans',
    anchor_watch: 'Anchor Watch',
    voyage_logging: 'Voyage logging',
    onboard_data: 'Onboard data',
};

const brisbaneDate = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});

function formatDate(value: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? brisbaneDate.format(date) : 'Unknown time';
}

function relativeDate(value: string): string {
    const date = new Date(value);
    const elapsed = Date.now() - date.getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) return formatDate(value);
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 14 ? `${days}d ago` : formatDate(value);
}

function sourceLabel(value: string): string {
    return value
        .split(/[_-]+/u)
        .filter(Boolean)
        .map((word) => word[0]?.toUpperCase() + word.slice(1))
        .join(' ');
}

function contactHref(application: FoundingSkipperApplicationRecord): string {
    const firstName = application.name.trim().split(/\s+/u)[0] || 'there';
    const subject = 'Your Thalassa Founding Skipper application';
    const body = [
        `Hi ${firstName},`,
        '',
        'Thanks for putting your hand up to help test Thalassa on the water.',
        '',
        'I wanted to get in touch about the next step.',
        '',
        'Cheers,',
        'Shane',
    ].join('\n');
    return `mailto:${encodeURIComponent(application.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function statusConfirmation(application: FoundingSkipperApplicationRecord, status: FoundingSkipperStatus): string {
    if (status === 'accepted') {
        return `${application.name} will be marked accepted. This does not send an email or a TestFlight invitation.`;
    }
    if (status === 'declined') {
        return `${application.name} will be marked declined. No email will be sent automatically.`;
    }
    if (status === 'withdrawn') {
        return `${application.name} will be marked withdrawn. Use this only when the applicant asks to withdraw.`;
    }
    if (status === 'contacted') {
        return `${application.name} will be marked contacted. Confirm only after you have actually contacted them.`;
    }
    return `${application.name} will be returned to the new queue.`;
}

export const FoundingSkipperInbox: React.FC<FoundingSkipperInboxProps> = ({
    service = FoundingSkipperAdminService,
}) => {
    const [applications, setApplications] = useState<FoundingSkipperApplicationRecord[]>([]);
    const [statusFilter, setStatusFilter] = useState<'all' | FoundingSkipperStatus>('all');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [cursor, setCursor] = useState<FoundingSkipperCursor | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const [pendingReview, setPendingReview] = useState<{
        application: FoundingSkipperApplicationRecord;
        status: FoundingSkipperStatus;
    } | null>(null);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const requestVersion = useRef(0);

    const loadApplications = useCallback(
        async (append: boolean) => {
            const version = ++requestVersion.current;
            if (append) setLoadingMore(true);
            else {
                setLoading(true);
                setError(null);
            }
            try {
                if (!append && !(await service.canReview())) {
                    throw new FoundingSkipperAdminError(
                        'not_authorized',
                        'This account cannot review Founding Skipper applications.',
                    );
                }
                const page = await service.list({
                    status: statusFilter === 'all' ? null : statusFilter,
                    cursor: append ? cursor : null,
                    limit: 50,
                });
                if (version !== requestVersion.current) return;
                setApplications((current) => {
                    if (!append) return page.applications;
                    const known = new Set(current.map((application) => application.id));
                    return [...current, ...page.applications.filter((application) => !known.has(application.id))];
                });
                setCursor(page.nextCursor);
                setLastUpdated(new Date());
                setAnnouncement(
                    `${page.applications.length} application${page.applications.length === 1 ? '' : 's'} loaded.`,
                );
            } catch (loadError) {
                if (version !== requestVersion.current) return;
                const message = loadError instanceof Error ? loadError.message : 'Applications could not be loaded.';
                if (!append) {
                    setApplications([]);
                    setSelectedId(null);
                    setError(message);
                } else {
                    toast.error(message);
                }
            } finally {
                if (version === requestVersion.current) {
                    setLoading(false);
                    setLoadingMore(false);
                }
            }
        },
        [cursor, service, statusFilter],
    );

    useEffect(() => {
        setCursor(null);
        setSelectedId(null);
        void loadApplications(false);
        // Cursor deliberately does not trigger first-page reloads.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [service, statusFilter]);

    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                requestVersion.current += 1;
                setApplications([]);
                setSelectedId(null);
                setCursor(null);
                setSearch('');
                setSourceFilter('all');
                setPendingReview(null);
                setUpdatingId(null);
                setAnnouncement('');
                setLastUpdated(null);
                setError('Your signed-in account changed. Close and reopen the admin panel.');
                setLoading(false);
                setLoadingMore(false);
            }),
        [],
    );

    const sources = useMemo(
        () => [...new Set(applications.map((application) => application.source))].sort(),
        [applications],
    );
    const visibleApplications = useMemo(() => {
        const needle = search.trim().toLocaleLowerCase('en-AU');
        return applications.filter((application) => {
            if (sourceFilter !== 'all' && application.source !== sourceFilter) return false;
            if (!needle) return true;
            return `${application.name} ${application.email} ${application.home_waters}`
                .toLocaleLowerCase('en-AU')
                .includes(needle);
        });
    }, [applications, search, sourceFilter]);
    const selected =
        visibleApplications.find((application) => application.id === selectedId) ?? visibleApplications[0] ?? null;
    const newCount = applications.filter((application) => application.status === 'new').length;
    const acceptedCount = applications.filter((application) => application.status === 'accepted').length;

    const confirmReview = useCallback(async () => {
        if (!pendingReview) return;
        const { application, status } = pendingReview;
        setUpdatingId(application.id);
        try {
            await service.review(application.id, application.status, status);
            setApplications((current) => {
                if (statusFilter !== 'all' && status !== statusFilter) {
                    return current.filter((entry) => entry.id !== application.id);
                }
                return current.map((entry) =>
                    entry.id === application.id
                        ? { ...entry, status, status_updated_at: new Date().toISOString() }
                        : entry,
                );
            });
            const message = `${application.name} marked ${STATUS_LABELS[status].toLowerCase()}.`;
            setAnnouncement(message);
            toast.success(message);
        } catch (reviewError) {
            const message = reviewError instanceof Error ? reviewError.message : 'The status could not be updated.';
            toast.error(message);
            setAnnouncement(message);
            if (reviewError instanceof FoundingSkipperAdminError && reviewError.code === 'stale_status') {
                void loadApplications(false);
            }
        } finally {
            setUpdatingId(null);
            setPendingReview(null);
        }
    }, [loadApplications, pendingReview, service, statusFilter]);

    return (
        <div className="min-h-full bg-slate-950" aria-busy={loading}>
            <ConfirmDialog
                isOpen={pendingReview !== null}
                title={pendingReview ? `Mark ${STATUS_LABELS[pendingReview.status]}` : 'Update application'}
                message={pendingReview ? statusConfirmation(pendingReview.application, pendingReview.status) : ''}
                confirmLabel={pendingReview ? `Mark ${STATUS_LABELS[pendingReview.status]}` : 'Confirm'}
                destructive={pendingReview?.status === 'declined' || pendingReview?.status === 'withdrawn'}
                onConfirm={confirmReview}
                onCancel={() => setPendingReview(null)}
            />

            <div className="px-4 pt-4 pb-3 border-b border-white/[0.06] bg-slate-950/95 sticky top-0 z-[5]">
                <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-cyan-300/60">
                            Founding Skippers
                        </p>
                        <h3 className="mt-1 text-lg font-black text-white">Applications inbox</h3>
                        <p className="mt-1 text-xs text-white/45">
                            {lastUpdated
                                ? `Updated ${lastUpdated.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`
                                : 'Private admin view'}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => loadApplications(false)}
                        disabled={loading}
                        className="min-h-[44px] px-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-xs font-bold text-cyan-200 disabled:opacity-50"
                    >
                        {loading ? 'Refreshing…' : '↻ Refresh'}
                    </button>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-4" aria-label="Loaded application summary">
                    <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
                        <p className="text-lg font-black text-white">{applications.length}</p>
                        <p className="text-[11px] uppercase tracking-wider text-white/40">Loaded</p>
                    </div>
                    <div className="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] px-3 py-2.5">
                        <p className="text-lg font-black text-cyan-300">{newCount}</p>
                        <p className="text-[11px] uppercase tracking-wider text-cyan-300/50">New</p>
                    </div>
                    <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.05] px-3 py-2.5">
                        <p className="text-lg font-black text-emerald-300">{acceptedCount}</p>
                        <p className="text-[11px] uppercase tracking-wider text-emerald-300/50">Accepted</p>
                    </div>
                </div>

                <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filter applications by status">
                    {(['all', ...FOUNDING_SKIPPER_STATUSES] as const).map((status) => (
                        <button
                            type="button"
                            key={status}
                            onClick={() => setStatusFilter(status)}
                            aria-pressed={statusFilter === status}
                            className={`shrink-0 min-h-[44px] px-3.5 rounded-xl border text-xs font-bold transition-colors ${
                                statusFilter === status
                                    ? 'border-cyan-300/35 bg-cyan-300/10 text-cyan-200'
                                    : 'border-white/[0.07] bg-white/[0.025] text-white/45'
                            }`}
                        >
                            {status === 'all' ? 'All' : STATUS_LABELS[status]}
                        </button>
                    ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_180px] gap-2 mt-2">
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        aria-label="Search Founding Skipper applications"
                        placeholder="Search name, email or home waters"
                        className="min-h-[44px] w-full rounded-xl border border-white/10 bg-white/[0.05] px-3.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-cyan-400/35"
                    />
                    <select
                        value={sourceFilter}
                        onChange={(event) => setSourceFilter(event.target.value)}
                        aria-label="Filter applications by source"
                        className="min-h-[44px] w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white/70 outline-none focus:border-cyan-400/35"
                    >
                        <option value="all">All sources</option>
                        {sources.map((source) => (
                            <option key={source} value={source}>
                                {sourceLabel(source)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <p className="sr-only" role="status" aria-live="polite">
                {announcement}
            </p>

            {loading ? (
                <div className="px-4 py-10">
                    <ShimmerBlock variant="list" rows={5} />
                </div>
            ) : error ? (
                <RetryCard
                    title="Applications unavailable"
                    description={error}
                    onRetry={() => loadApplications(false)}
                />
            ) : visibleApplications.length === 0 ? (
                <EmptyState
                    icon="⚓"
                    title="No applications here"
                    description={
                        search || sourceFilter !== 'all'
                            ? 'Try clearing the search or source filter.'
                            : statusFilter === 'all'
                              ? 'The next Founding Skipper will appear here.'
                              : `There are no ${STATUS_LABELS[statusFilter].toLowerCase()} applications.`
                    }
                />
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)] gap-3 p-4 items-start">
                    <div className="space-y-2" role="list" aria-label="Founding Skipper applications">
                        {visibleApplications.map((application) => {
                            const isSelected = application.id === selected?.id;
                            return (
                                <button
                                    type="button"
                                    key={application.id}
                                    role="listitem"
                                    onClick={() => setSelectedId(application.id)}
                                    aria-pressed={isSelected}
                                    className={`w-full text-left rounded-2xl border p-3.5 transition-colors min-h-[104px] ${
                                        isSelected
                                            ? 'border-cyan-300/30 bg-cyan-300/[0.07]'
                                            : 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.045]'
                                    }`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-black text-white truncate">{application.name}</p>
                                            <p className="mt-0.5 text-xs text-white/45 truncate">{application.email}</p>
                                        </div>
                                        <span
                                            className={`rounded-full border px-2 py-1 text-[11px] font-black uppercase tracking-wider ${STATUS_STYLES[application.status]}`}
                                        >
                                            {STATUS_LABELS[application.status]}
                                        </span>
                                    </div>
                                    <p className="mt-3 text-xs text-white/65">
                                        {BOAT_LABELS[application.boat_type]} · {application.home_waters}
                                    </p>
                                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-white/35">
                                        <span>{FREQUENCY_LABELS[application.boating_frequency]}</span>
                                        <time dateTime={application.created_at}>
                                            {relativeDate(application.created_at)}
                                        </time>
                                    </div>
                                </button>
                            );
                        })}

                        {cursor && (
                            <button
                                type="button"
                                onClick={() => loadApplications(true)}
                                disabled={loadingMore}
                                className="w-full min-h-[44px] rounded-xl border border-white/[0.08] bg-white/[0.03] text-xs font-bold text-white/55 disabled:opacity-50"
                            >
                                {loadingMore ? 'Loading…' : 'Load older applications'}
                            </button>
                        )}
                    </div>

                    {selected && (
                        <article
                            className="rounded-2xl border border-white/[0.08] bg-white/[0.025] overflow-hidden lg:sticky lg:top-[272px]"
                            aria-label={`${selected.name} application details`}
                        >
                            <div className="p-4 border-b border-white/[0.06]">
                                <div className="flex items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[11px] uppercase tracking-[0.17em] text-cyan-300/55">
                                            Application details
                                        </p>
                                        <h4 className="mt-1 text-xl font-black text-white">{selected.name}</h4>
                                        {selected.status === 'withdrawn' ? (
                                            <span className="mt-1 inline-block text-sm text-white/45 break-all">
                                                {selected.email}
                                            </span>
                                        ) : (
                                            <a
                                                href={`mailto:${encodeURIComponent(selected.email)}`}
                                                className="mt-1 inline-block text-sm text-cyan-300 underline decoration-cyan-300/30 underline-offset-4 break-all"
                                            >
                                                {selected.email}
                                            </a>
                                        )}
                                    </div>
                                    <span
                                        className={`rounded-full border px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wider ${STATUS_STYLES[selected.status]}`}
                                    >
                                        {STATUS_LABELS[selected.status]}
                                    </span>
                                </div>
                            </div>

                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4 p-4 text-sm">
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Boat</dt>
                                    <dd className="mt-1 text-white/80">{BOAT_LABELS[selected.boat_type]}</dd>
                                </div>
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Home waters</dt>
                                    <dd className="mt-1 text-white/80">{selected.home_waters}</dd>
                                </div>
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Apple gear</dt>
                                    <dd className="mt-1 text-white/80">{DEVICE_LABELS[selected.apple_device]}</dd>
                                </div>
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Gets afloat</dt>
                                    <dd className="mt-1 text-white/80">
                                        {FREQUENCY_LABELS[selected.boating_frequency]}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Source</dt>
                                    <dd className="mt-1 text-white/80">{sourceLabel(selected.source)}</dd>
                                </div>
                                <div>
                                    <dt className="text-[11px] uppercase tracking-wider text-white/35">Received</dt>
                                    <dd className="mt-1 text-white/80">
                                        <time dateTime={selected.created_at}>{formatDate(selected.created_at)}</time>
                                    </dd>
                                </div>
                            </dl>

                            <div className="px-4 pb-4">
                                <p className="text-[11px] uppercase tracking-wider text-white/35">Wants to test</p>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {selected.interests.map((interest) => (
                                        <span
                                            key={interest}
                                            className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.05] px-2.5 py-1.5 text-xs text-cyan-100/75"
                                        >
                                            {INTEREST_LABELS[interest] ?? sourceLabel(interest)}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            <div className="px-4 pb-4">
                                <p className="text-[11px] uppercase tracking-wider text-white/35">Notes</p>
                                <p className="mt-2 rounded-xl border border-white/[0.06] bg-black/15 p-3 text-sm leading-relaxed text-white/70 whitespace-pre-wrap">
                                    {selected.notes || 'No notes supplied.'}
                                </p>
                            </div>

                            <div className="px-4 pb-4 text-[11px] leading-relaxed text-white/35">
                                Consent recorded{' '}
                                <time dateTime={selected.consented_at}>{formatDate(selected.consented_at)}</time>
                                {' · '}expires{' '}
                                <time dateTime={selected.expires_at}>{formatDate(selected.expires_at)}</time>
                            </div>

                            <div className="p-4 border-t border-white/[0.06] bg-black/10">
                                {selected.status === 'withdrawn' ? (
                                    <p className="mt-3 rounded-xl border border-slate-400/15 bg-slate-400/[0.05] p-3 text-center text-xs leading-relaxed text-slate-300/70">
                                        Withdrawn applications are locked. A fresh application is required to reopen
                                        contact.
                                    </p>
                                ) : (
                                    <>
                                        <a
                                            href={contactHref(selected)}
                                            className="flex min-h-[48px] w-full items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 text-sm font-black text-cyan-100"
                                        >
                                            ✉️ Draft email to {selected.name.split(/\s+/u)[0]}
                                        </a>
                                        <p className="mt-2 text-center text-[11px] text-white/35">
                                            Opens a draft only. Nothing is sent or marked contacted automatically.
                                        </p>

                                        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
                                            {STATUS_TRANSITIONS[selected.status].map((status) => (
                                                <button
                                                    type="button"
                                                    key={status}
                                                    disabled={updatingId === selected.id}
                                                    onClick={() => setPendingReview({ application: selected, status })}
                                                    className={`min-h-[44px] rounded-xl border px-2.5 text-xs font-bold disabled:opacity-50 ${STATUS_STYLES[status]}`}
                                                >
                                                    Mark {STATUS_LABELS[status]}
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        </article>
                    )}
                </div>
            )}
        </div>
    );
};

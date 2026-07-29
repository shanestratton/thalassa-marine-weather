/**
 * CrewMatchesList — consent-first Crew List introduction inbox.
 *
 * Accepted conversations are opened by their Crew List introduction ID, never
 * by an app-wide direct-message user ID. That distinction is deliberate: the
 * database validates the acceptance and block state for every read and send.
 */

import React, { useMemo } from 'react';
import type { CrewListIntroduction } from '../../hooks/useCrewFinderState';
import { EmptyState } from '../ui/EmptyState';
import { SafeImage } from '../ui/SafeImage';

interface CrewMatchesListProps {
    introductions: CrewListIntroduction[];
    onOpenConversation: (introduction: CrewListIntroduction) => void;
    onRespondIntroduction: (requestId: string, response: 'accepted' | 'declined') => void;
    onWithdrawIntroduction: (requestId: string) => void;
}

function counterpartId(introduction: CrewListIntroduction): string {
    return introduction.direction === 'sent' ? introduction.request.recipient_id : introduction.request.sender_id;
}

export const CrewMatchesList: React.FC<CrewMatchesListProps> = React.memo(
    ({ introductions, onOpenConversation, onRespondIntroduction, onWithdrawIntroduction }) => {
        const incoming = introductions.filter(
            (introduction) => introduction.direction === 'received' && introduction.request.status === 'pending',
        );
        const outgoing = introductions.filter(
            (introduction) => introduction.direction === 'sent' && introduction.request.status === 'pending',
        );

        // A crossed pair of introductions can exist from the brief period
        // before either sailor responds. They still resolve to one canonical
        // private conversation, so present one calm entry rather than two.
        const accepted = useMemo(() => {
            const byCounterpart = new Map<string, CrewListIntroduction>();
            for (const introduction of introductions) {
                if (introduction.request.status !== 'accepted') continue;
                const key = counterpartId(introduction);
                const existing = byCounterpart.get(key);
                if (!existing || introduction.request.created_at < existing.request.created_at) {
                    byCounterpart.set(key, introduction);
                }
            }
            return [...byCounterpart.values()];
        }, [introductions]);

        return (
            <div className="px-4 py-5">
                <section
                    aria-labelledby="crew-list-introductions-title"
                    className="mb-4 rounded-3xl border border-sky-400/15 bg-gradient-to-br from-sky-500/[0.08] to-emerald-500/[0.06] p-4"
                >
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-sky-200/65">The Crew List</p>
                    <h2 id="crew-list-introductions-title" className="mt-1 text-base font-black text-white">
                        Mutual introductions
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-white/55">
                        A private conversation appears here only after both sailors choose to connect. Take your time
                        and keep early conversations in Thalassa.
                    </p>
                </section>

                {incoming.length > 0 && (
                    <section className="mb-5" aria-labelledby="incoming-introductions-title">
                        <div className="mb-2 flex items-center justify-between px-1">
                            <h3
                                id="incoming-introductions-title"
                                className="text-[11px] font-black uppercase tracking-[0.15em] text-amber-200/70"
                            >
                                Awaiting your choice ({incoming.length})
                            </h3>
                            <span className="text-[11px] text-white/50">No pressure — decline is private.</span>
                        </div>
                        <div className="space-y-3">
                            {incoming.map((introduction) => {
                                const sailor = introduction.counterpart;
                                const name = sailor?.display_name || 'A Crew List sailor';
                                return (
                                    <article
                                        key={introduction.request.id}
                                        className="rounded-2xl border border-amber-400/15 bg-amber-500/[0.045] p-4 shadow-lg shadow-slate-950/20"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-amber-400/20 bg-slate-950/40">
                                                {sailor?.avatar_url ? (
                                                    <SafeImage
                                                        src={sailor.avatar_url}
                                                        loading="lazy"
                                                        alt={`${name}'s profile photo`}
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <span aria-hidden="true">⛵</span>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-bold text-white/90">{name}</p>
                                                <p className="text-xs text-amber-100/55">
                                                    would like to introduce themselves
                                                </p>
                                            </div>
                                        </div>
                                        {introduction.request.message && (
                                            <p className="mt-3 rounded-xl border border-white/[0.05] bg-slate-950/30 px-3 py-2.5 text-sm leading-relaxed text-white/65">
                                                {introduction.request.message}
                                            </p>
                                        )}
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                            <button
                                                aria-label={`Decline introduction from ${name}`}
                                                onClick={() =>
                                                    onRespondIntroduction(introduction.request.id, 'declined')
                                                }
                                                className="min-h-[44px] rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-bold text-white/55 transition-colors hover:bg-white/[0.06] active:scale-[0.98]"
                                            >
                                                Decline
                                            </button>
                                            <button
                                                aria-label={`Accept introduction from ${name}`}
                                                onClick={() =>
                                                    onRespondIntroduction(introduction.request.id, 'accepted')
                                                }
                                                className="min-h-[44px] rounded-xl border border-emerald-400/20 bg-emerald-500/[0.16] px-3 py-2.5 text-sm font-bold text-emerald-100 transition-colors hover:bg-emerald-500/[0.23] active:scale-[0.98]"
                                            >
                                                Accept &amp; connect
                                            </button>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                )}

                {outgoing.length > 0 && (
                    <section className="mb-5" aria-labelledby="sent-introductions-title">
                        <h3
                            id="sent-introductions-title"
                            className="mb-2 px-1 text-[11px] font-black uppercase tracking-[0.15em] text-sky-200/65"
                        >
                            Sent introductions ({outgoing.length})
                        </h3>
                        <div className="space-y-2">
                            {outgoing.map((introduction) => {
                                const name = introduction.counterpart?.display_name || 'Crew List sailor';
                                return (
                                    <div
                                        key={introduction.request.id}
                                        className="flex items-center gap-3 rounded-2xl border border-sky-400/10 bg-sky-500/[0.035] p-3"
                                    >
                                        <span aria-hidden="true" className="text-lg">
                                            ✉️
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-bold text-white/80">{name}</p>
                                            <p className="text-xs text-white/40">Awaiting their choice</p>
                                        </div>
                                        <button
                                            aria-label={`Withdraw introduction to ${name}`}
                                            onClick={() => onWithdrawIntroduction(introduction.request.id)}
                                            className="min-h-[38px] rounded-xl px-2.5 text-xs font-bold text-sky-100/65 transition-colors hover:bg-white/[0.05]"
                                        >
                                            Withdraw
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                )}

                {accepted.length === 0 && incoming.length === 0 && outgoing.length === 0 ? (
                    <EmptyState
                        icon="🤝"
                        title="No introductions accepted yet"
                        description="Send a thoughtful introduction from The Crew List. If the other sailor accepts, you can both open a private conversation here."
                    />
                ) : (
                    accepted.length > 0 && (
                        <section className="space-y-3 stagger-in" aria-labelledby="accepted-introductions-title">
                            <h3
                                id="accepted-introductions-title"
                                className="px-1 text-[11px] font-black uppercase tracking-[0.15em] text-emerald-200/70"
                            >
                                Connected ({accepted.length})
                            </h3>
                            {accepted.map((introduction) => {
                                const sailor = introduction.counterpart;
                                const name = sailor?.display_name || 'Crew List connection';
                                const broadArea = sailor
                                    ? [sailor.location_state, sailor.location_country].filter(Boolean).join(', ')
                                    : '';
                                return (
                                    <article
                                        key={counterpartId(introduction)}
                                        className="rounded-2xl border border-emerald-400/12 bg-white/[0.025] p-4 shadow-lg shadow-slate-950/20"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border-2 border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 to-sky-500/10">
                                                {sailor?.avatar_url ? (
                                                    <SafeImage
                                                        src={sailor.avatar_url}
                                                        loading="lazy"
                                                        alt={`${name}'s profile photo`}
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <span aria-hidden="true" className="text-xl">
                                                        ⛵
                                                    </span>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-base font-semibold text-white/90">{name}</p>
                                                <p className="mt-0.5 text-xs text-emerald-200/65">
                                                    ✓ Introduction accepted
                                                </p>
                                                {broadArea && (
                                                    <p className="mt-0.5 truncate text-xs text-white/40">
                                                        📍 {broadArea}
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        {sailor && (sailor.sailing_experience || sailor.interests.length > 0) && (
                                            <div className="mt-3 border-t border-white/[0.05] pt-3">
                                                {sailor.sailing_experience && (
                                                    <p className="text-xs text-white/55">
                                                        🧭 {sailor.sailing_experience}
                                                    </p>
                                                )}
                                                {sailor.interests.length > 0 && (
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        {sailor.interests.slice(0, 4).map((interest) => (
                                                            <span
                                                                key={interest}
                                                                className="rounded-full border border-sky-400/10 bg-sky-500/[0.08] px-2.5 py-1 text-[11px] text-sky-100/70"
                                                            >
                                                                {interest}
                                                            </span>
                                                        ))}
                                                        {sailor.interests.length > 4 && (
                                                            <span className="rounded-full bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/40">
                                                                +{sailor.interests.length - 4}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        <button
                                            aria-label={`Open private conversation with ${name}`}
                                            onClick={() => onOpenConversation(introduction)}
                                            className="mt-3 w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-600 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-950/25 transition-all active:scale-[0.98]"
                                        >
                                            💬 Open private conversation
                                        </button>
                                    </article>
                                );
                            })}
                        </section>
                    )
                )}
            </div>
        );
    },
);

CrewMatchesList.displayName = 'CrewMatchesList';

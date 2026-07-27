/**
 * CrewListConversation — private, consent-first conversation surface.
 *
 * This component deliberately knows nothing about how messages are authorised
 * or persisted. Its parent must only render it once an introduction has been
 * mutually accepted and must supply server-authorised messages and callbacks.
 */

import React, { useCallback, useId } from 'react';

export interface CrewListConversationMessage {
    id: string;
    sender_id: string;
    message: string;
    created_at: string;
}

export interface CrewListConversationProps {
    /** The accepted introduction partner shown in the conversation header. */
    partnerName: string;
    /** Messages already authorised for this accepted introduction. */
    messages: CrewListConversationMessage[];
    /** The authenticated user's id, used solely to align their message bubbles. */
    currentUserId: string;
    /** Controlled composer value. */
    draft: string;
    /** True while the parent is fetching the conversation. */
    loading?: boolean;
    /** The server no longer authorises this accepted-introduction conversation. */
    unavailable?: boolean;
    /** True while the parent is sending the current draft. */
    sending?: boolean;
    onDraftChange: (draft: string) => void;
    onSend: () => void;
    onBack: () => void;
}

function formatMessageTime(createdAt: string): string {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return '';

    return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
    }).format(date);
}

export const CrewListConversation: React.FC<CrewListConversationProps> = React.memo(
    ({
        partnerName,
        messages,
        currentUserId,
        draft,
        loading = false,
        unavailable = false,
        sending = false,
        onDraftChange,
        onSend,
        onBack,
    }) => {
        const guidanceId = useId();
        const canSend = draft.trim().length > 0 && !sending && !loading && !unavailable;

        const submit = useCallback(
            (event?: React.FormEvent<HTMLFormElement>) => {
                event?.preventDefault();
                if (canSend) onSend();
            },
            [canSend, onSend],
        );

        const handleComposerKeyDown = useCallback(
            (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                }
            },
            [submit],
        );

        return (
            <section
                className="flex min-h-[100dvh] min-w-0 flex-col bg-[#050a18] text-white"
                aria-label={`Private conversation with ${partnerName}`}
            >
                <header className="sticky top-0 z-10 border-b border-white/[0.07] bg-[#050a18]/95 px-4 py-3 backdrop-blur-xl">
                    <div className="mx-auto flex max-w-2xl items-center gap-3">
                        <button
                            type="button"
                            onClick={onBack}
                            aria-label="Back to Crew List introductions"
                            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-white/80 transition-colors hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 active:scale-[0.97]"
                        >
                            <svg
                                aria-hidden="true"
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.25"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="m15 18-6-6 6-6" />
                            </svg>
                        </button>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-base font-black text-white">{partnerName}</p>
                            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200/65">
                                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                Accepted Crew List introduction
                            </p>
                        </div>
                    </div>
                </header>

                <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-4">
                    <aside
                        className="mb-5 rounded-2xl border border-sky-400/15 bg-sky-500/[0.06] px-3.5 py-3"
                        aria-label="Conversation safety guidance"
                    >
                        <div className="flex gap-2.5">
                            <span aria-hidden="true" className="mt-0.5 text-base">
                                🛟
                            </span>
                            <p className="text-xs leading-relaxed text-sky-100/70">
                                Keep early conversations in Thalassa. Take your time before sharing personal details,
                                and meet in a public marina or club if you decide to meet ashore.
                            </p>
                        </div>
                    </aside>

                    {loading ? (
                        <div
                            className="flex min-h-[260px] flex-col items-center justify-center"
                            role="status"
                            aria-live="polite"
                        >
                            <span className="h-8 w-8 animate-spin rounded-full border-2 border-sky-300/20 border-t-sky-300" />
                            <p className="mt-3 text-sm font-semibold text-white/60">
                                Loading your private conversation…
                            </p>
                        </div>
                    ) : unavailable ? (
                        <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
                            <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-amber-400/20 bg-amber-500/[0.08] text-3xl">
                                🔒
                            </div>
                            <h2 className="mt-4 text-base font-black text-white/90">Conversation unavailable</h2>
                            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-white/50">
                                This private introduction is no longer available. It may have been paused, withdrawn or
                                blocked.
                            </p>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
                            <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-emerald-400/15 bg-emerald-500/[0.08] text-3xl">
                                👋
                            </div>
                            <h2 className="mt-4 text-base font-black text-white/90">A calm place to start</h2>
                            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-white/50">
                                Your introduction is accepted. Say hello, ask about a passage, or compare sailing
                                experience here in Thalassa.
                            </p>
                        </div>
                    ) : (
                        <ol
                            className="space-y-2.5"
                            role="log"
                            aria-live="polite"
                            aria-label={`Messages with ${partnerName}`}
                        >
                            {messages.map((message) => {
                                const isMine = message.sender_id === currentUserId;
                                const sentAt = formatMessageTime(message.created_at);

                                return (
                                    <li key={message.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                                        <article
                                            className={`max-w-[84%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                                                isMine
                                                    ? 'rounded-br-md border border-sky-300/20 bg-sky-500/[0.18] text-sky-50'
                                                    : 'rounded-bl-md border border-white/[0.08] bg-white/[0.045] text-white/80'
                                            }`}
                                        >
                                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                                                {message.message}
                                            </p>
                                            {sentAt && (
                                                <time
                                                    dateTime={message.created_at}
                                                    className={`mt-1.5 block text-[11px] tabular-nums ${
                                                        isMine ? 'text-sky-100/50' : 'text-white/35'
                                                    }`}
                                                >
                                                    {sentAt}
                                                </time>
                                            )}
                                        </article>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </div>

                <form
                    onSubmit={submit}
                    className="sticky bottom-0 z-10 border-t border-white/[0.07] bg-[#050a18]/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl"
                    aria-describedby={guidanceId}
                >
                    <div className="mx-auto max-w-2xl">
                        <p id={guidanceId} className="mb-2 px-1 text-[11px] leading-relaxed text-white/42">
                            Keep early conversations in-app. Never send financial details, and take care before sharing
                            phone numbers, email addresses or links.
                        </p>
                        <div className="flex items-end gap-2">
                            <label className="sr-only" htmlFor="crew-list-conversation-draft">
                                Message {partnerName}
                            </label>
                            <textarea
                                id="crew-list-conversation-draft"
                                value={draft}
                                onChange={(event) => onDraftChange(event.target.value)}
                                onKeyDown={handleComposerKeyDown}
                                disabled={loading || sending || unavailable}
                                rows={1}
                                placeholder={`Message ${partnerName}…`}
                                className="max-h-32 min-h-[48px] flex-1 resize-none rounded-2xl border border-white/[0.09] bg-white/[0.045] px-3.5 py-3 text-sm leading-5 text-white placeholder:text-white/35 transition-colors focus:outline-none focus-visible:border-sky-300/50 focus-visible:ring-2 focus-visible:ring-sky-300/20 disabled:cursor-not-allowed disabled:opacity-55"
                            />
                            <button
                                type="submit"
                                disabled={!canSend}
                                aria-label={sending ? 'Sending message' : `Send message to ${partnerName}`}
                                className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-2xl border border-sky-300/25 bg-gradient-to-br from-sky-500 to-cyan-500 text-white shadow-lg shadow-sky-500/20 transition-all hover:from-sky-400 hover:to-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200/80 active:scale-[0.94] disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:from-white/[0.08] disabled:to-white/[0.05] disabled:text-white/35 disabled:shadow-none"
                            >
                                {sending ? (
                                    <span
                                        aria-hidden="true"
                                        className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                                    />
                                ) : (
                                    <svg
                                        aria-hidden="true"
                                        width="18"
                                        height="18"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.4"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="m22 2-7 20-4-9-9-4Z" />
                                        <path d="M22 2 11 13" />
                                    </svg>
                                )}
                            </button>
                        </div>
                        <p className="mt-1.5 px-1 text-[11px] text-white/30">Use ⌘/Ctrl + Enter to send.</p>
                    </div>
                </form>
            </section>
        );
    },
);

CrewListConversation.displayName = 'CrewListConversation';

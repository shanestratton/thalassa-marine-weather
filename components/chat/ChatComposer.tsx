/**
 * ChatComposer — Channel message compose bar with attachments.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React, { useCallback, useId, useRef } from 'react';
import { type ClientFilterResult } from '../../services/ContentModerationService';
import { MAX_CHAT_MESSAGE_CHARS } from '../../services/chat/messagePolicy';
import { useMenuNavigation } from '../../hooks/useMenuNavigation';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';

export interface ChatComposerProps {
    messageText: string;
    setMessageText: (text: string) => void;
    isQuestion: boolean;
    setIsQuestion: (v: boolean) => void;
    filterWarning: ClientFilterResult | null;
    setFilterWarning: (v: ClientFilterResult | null) => void;
    isMuted: boolean;
    mutedUntil: Date | null;
    showAttachMenu: boolean;
    setShowAttachMenu: (v: boolean) => void;
    keyboardOffset: number;
    inputRef: React.RefObject<HTMLInputElement>;
    onSend: (bypass?: boolean) => void;
    onOpenPinDrop: () => void;
    onOpenPoiPicker: () => void;
    onOpenTrackPicker: () => void;
}

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(
    ({
        messageText,
        setMessageText,
        isQuestion,
        setIsQuestion,
        filterWarning,
        setFilterWarning,
        isMuted,
        mutedUntil,
        showAttachMenu,
        setShowAttachMenu,
        keyboardOffset,
        inputRef,
        onSend,
        onOpenPinDrop,
        onOpenPoiPicker,
        onOpenTrackPicker,
    }) => {
        const attachTriggerRef = useRef<HTMLButtonElement>(null);
        const attachMenuId = useId();
        const messageLimitId = useId();
        const closeAttachMenu = useCallback(() => setShowAttachMenu(false), [setShowAttachMenu]);
        const attachMenuRef = useMenuNavigation<HTMLDivElement>(showAttachMenu, {
            triggerRef: attachTriggerRef,
            onClose: closeAttachMenu,
        });
        const chooseAttachment = useCallback(
            (openPicker: () => void) => {
                closeAttachMenu();
                openPicker();
            },
            [closeAttachMenu],
        );

        return (
            <div className="shrink-0 relative">
                <div className="absolute inset-0 bg-linear-to-t from-[#050a18] via-[#050a18]/95 to-transparent" />
                <div
                    className={`relative px-4 pt-2 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'}`}
                >
                    {/* Client filter warning */}
                    {filterWarning && (
                        <div className="mb-2 p-3 rounded-xl bg-amber-500/6 border border-amber-500/12 fade-slide-down">
                            <p className="text-xs text-amber-300 mb-2">⚠️ {filterWarning.warning}</p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => {
                                        setFilterWarning(null);
                                        setMessageText('');
                                    }}
                                    aria-label="Edit message"
                                    className="flex-1 py-2.5 rounded-lg bg-white/3 text-xs text-white/60 hover:bg-white/6 transition-colors min-h-[44px]"
                                >
                                    Edit message
                                </button>
                                {!filterWarning.blocked && (
                                    <button
                                        onClick={() => onSend(true)}
                                        aria-label="Send message anyway"
                                        className="flex-1 py-2.5 rounded-lg bg-amber-500/10 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors min-h-[44px]"
                                    >
                                        Send anyway
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {isMuted ? (
                        <div className="flex items-center justify-center gap-2 py-2 rounded-xl bg-red-500/4 border border-red-500/6">
                            <span className="text-xs text-red-300">
                                🔇 Muted until {mutedUntil?.toLocaleTimeString()}
                            </span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2" role="toolbar" aria-label="Message compose">
                            {/* ➕ Attach button */}
                            <div className="relative">
                                <button
                                    ref={attachTriggerRef}
                                    onClick={() => setShowAttachMenu(!showAttachMenu)}
                                    aria-label={showAttachMenu ? 'Close attachment menu' : 'Open attachment menu'}
                                    aria-expanded={showAttachMenu}
                                    aria-haspopup="menu"
                                    aria-controls={showAttachMenu ? attachMenuId : undefined}
                                    className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg transition-all duration-200 shrink-0 active:scale-90 ${
                                        showAttachMenu
                                            ? 'bg-sky-500/15 border border-sky-500/25'
                                            : 'bg-white/3 border border-white/4 hover:bg-white/6'
                                    }`}
                                >
                                    <span
                                        className={`transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`}
                                    >
                                        ➕
                                    </span>
                                </button>

                                {/* Attach menu flyout */}
                                {showAttachMenu && (
                                    <>
                                        <div
                                            role="presentation"
                                            aria-hidden="true"
                                            className="fixed inset-0 z-40"
                                            onClick={closeAttachMenu}
                                        />
                                        <div
                                            ref={attachMenuRef}
                                            id={attachMenuId}
                                            role="menu"
                                            aria-label="Share an attachment"
                                            className="absolute bottom-12 left-0 z-50 w-72 rounded-2xl bg-slate-900 border border-white/10 shadow-2xl overflow-hidden fade-slide-down"
                                        >
                                            <div className="px-4 pt-3 pb-2" role="presentation">
                                                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-sky-300/70">
                                                    Share with the crew
                                                </p>
                                            </div>
                                            <button
                                                role="menuitem"
                                                onClick={() => chooseAttachment(onOpenPinDrop)}
                                                aria-label="Share my current location"
                                                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-emerald-400/8 transition-colors text-left min-h-[64px]"
                                            >
                                                <span className="w-10 h-10 rounded-xl bg-emerald-400/10 border border-emerald-300/20 flex items-center justify-center text-lg shrink-0">
                                                    📍
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="block text-sm text-white/90 font-semibold">
                                                        Share my location
                                                    </span>
                                                    <span className="block text-[11px] text-white/50 mt-0.5">
                                                        Send your latest GPS fix
                                                    </span>
                                                </span>
                                            </button>
                                            <div role="separator" className="h-px bg-white/6" />
                                            <button
                                                role="menuitem"
                                                onClick={() => chooseAttachment(onOpenPoiPicker)}
                                                aria-label="Drop a pin on the chart"
                                                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-sky-400/8 transition-colors text-left min-h-[64px]"
                                            >
                                                <span className="w-10 h-10 rounded-xl bg-sky-400/10 border border-sky-300/20 flex items-center justify-center text-lg shrink-0">
                                                    📌
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="block text-sm text-white/90 font-semibold">
                                                        Drop a pin
                                                    </span>
                                                    <span className="block text-[11px] text-white/50 mt-0.5">
                                                        Search or choose any place on the chart
                                                    </span>
                                                </span>
                                            </button>
                                            {FEATURE_VISIBILITY.communityTrackSharing && (
                                                <>
                                                    <div role="separator" className="h-px bg-white/6" />
                                                    <button
                                                        role="menuitem"
                                                        onClick={() => chooseAttachment(onOpenTrackPicker)}
                                                        aria-label="Share a voyage track"
                                                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/6 transition-colors text-left min-h-[64px]"
                                                    >
                                                        <span className="w-10 h-10 rounded-xl bg-violet-400/10 border border-violet-300/20 flex items-center justify-center text-lg shrink-0">
                                                            🗺️
                                                        </span>
                                                        <span className="min-w-0">
                                                            <span className="block text-sm text-white/90 font-semibold">
                                                                Share voyage track
                                                            </span>
                                                            <span className="block text-[11px] text-white/50 mt-0.5">
                                                                Choose a track from your ship's log
                                                            </span>
                                                        </span>
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                            <button
                                onClick={() => setIsQuestion(!isQuestion)}
                                aria-label={
                                    isQuestion ? 'Unmark as question' : 'Mark as question — questions get priority'
                                }
                                aria-pressed={isQuestion}
                                className={`w-11 h-11 rounded-xl flex items-center justify-center text-sm transition-all duration-200 shrink-0 active:scale-90 ${
                                    isQuestion
                                        ? 'bg-amber-500/15 border border-amber-500/25 shadow-lg shadow-amber-500/10'
                                        : 'bg-white/3 border border-white/4 hover:bg-white/6'
                                }`}
                            >
                                ❓
                            </button>
                            <div className="flex-1 relative">
                                <input
                                    ref={inputRef as React.RefObject<HTMLInputElement>}
                                    type="text"
                                    value={messageText}
                                    onChange={(e) => {
                                        setMessageText(e.target.value);
                                        setFilterWarning(null);
                                    }}
                                    onKeyDown={(e) => e.key === 'Enter' && onSend()}
                                    placeholder={isQuestion ? 'Ask the crew anything...' : 'Message...'}
                                    aria-label={isQuestion ? 'Ask the crew a question' : 'Type a message'}
                                    aria-describedby={messageLimitId}
                                    maxLength={MAX_CHAT_MESSAGE_CHARS}
                                    className="w-full bg-white/4 border border-white/6 rounded-xl px-4 py-3 text-lg text-white placeholder:text-white/40 focus:outline-hidden focus:border-sky-500/30 focus:bg-white/6 transition-all duration-200 min-h-[48px]"
                                />
                                <span id={messageLimitId} className="sr-only">
                                    Maximum {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} characters
                                </span>
                            </div>
                            <button
                                onClick={() => onSend()}
                                disabled={!messageText.trim()}
                                aria-label="Send message"
                                className="w-11 h-11 rounded-xl bg-linear-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 disabled:from-white/3 disabled:to-white/3 disabled:border disabled:border-white/4 flex items-center justify-center transition-all duration-200 active:scale-90 disabled:active:scale-100 shadow-lg shadow-sky-500/20 disabled:shadow-none"
                            >
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className={messageText.trim() ? 'text-white' : 'text-white/40'}
                                >
                                    <path d="M22 2L11 13" />
                                    <path d="M22 2l-7 20-4-9-9-4z" />
                                </svg>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    },
);

ChatComposer.displayName = 'ChatComposer';

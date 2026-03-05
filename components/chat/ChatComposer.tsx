/**
 * ChatComposer — Channel message compose bar with attachments.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React from 'react';
import { type ClientFilterResult } from '../../services/ContentModerationService';

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

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(({
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
}) => (
    <div className="flex-shrink-0 relative">
        <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/95 to-transparent" />
        <div className={`relative px-4 pt-2 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'}`}>
            {/* Client filter warning */}
            {filterWarning && (
                <div className="mb-2 p-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/[0.12] fade-slide-down">
                    <p className="text-[11px] text-amber-400/80 mb-2">⚠️ {filterWarning.warning}</p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => { setFilterWarning(null); setMessageText(''); }}
                            className="flex-1 py-1.5 rounded-lg bg-white/[0.03] text-[11px] text-white/60 hover:bg-white/[0.06] transition-colors"
                        >
                            Edit message
                        </button>
                        {!filterWarning.blocked && (
                            <button
                                onClick={() => onSend(true)}
                                className="flex-1 py-1.5 rounded-lg bg-amber-500/10 text-[11px] text-amber-400 hover:bg-amber-500/20 transition-colors"
                            >
                                Send anyway
                            </button>
                        )}
                    </div>
                </div>
            )}

            {isMuted ? (
                <div className="flex items-center justify-center gap-2 py-2 rounded-xl bg-red-500/[0.04] border border-red-500/[0.06]">
                    <span className="text-[11px] text-red-400/50">🔇 Muted until {mutedUntil?.toLocaleTimeString()}</span>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    {/* ➕ Attach button */}
                    <div className="relative">
                        <button
                            onClick={() => setShowAttachMenu(!showAttachMenu)}
                            className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all duration-200 flex-shrink-0 active:scale-90 ${showAttachMenu
                                ? 'bg-sky-500/15 border border-sky-500/25 rotate-45'
                                : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
                                }`}
                            title="Share pin or track"
                        >
                            <span className={`transition-transform duration-200 ${showAttachMenu ? 'rotate-45' : ''}`}>➕</span>
                        </button>

                        {/* Attach menu flyout */}
                        {showAttachMenu && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowAttachMenu(false)} />
                                <div className="absolute bottom-12 left-0 z-50 w-52 rounded-2xl bg-slate-900/98 border border-white/[0.1] shadow-2xl overflow-hidden fade-slide-down">
                                    <button onClick={onOpenPinDrop} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left">
                                        <span className="text-lg">📍</span>
                                        <div>
                                            <p className="text-sm text-white/80 font-medium">Drop a Pin</p>
                                            <p className="text-[11px] text-white/60">Share your location</p>
                                        </div>
                                    </button>
                                    <div className="h-px bg-white/[0.06]" />
                                    <button onClick={onOpenPoiPicker} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left">
                                        <span className="text-lg">🗺️</span>
                                        <div>
                                            <p className="text-sm text-white/80 font-medium">Share POI</p>
                                            <p className="text-[11px] text-white/60">Browse & pick any spot</p>
                                        </div>
                                    </button>
                                    <div className="h-px bg-white/[0.06]" />
                                    <button onClick={onOpenTrackPicker} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.06] transition-colors text-left">
                                        <span className="text-lg">⛵</span>
                                        <div>
                                            <p className="text-sm text-white/80 font-medium">Share Track</p>
                                            <p className="text-[11px] text-white/60">Share a voyage</p>
                                        </div>
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                    <button
                        onClick={() => setIsQuestion(!isQuestion)}
                        className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-200 flex-shrink-0 active:scale-90 ${isQuestion
                            ? 'bg-amber-500/15 border border-amber-500/25 shadow-lg shadow-amber-500/10'
                            : 'bg-white/[0.03] border border-white/[0.04] hover:bg-white/[0.06]'
                            }`}
                        title="Mark as question — questions get priority"
                    >
                        📢
                    </button>
                    <div className="flex-1 relative">
                        <input
                            ref={inputRef as React.RefObject<HTMLInputElement>}
                            type="text"
                            value={messageText}
                            onChange={(e) => { setMessageText(e.target.value); setFilterWarning(null); }}
                            onKeyDown={(e) => e.key === 'Enter' && onSend()}
                            placeholder={isQuestion ? 'Ask the crew anything...' : 'Message...'}
                            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-4 py-3 text-lg text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 focus:bg-white/[0.06] transition-all duration-200"
                        />
                    </div>
                    <button
                        onClick={() => onSend()}
                        disabled={!messageText.trim()}
                        className="w-10 h-10 rounded-xl bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 disabled:from-white/[0.03] disabled:to-white/[0.03] disabled:border disabled:border-white/[0.04] flex items-center justify-center transition-all duration-200 active:scale-90 disabled:active:scale-100 shadow-lg shadow-sky-500/20 disabled:shadow-none"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={messageText.trim() ? 'text-white' : 'text-white/15'}>
                            <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    </div>
));

ChatComposer.displayName = 'ChatComposer';

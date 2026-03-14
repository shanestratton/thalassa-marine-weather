/**
 * ChannelProposalModal — Full-screen modal for proposing new channels.
 *
 * Keyboard-aware: tracks iOS keyboard height via Capacitor Keyboard plugin
 * with visualViewport web fallback. Inputs auto-scroll above keyboard on focus.
 * Matches the DiaryPage compose pattern.
 */
import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import type { ChatChannel } from '../../services/ChatService';

interface ChannelProposalModalProps {
    onClose: () => void;
    proposalIcon: string;
    setProposalIcon: (icon: string) => void;
    proposalName: string;
    setProposalName: (name: string) => void;
    proposalDesc: string;
    setProposalDesc: (desc: string) => void;
    proposalIsPrivate: boolean;
    setProposalIsPrivate: (v: boolean) => void;
    proposalSent: boolean;
    onProposeChannel: () => void;
    isAdmin?: boolean;
    /** Parent channel options (top-level channels that can have sub-channels) */
    parentOptions: ChatChannel[];
    proposalParentId: string | null;
    setProposalParentId: (id: string | null) => void;
}

export const ChannelProposalModal: React.FC<ChannelProposalModalProps> = ({
    onClose,
    proposalIcon,
    setProposalIcon,
    proposalName,
    setProposalName,
    proposalDesc,
    setProposalDesc,
    proposalIsPrivate,
    setProposalIsPrivate,
    proposalSent,
    onProposeChannel,
    isAdmin,
    parentOptions,
    proposalParentId,
    setProposalParentId,
}) => {
    const [step, setStep] = useState(1);
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    // Track keyboard height — same pattern as DiaryPage
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard').then(({ Keyboard }) => {
                const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                    setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                    setTimeout(() => {
                        const focused = document.activeElement as HTMLElement;
                        if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
                            focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }, 250);
                });
                const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardHeight(0);
                });
                cleanup = () => {
                    showHandle.then(h => h.remove());
                    hideHandle.then(h => h.remove());
                };
            }).catch(() => { /* Keyboard plugin not available */ });
        } else {
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    const kbHeight = window.innerHeight - vp.height;
                    setKeyboardHeight(kbHeight > 50 ? kbHeight : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, []);

    const canProceed1 = proposalName.trim().length > 0;
    const bottomPad = keyboardHeight > 0 ? `${keyboardHeight}px` : 'env(safe-area-inset-bottom)';

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-sm">
            {/* Header */}
            <div className="shrink-0 px-4 pt-4 pb-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onClose}
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                        aria-label="Close"
                    >
                        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <div className="flex-1">
                        <h1 className="text-lg font-extrabold text-white uppercase tracking-wider">New Channel</h1>
                        <p className="text-[11px] text-white/30">Step {step} of 3</p>
                    </div>
                    {/* Step dots */}
                    <div className="flex gap-1.5">
                        {[1, 2, 3].map(s => (
                            <div
                                key={s}
                                className={`w-2.5 h-2.5 rounded-full transition-all duration-200 ${
                                    s === step ? 'bg-sky-400 scale-110' : s < step ? 'bg-sky-400/40' : 'bg-white/[0.08]'
                                }`}
                            />
                        ))}
                    </div>
                </div>
            </div>

            {/* Body — scrollable with keyboard padding */}
            <div
                className="flex-1 overflow-y-auto p-4"
                style={{ paddingBottom: bottomPad }}
            >
                {/* ── Step 1: Name & Description ── */}
                {step === 1 && (
                    <div className="space-y-4 fade-slide-down max-w-lg mx-auto">
                        <p className="text-sm font-semibold text-white/70">What's your channel about?</p>

                        {/* Icon input */}
                        <div className="flex gap-3">
                            <div className="shrink-0">
                                <label className="text-[11px] text-white/30 block mb-1.5 px-1">Icon</label>
                                <input
                                    value={proposalIcon}
                                    onChange={e => setProposalIcon(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="🏖️"
                                    aria-label="Channel icon"
                                    className="w-14 bg-white/[0.04] border border-white/[0.08] rounded-xl px-2 py-3 text-center text-xl min-h-[48px] text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors"
                                    maxLength={2}
                                />
                            </div>
                            <div className="flex-1">
                                <label className="text-[11px] text-white/30 block mb-1.5 px-1">Channel Name</label>
                                <input
                                    value={proposalName}
                                    onChange={e => setProposalName(e.target.value)}
                                    onFocus={scrollInputAboveKeyboard}
                                    placeholder="e.g. Cruising Tips"
                                    aria-label="Channel name"
                                    autoFocus
                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors min-h-[48px]"
                                />
                            </div>
                        </div>

                        {/* Description */}
                        <div>
                            <label className="text-[11px] text-white/30 block mb-1.5 px-1">Description</label>
                            <input
                                value={proposalDesc}
                                onChange={e => setProposalDesc(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="Short description (optional)"
                                aria-label="Channel description"
                                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 transition-colors min-h-[48px]"
                            />
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={onClose}
                                aria-label="Cancel"
                                className="flex-1 py-3.5 rounded-xl bg-white/[0.04] text-sm text-white/60 hover:bg-white/[0.08] transition-colors min-h-[48px] font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => setStep(2)}
                                disabled={!canProceed1}
                                aria-label="Next step"
                                className="flex-1 py-3.5 rounded-xl bg-sky-500/15 text-sm text-sky-400 font-semibold hover:bg-sky-500/25 disabled:opacity-30 transition-colors min-h-[48px]"
                            >
                                Next →
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 2: Options ── */}
                {step === 2 && (
                    <div className="space-y-5 fade-slide-down max-w-lg mx-auto">
                        <p className="text-sm font-semibold text-white/70">Channel settings</p>

                        {/* Parent channel selector */}
                        <div>
                            <p className="text-[11px] text-white/30 mb-2 px-1">Parent Channel</p>
                            <div className="flex gap-2 flex-wrap">
                                <button
                                    onClick={() => setProposalParentId(null)}
                                    className={`px-3.5 py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95 min-h-[44px] ${!proposalParentId
                                        ? 'bg-sky-500/20 border border-sky-500/40 text-sky-400'
                                        : 'bg-white/[0.04] border border-white/[0.06] text-white/40'
                                    }`}
                                >
                                    📌 Top-Level
                                </button>
                                {parentOptions.map(p => (
                                    <button
                                        key={p.id}
                                        onClick={() => setProposalParentId(p.id)}
                                        className={`px-3.5 py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95 min-h-[44px] ${proposalParentId === p.id
                                            ? 'bg-sky-500/20 border border-sky-500/40 text-sky-400'
                                            : 'bg-white/[0.04] border border-white/[0.06] text-white/40'
                                        }`}
                                    >
                                        {p.icon} {p.name}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Public / Private toggle */}
                        <div>
                            <p className="text-[11px] text-white/30 mb-2 px-1">Visibility</p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setProposalIsPrivate(false)}
                                    className={`flex-1 py-3.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[48px] ${!proposalIsPrivate
                                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-400'
                                        : 'bg-white/[0.04] border-white/[0.06] text-white/40'
                                    }`}
                                >
                                    🌊 Public
                                </button>
                                <button
                                    onClick={() => setProposalIsPrivate(true)}
                                    className={`flex-1 py-3.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[48px] ${proposalIsPrivate
                                        ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                                        : 'bg-white/[0.04] border-white/[0.06] text-white/40'
                                    }`}
                                >
                                    🔒 Private
                                </button>
                            </div>
                        </div>

                        {proposalIsPrivate && (
                            <p className="text-[11px] text-purple-400/50 px-1">
                                Private channels require approval to join. You'll moderate who gets in.
                            </p>
                        )}

                        {/* Actions */}
                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={() => setStep(1)}
                                aria-label="Go back"
                                className="flex-1 py-3.5 rounded-xl bg-white/[0.04] text-sm text-white/60 hover:bg-white/[0.08] transition-colors min-h-[48px] font-medium"
                            >
                                ← Back
                            </button>
                            <button
                                onClick={() => setStep(3)}
                                aria-label="Review"
                                className="flex-1 py-3.5 rounded-xl bg-sky-500/15 text-sm text-sky-400 font-semibold hover:bg-sky-500/25 transition-colors min-h-[48px]"
                            >
                                Review →
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step 3: Review & Submit ── */}
                {step === 3 && (
                    <div className="space-y-5 fade-slide-down max-w-lg mx-auto">
                        <p className="text-sm font-semibold text-white/70">Review your channel</p>

                        {/* Preview card */}
                        <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06] space-y-3">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.05] flex items-center justify-center text-xl">
                                    {proposalIcon || '💬'}
                                </div>
                                <div>
                                    <p className="text-base font-bold text-white/85">{proposalName}</p>
                                    <p className="text-[11px] text-white/40">{proposalDesc || 'No description'}</p>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${proposalIsPrivate ? 'text-purple-400/70 bg-purple-500/10' : 'text-sky-400/70 bg-sky-500/10'}`}>
                                    {proposalIsPrivate ? '🔒 Private' : '🌊 Public'}
                                </span>
                                <span className="text-[11px] font-bold text-white/30 bg-white/[0.04] px-2.5 py-1 rounded-full">
                                    {proposalParentId ? `Sub of ${parentOptions.find(p => p.id === proposalParentId)?.name || '?'}` : '📌 Top-Level'}
                                </span>
                            </div>
                        </div>

                        <p className="text-[11px] text-white/25 text-center">
                            {isAdmin ? 'This channel will be created instantly.' : 'Submitted to admins for approval. You\'ll moderate it!'}
                        </p>

                        {/* Actions */}
                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={() => setStep(2)}
                                aria-label="Go back"
                                className="flex-1 py-3.5 rounded-xl bg-white/[0.04] text-sm text-white/60 hover:bg-white/[0.08] transition-colors min-h-[48px] font-medium"
                            >
                                ← Back
                            </button>
                            <button
                                onClick={onProposeChannel}
                                disabled={!proposalName.trim()}
                                aria-label="Submit channel proposal"
                                className="flex-1 py-3.5 rounded-xl bg-sky-500/15 text-sm text-sky-400 font-semibold hover:bg-sky-500/25 disabled:opacity-30 transition-colors min-h-[48px]"
                            >
                                {proposalSent ? '✓ Submitted!' : isAdmin ? '⚡ Create Channel' : '📋 Submit'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ChannelProposalModal;

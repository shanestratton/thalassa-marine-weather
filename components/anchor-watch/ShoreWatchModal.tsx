/**
 * ShoreWatchModal — Join a remote anchor watch session from shore.
 * Allows entering a 6-digit session code to connect to a vessel.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../theme';

interface ShoreWatchModalProps {
    sessionCode: string;
    onSessionCodeChange: (code: string) => void;
    onJoin: () => void;
    onClose: () => void;
}

export const ShoreWatchModal: React.FC<ShoreWatchModalProps> = React.memo(
    ({ sessionCode, onSessionCodeChange, onJoin, onClose }) =>
        createPortal(
            <div
                className="fixed inset-0 z-[9999] bg-black/70 flex flex-col items-center"
                style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 108px)' }}
                onClick={onClose}
            >
                <div
                    className="w-[calc(100%-1.5rem)] max-w-md bg-slate-900/95 border border-white/[0.08] rounded-2xl shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Modal Header */}
                    <div className={t.modal.header}>
                        <div className="flex items-center gap-2">
                            <span className="text-sky-400 text-lg">📱</span>
                            <h2 className="text-base font-black text-white tracking-tight">Shore Watch</h2>
                        </div>
                        <button onClick={onClose} className={t.modal.close} aria-label="Close shore watch modal">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>

                    {/* Modal Content */}
                    <div className={t.modal.body}>
                        <p className="text-sm text-slate-400 leading-relaxed">
                            Monitor your vessel&apos;s anchor from shore. Enter the{' '}
                            <span className="text-white font-bold">6-digit session code</span> displayed on the vessel
                            device to connect.
                        </p>

                        {/* How it works */}
                        <div className="space-y-2">
                            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">How it works</p>
                            <div className="space-y-1.5">
                                <div className="flex items-start gap-2">
                                    <span className="text-emerald-400 text-sm mt-px">1.</span>
                                    <p className="text-sm text-slate-300">Start Anchor Watch on the vessel device</p>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-emerald-400 text-sm mt-px">2.</span>
                                    <p className="text-sm text-slate-300">Note the 6-digit code shown on screen</p>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-emerald-400 text-sm mt-px">3.</span>
                                    <p className="text-sm text-slate-300">Enter the code below to monitor remotely</p>
                                </div>
                            </div>
                        </div>

                        {/* Divider */}
                        <div className="border-t border-white/5" />

                        {/* Code entry */}
                        <div>
                            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">
                                Session Code
                            </p>
                            <div className="flex gap-2 items-center">
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    maxLength={6}
                                    placeholder="000000"
                                    value={sessionCode}
                                    onChange={(e) => onSessionCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    className={`flex-1 min-w-0 ${t.input.code} text-lg`}
                                    autoFocus
                                    aria-label="6-digit session code"
                                />
                                <button
                                    onClick={() => {
                                        onJoin();
                                        onClose();
                                    }}
                                    disabled={sessionCode.length !== 6}
                                    className="shrink-0 px-5 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-lg text-white text-sm font-bold transition-all disabled:opacity-30 active:scale-95"
                                >
                                    Join
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>,
            document.body,
        ),
);

ShoreWatchModal.displayName = 'ShoreWatchModal';

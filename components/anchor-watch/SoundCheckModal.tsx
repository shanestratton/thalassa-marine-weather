/**
 * SoundCheckModal — Pre-anchor confirmation for alarm readiness.
 * Displays safety checklist (mute override, volume, app foreground).
 */
import React from 'react';
import { createPortal } from 'react-dom';

interface SoundCheckModalProps {
    onConfirm: () => void;
    onCancel: () => void;
}

export const SoundCheckModal: React.FC<SoundCheckModalProps> = React.memo(({ onConfirm, onCancel }) =>
    createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-6" onClick={onCancel}>
            <div
                className="w-full max-w-sm bg-slate-900/95 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-5 pt-5 pb-3 text-center">
                    <div className="text-4xl mb-3">🔊</div>
                    <h2 className="text-lg font-black text-white tracking-tight">Sound Check</h2>
                    <p className="text-sm text-slate-400 mt-1 leading-relaxed">
                        Before you anchor up, make sure your alarm will wake you.
                    </p>
                </div>

                {/* Checklist */}
                <div className="px-5 pb-4 space-y-2.5">
                    <div className="flex items-start gap-3 bg-emerald-500/[0.06] border border-emerald-500/10 rounded-xl px-3.5 py-2.5">
                        <span className="text-lg mt-0.5">✅</span>
                        <div>
                            <p className="text-sm font-bold text-emerald-400">Mute Switch Override</p>
                            <p className="text-xs text-emerald-400/70 leading-snug">
                                The drag alarm will bypass your silent switch and play at full volume through the
                                speaker.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-start gap-3 bg-amber-500/[0.06] border border-amber-500/10 rounded-xl px-3.5 py-2.5">
                        <span className="text-lg mt-0.5">🔔</span>
                        <div>
                            <p className="text-sm font-bold text-amber-400">Recommended</p>
                            <p className="text-xs text-amber-400/70 leading-snug">
                                Turn your volume up and disable Do Not Disturb for maximum safety — especially
                                overnight.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-start gap-3 bg-sky-500/[0.06] border border-sky-500/10 rounded-xl px-3.5 py-2.5">
                        <span className="text-lg mt-0.5">📱</span>
                        <div>
                            <p className="text-sm font-bold text-sky-400">Keep App Open</p>
                            <p className="text-xs text-sky-400/70 leading-snug">
                                Leave Thalassa running. Background GPS continues but the speaker alarm requires the app
                                in view.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="px-5 pb-5 flex gap-2.5">
                    <button
                        aria-label="Cancel this action"
                        onClick={onCancel}
                        className="flex-1 py-3 rounded-xl bg-white/5 border border-white/[0.06] text-sm font-bold text-slate-400 hover:text-white transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        aria-label="Confirm selection"
                        onClick={onConfirm}
                        className="flex-[2] py-3 rounded-xl text-white text-sm font-black transition-all active:scale-[0.98]"
                        style={{
                            background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                            boxShadow: '0 4px 16px rgba(249,115,22,0.3)',
                        }}
                    >
                        ⚓ Drop Anchor
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    ),
);

SoundCheckModal.displayName = 'SoundCheckModal';

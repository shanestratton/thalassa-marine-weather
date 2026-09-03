import React, { useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { OverlayPortal } from '../../ui/OverlayPortal';
import type { DeleteConfirmSheetProps } from './types';

// ── Delete-playlist confirmation ──────────────────────────────────

export const DeleteConfirmSheet: React.FC<DeleteConfirmSheetProps> = ({ playlistName, busy, onCancel, onConfirm }) => {
    const [mounted, setMounted] = useState(false);
    const titleId = useId();
    const descriptionId = useId();
    const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: cancelButtonRef,
        onEscape: onCancel,
    });
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);
    return (
        <OverlayPortal>
            <div
                role="presentation"
                onClick={onCancel}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            <div className="absolute inset-0 flex items-center justify-center px-4 pointer-events-none">
                <div
                    ref={focusTrapRef}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    className={`relative w-full max-w-sm rounded-3xl border border-sky-300/15 bg-linear-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div id={titleId} className="text-white font-bold text-lg">
                            Delete in Apple Music
                        </div>
                        <div id={descriptionId} className="text-white/60 text-sm mt-2 leading-relaxed">
                            Apple doesn't let third-party apps delete library playlists — only their own Music app can.
                            Tap below and we'll open it for you so you can remove "{playlistName}".
                        </div>
                        <div className="flex gap-2 mt-6">
                            <button
                                ref={cancelButtonRef}
                                onClick={onCancel}
                                disabled={busy}
                                aria-label={`Cancel deleting ${playlistName} playlist`}
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                disabled={busy}
                                aria-label={`Open Apple Music to delete ${playlistName} playlist`}
                                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-sky-600 py-3 text-sm font-extrabold text-white transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                            >
                                {busy ? (
                                    <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <span>Open Apple Music</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};

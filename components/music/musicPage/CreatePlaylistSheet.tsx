import React, { useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../../hooks/useKeyboardOffset';
import { OverlayPortal } from '../../ui/OverlayPortal';
import type { CreatePlaylistSheetProps } from './types';

// ── Create playlist sheet ──────────────────────────────────────────

export const CreatePlaylistSheet: React.FC<CreatePlaylistSheetProps> = ({ busy, error, onClose, onSubmit }) => {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [mounted, setMounted] = useState(false);
    const titleId = useId();
    const descriptionId = useId();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const focusTrapRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: inputRef,
        onEscape: onClose,
    });
    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const canSubmit = name.trim().length > 0 && !busy;

    const keyboardHeight = useKeyboardOffset();

    return (
        <OverlayPortal>
            <div
                role="presentation"
                onClick={onClose}
                className={`absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-300 ${
                    mounted ? 'opacity-100' : 'opacity-0'
                }`}
            />
            {/* Centre inside the uncovered viewport. A capped, scrollable
             * card also handles landscape and large accessibility text. */}
            <div
                className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none"
                style={{ bottom: keyboardHeight }}
            >
                <div
                    ref={focusTrapRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={descriptionId}
                    style={{ maxHeight: `calc(100dvh - ${keyboardHeight}px - 2rem)`, overflowY: 'auto' }}
                    className={`relative w-full max-w-sm rounded-3xl border border-sky-300/15 bg-linear-to-b from-slate-900 via-slate-950 to-slate-950 shadow-2xl transition-all duration-300 ease-out pointer-events-auto ${
                        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
                    }`}
                >
                    <div className="px-5 pt-5 pb-5">
                        <div id={titleId} className="text-white font-bold text-lg">
                            New playlist
                        </div>
                        <div id={descriptionId} className="text-white/50 text-xs mt-1">
                            Give it a name. You can ask Calypso to "save this to my [name]" while a track is playing to
                            add songs.
                        </div>

                        <label className="block mt-5">
                            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5">Name</div>
                            <input
                                ref={inputRef}
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Sundowner mix"
                                aria-label="Playlist name"
                                disabled={busy}
                                maxLength={80}
                                className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-hidden"
                            />
                        </label>

                        <label className="block mt-4">
                            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5">
                                Description (optional)
                            </div>
                            <input
                                type="text"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What's this playlist for?"
                                aria-label="Playlist description"
                                disabled={busy}
                                maxLength={140}
                                className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/50 transition-colors focus:border-sky-300/60 focus:bg-sky-400/[0.07] focus:outline-hidden"
                            />
                        </label>

                        {error && (
                            <div className="mt-4 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 mt-6">
                            <button
                                onClick={onClose}
                                disabled={busy}
                                aria-label="Cancel playlist creation"
                                className="flex-1 py-3 rounded-2xl border border-white/15 text-white/70 font-bold active:scale-[0.97] transition-transform disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => onSubmit(name, description)}
                                disabled={!canSubmit}
                                aria-label="Create new playlist"
                                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-sky-600 py-3 text-sm font-extrabold text-white transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
                            >
                                {busy ? (
                                    <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <span>Create</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};

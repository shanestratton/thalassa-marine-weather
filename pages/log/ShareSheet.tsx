/**
 * ShareSheet — Share action sheet extracted from LogPage.
 * Shows community share + browse community options.
 */
import React, { useRef } from 'react';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface ShareSheetProps {
    onClose: () => void;
    onShowShareForm: () => void;
    onShowCommunityBrowser: () => void;
    onShareImage: () => void;
    hasNonDeviceEntries: boolean;
    selectedVoyageId: string | null;
}

export const ShareSheet: React.FC<ShareSheetProps> = ({
    onClose,
    onShowShareForm,
    onShowCommunityBrowser,
    onShareImage,
    hasNonDeviceEntries,
    selectedVoyageId,
}) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const sheetRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    return (
        <OverlayPortal
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-sheet-title"
            className="flex flex-col bg-slate-950 animate-[slideUp_0.3s_ease-out]"
        >
            {/* Header bar */}
            <div className="shrink-0 bg-slate-900/90 backdrop-blur-md border-b border-white/10 px-4 pt-3 pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                            <svg
                                className="w-4.5 h-4.5 text-purple-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                                />
                            </svg>
                        </div>
                        <h2 id="share-sheet-title" className="text-lg font-bold text-white">
                            Share
                        </h2>
                    </div>
                    <button
                        ref={closeButtonRef}
                        aria-label="Close"
                        onClick={onClose}
                        className="p-2 text-slate-400 hover:text-white transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
                <p className="text-sm text-slate-400 mt-2">
                    {selectedVoyageId ? 'Share the selected voyage' : 'Share your voyage data with the community'}
                </p>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col justify-center px-4 pb-8">
                <div className="space-y-4 max-w-2xl mx-auto w-full">
                    {/* Community Share Card */}
                    <button
                        aria-label="Share voyage"
                        onClick={() => {
                            if (!hasNonDeviceEntries) onShowShareForm();
                        }}
                        className={`w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all ${
                            hasNonDeviceEntries
                                ? 'bg-slate-800/40 border-slate-700/30 opacity-50 cursor-not-allowed'
                                : 'bg-gradient-to-r from-purple-500/15 to-purple-600/5 border-purple-500/20 hover:border-purple-400/40'
                        }`}
                    >
                        <div className="w-14 h-14 rounded-xl bg-purple-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-purple-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Community Share</div>
                            {hasNonDeviceEntries ? (
                                <div className="text-amber-400 text-sm mt-1">
                                    ⚠️ Unavailable — contains imported or community data
                                </div>
                            ) : (
                                <div className="text-slate-400 text-sm mt-1">
                                    Share your track, route, or anchorage with others
                                </div>
                            )}
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* Share Image Card — a self-contained summary PNG for
                        socials, no community upload. */}
                    <button
                        aria-label="Share voyage image"
                        onClick={onShareImage}
                        className="w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all bg-gradient-to-r from-emerald-500/15 to-emerald-600/5 border-emerald-500/20 hover:border-emerald-400/40"
                    >
                        <div className="w-14 h-14 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                            <svg
                                className="w-7 h-7 text-emerald-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Share Image</div>
                            <div className="text-slate-400 text-sm mt-1">
                                A summary card with your track & stats — for socials
                            </div>
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    {/* Browse Community Card */}
                    <button
                        aria-label="Browse community tracks"
                        onClick={onShowCommunityBrowser}
                        className="w-full flex items-center gap-4 p-5 rounded-2xl border active:scale-[0.98] transition-all bg-gradient-to-r from-sky-500/15 to-sky-600/5 border-sky-500/20 hover:border-sky-400/40"
                    >
                        <div className="w-14 h-14 rounded-xl bg-sky-500/20 flex items-center justify-center shrink-0">
                            <svg className="w-7 h-7 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                                />
                            </svg>
                        </div>
                        <div className="flex-1 text-left">
                            <div className="text-white font-bold text-lg">Browse Community</div>
                            <div className="text-slate-400 text-sm mt-1">
                                Discover and import anchorages, passages & routes
                            </div>
                        </div>
                        <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
            </div>
        </OverlayPortal>
    );
};

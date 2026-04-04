/**
 * CrewModals — Report and Super Like modals for crew finder
 *
 * Extracted from LonelyHeartsPage to reduce file size.
 */

import React, { useCallback } from 'react';
import { CrewFinderState, CrewFinderAction } from '../../hooks/useCrewFinderState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';

interface CrewModalsProps {
    state: CrewFinderState;
    dispatch: React.Dispatch<CrewFinderAction>;
    onReport: () => void;
    onSuperLike: () => void;
    onDeleteProfile: () => void;
}

export const CrewModals: React.FC<CrewModalsProps> = React.memo(
    ({ state, dispatch, onReport, onSuperLike, onDeleteProfile }) => {
        const { showDeleteConfirm, showReportModal, showSuperLikeModal, reportReason, superLikeMessage, deleting } =
            state;

        const setShowDeleteConfirm = useCallback(
            (v: boolean) => dispatch({ type: 'SET_SHOW_DELETE_CONFIRM', payload: v }),
            [dispatch],
        );
        const setShowReportModal = useCallback(
            (v: string | null) => dispatch({ type: 'SET_SHOW_REPORT_MODAL', payload: v }),
            [dispatch],
        );
        const setShowSuperLikeModal = useCallback(
            (v: null) => dispatch({ type: 'SET_SHOW_SUPER_LIKE_MODAL', payload: v }),
            [dispatch],
        );
        const setReportReason = useCallback(
            (v: string) => dispatch({ type: 'SET_REPORT_REASON', payload: v }),
            [dispatch],
        );
        const setSuperLikeMessage = useCallback(
            (v: string) => dispatch({ type: 'SET_SUPER_LIKE_MESSAGE', payload: v }),
            [dispatch],
        );

        return (
            <>
                {/* Delete listing confirmation */}
                <ConfirmDialog
                    isOpen={showDeleteConfirm}
                    title="Delete Your Listing?"
                    message="This will permanently remove your crew listing from the board. You can always create a new one later."
                    confirmLabel={deleting ? 'Deleting...' : 'Delete Listing'}
                    cancelLabel="Keep It"
                    onConfirm={onDeleteProfile}
                    onCancel={() => setShowDeleteConfirm(false)}
                    destructive
                />

                {/* Report Modal */}
                {showReportModal && (
                    <div
                        role="dialog" aria-modal="true" className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                        onClick={() => setShowReportModal(null)}
                    >
                        <div
                            className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-[90%] max-w-sm shadow-2xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <h3 className="text-lg font-bold text-white/80 mb-3">🚩 Report User</h3>
                            <p className="text-xs text-white/40 mb-4">
                                Help us keep the community safe. What's the issue?
                            </p>
                            <select
                                value={reportReason}
                                onChange={(e) => setReportReason(e.target.value)}
                                className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 mb-4 outline-none focus:border-white/20"
                            >
                                <option value="">Select a reason...</option>
                                <option value="Fake profile">Fake profile</option>
                                <option value="Inappropriate content">Inappropriate content</option>
                                <option value="Harassment">Harassment</option>
                                <option value="Spam">Spam</option>
                                <option value="Other">Other</option>
                            </select>
                            <div className="flex gap-3">
                                <button
                                    aria-label="Report content"
                                    onClick={() => setShowReportModal(null)}
                                    className="flex-1 py-3 rounded-xl bg-white/[0.05] text-sm text-white/40 font-medium"
                                >
                                    Cancel
                                </button>
                                <button
                                    aria-label="Report content"
                                    onClick={onReport}
                                    disabled={!reportReason}
                                    className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${reportReason ? 'bg-red-500/20 text-red-300 border border-red-500/20' : 'bg-white/[0.03] text-white/40 cursor-not-allowed'}`}
                                >
                                    Submit Report
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Super Like Modal */}
                {showSuperLikeModal && (
                    <div
                        role="dialog" aria-modal="true" className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                        onClick={() => setShowSuperLikeModal(null)}
                    >
                        <div
                            className="bg-slate-900 border border-violet-500/20 rounded-2xl p-6 w-[90%] max-w-sm shadow-2xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <h3 className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-violet-300 to-pink-300 mb-1">
                                ⚡ Super Like
                            </h3>
                            <p className="text-xs text-white/40 mb-4">
                                Send {showSuperLikeModal.display_name} a message with your star! (1 per day)
                            </p>
                            <textarea
                                value={superLikeMessage}
                                onChange={(e) => setSuperLikeMessage(e.target.value)}
                                onFocus={scrollInputAboveKeyboard}
                                placeholder="Hey! I noticed we both love diving..."
                                maxLength={200}
                                className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 mb-1 outline-none focus:border-violet-400/30 resize-none h-24"
                            />
                            <p className="text-[11px] text-white/40 text-right mb-4">{superLikeMessage.length}/200</p>
                            <div className="flex gap-3">
                                <button
                                    aria-label="Like this item"
                                    onClick={() => setShowSuperLikeModal(null)}
                                    className="flex-1 py-3 rounded-xl bg-white/[0.05] text-sm text-white/40 font-medium"
                                >
                                    Cancel
                                </button>
                                <button
                                    aria-label="Like this item"
                                    onClick={onSuperLike}
                                    className="flex-1 py-3 rounded-xl bg-gradient-to-r from-violet-500/30 to-pink-500/30 text-sm font-bold text-violet-200 border border-violet-400/20 transition-all active:scale-[0.97]"
                                >
                                    ⚡ Send Super Like
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </>
        );
    },
);

CrewModals.displayName = 'CrewModals';

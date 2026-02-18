/**
 * Delete Voyage Modal
 * Confirmation dialog with option to export first before deletion
 */

import React from 'react';
import { useFocusTrap } from '../hooks/useAccessibility';

interface DeleteVoyageModalProps {
    isOpen: boolean;
    onClose: () => void;
    onExportFirst: () => void;
    onDelete: () => void;
    voyageInfo: {
        startLocation: string;
        endLocation: string;
        totalDays: number;
        totalEntries: number;
        totalDistance: number;
    };
}

export const DeleteVoyageModal: React.FC<DeleteVoyageModalProps> = ({
    isOpen,
    onClose,
    onExportFirst,
    onDelete,
    voyageInfo
}) => {
    if (!isOpen) return null;

    const focusTrapRef = useFocusTrap(isOpen);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="delete-voyage-title" ref={focusTrapRef}>
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative bg-slate-900 border border-white/10 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="bg-red-600/20 border-b border-red-500/30 p-4 text-center">
                    <div className="text-3xl mb-2">🗑️</div>
                    <h2 id="delete-voyage-title" className="text-xl font-bold text-white">Delete Voyage?</h2>
                </div>

                {/* Voyage Info */}
                <div className="p-4">
                    <div className="bg-slate-800/50 rounded-xl p-4 mb-4">
                        <div className="text-center mb-3">
                            <div className="text-sm text-slate-400">Route</div>
                            <div className="text-white font-bold">
                                {voyageInfo.startLocation} → {voyageInfo.endLocation}
                            </div>
                        </div>
                        <div className="flex justify-center gap-4 text-center">
                            <div>
                                <div className="text-lg font-bold text-white">{voyageInfo.totalDays}</div>
                                <div className="text-[10px] text-slate-400 uppercase">Days</div>
                            </div>
                            <div className="w-px bg-slate-700" />
                            <div>
                                <div className="text-lg font-bold text-white">{voyageInfo.totalEntries}</div>
                                <div className="text-[10px] text-slate-400 uppercase">Entries</div>
                            </div>
                            <div className="w-px bg-slate-700" />
                            <div>
                                <div className="text-lg font-bold text-white">{(voyageInfo.totalDistance ?? 0).toFixed(1)}</div>
                                <div className="text-[10px] text-slate-400 uppercase">NM</div>
                            </div>
                        </div>
                    </div>

                    <p className="text-slate-400 text-sm text-center mb-4">
                        This action cannot be undone. Consider exporting your voyage data first.
                    </p>

                    {/* Buttons */}
                    <div className="space-y-2">
                        <button
                            onClick={onExportFirst}
                            className="w-full px-4 py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                            </svg>
                            Export First (Recommended)
                        </button>

                        <button
                            onClick={onDelete}
                            className="w-full px-4 py-3 bg-red-600/80 hover:bg-red-600 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                        >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            Delete Anyway
                        </button>

                        <button
                            onClick={onClose}
                            className="w-full px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

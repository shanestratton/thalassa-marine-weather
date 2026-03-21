/**
 * VoyageChoiceDialog — Continue or start new voyage before tracking.
 */
import React from 'react';

interface VoyageChoiceDialogProps {
    onContinue: () => void;
    onNewVoyage: () => void;
    onCancel: () => void;
}

export const VoyageChoiceDialog: React.FC<VoyageChoiceDialogProps> = React.memo(
    ({ onContinue, onNewVoyage, onCancel }) => (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-2xl border border-white/10 p-6 max-w-sm w-full shadow-2xl">
                <h3 className="text-xl font-bold text-white mb-2 text-center">Start Tracking</h3>
                <p className="text-slate-400 text-sm text-center mb-6">
                    You have an existing voyage. Would you like to continue it or start a new one?
                </p>

                <div className="space-y-3">
                    <button aria-label="Join"
                        onClick={onContinue}
                        className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                            />
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                        </svg>
                        Continue Last Voyage
                    </button>

                    <button aria-label="Add"
                        onClick={onNewVoyage}
                        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Start New Voyage
                    </button>

                    <button aria-label="Cancel"
                        onClick={onCancel}
                        className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl font-bold transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    ),
);

VoyageChoiceDialog.displayName = 'VoyageChoiceDialog';

/**
 * StopVoyageDialog — Confirmation before ending a voyage.
 */
interface StopVoyageDialogProps {
    onConfirm: () => void;
    onCancel: () => void;
}

export const StopVoyageDialog: React.FC<StopVoyageDialogProps> = React.memo(({ onConfirm, onCancel }) => (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
        <div className="bg-slate-800 rounded-2xl border border-white/10 p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">End Voyage?</h3>
            <p className="text-slate-400 text-sm mb-6">
                This will finalize your voyage log. You won&apos;t be able to add more entries to this voyage.
            </p>
            <div className="flex gap-3">
                <button aria-label="Save"
                    onClick={onCancel}
                    className="flex-1 py-3 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl font-bold transition-colors"
                >
                    Cancel
                </button>
                <button aria-label="Save"
                    onClick={onConfirm}
                    className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold transition-colors"
                >
                    End Voyage
                </button>
            </div>
        </div>
    </div>
));

StopVoyageDialog.displayName = 'StopVoyageDialog';

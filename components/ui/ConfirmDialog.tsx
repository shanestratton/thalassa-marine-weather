/**
 * ConfirmDialog — Premium native-feel confirmation dialog.
 *
 * Replaces the browser-native `confirm()` with a styled modal that
 * matches the Thalassa design system. Features:
 * - Backdrop blur
 * - Destructive (red) and safe (sky) variants
 * - Loading state on confirm button
 * - Accessible keyboard and screen reader support
 */
import React, { useState, useCallback } from 'react';

interface ConfirmDialogProps {
    /** Whether the dialog is visible */
    isOpen: boolean;
    /** Title text */
    title: string;
    /** Body text */
    message: string;
    /** Label for confirm button (default: "Confirm") */
    confirmLabel?: string;
    /** Label for cancel button (default: "Cancel") */
    cancelLabel?: string;
    /** If true, confirm button is styled red for destructive actions */
    destructive?: boolean;
    /** Called when user confirms — can be async */
    onConfirm: () => void | Promise<void>;
    /** Called when user cancels */
    onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    isOpen,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    onConfirm,
    onCancel,
}) => {
    const [loading, setLoading] = useState(false);

    const handleConfirm = useCallback(async () => {
        setLoading(true);
        try {
            await onConfirm();
        } finally {
            setLoading(false);
        }
    }, [onConfirm]);

    if (!isOpen) return null;

    const confirmBg = destructive
        ? 'bg-gradient-to-r from-red-600 to-red-600 shadow-red-500/20 hover:from-red-500 hover:to-red-500'
        : 'bg-gradient-to-r from-sky-600 to-sky-600 shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500';

    return (
        <div
            className="fixed inset-0 z-[1001] flex items-center justify-center p-4"
            onClick={onCancel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
        >
            <div className="absolute inset-0 bg-black/60" />
            <div
                className="relative w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl p-6 animate-in fade-in zoom-in-95 duration-200"
                onClick={e => e.stopPropagation()}
            >
                {/* Icon */}
                <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${destructive ? 'bg-red-500/20' : 'bg-sky-500/20'}`}>
                    {destructive ? (
                        <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    ) : (
                        <svg className="w-6 h-6 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                    )}
                </div>

                <h3 id="confirm-title" className="text-lg font-black text-white text-center mb-2">{title}</h3>
                <p className="text-sm text-gray-400 text-center mb-6">{message}</p>

                <div className="flex gap-3">
                    <button
                        onClick={onCancel}
                        className="flex-1 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-gray-400 hover:bg-white/10 transition-colors active:scale-[0.97]"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={loading}
                        className={`flex-1 py-3 rounded-xl text-sm font-black text-white uppercase tracking-widest shadow-lg transition-all active:scale-[0.97] disabled:opacity-50 ${confirmBg}`}
                    >
                        {loading ? (
                            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                        ) : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
};

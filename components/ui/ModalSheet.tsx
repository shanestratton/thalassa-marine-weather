/**
 * ModalSheet — Shared modal/bottom-sheet wrapper.
 *
 * Provides:
 * - Backdrop blur + dimming
 * - Close on backdrop tap
 * - Close button (X) in top-right
 * - Safe area padding
 * - Consistent animation (fade + zoom)
 *
 * Eliminates ~30 lines of boilerplate per modal instance.
 */
import React from 'react';

interface ModalSheetProps {
    /** Whether the modal is visible */
    isOpen: boolean;
    /** Called when user taps backdrop or close button */
    onClose: () => void;
    /** Optional title shown at top */
    title?: string;
    /** Modal contents */
    children: React.ReactNode;
    /** Optional max-width class override (default: max-w-2xl) */
    maxWidth?: string;
    /** Optional z-index override (default: z-[999]) */
    zIndex?: string;
    /** If true, content starts at top; if false (default), centered */
    alignTop?: boolean;
}

export const ModalSheet: React.FC<ModalSheetProps> = ({
    isOpen,
    onClose,
    title,
    children,
    maxWidth = 'max-w-2xl',
    zIndex = 'z-[999]',
    alignTop = false,
}) => {
    if (!isOpen) return null;

    return (
        <div
            className={`fixed inset-0 ${zIndex} flex ${alignTop ? 'items-start' : 'items-center'} justify-center`}
            style={{
                padding: '0 12px',
                paddingTop: alignTop
                    ? 'calc(env(safe-area-inset-top, 0px) + 56px)'
                    : 'calc(env(safe-area-inset-top, 0px) + 16px)',
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4rem + 8px)',
            }}
            onClick={onClose}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

            {/* Content panel */}
            <div
                className={`relative w-full ${maxWidth} bg-slate-900 border border-white/10 rounded-2xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,20px))] animate-in fade-in zoom-in-95 duration-300 flex flex-col`}
                style={{ maxHeight: '100%' }}
                onClick={e => e.stopPropagation()}
            >
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                    aria-label="Close"
                >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>

                {/* Title */}
                {title && (
                    <h3 className="text-lg font-black text-white mb-4 shrink-0">{title}</h3>
                )}

                <div className="flex-1 min-h-0 overflow-y-auto">
                    {children}
                </div>
            </div>
        </div>
    );
};

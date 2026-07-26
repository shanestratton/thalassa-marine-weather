/**
 * ModalSheet — Shared modal/bottom-sheet wrapper.
 *
 * Renders via React Portal into document.body so that parent
 * containers with overflow:hidden/auto, transforms, or scroll
 * contexts cannot affect the fixed positioning.
 *
 * Keyboard-aware: consumes the shared native/web keyboard measurement and
 * shrinks the panel + shifts it to the top of the screen so fields stay
 * visible above the keyboard.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';

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
    const keyboardHeight = useKeyboardOffset(isOpen);
    const panelRef = useFocusTrap<HTMLDivElement>(isOpen, { onEscape: onClose });

    if (!isOpen) return null;

    const kbOpen = keyboardHeight > 0;

    // When keyboard is open: shrink panel and align to top.
    // When closed: center vertically with generous clearance.
    const panelMaxHeight = kbOpen ? `calc(100dvh - ${keyboardHeight}px - 6rem)` : 'calc(100dvh - 12rem)';

    // When keyboard is open, switch to items-start with top padding
    // so the panel sits above the keyboard. When closed, center it.
    const alignment = kbOpen ? 'items-start pt-12' : alignTop ? 'items-start pt-24' : 'items-center';

    const modalId = title ? `modal-title-${title.replace(/\s+/g, '-').toLowerCase()}` : undefined;

    const modal = (
        <div
            data-modal-sheet-backdrop
            className={`fixed inset-0 ${zIndex} flex ${alignment} justify-center px-3`}
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalId}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

            {/* Content panel — data-modal-sheet prevents global keyboard dismiss on scroll */}
            <div
                ref={panelRef}
                data-modal-sheet
                className={`relative w-full ${maxWidth} bg-slate-900 border border-white/10 rounded-2xl p-5 animate-in fade-in zoom-in-95 duration-300 overflow-y-auto`}
                style={{ maxHeight: panelMaxHeight, transition: 'max-height 200ms ease' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                    aria-label="Close modal"
                >
                    <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>

                {/* Title */}
                {title && (
                    <h3 id={modalId} className="text-lg font-black text-white mb-4">
                        {title}
                    </h3>
                )}

                {children}
            </div>
        </div>
    );

    // Portal to document.body — escapes all parent overflow/transform contexts
    return createPortal(modal, document.body);
};

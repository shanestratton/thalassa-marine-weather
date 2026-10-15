/**
 * ModalSheet — Shared modal/bottom-sheet wrapper.
 *
 * Renders outside page scrolling/transforms, within its owning pane in split
 * view and across the app otherwise.
 *
 * Keyboard-aware: consumes the shared native/web keyboard measurement and
 * shrinks the panel and centres it in the visible area above the keyboard.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import { usePaneModalLock, usePaneScope } from '../../context/PanePortalContext';

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
    /**
     * The sheet's main button (132-B19): pinned below the fields, which
     * scroll above it, so Save stays on screen on an SE. It sat at the end of
     * the scroll, below the fold.
     */
    footer?: React.ReactNode;
}

export const ModalSheet: React.FC<ModalSheetProps> = ({
    isOpen,
    onClose,
    title,
    children,
    maxWidth = 'max-w-2xl',
    zIndex = 'z-999',
    footer,
}) => {
    const keyboardHeight = useKeyboardOffset(isOpen);
    const titleId = React.useId();
    const pane = usePaneScope();
    usePaneModalLock(isOpen);
    const panelRef = useFocusTrap<HTMLDivElement>(isOpen, { onEscape: onClose });

    if (!isOpen) return null;

    const kbOpen = keyboardHeight > 0;

    // When keyboard is open: shrink the panel to the available height.
    // When closed: center vertically with generous clearance.
    const panelMaxHeight = pane
        ? 'calc(var(--pane-height) - 2rem)'
        : kbOpen
          ? `calc(100dvh - ${keyboardHeight}px - 2rem)`
          : 'calc(100dvh - 12rem)';

    // Keyboard padding removes the covered region from the flex layout, so
    // short forms centre in the visible screen rather than hugging its top.
    const alignment = 'items-center';

    const modalId = title ? titleId : undefined;

    const body = (
        <>
            {/* Close button */}
            <button
                onClick={onClose}
                className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                aria-label="Close"
            >
                <svg
                    aria-hidden="true"
                    className="w-5 h-5 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>

            {/* Title — pr-12 clears the absolutely-positioned close
                button, and break-words lets a long title (an email
                address, say) wrap instead of running under the X. */}
            {title && (
                <h3 id={modalId} className="ui-dialog-title text-lg font-extrabold text-white mb-4 pr-12 break-words">
                    {title}
                </h3>
            )}

            {children}
        </>
    );

    const modal = (
        <div
            data-modal-sheet-backdrop
            className={`fixed inset-0 ${zIndex} flex ${alignment} justify-center px-3`}
            onClick={onClose}
            role="dialog"
            aria-modal={pane ? undefined : true}
            aria-labelledby={modalId}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

            {/* Content panel — data-modal-sheet prevents global keyboard dismiss on scroll */}
            <div
                ref={panelRef}
                data-modal-sheet
                className={`relative w-full ${maxWidth} bg-slate-900 border border-white/10 rounded-2xl animate-in fade-in zoom-in-95 duration-300 ${
                    footer ? 'flex flex-col overflow-hidden' : 'p-5 overflow-y-auto'
                }`}
                style={{ maxHeight: panelMaxHeight, transition: 'max-height 200ms ease' }}
                onClick={(e) => e.stopPropagation()}
            >
                {footer ? (
                    <>
                        {/* The fields scroll here, so the keyboard guard keeps a
                            focused one inside this box and never under the
                            footer (utils/keyboardScroll.ts). */}
                        <div data-modal-sheet-body className="relative min-h-0 flex-1 overflow-y-auto p-5 pb-3">
                            {body}
                        </div>
                        <div data-modal-sheet-footer className="flex-none border-t border-white/10 px-5 pt-3 pb-5">
                            {footer}
                        </div>
                    </>
                ) : (
                    body
                )}
            </div>
        </div>
    );

    return createPortal(modal, pane?.host ?? document.body);
};

/**
 * ModalSheet — Shared modal/bottom-sheet wrapper.
 *
 * Renders via React Portal into document.body so that parent
 * containers with overflow:hidden/auto, transforms, or scroll
 * contexts cannot affect the fixed positioning.
 *
 * Keyboard-aware: on iOS, listens for keyboard show/hide events
 * (via Capacitor Keyboard plugin) and shrinks the panel + shifts
 * it to the top of the screen so fields stay visible above the
 * keyboard. Also scrolls the focused field into view after resize.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';

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
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const panelRef = useRef<HTMLDivElement>(null);

    // Listen for keyboard show/hide on native platforms
    useEffect(() => {
        if (!isOpen || !Capacitor.isNativePlatform()) return;

        let cleanup: (() => void) | undefined;

        import('@capacitor/keyboard')
            .then(({ Keyboard }) => {
                const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                    setKeyboardHeight(info.keyboardHeight);

                    // After the panel shrinks (allow 250ms for CSS transition),
                    // scroll the focused field into view
                    setTimeout(() => {
                        const focused = document.activeElement as HTMLElement;
                        if (
                            focused &&
                            (focused.tagName === 'INPUT' ||
                                focused.tagName === 'TEXTAREA' ||
                                focused.tagName === 'SELECT')
                        ) {
                            focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }, 250);
                });
                const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardHeight(0);
                    // Scroll panel back to top when keyboard hides
                    if (panelRef.current) {
                        panelRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                });

                cleanup = () => {
                    showHandle.then((h) => h.remove());
                    hideHandle.then((h) => h.remove());
                };
            })
            .catch(() => {
                /* Keyboard plugin not available */
            });

        return () => {
            cleanup?.();
            setKeyboardHeight(0);
        };
    }, [isOpen]);

    // Escape key to close
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Focus trap: cycle Tab through focusable elements within the modal
    const handleFocusTrap = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;

        const focusable = panel.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }, []);

    // Auto-focus first focusable element on open
    useEffect(() => {
        if (!isOpen || !panelRef.current) return;
        // Delay to allow animation to complete
        const timer = setTimeout(() => {
            const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            );
            firstFocusable?.focus();
        }, 100);
        return () => clearTimeout(timer);
    }, [isOpen]);

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
            className={`fixed inset-0 ${zIndex} flex ${alignment} justify-center px-3`}
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalId}
            onKeyDown={handleFocusTrap}
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
                    className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors z-10"
                    aria-label="Close"
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

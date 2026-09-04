/**
 * Shared keyboard focus management for modal dialogs and sheets.
 *
 * When active, focus moves into the container, Tab and Shift+Tab stay
 * inside it, Escape can invoke the supplied dismiss action, and focus is
 * restored to the control that opened the dialog when it closes.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { isAvailableForFocus, isTextEntry } from '../utils/focusableFields';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

// More than one modal can be mounted at once (for example, a recipe form
// opened from a recipe picker). Every trap keeps its own restore target, but
// only the most recently activated trap may handle keyboard input. Without
// this stack, an underlying dialog can pull Tab focus out of the child dialog.
const activeTrapStack: HTMLElement[] = [];

export interface FocusTrapOptions {
    /** Preferred control. Otherwise start at the first editable field, then the first control. */
    initialFocusRef?: RefObject<HTMLElement | null>;
    /** Optional Escape-key action. */
    onEscape?: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => (element.tabIndex >= 0 || isTextEntry(element)) && isAvailableForFocus(element),
    );
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
    isActive: boolean,
    options: FocusTrapOptions = {},
): RefObject<T> {
    const containerRef = useRef<T>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        if (!isActive || typeof document === 'undefined') return;

        const container = containerRef.current;
        if (!container) return;

        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const descendants = focusableElements(container);
        const preferred = optionsRef.current.initialFocusRef?.current;
        // React autoFocus or a tap on the second field may already have chosen
        // the target before this effect runs. Never pull that focus back to field 1.
        const active = document.activeElement;
        const existingTarget =
            active instanceof HTMLElement &&
            active !== container &&
            container.contains(active) &&
            isAvailableForFocus(active)
                ? active
                : null;
        const initialTarget =
            existingTarget ??
            (preferred && container.contains(preferred) && isAvailableForFocus(preferred)
                ? preferred
                : (descendants.find(isTextEntry) ?? descendants[0]));
        const previousScope = container.getAttribute('data-keyboard-focus-scope');
        container.setAttribute('data-keyboard-focus-scope', '');
        const addedTabIndex = !initialTarget && !container.hasAttribute('tabindex');
        if (addedTabIndex) container.setAttribute('tabindex', '-1');
        (initialTarget ?? container).focus({ preventScroll: true });
        activeTrapStack.push(container);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (activeTrapStack[activeTrapStack.length - 1] !== container) return;

            if (event.key === 'Escape' && container.contains(document.activeElement)) {
                const onEscape = optionsRef.current.onEscape;
                if (onEscape) {
                    event.preventDefault();
                    event.stopPropagation();
                    onEscape();
                }
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = focusableElements(container);
            if (focusable.length === 0) {
                event.preventDefault();
                container.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const activeElement = document.activeElement;

            if (!container.contains(activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            const stackIndex = activeTrapStack.lastIndexOf(container);
            if (stackIndex !== -1) activeTrapStack.splice(stackIndex, 1);
            if (addedTabIndex) container.removeAttribute('tabindex');
            if (previousScope === null) container.removeAttribute('data-keyboard-focus-scope');
            else container.setAttribute('data-keyboard-focus-scope', previousScope);
            if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus({ preventScroll: true });
            previousFocusRef.current = null;
        };
    }, [isActive]);

    return containerRef;
}
